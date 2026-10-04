import streamDeck, {
  action,
  type DialAction,
  type DidReceiveSettingsEvent,
  type KeyAction,
  type KeyDownEvent,
  type KeyUpEvent,
  type SendToPluginEvent,
  SingletonAction,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";

import { checkForNewAchievement, type LatestAchievement } from "../steam/achievements";
import {
  type ArtFit,
  type ArtStyle,
  LABEL_LINE_LENGTH,
  renderAchievementKey,
  renderCaption,
  renderEmptyKey,
  renderKeyImage,
  type StatusBadge,
} from "../steam/artwork";
import { launchGame, openSteamUrl } from "../steam/launch";
import { getDownloadFraction, type SortOrder } from "../steam/library";
import { addClockListener, addStatusListener, removeClockListener, removeStatusListener } from "../steam/monitor";
import { getCurrentSession, getRunningGame } from "../steam/running";
import { getAppStates, peekAppStates } from "../steam/status";
import { lookupStoreApp } from "../steam/store";
import {
  badgeFor,
  collectionPickerItems,
  formatElapsed,
  type GamePagePage,
  librarySlots,
  type LibrarySlot,
  profileFor,
  steamPageUrl,
  wrapTitle,
} from "./common";
import { currentPage, notify as notifyPageListeners, resetPage, setPageProvider } from "./paging";
import { textStyleOf, type TextStyle } from "./text-style";

/** How long a key takes over to show a just-unlocked achievement before returning to its own art. */
const FLASH_MS = 5_000;

/**
 * What a key does:
 * - `auto`: shows a game, taking the next free slot in grid order, left to right, top to bottom.
 * - `fixed`: shows a game, in the slot typed into {@link SlotSettings.index}.
 * - `entry`: shows no game; pressing it opens the bundled Steam Hub profile.
 *
 * Absent on keys set up before this setting existed, which keep their old meaning: a key with a
 * number is `fixed`, a key without one is `entry`. A key just dragged onto the device has no
 * settings either, so it starts as `entry` too, which keeps every existing entry key working.
 */
type SlotMode = "auto" | "fixed" | "entry";

/**
 * Per-key settings for {@link ShowInstalled}: what the key does, the slot it stands for, and which
 * list it is a slot in.
 */
type SlotSettings = {
  /** What the key does; see {@link SlotMode}. */
  mode?: SlotMode;

  /**
   * 1-based slot within a page, for a `fixed` key. Stored as typed, because the property
   * inspector's text field hands back a string.
   */
  index?: string | number;

  /**
   * Id of the Steam collection this key numbers into; empty or absent for the whole library.
   *
   * Per key rather than shared, unlike the look below, because this is exactly what is meant to
   * differ between profiles: one page of favourites, another of co-op games, each its own 1, 2, 3…
   * The property inspector can copy it onto every other key of the page in one go.
   */
  collection?: string;
};

/** Messages the property inspector sends this action. */
type InspectorMessage =
  { event: "getCollections"; isRefresh?: boolean } | { event: "applyCollection" } | { event: "getSlotInfo" };

/**
 * Where a key showing a game sits on its device, kept for every such key on screen so slots and page
 * sizes can be worked out without reading every key's settings again.
 */
type LayoutEntry = {
  deviceId: string;
  mode: "auto" | "fixed";

  /** The typed slot, for a `fixed` key. */
  fixed?: number;

  /** Grid position, for ordering `auto` keys; `Infinity` when the key has none (a multi-action). */
  row: number;
  column: number;

  collection: string;
};

/**
 * Settings shared by every key of this action, held in the plugin's global settings.
 *
 * A profile of these keys is one list split across a device, so the look and the ordering have to
 * agree across all of them. Making them global means the user sets them once on any key rather
 * than repeating themselves thirty-two times.
 */
type SharedSettings = {
  sortOrder?: SortOrder;
  artStyle?: ArtStyle;
  artFit?: ArtFit;
  showTitle?: boolean;
  showStatus?: boolean;

  /** Whether the key currently running a game also shows how long it has been open. */
  showPlayTime?: boolean;

  /**
   * Whether the play time, download percentage and game name are drawn into the key image or
   * written as the Stream Deck title; see {@link TextStyle}. Only these keys offer the choice, every other key draws its text. Drawn unless
   * set to `title`.
   */
  textStyle?: TextStyle;

  /**
   * Whether a game downloading for the first time gets a temporary slot at the front of the list,
   * filling with the amber "updating" ring as it goes. Shifts every other slot down by one for as
   * long as it is there; turning this off keeps slot numbers stable instead. Defaults to on.
   */
  showInstalling?: boolean;

  /**
   * Whether a key pointed at a collection also lists that collection's games that are not installed,
   * in black and white after every installed one, and opens Steam's install dialog when pressed. Off by
   * default: a large collection would otherwise fill a page with games that cannot be played yet.
   */
  showMissing?: boolean;

  /** Absolute path to an image shown on positions with no game behind them. */
  emptyImage?: string;

  /**
   * What holding a key down opens instead of launching. `"none"` (the default) leaves every key
   * launching on a tap, exactly as before this setting existed.
   */
  longPress?: GamePagePage | "none";
};

/** A key position: plain digits, up to a library far larger than any device could show. */
const POSITION = /^\d{1,4}$/;

/** How long a key must stay down before it counts as a hold rather than a tap. */
const LONG_PRESS_MS = 500;

const DEFAULT_SHARED: Required<Pick<SharedSettings, "sortOrder" | "artStyle" | "artFit">> = {
  sortOrder: "name",
  artStyle: "logo",
  artFit: "fill",
};

/**
 * A key that shows whichever installed game sits at a given position in the library, so a whole
 * profile can be filled in by numbering its keys 1, 2, 3, … and letting the plugin populate them.
 */
@action({ UUID: "com.unai-gonzalez.steam-hub.slot" })
export class ShowInstalled extends SingletonAction<SlotSettings> {
  /** Bound so the same reference can be added to and removed from the shared poll. */
  readonly #onPoll = (): Promise<void> => this.#redrawAll();

  /** Bound for the same reason, for the once-a-second clock. */
  readonly #onClock = (): Promise<void> => this.#tickAll();

  /** Whether {@link ShowInstalled.#onPoll} and {@link ShowInstalled.#onClock} are currently registered. */
  #listening = false;

  /** What each key currently shows, so a poll only repaints what actually changed. */
  readonly #drawn = new Map<string, string>();

  /**
   * Writes held back while a whole device is being repainted, so its keys change together once every
   * image is ready instead of one by one as each render finishes. See {@link ShowInstalled.#redrawDevice}.
   */
  readonly #batches = new Map<string, (() => Promise<void>)[]>();

  /** Every key on screen that shows a game, kept in step by {@link ShowInstalled.#track}. */
  readonly #layout = new Map<string, LayoutEntry>();

  /**
   * Pending repaints of a whole device, scheduled when its layout changes: a key showing a game came
   * or went, or changed slot. Automatic keys renumber when that happens, and a page of keys appearing
   * one after another is coalesced into a single pass.
   */
  readonly #layoutTimers = new Map<string, NodeJS.Timeout>();

  /**
   * Keys currently showing their game's play time, with what goes above the clock, so the clock
   * can tick every second without redrawing the art or reading anything. `art` is set when the clock
   * is drawn into the image rather than written as the title: the key's art without the clock, to
   * draw each new reading onto.
   */
  readonly #clocks = new Map<
    string,
    {
      target: KeyAction<SlotSettings>;
      appId: string;
      nameTitle: string;
      art?: ClockArt;
    }
  >();

  /** Keys currently showing a download ring, so the clock can keep it filling between polls. */
  readonly #downloads = new Map<string, KeyAction<SlotSettings>>();

  /**
   * Timers for keys currently held down, waiting to see whether the press turns into a hold. Only
   * populated while {@link SharedSettings.longPress} asks for one; a plain tap never creates one.
   */
  readonly #pressTimers = new Map<string, NodeJS.Timeout>();

  /**
   * Timers for keys currently taken over to show a just-unlocked achievement. A key's presence here,
   * not just its signature, is what {@link ShowInstalled.#draw} checks to skip repainting it with its
   * normal art while the takeover is still showing.
   */
  readonly #flashTimers = new Map<string, NodeJS.Timeout>();

  /**
   * Initialises the action, and starts watching the settings its keys share.
   */
  constructor() {
    super();

    streamDeck.settings.onDidReceiveGlobalSettings<SharedSettings>((ev) => {
      // This also fires for our own reads; repainting on those would loop forever.
      if (JSON.stringify(ev.settings) === JSON.stringify(shared)) {
        return;
      }

      // Another order, or a list that gains or loses whole groups of entries, makes the old page
      // number meaningless, so every device goes back to its first page.
      const before = shared;
      if (
        before?.sortOrder !== ev.settings.sortOrder ||
        before?.showInstalling !== ev.settings.showInstalling ||
        before?.showMissing !== ev.settings.showMissing
      ) {
        resetPage();
      }

      shared = ev.settings;
      void this.#redrawAll();
    });

    setPageProvider({
      pageCount: (deviceId) => this.#pageCount(deviceId),
      redraw: (deviceId) => this.#redrawDevice(deviceId),
    });
  }

  /**
   * Draws the key when it comes into view.
   * @param ev Event arguments.
   */
  override async onWillAppear(ev: WillAppearEvent<SlotSettings>): Promise<void> {
    if (!this.#listening) {
      this.#listening = true;
      addStatusListener(this.#onPoll);
      addClockListener(this.#onClock);
    }

    // Tracked before drawing, so keys appearing together already see each other when numbering.
    if (ev.action.isKey()) {
      this.#track(ev.action, ev.payload.settings);
    }

    await this.#draw(ev.action, ev.payload.settings);
  }

  /**
   * Stops polling once the last key of this action leaves the screen.
   * @param ev Event arguments.
   */
  override onWillDisappear(ev: WillDisappearEvent<SlotSettings>): void {
    this.#drawn.delete(ev.action.id);

    this.#untrack(ev.action.id, ev.action.device.id);

    this.#clocks.delete(ev.action.id);
    this.#downloads.delete(ev.action.id);
    this.#cancelPress(ev.action.id);
    this.#cancelFlash(ev.action.id);

    // `actions` still includes the departing key at this point, hence the count of one.
    if (this.#listening && [...this.actions].length <= 1) {
      this.#listening = false;
      removeStatusListener(this.#onPoll);
      removeClockListener(this.#onClock);
    }
  }

  /**
   * Redraws the key when its index changes.
   * @param ev Event arguments.
   */
  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<SlotSettings>): Promise<void> {
    const before = this.#layout.get(ev.action.id);
    if (ev.action.isKey()) {
      this.#track(ev.action, ev.payload.settings);
    }

    if (before !== undefined && before.collection !== (ev.payload.settings.collection ?? "")) {
      // A different collection is a different list; its page 1 is the only page sure to exist.
      resetPage(ev.action.device.id);
      await this.#draw(ev.action, ev.payload.settings);
      await this.#redrawDevice(ev.action.device.id);
      return;
    }

    await this.#draw(ev.action, ev.payload.settings);
  }

  /**
   * Launches whichever game this key is showing, or, when {@link SharedSettings.longPress} is
   * configured, waits to see whether the press turns into a hold before deciding which.
   * @param ev Event arguments.
   */
  override async onKeyDown(ev: KeyDownEvent<SlotSettings>): Promise<void> {
    // The entry key is the way into the library: it jumps to the profile that holds the game
    // keys, so one key on the main profile opens the whole list. It never has a game behind it,
    // so a hold makes no sense here regardless of the shared setting.
    const role = roleOf(ev.payload.settings);
    if (role === "unset") {
      await ev.action.showAlert(); // set to a fixed slot without one typed in yet
      return;
    }

    if (role === "entry") {
      const profile = profileFor(ev.action.device.type);

      try {
        streamDeck.logger.info(`Switching to the ${profile} profile`);
        await streamDeck.profiles.switchToProfile(ev.action.device.id, profile);
      } catch (err) {
        streamDeck.logger.error(`Could not switch to the ${profile} profile`, err);
        await ev.action.showAlert();
      }

      return;
    }

    const longPress = (await getShared()).longPress ?? "none";
    if (longPress === "none") {
      await this.#launch(ev.action, ev.payload.settings);
      return;
    }

    // Deferred rather than acted on immediately: only a release before the timer fires is a tap.
    const timer = setTimeout(() => {
      this.#pressTimers.delete(ev.action.id);
      void this.#openPage(ev.action, ev.payload.settings, longPress);
    }, LONG_PRESS_MS);

    this.#pressTimers.set(ev.action.id, timer);
  }

  /**
   * Resolves a press that let go before turning into a hold. A release with nothing pending means
   * either a hold already fired, or {@link SharedSettings.longPress} is off, in which case
   * {@link ShowInstalled.onKeyDown} already launched the game and there is nothing left to do.
   * @param ev Event arguments.
   */
  override async onKeyUp(ev: KeyUpEvent<SlotSettings>): Promise<void> {
    if (!this.#cancelPress(ev.action.id)) {
      return;
    }

    await this.#launch(ev.action, ev.payload.settings);
  }

  /**
   * Serves the property inspector: the collection picker, and the button that copies a key's
   * collection onto every other numbered key on the same device.
   * @param ev Event arguments.
   */
  override async onSendToPlugin(ev: SendToPluginEvent<InspectorMessage, SlotSettings>): Promise<void> {
    switch (ev.payload?.event) {
      case "getCollections":
        await streamDeck.ui.sendToPropertyInspector({
          event: "getCollections",
          items: await collectionPickerItems(ev.payload.isRefresh === true),
        });
        return;

      case "applyCollection":
        resetPage(ev.action.device.id);
        await streamDeck.ui.sendToPropertyInspector({
          event: "applyResult",
          text: await this.#applyToPage(ev.action.device.id, ev.action.id, await ev.action.getSettings()),
        });
        return;

      case "getSlotInfo":
        await streamDeck.ui.sendToPropertyInspector({
          event: "slotInfo",
          ...(ev.action.isKey() ? this.#slotInfo(ev.action, await ev.action.getSettings()) : {}),
        });
        return;

      default:
        streamDeck.logger.debug(
          `Ignoring unknown message from the property inspector: ${(ev.payload as { event?: string } | undefined)?.event}`,
        );
    }
  }

  /**
   * Copies a key's setup onto every other key of this action showing on the same device: always its
   * collection, and, from an automatic key, the automatic mode too, which is what turns a page of
   * freshly dragged keys into a working page in one click. Keys explicitly set to open the Steam Hub
   * profile are left alone. Only keys currently on screen are reachable, which is exactly the page
   * the user is setting up.
   * @param deviceId Device whose keys to update.
   * @param sourceId Key the property inspector is open for, left out of the counts, so they describe
   * what the button did to the rest of the page.
   * @param source That key's settings.
   * @returns A one-line summary for the property inspector.
   */
  async #applyToPage(deviceId: string, sourceId: string, source: SlotSettings): Promise<string> {
    const collection = source.collection ?? "";
    const makeAuto = roleOf(source) === "auto";
    let changed = 0;
    let already = 0;

    await Promise.all(
      [...this.actions].map(async (target) => {
        if (!target.isKey() || target.device.id !== deviceId || target.id === sourceId) {
          return;
        }

        const settings = await target.getSettings();
        const role = roleOf(settings);

        // An automatic source also adopts keys that show no game yet, new ones above all, but never
        // one deliberately set to open the profile. Otherwise only keys showing a game are touched.
        const adopts = makeAuto && settings.mode !== "entry" && role !== "auto" && role !== "fixed";
        if (!adopts && role !== "auto" && role !== "fixed") {
          return;
        }

        const next: SlotSettings = {
          ...settings,
          collection,
          ...(adopts ? { mode: "auto" as const } : {}),
        };
        if (!adopts && (settings.collection ?? "") === collection) {
          already++;
          return;
        }

        await target.setSettings(next);
        this.#track(target, next); // a plugin-side write raises no settings event to track it on
        await this.#draw(target, next);
        changed++;
      }),
    );

    streamDeck.logger.info(`Applied collection "${collection || "whole library"}" to ${changed} key(s)`);

    if (changed === 0) {
      return already === 0 ? "No other game keys on this page." : "Every key on this page already uses it.";
    }

    const keys = `${changed} more key${changed === 1 ? "" : "s"}`;
    return already === 0 ? `Applied to ${keys}.` : `Applied to ${keys}, ${already} already had it.`;
  }

  /**
   * Launches whichever game a key stands for, or opens Steam's downloads page while it is still
   * downloading. Used for a plain tap, and for a release that never grew into a hold.
   * @param target Key that was pressed.
   * @param settings The key's settings.
   */
  async #launch(target: KeyAction<SlotSettings>, settings: SlotSettings): Promise<void> {
    const slot = await this.#slotFor(target, settings);

    if (slot === undefined) {
      return; // a numbered slot with no game is not a broken key, so it stays silent
    }

    // Still downloading, whether a first install or an update: nothing to launch yet, so the press
    // shows where the download stands instead, in Steam's downloads page.
    if (slot.installing || (await getAppStates()).get(slot.appId)?.updating === true) {
      try {
        streamDeck.logger.info(`${slot.name} is still downloading; opening Steam's downloads page`);
        await openSteamUrl("steam://open/downloads");
        await target.showOk();
      } catch (err) {
        streamDeck.logger.error("Could not open Steam's downloads page", err);
        await target.showAlert();
      }
      return;
    }

    if (slot.missing === true) {
      // Steam's own dialog, where the user picks a library and confirms; nothing starts on its own.
      try {
        await openSteamUrl(`steam://install/${slot.appId}`);
        await target.showOk();
      } catch (err) {
        streamDeck.logger.error(`Could not open the install dialog for app ${slot.appId}`, err);
        await target.showAlert();
      }
      return;
    }

    try {
      streamDeck.logger.info(`Launching ${slot.name} from key ${target.id}`);
      await launchGame(slot.appId);
      await target.showOk();
    } catch (err) {
      streamDeck.logger.error(`Could not launch ${slot.name}`, err);
      await target.showAlert();
    }
  }

  /**
   * Opens the configured page for whichever game a key stands for, the hold counterpart to
   * {@link ShowInstalled.#launch}.
   * @param target Key that was held.
   * @param settings The key's settings.
   * @param page Page to open.
   */
  async #openPage(target: KeyAction<SlotSettings>, settings: SlotSettings, page: GamePagePage): Promise<void> {
    const slot = await this.#slotFor(target, settings);

    if (slot === undefined) {
      return; // a numbered slot with no game is not a broken key, so it stays silent
    }

    if (slot.installing || (slot.missing === true && page === "uninstall")) {
      await target.showAlert(); // still downloading, or nothing on disk to uninstall
      return;
    }

    try {
      await openSteamUrl(steamPageUrl(page, slot.appId));
      await target.showOk();
    } catch (err) {
      streamDeck.logger.error(`Could not open the ${page} page for ${slot.name}`, err);
      await target.showAlert();
    }
  }

  /**
   * Cancels a key's pending hold timer, if it has one.
   * @param actionId Id of the key, i.e. {@link KeyAction.id}.
   * @returns Whether a timer was actually pending. `false` means either the hold already fired, or
   * {@link SharedSettings.longPress} is off and no timer was ever created for this press.
   */
  #cancelPress(actionId: string): boolean {
    const timer = this.#pressTimers.get(actionId);
    if (timer === undefined) {
      return false;
    }

    clearTimeout(timer);
    this.#pressTimers.delete(actionId);
    return true;
  }

  /**
   * Repaints every visible key of this action. Called on each status poll, and whenever the
   * shared settings change.
   */
  async #redrawAll(): Promise<void> {
    await this.#checkForUnlock();

    await Promise.all(
      [...this.actions].map(async (target) => {
        if (target.isKey()) {
          await this.#draw(target, await target.getSettings());
        }
      }),
    );
  }

  /**
   * Repaints every key on one device at once, after its page moved or its layout changed.
   *
   * Every key's image is prepared first, and only then are they all sent together: renders finish at
   * very different times, a cached image instantly, a download or a decode much later, so writing
   * each as it came made the page change in a ragged, random-looking wave. Afterwards the pages either
   * side are rendered ahead, so the next turn has its images ready.
   * @param deviceId Device to repaint.
   */
  async #redrawDevice(deviceId: string): Promise<void> {
    const batch: (() => Promise<void>)[] = [];
    this.#batches.set(deviceId, batch);

    try {
      await Promise.all(
        [...this.actions].map(async (target) => {
          if (target.isKey() && target.device.id === deviceId) {
            await this.#draw(target, await target.getSettings());
          }
        }),
      );
    } finally {
      if (this.#batches.get(deviceId) === batch) {
        this.#batches.delete(deviceId);
      }
    }

    await Promise.all(batch.map((write) => write()));

    void this.#prefetch(deviceId).catch((err) => streamDeck.logger.debug(`Could not prefetch pages for ${deviceId}`, err));
  }

  /**
   * Renders the pages either side of the one a device is on, so turning to them only has to send
   * images that are already made. Runs one render at a time in the background: nothing waits on it,
   * and it should never compete with what is actually on screen.
   *
   * Drawn as plain idle art, which is what nearly every key on a page shows; the odd running or
   * updating game simply renders when its page comes up.
   * @param deviceId Device to prefetch for.
   */
  async #prefetch(deviceId: string): Promise<void> {
    const size = this.#pageSize(deviceId);
    const count = await this.#pageCount(deviceId);
    if (size === undefined || count === undefined || count < 2) {
      return;
    }

    const shared = await getShared();
    const style = shared.artStyle ?? DEFAULT_SHARED.artStyle;
    const fit = shared.artFit ?? DEFAULT_SHARED.artFit;
    if (style === "none") {
      return; // nothing to render
    }

    const page = currentPage(deviceId, count);
    const pages = [...new Set([(page + 1) % count, (page - 1 + count) % count])].filter((p) => p !== page);

    for (const [id, slot] of this.#slots(deviceId)) {
      const list = await this.#listFor(this.#layout.get(id)?.collection);

      for (const p of pages) {
        const entry = list[p * size + slot - 1];
        if (entry === undefined || entry.installing) {
          continue; // a download ring changes every second, there is nothing to render ahead
        }

        await renderKeyImage(entry.appId, style, fit, entry.missing === true ? "missing" : "idle");
      }
    }
  }

  /**
   * Records where a key sits and what it does, and schedules a repaint of its device when that
   * changes the layout. Cheap enough to call on every draw.
   * @param target Key to record.
   * @param settings Its settings.
   */
  #track(target: KeyAction<SlotSettings>, settings: SlotSettings): void {
    const deviceId = target.device.id;
    const before = this.#layoutSignature(deviceId);
    const role = roleOf(settings);

    if (role === "auto" || role === "fixed") {
      this.#layout.set(target.id, {
        deviceId,
        mode: role,
        fixed: role === "fixed" ? parseIndex(settings) : undefined,
        row: target.coordinates?.row ?? Infinity,
        column: target.coordinates?.column ?? Infinity,
        collection: settings.collection ?? "",
      });
    } else {
      this.#layout.delete(target.id);
    }

    this.#onLayoutChange(deviceId, before);
  }

  /**
   * Forgets a key that left the screen.
   * @param actionId Id of the key.
   * @param deviceId Its device.
   */
  #untrack(actionId: string, deviceId: string): void {
    const before = this.#layoutSignature(deviceId);
    this.#layout.delete(actionId);
    this.#onLayoutChange(deviceId, before);
  }

  /**
   * Repaints a device once its layout settles, when it changed. Automatic keys renumber whenever a
   * game key comes or goes, and the page size moves with the highest slot, so every key on the device
   * may need to show something else; a burst of changes, a page of keys appearing, is one repaint.
   * @param deviceId Device whose layout may have changed.
   * @param before Its {@link ShowInstalled.#layoutSignature} before the change.
   */
  #onLayoutChange(deviceId: string, before: string): void {
    if (this.#layoutSignature(deviceId) === before) {
      return;
    }

    notifyPageListeners(); // a page key's "3 / 20" depends on the page size too

    // Nothing left on screen, a profile switch away: nothing to repaint.
    if (this.#pageSize(deviceId) === undefined || this.#layoutTimers.has(deviceId)) {
      return;
    }

    this.#layoutTimers.set(
      deviceId,
      setTimeout(() => {
        this.#layoutTimers.delete(deviceId);
        void this.#redrawDevice(deviceId).catch((err) =>
          streamDeck.logger.error(`Could not repaint ${deviceId} after its layout changed`, err),
        );
      }, 100),
    );
  }

  /**
   * Works out the slot of every game key on a device. Fixed keys take the slot typed into them;
   * automatic keys fill the slots left free, in grid order, left to right, top to bottom.
   * @param deviceId Device to number.
   * @returns Slot by action id.
   */
  #slots(deviceId: string): Map<string, number> {
    const result = new Map<string, number>();
    const taken = new Set<number>();
    const auto: [string, LayoutEntry][] = [];

    for (const [id, entry] of this.#layout) {
      if (entry.deviceId !== deviceId) {
        continue;
      }

      if (entry.mode === "fixed" && entry.fixed !== undefined) {
        result.set(id, entry.fixed);
        taken.add(entry.fixed);
      } else {
        auto.push([id, entry]);
      }
    }

    auto.sort(([a, x], [b, y]) => x.row - y.row || x.column - y.column || a.localeCompare(b));

    let next = 1;
    for (const [id] of auto) {
      while (taken.has(next)) {
        next++;
      }
      result.set(id, next);
      taken.add(next);
    }

    return result;
  }

  /**
   * A string that changes whenever any game key on a device changes slot or collection.
   * @param deviceId Device to describe.
   * @returns The signature.
   */
  #layoutSignature(deviceId: string): string {
    return [...this.#slots(deviceId)]
      .map(([id, slot]) => `${id}=${slot}:${this.#layout.get(id)?.collection ?? ""}`)
      .sort()
      .join(",");
  }

  /**
   * How many keys make up one page on a device: its highest slot, so a page of 13 game keys pages by
   * 13 whatever the device, and a gap in fixed numbering does not shrink the page.
   * @param deviceId Device to measure.
   * @returns The page size, or `undefined` when the device has no game key on screen.
   */
  #pageSize(deviceId: string): number | undefined {
    const slots = [...this.#slots(deviceId).values()];
    return slots.length === 0 ? undefined : Math.max(...slots);
  }

  /**
   * Describes a key's slot for its property inspector.
   * @param target Key to describe.
   * @param settings Its settings.
   * @returns What the key does, and for a game key its slot and the page size.
   */
  #slotInfo(
    target: KeyAction<SlotSettings>,
    settings: SlotSettings,
  ): { role: ReturnType<typeof roleOf>; slot?: number; size?: number } {
    this.#track(target, settings);

    return {
      role: roleOf(settings),
      slot: this.#slots(target.device.id).get(target.id),
      size: this.#pageSize(target.device.id),
    };
  }

  /**
   * How many pages a device's list spans. The list is the one its lowest-numbered key shows, since
   * a page normally holds a single collection; keys pointed at another one still page in step.
   * @param deviceId Device to measure.
   * @returns The page count, at least one, or `undefined` when there is nothing to page through.
   */
  async #pageCount(deviceId: string): Promise<number | undefined> {
    const size = this.#pageSize(deviceId);
    if (size === undefined) {
      return undefined;
    }

    // The key in slot 1, or failing that the lowest slot there is.
    let first: { slot: number; collection: string } | undefined;
    for (const [id, slot] of this.#slots(deviceId)) {
      if (first === undefined || slot < first.slot) {
        first = { slot, collection: this.#layout.get(id)?.collection ?? "" };
      }
    }

    const slots = await this.#listFor(first?.collection);
    return Math.max(1, Math.ceil(slots.length / size));
  }

  /**
   * The list a key numbers into, built from the shared settings and the key's collection.
   * @param collection Collection id, or empty / `undefined` for the whole library.
   * @returns The slots.
   */
  async #listFor(collection: string | undefined): Promise<LibrarySlot[]> {
    const shared = await getShared();

    return librarySlots(
      shared.sortOrder ?? DEFAULT_SHARED.sortOrder,
      shared.showInstalling !== false,
      collection,
      shared.showMissing === true,
    );
  }

  /**
   * Advances the play-time line on every key showing one, between polls. Only the title changes,
   * from the session the last poll found, so nothing is read and no art is redrawn.
   */
  async #tickAll(): Promise<void> {
    // Download rings follow the manifests on disk, which Steam rewrites as bytes arrive; those are
    // cheap to re-read, unlike the registry, so the ring fills every second rather than every poll.
    await Promise.all(
      [...this.#downloads.values()].map(async (target) => this.#draw(target, await target.getSettings(), false)),
    );

    const session = getCurrentSession();
    if (session === undefined) {
      return;
    }

    const elapsed = formatElapsed(Date.now() - session.since);

    await Promise.all(
      [...this.#clocks.values()].map(async ({ target, appId, nameTitle, art }) => {
        if (appId !== session.appId || this.#flashTimers.has(target.id)) {
          return;
        }

        if (art === undefined) {
          await target.setTitle(withElapsed(nameTitle, elapsed));
        } else {
          await target.setImage(clockImage(art, elapsed));
        }
      }),
    );
  }

  /**
   * Checks whether the running game just unlocked a new achievement and, when a visible key happens
   * to be showing that game right now, takes it over to announce it.
   *
   * Only the running game is ever checked, the same game {@link NowPlaying} and co. follow, since
   * checking every installed game on every poll would mean reading two files per game, a whole
   * library's worth, four times a minute for no benefit: a game that is not running cannot have just
   * unlocked anything.
   */
  async #checkForUnlock(): Promise<void> {
    const running = await getRunningGame();
    if (running === undefined) {
      return;
    }

    const achievement = await checkForNewAchievement(running.game.appId);
    if (achievement === undefined) {
      return;
    }

    for (const target of this.actions) {
      if (!target.isKey()) {
        continue;
      }

      const slot = await this.#slotFor(target, await target.getSettings());
      if (slot?.appId === running.game.appId) {
        await this.#startFlash(target, running.game.appId, achievement);
      }
    }
  }

  /**
   * Takes a key over for {@link FLASH_MS}, showing the achievement that was just unlocked in place
   * of whatever game it normally displays, then restores the normal art on its own.
   * @param target Key to take over.
   * @param appId Steam application id the achievement belongs to.
   * @param achievement Achievement to show.
   */
  async #startFlash(target: KeyAction<SlotSettings>, appId: string, achievement: LatestAchievement): Promise<void> {
    this.#cancelFlash(target.id);

    const image = await renderAchievementKey(appId, achievement.icon);

    // The achievement's name follows the same text style as the rest of the key.
    if (textStyleOf(await getShared()) === "drawn" && image !== undefined) {
      await target.setImage(renderCaption(image, { label: drawnName(achievement.name) }));
      await target.setTitle("");
    } else {
      await target.setImage(image);
      await target.setTitle(wrapTitle(achievement.name));
    }
    this.#drawn.set(target.id, `flash:${appId}:${achievement.icon}`);

    this.#flashTimers.set(
      target.id,
      setTimeout(() => {
        this.#flashTimers.delete(target.id);
        this.#drawn.delete(target.id); // forces #draw to actually repaint once it stops skipping this key

        void target
          .getSettings()
          .then((settings) => this.#draw(target, settings))
          .catch((err) => streamDeck.logger.error(`Could not restore ${target.id} after an achievement flash`, err));
      }, FLASH_MS),
    );
  }

  /**
   * Cancels a key's pending flash timer, if it has one. Used both when a new flash pre-empts an
   * older one still showing, and when the key leaves the screen mid-flash.
   * @param actionId Id of the key, i.e. {@link KeyAction.id}.
   */
  #cancelFlash(actionId: string): void {
    const timer = this.#flashTimers.get(actionId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.#flashTimers.delete(actionId);
    }
  }

  /**
   * Resolves the slot a key stands for: a launchable game, a first install still downloading, or
   * nothing at all. On any page past the first, the position is shifted by whole pages, so key 1
   * on page 3 of a 13-key page shows entry 27.
   * @param target Key asking, for the device whose page applies.
   * @param settings The key's settings.
   * @returns The slot at that index, or `undefined` when the position is unset or past the end.
   */
  async #slotFor(target: KeyAction<SlotSettings>, settings: SlotSettings): Promise<LibrarySlot | undefined> {
    this.#track(target, settings);
    const index = this.#slots(target.device.id).get(target.id);
    if (index === undefined) {
      return undefined;
    }

    const slots = await this.#listFor(settings.collection);
    const size = this.#pageSize(target.device.id) ?? index;
    const page = currentPage(target.device.id, Math.max(1, Math.ceil(slots.length / size)));

    return slots[page * size + index - 1]; // 1-based, so the numbers on the keys read the way people count
  }

  /**
   * Paints a key: the game at its index, or nothing at all.
   * @param target Key to draw on.
   * @param settings The key's settings.
   * @param live Whether to read the registry afresh; a clock tick reuses the last poll's reading.
   */
  async #draw(
    target: DialAction<SlotSettings> | KeyAction<SlotSettings>,
    settings: SlotSettings,
    live = true,
  ): Promise<void> {
    if (!target.isKey()) {
      return; // the manifest only offers this action on keypads
    }

    if (this.#flashTimers.has(target.id)) {
      return; // a just-unlocked achievement is taking this key over; its own timer restores the normal art
    }

    // Put back below, if this key still has a clock or a download ring to show.
    this.#clocks.delete(target.id);
    this.#downloads.delete(target.id);

    // The entry key, or a fixed key with no slot typed in yet: leave the action's own icon showing,
    // so it reads as "the way in" or "configure me" rather than as a slot that happens to be empty.
    this.#track(target, settings);
    const role = roleOf(settings);
    if (role !== "auto" && role !== "fixed") {
      await this.#paint(target, "unset", undefined, "");
      return;
    }

    const shared = await getShared();
    const slot = await this.#slotFor(target, settings);

    if (slot === undefined) {
      // A real position with nothing behind it, that is what the empty plate is for.
      await this.#paint(target, `empty:${shared.emptyImage ?? ""}`, await renderEmptyKey(shared.emptyImage), "");
      return;
    }

    if (slot.installing) {
      this.#downloads.set(target.id, target);
      await this.#drawInstalling(target, slot, shared);
      return;
    }

    if (slot.missing === true) {
      await this.#drawMissing(target, slot, shared);
      return;
    }

    const states = live ? await getAppStates() : (peekAppStates() ?? (await getAppStates()));
    const state = states.get(slot.appId);
    const badge: StatusBadge = badgeFor(shared.showStatus !== false, state);
    const style = shared.artStyle ?? DEFAULT_SHARED.artStyle;

    // Only worth the extra file read when there is actually a ring to fill in.
    const fraction = badge === "updating" ? await getDownloadFraction(slot.appId) : undefined;

    const image =
      style === "none"
        ? await renderEmptyKey(shared.emptyImage)
        : await renderKeyImage(slot.appId, style, shared.artFit ?? DEFAULT_SHARED.artFit, badge, fraction);

    // Fetching who is running is a bit of extra work, so it only happens for a key whose own game
    // is actually running and only when the setting asks for it, never for the other thirty-one.
    const elapsed = shared.showPlayTime === true && state?.running === true ? await elapsedSince(slot.appId) : undefined;

    const drawn = textStyleOf(shared) === "drawn";
    const wantsName = shared.showTitle === true || style === "none";
    const percent = fraction === undefined ? "-" : Math.round(fraction * 100);
    const base = image ?? (await renderEmptyKey(shared.emptyImage));

    // Drawn, the name goes into the image along with the clock, and the key carries no title at all.
    const nameTitle = wantsName && !drawn ? wrapTitle(slot.name, elapsed ? 2 : 3) : "";
    const art: ClockArt | undefined = drawn
      ? { base, label: wantsName ? drawnName(slot.name) : [], framed: badge === "running" || badge === "updating" }
      : undefined;
    const title = elapsed === undefined || drawn ? nameTitle : withElapsed(nameTitle, elapsed);

    if (elapsed !== undefined) {
      this.#clocks.set(target.id, {
        target,
        appId: slot.appId,
        nameTitle,
        art,
      });
    }

    if (badge === "updating") {
      this.#downloads.set(target.id, target);
    }

    // The clock itself stays out of the signature: #tickAll keeps it current every second, and
    // leaving it in would push the whole image again on every poll just because the time moved.
    await this.#paint(
      target,
      `${slot.appId}:${style}:${badge}:${percent}:${nameTitle}:${elapsed !== undefined}:${drawn}:${art?.label.join("|") ?? ""}`,
      art === undefined ? base : clockImage(art, elapsed),
      title,
    );
  }

  /**
   * Paints a key for a game whose first install is still in progress: the same amber ring the
   * "updating" badge draws, filled to its actual download fraction instead of solid, since there is
   * no launchable game behind the slot yet.
   * @param target Key to draw on.
   * @param slot The installing entry.
   * @param shared Shared settings, already read by the caller.
   */
  async #drawInstalling(target: KeyAction<SlotSettings>, slot: LibrarySlot, shared: SharedSettings): Promise<void> {
    const percent = slot.fraction === undefined ? undefined : Math.round(slot.fraction * 100);
    const drawn = textStyleOf(shared) === "drawn";
    const signature = `installing:${slot.appId}:${percent}:${drawn}`;

    if (this.#drawn.get(target.id) === signature) {
      return;
    }

    const style = shared.artStyle ?? DEFAULT_SHARED.artStyle;
    const image =
      style === "none"
        ? await renderEmptyKey(shared.emptyImage)
        : ((await renderKeyImage(slot.appId, style, shared.artFit ?? DEFAULT_SHARED.artFit, "updating", slot.fraction)) ??
          (await renderEmptyKey(shared.emptyImage)));

    if (drawn) {
      // The name along the bottom, the percentage above it at the top.
      const reading = percent === undefined ? {} : { main: String(percent), suffix: "%" };
      await this.#paint(
        target,
        signature,
        renderCaption(image, { ...reading, label: drawnName(slot.name), framed: true }),
        "",
      );
      return;
    }

    const nameTitle = wrapTitle(slot.name, 2);
    const title = percent === undefined ? nameTitle : `${nameTitle}\n${percent}%`;

    await this.#paint(target, signature, image, title);
  }

  /**
   * Paints a key for a game from the key's collection that is not installed: the same art as any
   * other game, in black and white, since a press opens Steam's install dialog rather than launching.
   * @param target Key to draw on.
   * @param slot The not-installed entry.
   * @param shared Shared settings, already read by the caller.
   */
  async #drawMissing(target: KeyAction<SlotSettings>, slot: LibrarySlot, shared: SharedSettings): Promise<void> {
    const style = shared.artStyle ?? DEFAULT_SHARED.artStyle;
    const wantsTitle = shared.showTitle === true || style === "none";

    // Nothing local knows a game that was never installed here, so its name comes from the store,
    // and only when the key is actually going to write it: the art carries the logo regardless.
    const name = wantsTitle ? ((await lookupStoreApp(slot.appId))?.name ?? slot.name) : "";
    const drawn = textStyleOf(shared) === "drawn";
    const title = wantsTitle && !drawn ? wrapTitle(name) : "";
    const label = wantsTitle && drawn ? drawnName(name) : [];
    const signature = `missing:${slot.appId}:${style}:${shared.artFit ?? DEFAULT_SHARED.artFit}:${title}:${label.join("|")}`;

    if (this.#drawn.get(target.id) === signature) {
      return;
    }

    const image =
      style === "none"
        ? await renderEmptyKey(shared.emptyImage)
        : ((await renderKeyImage(slot.appId, style, shared.artFit ?? DEFAULT_SHARED.artFit, "missing")) ??
          (await renderEmptyKey(shared.emptyImage)));

    await this.#paint(target, signature, label.length > 0 ? renderCaption(image, { label }) : image, title);
  }

  /**
   * Writes to a key only when something about it actually changed, which keeps a poll over a full
   * profile from pushing thirty-two identical images every four seconds.
   * @param target Key to draw on.
   * @param signature Value identifying what is being drawn.
   * @param image Image to set; `undefined` restores the action's icon from the manifest.
   * @param title Title to set.
   */
  async #paint(target: KeyAction<SlotSettings>, signature: string, image: string | undefined, title: string): Promise<void> {
    if (this.#drawn.get(target.id) === signature) {
      return;
    }

    const write = async (): Promise<void> => {
      await Promise.all([target.setImage(image), target.setTitle(title)]);
      this.#drawn.set(target.id, signature);
    };

    // During a whole-device repaint, held back and sent with every other key's; see #redrawDevice.
    const batch = this.#batches.get(target.device.id);
    if (batch !== undefined) {
      batch.push(write);
      return;
    }

    await write();
  }
}

let shared: SharedSettings | undefined;

/**
 * Reads a key's position.
 *
 * Deliberately stricter than `parseInt`, which would read "1.5.2" as position 1. For a field this
 * simple, anything unparseable is a mistake, and the key says so by staying unconfigured rather
 * than silently pointing at the wrong game.
 * @param settings The key's settings.
 * @returns The 1-based position, or `undefined` when none is set.
 */
function parseIndex(settings: SlotSettings): number | undefined {
  const raw = String(settings.index ?? "").trim();
  if (!POSITION.test(raw)) {
    return undefined;
  }

  const index = Number.parseInt(raw, 10);
  return index >= 1 ? index : undefined;
}

/**
 * Resolves what a key does, reading keys set up before {@link SlotSettings.mode} existed the way they
 * always worked.
 * @param settings The key's settings.
 * @returns `auto` or `fixed` for a game key, `entry` for the way into the profile, or `unset` for a
 * key set to a fixed slot that has none typed in yet.
 */
function roleOf(settings: SlotSettings): SlotMode | "unset" {
  switch (settings.mode) {
    case "auto":
    case "entry":
      return settings.mode;
    case "fixed":
      return parseIndex(settings) === undefined ? "unset" : "fixed";
    default:
      return parseIndex(settings) === undefined ? "entry" : "fixed";
  }
}

/**
 * Reads the settings shared by every key of this action, cached after the first read and kept in
 * step by the subscription the action sets up.
 * @returns The shared settings.
 */
async function getShared(): Promise<SharedSettings> {
  return (shared ??= await streamDeck.settings.getGlobalSettings<SharedSettings>());
}

/** What a key drawing its play time into the image needs to draw each new reading. */
type ClockArt = {
  /** The key's art without the clock or the name. */
  base: string;

  /** The name drawn along the bottom, already wrapped, or none. */
  label: string[];

  /** Whether the key wears a status frame, which keeps the text further in from the edges. */
  framed: boolean;
};

/**
 * Draws a play time, and the name, if any, onto a key's art.
 * @param art The key's art and name.
 * @param elapsed The formatted play time, or `undefined` for a key with no clock running.
 * @returns A `data:` URI, or the bare art when there is nothing to draw.
 */
function clockImage(art: ClockArt, elapsed: string | undefined): string {
  if (elapsed === undefined && art.label.length === 0) {
    return art.base;
  }

  // "1:23:45" is too wide for the size a page number gets.
  const reading = elapsed === undefined ? {} : { main: elapsed, size: elapsed.length > 5 ? 24 : 28 };
  return renderCaption(art.base, { ...reading, label: art.label, framed: art.framed });
}

/**
 * Wraps a game name for drawing into the key image, which fits more per line than a title.
 * @param name The name.
 * @returns The lines.
 */
function drawnName(name: string): string[] {
  return wrapTitle(name, 2, LABEL_LINE_LENGTH).split("\n");
}

/**
 * Puts the play-time line under a key's name, or on its own when the key shows no name.
 * @param nameTitle The wrapped name, or `""`.
 * @param elapsed The formatted play time.
 * @returns The key's title.
 */
function withElapsed(nameTitle: string, elapsed: string): string {
  return nameTitle === "" ? elapsed : `${nameTitle}\n${elapsed}`;
}

/**
 * Formats how long the given app has been running, if it is in fact the game Steam is currently
 * running, as opposed to merely updating, or another app entirely having grabbed the flag between
 * the caller's own read of the registry and this one.
 * @param appId Steam application id of the key asking.
 * @returns The formatted elapsed time, or `undefined` when that app is not the one running.
 */
async function elapsedSince(appId: string): Promise<string | undefined> {
  const running = await getRunningGame();

  return running?.game.appId === appId && running.badge === "running" && running.since !== undefined
    ? formatElapsed(Date.now() - running.since)
    : undefined;
}
