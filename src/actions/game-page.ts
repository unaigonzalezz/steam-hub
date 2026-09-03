import streamDeck, {
  action,
  type DialAction,
  type DidReceiveSettingsEvent,
  type KeyAction,
  type KeyDownEvent,
  type SendToPluginEvent,
  SingletonAction,
  type WillAppearEvent,
} from "@elgato/streamdeck";

import { type ArtFit, type ArtStyle, clearRenderCache, renderKeyImage } from "../steam/artwork";
import { openSteamUrl } from "../steam/launch";
import { getInstalledGames, groupForPicker } from "../steam/library";
import { findSteam } from "../steam/paths";
import { type GamePagePage, steamPageUrl } from "./common";

/** Short label drawn on the key, so identically-skinned keys for the same game stay tellable apart. */
const PAGE_LABELS: Record<GamePagePage, string> = {
  store: "Store",
  hub: "Community\nHub",
  uninstall: "Uninstall",
};

/**
 * Settings for {@link GamePage}.
 */
type GamePageSettings = {
  /** Steam application id picked from the list of installed games. */
  appId?: string;

  /**
   * App id typed by hand, which takes precedence over {@link GamePageSettings.appId}. Covers
   * games that are not installed on this machine, a store or hub link works either way. The id is
   * the number in a store or SteamDB URL, e.g. 292030 for The Witcher 3.
   */
  customAppId?: string;

  /** Which page of the game to open. */
  page?: GamePagePage;

  /** Which piece of store art to draw on the key. */
  artStyle?: ArtStyle;

  /** How that art is fitted into the key. */
  artFit?: ArtFit;
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

const DEFAULT_PAGE: GamePagePage = "store";
const DEFAULT_STYLE: ArtStyle = "logo";
const DEFAULT_FIT: ArtFit = "fill";

/** A Steam app id: digits only, and short enough that it cannot be anything else. */
const APP_ID = /^\d{1,10}$/;

/**
 * Resolves the app id a key should actually use. A hand-typed id wins, so it can point a key at
 * something the scan never found. Returns `undefined` until there is a usable id.
 * @param settings Current settings.
 * @returns The app id, or `undefined`.
 */
function resolveAppId(settings: GamePageSettings): string | undefined {
  for (const candidate of [settings.customAppId, settings.appId]) {
    const id = candidate?.trim();
    if (id !== undefined && APP_ID.test(id)) {
      return id;
    }
  }

  return undefined;
}

/**
 * A key that opens one specific game's store page, Community Hub, or uninstall dialog, the same
 * game picker as {@link "./launch-game".LaunchGame}, pointed at a page instead of a launch.
 *
 * The page always shows its own label rather than the game's name: several of these keys can share
 * one game's art side by side, and the label is the only thing telling them apart.
 */
@action({ UUID: "com.unai-gonzalez.steam-hub.gamepage" })
export class GamePage extends SingletonAction<GamePageSettings> {
  /**
   * Draws the key when it comes into view.
   * @param ev Event arguments.
   */
  override async onWillAppear(ev: WillAppearEvent<GamePageSettings>): Promise<void> {
    await this.draw(ev.action, ev.payload.settings);
  }

  /**
   * Redraws the key whenever the property inspector changes something.
   * @param ev Event arguments.
   */
  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<GamePageSettings>): Promise<void> {
    await this.draw(ev.action, ev.payload.settings);
  }

  /**
   * Opens the configured page for the configured game.
   * @param ev Event arguments.
   */
  override async onKeyDown(ev: KeyDownEvent<GamePageSettings>): Promise<void> {
    const appId = resolveAppId(ev.payload.settings);

    if (appId === undefined) {
      streamDeck.logger.warn("Key pressed with no game selected");
      await ev.action.showAlert();
      return;
    }

    const page = ev.payload.settings.page ?? DEFAULT_PAGE;
    const url = steamPageUrl(page, appId);

    try {
      streamDeck.logger.info(`Opening ${url}`);
      await openSteamUrl(url);
      await ev.action.showOk();
    } catch (err) {
      streamDeck.logger.error(`Could not open the ${page} page for app ${appId}`, err);
      await ev.action.showAlert();
    }
  }

  /**
   * Serves the property inspector's game picker, identical to {@link "./launch-game".LaunchGame}'s.
   * @param ev Event arguments.
   */
  override async onSendToPlugin(ev: SendToPluginEvent<InspectorMessage, GamePageSettings>): Promise<void> {
    if (ev.payload?.event === "getGames") {
      await this.sendGames(ev.payload.isRefresh === true);
      return;
    }

    streamDeck.logger.debug(`Ignoring unknown message from the property inspector: ${ev.payload?.event}`);
  }

  /**
   * Sends the installed games to the property inspector's picker, followed by a short status line.
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
      ok: steam !== undefined,
      text:
        steam === undefined
          ? "Steam was not found on this computer. You can still target a game by App ID."
          : games.length === 0
            ? `Steam is installed at ${steam.root}, but no games were found. You can still target a game by App ID.`
            : `${games.length} installed game${games.length === 1 ? "" : "s"} found.`,
    });
  }

  /**
   * Paints a key: the game's art as the image, and the page's own label as the title.
   * @param target Key to draw on.
   * @param settings Current settings.
   */
  private async draw(
    target: DialAction<GamePageSettings> | KeyAction<GamePageSettings>,
    settings: GamePageSettings,
  ): Promise<void> {
    if (!target.isKey()) {
      return; // the manifest only offers this action on keypads
    }

    const appId = resolveAppId(settings);
    if (appId === undefined) {
      await target.setImage(); // restores the action's default image from the manifest
      await target.setTitle("Choose\ngame");
      return;
    }

    const image = await renderKeyImage(appId, settings.artStyle ?? DEFAULT_STYLE, settings.artFit ?? DEFAULT_FIT);

    await target.setImage(image);
    await target.setTitle(PAGE_LABELS[settings.page ?? DEFAULT_PAGE]);
  }
}
