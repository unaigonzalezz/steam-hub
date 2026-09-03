import streamDeck, {
  action,
  type DidReceiveSettingsEvent,
  type KeyDownEvent,
  SingletonAction,
  type WillAppearEvent,
} from "@elgato/streamdeck";

import { type ArtFit, type ArtStyle, renderKeyImage } from "../steam/artwork";
import { getInstalledGames } from "../steam/library";
import { launchGame } from "../steam/launch";

/**
 * Settings for {@link RandomGame}.
 */
type RandomGameSettings = {
  /** App id of the game the last press picked, so the key can keep showing it. */
  lastAppId?: string;

  /** Name of that game, for the title. */
  lastGameName?: string;

  /** Which piece of store art to draw once a game has been picked. */
  artStyle?: ArtStyle;

  /** How that art is fitted into the key. */
  artFit?: ArtFit;

  /** Whether the key keeps showing the last pick instead of resetting. Defaults to on. */
  rememberLast?: boolean;
};

const DEFAULT_STYLE: ArtStyle = "logo";
const DEFAULT_FIT: ArtFit = "fill";

/**
 * A key that launches one of the installed games at random.
 */
@action({ UUID: "com.unai-gonzalez.steam-hub.random" })
export class RandomGame extends SingletonAction<RandomGameSettings> {
  /**
   * Draws the key when it comes into view.
   * @param ev Event arguments.
   */
  override async onWillAppear(ev: WillAppearEvent<RandomGameSettings>): Promise<void> {
    await this.draw(ev);
  }

  /**
   * Redraws the key when the property inspector changes something.
   * @param ev Event arguments.
   */
  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<RandomGameSettings>): Promise<void> {
    await this.draw(ev);
  }

  /**
   * Picks a game and launches it.
   * @param ev Event arguments.
   */
  override async onKeyDown(ev: KeyDownEvent<RandomGameSettings>): Promise<void> {
    const { settings } = ev.payload;
    const games = await getInstalledGames();

    if (games.length === 0) {
      streamDeck.logger.warn("Random key pressed with no installed games to choose from");
      await ev.action.showAlert();
      return;
    }

    // Avoid picking the same game twice running, which otherwise happens often with a small
    // library and makes the key feel broken.
    const choices =
      games.length > 1 && settings.lastAppId !== undefined
        ? games.filter((game) => game.appId !== settings.lastAppId)
        : games;

    const pick = choices[Math.floor(Math.random() * choices.length)]!;

    try {
      await launchGame(pick.appId);
    } catch (err) {
      streamDeck.logger.error(`Could not launch ${pick.name}`, err);
      await ev.action.showAlert();
      return;
    }

    streamDeck.logger.info(`Random pick: ${pick.name} (${pick.appId})`);
    await ev.action.setSettings({ ...settings, lastAppId: pick.appId, lastGameName: pick.name });
    await ev.action.showOk();
  }

  /**
   * Shows the last pick's art, or the action's own icon when there is nothing to show yet.
   * @param ev Event carrying the action and its settings.
   */
  private async draw(
    ev: WillAppearEvent<RandomGameSettings> | DidReceiveSettingsEvent<RandomGameSettings>,
  ): Promise<void> {
    const { settings } = ev.payload;

    if (!ev.action.isKey()) {
      return; // the manifest only offers this action on keypads
    }

    if (settings.rememberLast === false || settings.lastAppId === undefined) {
      await ev.action.setImage();
      await ev.action.setTitle("");
      return;
    }

    const image = await renderKeyImage(
      settings.lastAppId,
      settings.artStyle ?? DEFAULT_STYLE,
      settings.artFit ?? DEFAULT_FIT,
    );

    await ev.action.setImage(image);
  }
}
