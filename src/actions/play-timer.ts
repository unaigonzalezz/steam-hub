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

import { type ArtFit, type ArtStyle, pluginPath, renderCaption, renderImageFile, renderKeyImage } from "../steam/artwork";
import { openSteamUrl } from "../steam/launch";
import { addClockListener, addStatusListener, removeClockListener, removeStatusListener } from "../steam/monitor";
import { getCurrentSession, getRunningGame } from "../steam/running";
import { formatElapsed } from "./common";
import { getTextStyle } from "./text-style";

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
 * What a key drawing its clock into the image draws each reading onto.
 */
type ClockFace = {
  /** The key's image without the clock. */
  base: string;

  /**
   * Whether the clock sits in the middle, inside the stock art's display, or along the bottom of a
   * game's art, clear of its "running" frame.
   */
  middle: boolean;
};

/**
 * One running game's session, timed from when Steam launched it, so it matches Steam's own record
 * and a session already under way when the plugin starts is still timed from its real start.
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

  /** Bound for the same reason, for the once-a-second clock. */
  readonly #onClock = (): Promise<void> => this.#tickAll();

  /** Whether {@link PlayTimer.#onPoll} and {@link PlayTimer.#onClock} are currently registered. */
  #listening = false;

  /** What each key currently shows, so a poll only repaints what actually changed. */
  readonly #drawn = new Map<string, string>();

  /** The session in progress, if any. Lives only in memory, a restart starts the clock over. */
  #session: Session | undefined;

  /** Keys drawing their clock into the image, with what to draw it onto; absent for title keys. */
  readonly #faces = new Map<string, ClockFace>();

  /**
   * Initialises the action, repainting its keys when the shared text style changes.
   */
  constructor() {
    super();
    streamDeck.settings.onDidReceiveGlobalSettings(() => void this.#redrawAll());
  }

  /**
   * Draws the key when it comes into view, and starts following the running game's session.
   * @param ev Event arguments.
   */
  override async onWillAppear(ev: WillAppearEvent<PlayTimerSettings>): Promise<void> {
    if (!this.#listening) {
      this.#listening = true;
      addStatusListener(this.#onPoll);
      addClockListener(this.#onClock);
    }

    await this.#draw(ev.action, ev.payload.settings);
  }

  /**
   * Stops following once the last key of this action leaves the screen.
   * @param ev Event arguments.
   */
  override onWillDisappear(ev: WillDisappearEvent<PlayTimerSettings>): void {
    this.#drawn.delete(ev.action.id);
    this.#faces.delete(ev.action.id);

    // `actions` still includes the departing key at this point, hence the count of one.
    if (this.#listening && [...this.actions].length <= 1) {
      this.#listening = false;
      removeStatusListener(this.#onPoll);
      removeClockListener(this.#onClock);
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
   * Advances the clock on every visible key between polls, from the session the last poll found.
   * Only the clock changes, drawn onto the art already rendered or written as the title, so nothing
   * is read and no art is rendered again.
   */
  async #tickAll(): Promise<void> {
    // Straight from the shared session, whose start may just have been corrected to Steam's stamp.
    const session = getCurrentSession();
    if (session === undefined || this.#session?.appId !== session.appId) {
      return; // idle, or the game changed and the next poll will repaint the keys properly
    }

    const elapsed = formatElapsed(Date.now() - session.since);
    await Promise.all(
      [...this.actions].map(async (target) => {
        if (!target.isKey()) {
          return;
        }

        const face = this.#faces.get(target.id);
        await (face === undefined ? target.setTitle(elapsed) : target.setImage(clockImage(face, elapsed)));
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
   * Writes to a key: the clock always, since it changes every tick anyway, but the art only when the
   * game, style or text style behind it actually changed, that is the expensive part.
   * @param target Key to draw on.
   * @param settings The key's settings.
   */
  async #paint(target: KeyAction<PlayTimerSettings>, settings: PlayTimerSettings): Promise<void> {
    const session = this.#session;
    const style = settings.artStyle ?? DEFAULT_STYLE;
    const drawn = (await getTextStyle()) === "drawn";
    const signature = `${session?.appId ?? "idle"}:${style}:${settings.artFit ?? DEFAULT_FIT}:${drawn}`;
    const reading = session === undefined ? IDLE_TITLE : formatElapsed(Date.now() - session.since);

    if (this.#drawn.get(target.id) !== signature) {
      this.#drawn.set(target.id, signature);
      this.#faces.delete(target.id);

      const art =
        session === undefined || style === "none"
          ? undefined
          : await renderKeyImage(session.appId, style, settings.artFit ?? DEFAULT_FIT, "running");

      if (!drawn) {
        await target.setImage(art);
      } else {
        // Without game art, the stock display the title used to sit in, so the clock still reads as
        // a screen; with it, along the bottom, leaving the art to show which game is being timed.
        const base = art ?? (await renderImageFile(pluginPath("imgs", "actions", "playtimer", "key@2x.png")));
        if (base !== undefined) {
          this.#faces.set(target.id, { base, middle: art === undefined });
        }
      }
    }

    const face = this.#faces.get(target.id);
    if (face === undefined) {
      await target.setTitle(reading);
    } else {
      await target.setImage(clockImage(face, reading, session === undefined));
      await target.setTitle("");
    }
  }
}

/**
 * Draws a clock reading onto a key.
 * @param face What to draw it onto, and where.
 * @param reading The formatted time, or the idle placeholder.
 * @param idle Whether no game is running, drawn dimmer so it reads as "not counting".
 * @returns A `data:` URI.
 */
function clockImage(face: ClockFace, reading: string, idle = false): string {
  // The stock display has room for a large clock; over game art it stays the size the library keys use.
  const long = reading.length > 5; // "1:23:45" is wider than "12:07"
  const size = face.middle ? (long ? 28 : 34) : long ? 24 : 28;
  return renderCaption(face.base, { main: reading, size, middle: face.middle, framed: !face.middle, muted: idle });
}
