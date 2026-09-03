import streamDeck, {
  action,
  type DialAction,
  type DidReceiveSettingsEvent,
  type KeyAction,
  type KeyDownEvent,
  SingletonAction,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";

import { type ArtFit, type ArtStyle, renderKeyImage } from "../steam/artwork";
import { openSteamUrl } from "../steam/launch";
import { addStatusListener, removeStatusListener } from "../steam/monitor";
import { getRunningGame, type RunningGame } from "../steam/running";
import { wrapTitle } from "./common";

/**
 * Settings for {@link NowPlaying}.
 */
type NowPlayingSettings = {
  /** Which piece of store art to draw once a game is running. */
  artStyle?: ArtStyle;

  /** How that art is fitted into the key. */
  artFit?: ArtFit;

  /** Whether the game's name is drawn over the art. */
  showTitle?: boolean;
};

const DEFAULT_STYLE: ArtStyle = "logo";
const DEFAULT_FIT: ArtFit = "fill";

/**
 * A key that always shows whichever installed game is currently running or updating, with no game
 * to pick, it just follows Steam. Pressing it opens that game's Community Hub, so the key doubles
 * as quick access to its screenshots, guides, and discussions while it is on screen.
 */
@action({ UUID: "com.unai-gonzalez.steam-hub.nowplaying" })
export class NowPlaying extends SingletonAction<NowPlayingSettings> {
  /** Bound so the same reference can be added to and removed from the shared poll. */
  readonly #onPoll = (): Promise<void> => this.#redrawAll();

  /** Whether {@link NowPlaying.#onPoll} is currently registered. */
  #listening = false;

  /** What each key currently shows, so a poll only repaints what actually changed. */
  readonly #drawn = new Map<string, string>();

  /** The game the last poll found running or updating, if any, reused by {@link onKeyDown}. */
  #current: RunningGame | undefined;

  /**
   * Draws the key when it comes into view, and starts following Steam's running app.
   * @param ev Event arguments.
   */
  override async onWillAppear(ev: WillAppearEvent<NowPlayingSettings>): Promise<void> {
    if (!this.#listening) {
      this.#listening = true;
      addStatusListener(this.#onPoll);
    }

    await this.#draw(ev.action, ev.payload.settings);
  }

  /**
   * Stops following once the last key of this action leaves the screen.
   * @param ev Event arguments.
   */
  override onWillDisappear(ev: WillDisappearEvent<NowPlayingSettings>): void {
    this.#drawn.delete(ev.action.id);

    // `actions` still includes the departing key at this point, hence the count of one.
    if (this.#listening && [...this.actions].length <= 1) {
      this.#listening = false;
      removeStatusListener(this.#onPoll);
    }
  }

  /**
   * Redraws the key when its settings change.
   * @param ev Event arguments.
   */
  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<NowPlayingSettings>): Promise<void> {
    await this.#draw(ev.action, ev.payload.settings);
  }

  /**
   * Opens the running game's Community Hub. Silent when nothing is running, there is nothing to
   * jump to, and the key already shows that at a glance.
   * @param ev Event arguments.
   */
  override async onKeyDown(ev: KeyDownEvent<NowPlayingSettings>): Promise<void> {
    if (this.#current === undefined) {
      await ev.action.showAlert();
      return;
    }

    const { appId, name } = this.#current.game;

    try {
      streamDeck.logger.info(`Opening the Community Hub for ${name}`);
      await openSteamUrl(`steam://url/GameHub/${appId}`);
      await ev.action.showOk();
    } catch (err) {
      streamDeck.logger.error(`Could not open the Community Hub for ${name}`, err);
      await ev.action.showAlert();
    }
  }

  /**
   * Repaints every visible key with whatever is running now.
   */
  async #redrawAll(): Promise<void> {
    this.#current = await getRunningGame();

    await Promise.all(
      [...this.actions].map(async (target) => {
        if (target.isKey()) {
          await this.#paint(target, await target.getSettings());
        }
      }),
    );
  }

  /**
   * Draws a single key from the currently running game, cached from the last poll rather than
   * re-fetched, so a key coming into view between polls does not race the next one.
   * @param target Key to draw on.
   * @param settings The key's settings.
   */
  async #draw(
    target: DialAction<NowPlayingSettings> | KeyAction<NowPlayingSettings>,
    settings: NowPlayingSettings,
  ): Promise<void> {
    if (!target.isKey()) {
      return; // the manifest only offers this action on keypads
    }

    this.#current ??= await getRunningGame();
    await this.#paint(target, settings);
  }

  /**
   * Writes to a key only when something about it actually changed, which keeps a poll from
   * pushing an identical image every four seconds.
   * @param target Key to draw on.
   * @param settings The key's settings.
   */
  async #paint(target: KeyAction<NowPlayingSettings>, settings: NowPlayingSettings): Promise<void> {
    const current = this.#current;
    const signature =
      current === undefined
        ? "idle"
        : `${current.game.appId}:${current.badge}:${settings.artStyle ?? DEFAULT_STYLE}:${settings.artFit ?? DEFAULT_FIT}:${settings.showTitle === true}`;

    if (this.#drawn.get(target.id) === signature) {
      return;
    }

    this.#drawn.set(target.id, signature);

    if (current === undefined) {
      await target.setImage(); // restores the action's default image from the manifest
      await target.setTitle("");
      return;
    }

    const image = await renderKeyImage(
      current.game.appId,
      settings.artStyle ?? DEFAULT_STYLE,
      settings.artFit ?? DEFAULT_FIT,
      current.badge,
    );

    await target.setImage(image);
    await target.setTitle(settings.showTitle === true ? wrapTitle(current.game.name) : "");
  }
}
