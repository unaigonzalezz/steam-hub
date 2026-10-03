import streamDeck, {
  action,
  type DialDownEvent,
  type DialRotateEvent,
  type DidReceiveSettingsEvent,
  SingletonAction,
  type TouchTapEvent,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";

import { type ArtFit, type ArtStyle, renderStripImage, type Size, type StatusBadge } from "../steam/artwork";
import { launchGame, openSteamUrl } from "../steam/launch";
import { getDownloadFraction, type SortOrder } from "../steam/library";
import { addClockListener, addStatusListener, removeClockListener, removeStatusListener } from "../steam/monitor";
import { getCurrentSession, getRunningGame } from "../steam/running";
import { getAppStates, peekAppStates } from "../steam/status";
import { badgeFor, formatElapsed, type GamePagePage, librarySlots, type LibrarySlot, steamPageUrl } from "./common";

/**
 * Per-dial settings for {@link LibraryDial}.
 *
 * The cursor lives here rather than in memory so a dial comes back to the game it was left on,
 * across profile switches and restarts alike. Each dial keeps its own, so several dials on a
 * Stream Deck + XL can sit at different points in the library rather than moving as one.
 */
type LibraryDialSettings = {
  /** 0-based position in the sorted library. */
  cursor?: number;

  /** Which piece of store art fills the touch display. */
  artStyle?: ArtStyle;

  /** How that art is fitted into the display. */
  artFit?: ArtFit;

  /** Ordering of the library the dial scrolls through. */
  sortOrder?: SortOrder;

  /**
   * What tapping the touch display opens. `"none"` leaves the tap doing nothing.
   *
   * Deliberately narrower than {@link GamePagePage}: `uninstall` is offered on a key, where it
   * takes a considered press, but a touch strip is easy to brush past and is the wrong place to
   * put it.
   */
  tapOpens?: Extract<GamePagePage, "store" | "hub"> | "none";

  /** Whether the art is framed green while its game runs, amber while it updates. Defaults to on. */
  showStatus?: boolean;

  /** Whether the position line also counts up while the game on show is running. Defaults to on. */
  showPlayTime?: boolean;

  /**
   * Whether a game downloading for the first time gets a temporary entry at the front of the scroll,
   * filling with the amber "updating" ring as it goes. Defaults to on.
   */
  showInstalling?: boolean;
};

const DEFAULT_STYLE: ArtStyle = "hero";
const DEFAULT_FIT: ArtFit = "fill";
const DEFAULT_SORT: SortOrder = "name";

/**
 * Size of the `art` item in `layouts/library-dial.json`, which the art is composited at so the
 * touch strip has nothing left to stretch. Keep the two in step: the layout's `rect` is the
 * source of truth, and this is the same numbers on the render side.
 *
 * At roughly 4:1 this is near the proportions of Steam's `library_hero.jpg`, which is why `hero`
 * is the default style, it lands with only a little cropped from the sides.
 */
const ART_SIZE: Size = { w: 200, h: 50 };

/**
 * The part of a dial this action draws on, plus the id it is tracked by.
 *
 * Structural rather than `DialAction<T>`, so the same helpers serve an event's action and one
 * pulled from {@link SingletonAction.actions} during a poll.
 */
type DialTarget = {
  readonly id: string;
  setFeedback(feedback: Record<string, unknown>): Promise<void>;
};

/** Marks a dial as currently showing the empty state, for {@link LibraryDial.#drawn}. */
const EMPTY = "empty";

/**
 * Colour of the clock, matching `STATUS_COLOURS.running` in `artwork.ts` exactly so the text and
 * the border around the art read as one signal rather than two greens that nearly agree.
 */
const RUNNING_COLOUR = "#359b43";

/**
 * How the line under the name is drawn in each state.
 *
 * Both are spelled out in full, and every update sends one of them whole, because a definition
 * handed to `setFeedback` *sticks*: set a font once and a later plain string keeps it rather than
 * falling back to the layout. Leaving either half unstated means the clock's size survives the
 * game exiting.
 */
const PLACE_STYLE = { color: "#ffffff", font: { size: 13, weight: 500 } } as const;
const CLOCK_STYLE = { color: RUNNING_COLOUR, font: { size: 22, weight: 600 } } as const;

/**
 * Colour of the "Installing NN%" line, matching `STATUS_COLOURS.updating` in `artwork.ts` exactly
 * so the text and the ring filling in around the art read as one signal.
 */
const INSTALLING_COLOUR = "#f5a623";
const INSTALLING_STYLE = { color: INSTALLING_COLOUR, font: { size: 14, weight: 600 } } as const;

/**
 * A dial that scrolls through the installed library on its touch display: turn to move through
 * the games, press to launch the one shown, tap to open its Steam page.
 *
 * This is the counterpart to "Show installed games" for devices with encoders. Where that action
 * pins one game per key and needs a key for every game you want reachable, a dial reaches the
 * whole library from a single control, which is the only practical way to browse 97 games on a
 * device that cannot show 97 keys.
 */
@action({ UUID: "com.unai-gonzalez.steam-hub.library-dial" })
export class LibraryDial extends SingletonAction<LibraryDialSettings> {
  /** Bound so the same reference can be added to and removed from the shared poll. */
  readonly #onPoll = (): Promise<void> => this.#redrawAll();

  /** Bound for the same reason, for the once-a-second clock. */
  readonly #onClock = (): Promise<void> => this.#tickAll();

  /** Whether {@link LibraryDial.#onPoll} and {@link LibraryDial.#onClock} are currently registered. */
  #listening = false;

  /** What each dial currently shows, so a poll only repaints what actually changed. */
  readonly #drawn = new Map<string, string>();

  /**
   * Dials currently showing their game's play time, so the clock can tick every second without
   * re-rendering the art or reading anything.
   */
  readonly #clocks = new Map<string, { target: DialTarget; appId: string }>();

  /** Dials currently showing a download ring, so the clock can keep it filling between polls. */
  readonly #downloads = new Map<string, WillAppearEvent<LibraryDialSettings>["action"]>();

  /**
   * Draws the dial when it comes into view, and starts watching for the running game so the
   * border and clock keep up without the dial being touched.
   * @param ev Event arguments.
   */
  override async onWillAppear(ev: WillAppearEvent<LibraryDialSettings>): Promise<void> {
    if (!this.#listening) {
      this.#listening = true;
      addStatusListener(this.#onPoll);
      addClockListener(this.#onClock);
    }

    await this.#draw(ev.action, ev.payload.settings);
  }

  /**
   * Stops polling once the last dial of this action leaves the screen.
   * @param ev Event arguments.
   */
  override onWillDisappear(ev: WillDisappearEvent<LibraryDialSettings>): void {
    this.#drawn.delete(ev.action.id);
    this.#clocks.delete(ev.action.id);
    this.#downloads.delete(ev.action.id);

    // `actions` still includes the departing dial at this point, hence the count of one.
    if (this.#listening && [...this.actions].length <= 1) {
      this.#listening = false;
      removeStatusListener(this.#onPoll);
      removeClockListener(this.#onClock);
    }
  }

  /**
   * Repaints every visible dial, called on each poll of the shared status monitor.
   */
  async #redrawAll(): Promise<void> {
    for (const target of this.actions) {
      if (!target.isDial()) {
        continue;
      }

      const settings = await target.getSettings<LibraryDialSettings>();
      await this.#draw(target, settings);
    }
  }

  /**
   * Advances the clock on every dial showing one, between polls. Only the position line is sent,
   * from the session the last poll found, so nothing is read and the art is not re-rendered.
   */
  async #tickAll(): Promise<void> {
    // Download rings follow the manifests on disk, which Steam rewrites as bytes arrive; those are
    // cheap to re-read, unlike the registry, so the ring fills every second rather than every poll.
    await Promise.all(
      [...this.#downloads.values()].map(async (target) =>
        this.#draw(target, await target.getSettings<LibraryDialSettings>(), false),
      ),
    );

    const session = getCurrentSession();
    if (session === undefined) {
      return;
    }

    const position = { value: formatElapsed(Date.now() - session.since), ...CLOCK_STYLE };

    await Promise.all(
      [...this.#clocks.values()].map(async ({ target, appId }) => {
        if (appId === session.appId) {
          await target.setFeedback({ position });
        }
      }),
    );
  }

  /**
   * Redraws when the property inspector changes something, so a new sort order or art style shows
   * up without waiting for the next turn of the dial.
   * @param ev Event arguments.
   */
  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<LibraryDialSettings>): Promise<void> {
    await this.#draw(ev.action, ev.payload.settings);
  }

  /**
   * Moves the cursor by however far the dial turned, then redraws.
   *
   * `ticks` arrives signed and can be greater than one when the dial is spun quickly, so a fast
   * flick covers ground instead of being reported as a series of single steps. The cursor wraps
   * at both ends, which makes reaching the last few games a short turn backwards rather than a
   * long turn forwards.
   * @param ev Event arguments.
   */
  override async onDialRotate(ev: DialRotateEvent<LibraryDialSettings>): Promise<void> {
    const { settings } = ev.payload;
    const slots = await this.#slots(settings);

    if (slots.length === 0) {
      await this.#drawEmpty(ev.action);
      return;
    }

    const from = clampCursor(settings.cursor, slots.length);
    const cursor = (((from + ev.payload.ticks) % slots.length) + slots.length) % slots.length;

    await ev.action.setSettings({ ...settings, cursor });
    await this.#paint(ev.action, settings, slots, cursor);
  }

  /**
   * Launches whichever game the dial is currently showing.
   * @param ev Event arguments.
   */
  override async onDialDown(ev: DialDownEvent<LibraryDialSettings>): Promise<void> {
    const { settings } = ev.payload;
    const slot = await this.#current(settings);

    if (slot === undefined) {
      await ev.action.showAlert();
      return;
    }

    if (slot.installing) {
      await ev.action.showAlert(); // still downloading, nothing to launch yet
      return;
    }

    try {
      await launchGame(slot.appId);
    } catch (err) {
      streamDeck.logger.error(`Could not launch ${slot.name}`, err);
      await ev.action.showAlert();
      return;
    }

    streamDeck.logger.info(`Dial launched ${slot.name} (${slot.appId})`);
  }

  /**
   * Opens the Steam page for the game on show, so the dial can be used to look something up
   * without launching it. Works the same whether the game is fully installed or still downloading
   * for the first time, opening its store page is harmless either way.
   * @param ev Event arguments.
   */
  override async onTouchTap(ev: TouchTapEvent<LibraryDialSettings>): Promise<void> {
    const { settings } = ev.payload;
    const opens = settings.tapOpens ?? "store";

    if (opens === "none") {
      return;
    }

    const slot = await this.#current(settings);
    if (slot === undefined) {
      await ev.action.showAlert();
      return;
    }

    try {
      await openSteamUrl(steamPageUrl(opens, slot.appId));
    } catch (err) {
      streamDeck.logger.error(`Could not open the ${opens} page for ${slot.name}`, err);
      await ev.action.showAlert();
    }
  }

  /**
   * The library in the order this dial scrolls it, games still downloading for the first time up
   * front, followed by the already-installed library sorted per the dial's own setting.
   * @param settings The dial's settings.
   * @returns The combined slot list.
   */
  async #slots(settings: LibraryDialSettings): Promise<LibrarySlot[]> {
    return librarySlots(settings.sortOrder ?? DEFAULT_SORT, settings.showInstalling !== false);
  }

  /**
   * The slot the dial is currently sitting on.
   * @param settings The dial's settings.
   * @returns The slot, or `undefined` when there is nothing to show.
   */
  async #current(settings: LibraryDialSettings): Promise<LibrarySlot | undefined> {
    const slots = await this.#slots(settings);
    if (slots.length === 0) {
      return undefined;
    }

    return slots[clampCursor(settings.cursor, slots.length)];
  }

  /**
   * Draws the dial from scratch, scanning the library first.
   * @param target The dial to draw on.
   * @param settings Its settings.
   * @param live Whether to read the registry afresh; a clock tick reuses the last poll's reading.
   */
  async #draw(
    target: WillAppearEvent<LibraryDialSettings>["action"],
    settings: LibraryDialSettings,
    live = true,
  ): Promise<void> {
    if (!target.isDial()) {
      return; // the manifest only offers this action on encoders
    }

    const slots = await this.#slots(settings);
    if (slots.length === 0) {
      this.#downloads.delete(target.id);
      await this.#drawEmpty(target);
      return;
    }

    const ringing = await this.#paint(target, settings, slots, clampCursor(settings.cursor, slots.length), live);

    if (ringing) {
      this.#downloads.set(target.id, target);
    } else {
      this.#downloads.delete(target.id);
    }
  }

  /**
   * Paints the touch display for one position in the combined list.
   * @param target The dial to draw on.
   * @param settings Its settings.
   * @param slots The combined slot list.
   * @param cursor Position within it.
   * @param live Whether to read the registry afresh; a clock tick reuses the last poll's reading.
   * @returns Whether the dial now shows a download ring, which the clock then keeps filling.
   */
  async #paint(
    target: DialTarget,
    settings: LibraryDialSettings,
    slots: LibrarySlot[],
    cursor: number,
    live = true,
  ): Promise<boolean> {
    const slot = slots[cursor]!;
    this.#clocks.delete(target.id); // put back below, if this dial still has a clock to show

    if (slot.installing) {
      await this.#paintInstalling(target, slot, settings);
      return true;
    }

    const states = live ? await getAppStates() : (peekAppStates() ?? (await getAppStates()));
    const state = states.get(slot.appId);
    const badge = badgeFor(settings.showStatus !== false, state);

    // Only worth the extra file read when there is actually a ring to fill in.
    const fraction = badge === "updating" ? await getDownloadFraction(slot.appId) : undefined;

    const since = await this.#runningSince(settings, slot, badge);

    // The clock replaces the position rather than sharing the line with it. There is one row to
    // work with, and at a size worth reading only one of the two fits; of the pair, where you are
    // in the library is the one the art already tells you.
    const position =
      since === undefined
        ? { value: `${cursor + 1} / ${slots.length}`, ...PLACE_STYLE }
        : { value: formatElapsed(Date.now() - since), ...CLOCK_STYLE };

    if (since !== undefined) {
      this.#clocks.set(target.id, { target, appId: slot.appId });
    }

    // The poll fires every few seconds whether or not anything moved; sending an unchanged frame
    // every time would burn a render and a round trip per dial for nothing. The clock itself stays
    // out of the signature, #tickAll keeps it current every second on its own.
    const percent = fraction === undefined ? "-" : Math.round(fraction * 100);
    const line = since === undefined ? position.value : "clock";
    const signature = `${slot.appId}:${badge}:${line}:${settings.artStyle}:${settings.artFit}:${percent}`;
    if (this.#drawn.get(target.id) === signature) {
      return badge === "updating";
    }

    const art = await renderStripImage(
      slot.appId,
      settings.artStyle ?? DEFAULT_STYLE,
      settings.artFit ?? DEFAULT_FIT,
      ART_SIZE,
      badge,
      fraction,
    );

    this.#drawn.set(target.id, signature);

    // `name` rather than `title`: a layout item keyed "title" is special-cased by Stream Deck to
    // follow the action's own title settings, so a profile that ships with titles switched off
    // hides the game's name entirely. Its own key keeps that out of the profile's hands.
    // A layout item can be handed a whole definition rather than just a string, which is how the
    // clock gets its own colour without a second item; the layout has no room for one, and items
    // are not allowed to overlap.
    await target.setFeedback({ art, name: slot.name, position });
    return badge === "updating";
  }

  /**
   * Paints the touch display for a game whose first install is still in progress: the same amber
   * ring "updating" games get, filled to its actual download fraction, with the position line
   * replaced by the percentage since there is no place in the library to report yet.
   * @param target The dial to draw on.
   * @param slot The installing entry.
   * @param settings Its settings.
   */
  async #paintInstalling(target: DialTarget, slot: LibrarySlot, settings: LibraryDialSettings): Promise<void> {
    const percent = slot.fraction === undefined ? undefined : Math.round(slot.fraction * 100);
    const signature = `installing:${slot.appId}:${percent}:${settings.artStyle}:${settings.artFit}`;

    if (this.#drawn.get(target.id) === signature) {
      return;
    }

    const art = await renderStripImage(
      slot.appId,
      settings.artStyle ?? DEFAULT_STYLE,
      settings.artFit ?? DEFAULT_FIT,
      ART_SIZE,
      "updating",
      slot.fraction,
    );

    this.#drawn.set(target.id, signature);

    const position = {
      value: percent === undefined ? "Installing…" : `Installing ${percent}%`,
      ...INSTALLING_STYLE,
    };

    await target.setFeedback({ art, name: slot.name, position });
  }

  /**
   * When the game on show started running, for the clock that replaces the position line.
   *
   * The clock only appears for the game the dial is actually showing, the same rule the keys
   * follow. A dial parked elsewhere in the library does not report someone else's session.
   * @param settings The dial's settings.
   * @param slot The slot on show.
   * @param badge What the art is framed with, so an idle game skips the lookup entirely.
   * @returns The session's start instant, or `undefined` when the dial shows its position instead.
   */
  async #runningSince(settings: LibraryDialSettings, slot: LibrarySlot, badge: StatusBadge): Promise<number | undefined> {
    if (badge !== "running" || settings.showPlayTime === false) {
      return undefined;
    }

    const running = await getRunningGame();
    return running?.game.appId === slot.appId ? running.since : undefined;
  }

  /**
   * Says so on the display when there is no library to scroll, rather than leaving the dial blank
   * and looking broken.
   * @param target The dial to draw on.
   */
  async #drawEmpty(target: DialTarget): Promise<void> {
    this.#clocks.delete(target.id);

    if (this.#drawn.get(target.id) === EMPTY) {
      return;
    }

    this.#drawn.set(target.id, EMPTY);
    await target.setFeedback({ art: undefined, name: "No games found", position: "" });
  }
}

/**
 * Brings a stored cursor back into range, so a library that shrank since the dial was last used
 * lands somewhere real instead of off the end.
 * @param cursor The stored cursor, which may be missing or stale.
 * @param length Number of games available.
 * @returns A position within the library.
 */
function clampCursor(cursor: number | undefined, length: number): number {
  if (cursor === undefined || !Number.isFinite(cursor) || cursor < 0) {
    return 0;
  }

  return Math.min(Math.floor(cursor), length - 1);
}
