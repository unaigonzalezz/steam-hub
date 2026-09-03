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
import { getRunningGame } from "../steam/running";
import { formatElapsed } from "./common";

/**
 * Settings for {@link PlayTimer}.
 */
type PlayTimerSettings = {
  /** Which piece of store art to draw behind the clock. Off by default, so the time stays legible. */
  artStyle?: ArtStyle;

  /** How that art is fitted into the key. */
  artFit?: ArtFit;
};

const DEFAULT_STYLE: ArtStyle = "none";
const DEFAULT_FIT: ArtFit = "fill";

/** Shown while no game is running, long enough to read as "not counting" rather than a stuck clock. */
const IDLE_TITLE = "--:--";

/**
 * One running game's session, timed from the moment this plugin first saw it running rather than
 * from Steam's own record, so a session already under way when the plugin starts is timed from
 * then, not from zero.
 */
type Session = {
  appId: string;
  name: string;
  since: number;
};

/**
 * A key with no game to pick that times the current play session, counting up for as long as
 * Steam reports a game running. Pressing it opens that game's Community Hub.
 */
@action({ UUID: "com.unai-gonzalez.steam-hub.playtimer" })
export class PlayTimer extends SingletonAction<PlayTimerSettings> {
  /** Bound so the same reference can be added to and removed from the shared poll. */
  readonly #onPoll = (): Promise<void> => this.#redrawAll();

  /** Whether {@link PlayTimer.#onPoll} is currently registered. */
  #listening = false;

  /** What each key currently shows, so a poll only repaints what actually changed. */
  readonly #drawn = new Map<string, string>();

  /** The session in progress, if any. Lives only in memory, a restart starts the clock over. */
  #session: Session | undefined;

  /**
   * Draws the key when it comes into view, and starts following the running game's session.
   * @param ev Event arguments.
   */
  override async onWillAppear(ev: WillAppearEvent<PlayTimerSettings>): Promise<void> {
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
  override onWillDisappear(ev: WillDisappearEvent<PlayTimerSettings>): void {
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
  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<PlayTimerSettings>): Promise<void> {
    await this.#draw(ev.action, ev.payload.settings);
  }

  /**
   * Opens the timed game's Community Hub. Silent when nothing is being timed.
   * @param ev Event arguments.
   */
  override async onKeyDown(ev: KeyDownEvent<PlayTimerSettings>): Promise<void> {
    const session = this.#session;
    if (session === undefined) {
      await ev.action.showAlert();
      return;
    }

    try {
      streamDeck.logger.info(`Opening the Community Hub for ${session.name}`);
      await openSteamUrl(`steam://url/GameHub/${session.appId}`);
      await ev.action.showOk();
    } catch (err) {
      streamDeck.logger.error(`Could not open the Community Hub for ${session.name}`, err);
      await ev.action.showAlert();
    }
  }

  /**
   * Updates the session against what is running now, then repaints every visible key.
   *
   * The start instant itself comes from {@link getRunningGame}, which is the one place that tracks
   * it, so this key and {@link ShowInstalled}'s optional elapsed-time line always agree down to
   * the second, however many keys are watching.
   */
  async #redrawAll(): Promise<void> {
    const running = await getRunningGame();

    this.#session =
      running !== undefined && running.badge === "running" && running.since !== undefined
        ? { appId: running.game.appId, name: running.game.name, since: running.since }
        : undefined;

    await Promise.all(
      [...this.actions].map(async (target) => {
        if (target.isKey()) {
          await this.#paint(target, await target.getSettings());
        }
      }),
    );
  }

  /**
   * Draws a single key from the session in progress.
   * @param target Key to draw on.
   * @param settings The key's settings.
   */
  async #draw(
    target: DialAction<PlayTimerSettings> | KeyAction<PlayTimerSettings>,
    settings: PlayTimerSettings,
  ): Promise<void> {
    if (!target.isKey()) {
      return; // the manifest only offers this action on keypads
    }

    await this.#paint(target, settings);
  }

  /**
   * Writes to a key: the clock always, since a title is cheap and changes every tick anyway, but
   * the art only when the game or style behind it actually changed, that is the expensive part.
   * @param target Key to draw on.
   * @param settings The key's settings.
   */
  async #paint(target: KeyAction<PlayTimerSettings>, settings: PlayTimerSettings): Promise<void> {
    const session = this.#session;
    const style = settings.artStyle ?? DEFAULT_STYLE;
    const signature = `${session?.appId ?? "idle"}:${style}:${settings.artFit ?? DEFAULT_FIT}`;

    if (this.#drawn.get(target.id) !== signature) {
      this.#drawn.set(target.id, signature);

      const image =
        session === undefined || style === "none"
          ? undefined
          : await renderKeyImage(session.appId, style, settings.artFit ?? DEFAULT_FIT, "running");

      await target.setImage(image);
    }

    await target.setTitle(session === undefined ? IDLE_TITLE : formatElapsed(Date.now() - session.since));
  }
}
