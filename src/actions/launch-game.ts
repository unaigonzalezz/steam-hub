import streamDeck, {
  action,
  type DialAction,
  type DidReceiveSettingsEvent,
  type KeyAction,
  type KeyDownEvent,
  type SendToPluginEvent,
  SingletonAction,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";

import { type ArtFit, type ArtStyle, clearRenderCache, renderCaption, renderKeyImage } from "../steam/artwork";
import { launchGame } from "../steam/launch";
import { findGame, getDownloadFraction, getInstalledGames, groupForPicker } from "../steam/library";
import { addClockListener, addStatusListener, removeClockListener, removeStatusListener } from "../steam/monitor";
import { findSteam } from "../steam/paths";
import { getAppStates } from "../steam/status";
import { badgeFor, drawnLines, paintKey } from "./common";

/**
 * Settings for {@link LaunchGame}.
 */
type LaunchGameSettings = {
  /** Steam application id picked from the list of installed games. */
  appId?: string;

  /**
   * App id typed by hand, which takes precedence over {@link LaunchGameSettings.appId}. Covers
   * games that are not installed on this machine, and anything the picker filters out. The id is
   * the number in a store or SteamDB URL, e.g. 292030 for The Witcher 3.
   */
  customAppId?: string;

  /** Cached display name, so the key still labels itself when Steam is unavailable. */
  gameName?: string;

  /** Which piece of store art to draw on the key. */
  artStyle?: ArtStyle;

  /** How that art is fitted into the key. */
  artFit?: ArtFit;

  /** Whether the game's name is drawn over the art. */
  showTitle?: boolean;

  /** Whether the key is framed while the game is running or updating. Defaults to on. */
  showStatus?: boolean;

  /**
   * Whether the title currently on the key was written by us. Lets us clear our own title when
   * the user turns {@link LaunchGameSettings.showTitle} off, without ever wiping a title they
   * typed in Stream Deck themselves.
   */
  titleIsOurs?: boolean;
};

/**
 * Messages the property inspector sends us. Fields are optional and loosely typed because they
 * arrive over a WebSocket from a page we do not control.
 */
type InspectorMessage = {
  /** Which request this is. */
  event?: string;

  /** Set by the picker's refresh button. */
  isRefresh?: boolean;
};

const DEFAULT_STYLE: ArtStyle = "logo";
const DEFAULT_FIT: ArtFit = "fill";

/** A Steam app id: digits only, and short enough that it cannot be anything else. */
const APP_ID = /^\d{1,10}$/;

/**
 * Resolves the app id a key should actually use, collapsing the "pick from the list" and "type it
 * in" paths into one value. A hand-typed id wins, so it can point a key at something the scan
 * never found. Returns `undefined` until there is a usable id, which is what keeps a
 * half-configured key from trying to launch anything.
 * @param settings Current settings.
 * @returns The app id, or `undefined`.
 */
function resolveAppId(settings: LaunchGameSettings): string | undefined {
  for (const candidate of [settings.customAppId, settings.appId]) {
    const id = candidate?.trim();
    if (id !== undefined && APP_ID.test(id)) {
      return id;
    }
  }

  return undefined;
}

/**
 * A key that launches a Steam game, showing that game's store art.
 */
@action({ UUID: "com.unai-gonzalez.steam-hub.launch" })
export class LaunchGame extends SingletonAction<LaunchGameSettings> {
  /** Bound so the same reference can be added to and removed from the shared poll. */
  readonly #onPoll = (): Promise<void> => this.#refreshStatuses();

  /** Bound for the same reason, for the once-a-second clock that keeps download rings filling. */
  readonly #onClock = (): Promise<void> => this.#tickDownloads();

  /** Whether {@link LaunchGame.#onPoll} and {@link LaunchGame.#onClock} are currently registered. */
  #listening = false;

  /**
   * What each key last showed, so a poll or a tick only repaints what actually changed.
   */
  readonly #drawn = new Map<string, string>();

  /** Keys whose game is updating, so the clock can keep their ring and percentage moving between polls. */
  readonly #downloads = new Map<string, KeyAction<LaunchGameSettings>>();

  /**
   * Draws the key when it comes into view, on startup, or when the user navigates to its page.
   * @param ev Event arguments.
   */
  override async onWillAppear(ev: WillAppearEvent<LaunchGameSettings>): Promise<void> {
    if (!this.#listening) {
      this.#listening = true;
      addStatusListener(this.#onPoll);
      addClockListener(this.#onClock);
    }

    await this.draw(ev.action, ev.payload.settings);
  }

  /**
   * Stops tracking a key that has left the screen, and shuts the poll down with the last one.
   * @param ev Event arguments.
   */
  override onWillDisappear(ev: WillDisappearEvent<LaunchGameSettings>): void {
    this.#drawn.delete(ev.action.id);
    this.#downloads.delete(ev.action.id);

    // `actions` still includes the departing key at this point, hence the count of one.
    if (this.#listening && [...this.actions].length <= 1) {
      this.#listening = false;
      removeStatusListener(this.#onPoll);
      removeClockListener(this.#onClock);
    }
  }

  /**
   * Redraws the key whenever the property inspector changes something.
   * @param ev Event arguments.
   */
  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<LaunchGameSettings>): Promise<void> {
    await this.draw(ev.action, ev.payload.settings);
  }

  /**
   * Launches the selected game.
   * @param ev Event arguments.
   */
  override async onKeyDown(ev: KeyDownEvent<LaunchGameSettings>): Promise<void> {
    const appId = resolveAppId(ev.payload.settings);

    if (appId === undefined) {
      streamDeck.logger.warn("Key pressed with no game selected");
      await ev.action.showAlert();
      return;
    }

    try {
      await launchGame(appId, () => ev.action.showAlert());
      await ev.action.showOk();
    } catch (err) {
      streamDeck.logger.error(`Could not launch ${ev.payload.settings.gameName ?? appId}`, err);
      await ev.action.showAlert();
    }
  }

  /**
   * Serves the property inspector's game picker.
   * @param ev Event arguments.
   */
  override async onSendToPlugin(ev: SendToPluginEvent<InspectorMessage, LaunchGameSettings>): Promise<void> {
    if (ev.payload?.event === "getGames") {
      await this.sendGames(ev.payload.isRefresh === true);
      return;
    }

    streamDeck.logger.debug(`Ignoring unknown message from the property inspector: ${ev.payload?.event}`);
  }

  /**
   * Repaints any visible key whose game has started, stopped, or begun updating.
   */
  async #refreshStatuses(): Promise<void> {
    await Promise.all(
      [...this.actions].map(async (target) => {
        if (target.isKey()) {
          await this.draw(target, await target.getSettings());
        }
      }),
    ).catch((err) => streamDeck.logger.error("Could not repaint the game keys", err));
  }

  /**
   * Moves the ring and percentage on keys whose game is updating, between the slower status polls.
   */
  async #tickDownloads(): Promise<void> {
    await Promise.all(
      [...this.#downloads.values()].map(async (target) => this.draw(target, await target.getSettings())),
    ).catch((err) => streamDeck.logger.error("Could not repaint a download ring", err));
  }

  /**
   * Sends the installed games to the property inspector's picker, followed by a short status line
   * describing what was found, the fastest way to tell "no games" from "no Steam".
   * @param refresh Whether to rescan rather than reuse the cached scan.
   */
  private async sendGames(refresh: boolean): Promise<void> {
    if (refresh) {
      clearRenderCache();
    }

    const games = await getInstalledGames(refresh);

    await streamDeck.ui.sendToPropertyInspector({
      event: "getGames",
      items: groupForPicker(games),
    });

    const steam = await findSteam();
    await streamDeck.ui.sendToPropertyInspector({
      event: "status",
      ok: steam !== undefined && games.length > 0,
      text:
        steam === undefined
          ? "Steam was not found on this computer. You can still launch a game by App ID."
          : games.length === 0
            ? `Steam is installed at ${steam.root}, but no games were found.`
            : `${games.length} installed game${games.length === 1 ? "" : "s"} found.`,
    });
  }

  /**
   * Paints a key from its settings: the game's art as the image, and its name as the title when
   * asked for.
   * @param target Key to draw on.
   * @param settings Current settings.
   */
  private async draw(
    target: DialAction<LaunchGameSettings> | KeyAction<LaunchGameSettings>,
    settings: LaunchGameSettings,
  ): Promise<void> {
    if (!target.isKey()) {
      return; // the manifest only offers this action on keypads
    }

    const appId = resolveAppId(settings);
    this.#downloads.delete(target.id); // put back below while the game is updating

    if (appId === undefined) {
      this.#drawn.delete(target.id);
      // The action's own icon from the manifest, with the prompt drawn on it. The title is left alone,
      // it may be the user's own.
      await paintKey(target, undefined, "Choose game", "launch", { clearTitle: settings.titleIsOurs === true });
      if (settings.titleIsOurs === true) {
        await target.setSettings({ ...settings, titleIsOurs: false });
      }
      return;
    }

    // Remember the name so a key keeps labelling itself if the game is later uninstalled, and,
    // for a hand-typed id, so it has something to show at all.
    const name = (await findGame(appId))?.name ?? settings.gameName;
    const updated: LaunchGameSettings = { ...settings };

    if (name !== undefined) {
      updated.gameName = name;
    }

    const style = settings.artStyle ?? DEFAULT_STYLE;
    const fit = settings.artFit ?? DEFAULT_FIT;
    const badge = badgeFor(settings.showStatus !== false, (await getAppStates()).get(appId));

    // While updating, the amber ring fills to the download's progress and the percentage is written
    // along the top, kept moving every second by the clock.
    const fraction = badge === "updating" ? await getDownloadFraction(appId) : undefined;
    const percent = fraction === undefined ? undefined : Math.round(fraction * 100);
    if (badge === "updating") {
      this.#downloads.set(target.id, target);
    }

    const label = settings.showTitle === true ? (name ?? `App ${appId}`) : "";
    const signature = `${appId}:${style}:${fit}:${badge}:${percent ?? "-"}:${label}:${settings.titleIsOurs === true}`;

    if (this.#drawn.get(target.id) !== signature) {
      const image = await renderKeyImage(appId, style, fit, badge, fraction);

      // The name is drawn into the image. A title is only ever cleared when it is one an earlier
      // version wrote, never one the user typed.
      if (percent !== undefined && image !== undefined) {
        await target.setImage(
          renderCaption(image, {
            main: String(percent),
            suffix: "%",
            top: true,
            framed: true,
            ...(label === "" ? {} : { label: drawnLines(label) }),
          }),
        );
        if (settings.titleIsOurs === true) {
          await target.setTitle("");
        }
      } else {
        await paintKey(target, image, label, "launch", { clearTitle: settings.titleIsOurs === true });
      }

      this.#drawn.set(target.id, signature);
    }
    updated.titleIsOurs = false;

    // Written once, and only when something actually changed, so this can never loop.
    if (updated.gameName !== settings.gameName || updated.titleIsOurs !== settings.titleIsOurs) {
      await target.setSettings(updated);
    }
  }
}
