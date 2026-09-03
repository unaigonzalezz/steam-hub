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

import { type ArtFit, type ArtStyle, clearRenderCache, renderKeyImage, type StatusBadge } from "../steam/artwork";
import { launchGame } from "../steam/launch";
import { findGame, getInstalledGames, groupForPicker } from "../steam/library";
import { addStatusListener, removeStatusListener } from "../steam/monitor";
import { findSteam } from "../steam/paths";
import { getAppStates } from "../steam/status";
import { badgeFor, wrapTitle } from "./common";

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

  /** Whether {@link LaunchGame.#onPoll} is currently registered. */
  #listening = false;

  /**
   * Badge last drawn on each key, so a poll only repaints what actually changed.
   */
  readonly #drawn = new Map<string, StatusBadge>();

  /**
   * Draws the key when it comes into view, on startup, or when the user navigates to its page.
   * @param ev Event arguments.
   */
  override async onWillAppear(ev: WillAppearEvent<LaunchGameSettings>): Promise<void> {
    if (!this.#listening) {
      this.#listening = true;
      addStatusListener(this.#onPoll);
    }

    await this.draw(ev.action, ev.payload.settings);
  }

  /**
   * Stops tracking a key that has left the screen, and shuts the poll down with the last one.
   * @param ev Event arguments.
   */
  override onWillDisappear(ev: WillDisappearEvent<LaunchGameSettings>): void {
    this.#drawn.delete(ev.action.id);

    // `actions` still includes the departing key at this point, hence the count of one.
    if (this.#listening && [...this.actions].length <= 1) {
      this.#listening = false;
      removeStatusListener(this.#onPoll);
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
      await launchGame(appId);
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
    const visible = [...this.actions];
    if (visible.length === 0) {
      return;
    }

    const states = await getAppStates();

    await Promise.all(
      visible.map(async (target) => {
        if (!target.isKey()) {
          return;
        }

        const settings = await target.getSettings();
        const appId = resolveAppId(settings);
        if (appId === undefined || settings.artStyle === "none") {
          return;
        }

        const badge = badgeFor(settings.showStatus !== false, states.get(appId));
        if (this.#drawn.get(target.id) === badge) {
          return;
        }

        const image = await renderKeyImage(
          appId,
          settings.artStyle ?? DEFAULT_STYLE,
          settings.artFit ?? DEFAULT_FIT,
          badge,
        );

        if (image !== undefined) {
          await target.setImage(image);
          this.#drawn.set(target.id, badge);
        }
      }),
    );
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
    if (appId === undefined) {
      this.#drawn.delete(target.id);
      await target.setImage(); // restores the action's default image from the manifest
      await target.setTitle("Choose\ngame");

      // Mark this title as ours, same as the branch below, so it gets cleared once an app id is
      // set and showTitle is off. Otherwise the placeholder is stuck on the key forever.
      if (settings.titleIsOurs !== true) {
        await target.setSettings({ ...settings, titleIsOurs: true });
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

    const badge = badgeFor(settings.showStatus !== false, (await getAppStates()).get(appId));
    const image = await renderKeyImage(
      appId,
      settings.artStyle ?? DEFAULT_STYLE,
      settings.artFit ?? DEFAULT_FIT,
      badge,
    );

    await target.setImage(image);
    this.#drawn.set(target.id, badge);

    if (settings.showTitle) {
      await target.setTitle(wrapTitle(name ?? `App ${appId}`));
      updated.titleIsOurs = true;
    } else if (settings.titleIsOurs) {
      // Only ever clear a title we put there ourselves, never one the user typed.
      await target.setTitle("");
      updated.titleIsOurs = false;
    }

    // Written once, and only when something actually changed, so this can never loop.
    if (updated.gameName !== settings.gameName || updated.titleIsOurs !== settings.titleIsOurs) {
      await target.setSettings(updated);
    }
  }
}
