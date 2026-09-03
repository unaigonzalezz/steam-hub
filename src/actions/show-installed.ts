import streamDeck, {
  action,
  type DialAction,
  type DidReceiveSettingsEvent,
  type KeyAction,
  type KeyDownEvent,
  type KeyUpEvent,
  SingletonAction,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";

import { type ArtFit, type ArtStyle, renderEmptyKey, renderKeyImage, type StatusBadge } from "../steam/artwork";
import { launchGame, openSteamUrl } from "../steam/launch";
import { getInstalledGames, sortGames, type SortOrder, type SteamGame } from "../steam/library";
import { addStatusListener, removeStatusListener } from "../steam/monitor";
import { getRunningGame } from "../steam/running";
import { getAppStates } from "../steam/status";
import { badgeFor, formatElapsed, type GamePagePage, profileFor, steamPageUrl, wrapTitle } from "./common";

/**
 * Per-key settings for {@link ShowInstalled}: just the slot this key stands for.
 */
type SlotSettings = {
  /**
   * 1-based position in the sorted library. Stored as typed, because the property inspector's
   * text field hands back a string.
   */
  index?: string | number;
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

  /** Whether {@link ShowInstalled.#onPoll} is currently registered. */
  #listening = false;

  /** What each key currently shows, so a poll only repaints what actually changed. */
  readonly #drawn = new Map<string, string>();

  /**
   * Timers for keys currently held down, waiting to see whether the press turns into a hold. Only
   * populated while {@link SharedSettings.longPress} asks for one; a plain tap never creates one.
   */
  readonly #pressTimers = new Map<string, NodeJS.Timeout>();

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

      shared = ev.settings;
      void this.#redrawAll();
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
    }

    await this.#draw(ev.action, ev.payload.settings);
  }

  /**
   * Stops polling once the last key of this action leaves the screen.
   * @param ev Event arguments.
   */
  override onWillDisappear(ev: WillDisappearEvent<SlotSettings>): void {
    this.#drawn.delete(ev.action.id);
    this.#cancelPress(ev.action.id);

    // `actions` still includes the departing key at this point, hence the count of one.
    if (this.#listening && [...this.actions].length <= 1) {
      this.#listening = false;
      removeStatusListener(this.#onPoll);
    }
  }

  /**
   * Redraws the key when its index changes.
   * @param ev Event arguments.
   */
  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<SlotSettings>): Promise<void> {
    await this.#draw(ev.action, ev.payload.settings);
  }

  /**
   * Launches whichever game this key is showing, or, when {@link SharedSettings.longPress} is
   * configured, waits to see whether the press turns into a hold before deciding which.
   * @param ev Event arguments.
   */
  override async onKeyDown(ev: KeyDownEvent<SlotSettings>): Promise<void> {
    // A key with no position is the way into the library: it jumps to the profile that holds
    // the numbered slots, so one key on the main profile opens the whole list. It never has a
    // game behind it, so a hold makes no sense here regardless of the shared setting.
    if (parseIndex(ev.payload.settings) === undefined) {
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
   * Launches whichever game a key stands for. Used for a plain tap, and for a release that never
   * grew into a hold.
   * @param target Key that was pressed.
   * @param settings The key's settings.
   */
  async #launch(target: KeyAction<SlotSettings>, settings: SlotSettings): Promise<void> {
    const game = await this.#gameFor(settings);

    if (game === undefined) {
      return; // a numbered slot with no game is not a broken key, so it stays silent
    }

    try {
      await launchGame(game.appId);
      await target.showOk();
    } catch (err) {
      streamDeck.logger.error(`Could not launch ${game.name}`, err);
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
    const game = await this.#gameFor(settings);

    if (game === undefined) {
      return; // a numbered slot with no game is not a broken key, so it stays silent
    }

    try {
      await openSteamUrl(steamPageUrl(page, game.appId));
      await target.showOk();
    } catch (err) {
      streamDeck.logger.error(`Could not open the ${page} page for ${game.name}`, err);
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
    await Promise.all(
      [...this.actions].map(async (target) => {
        if (target.isKey()) {
          await this.#draw(target, await target.getSettings());
        }
      }),
    );
  }

  /**
   * Resolves the game a key stands for.
   * @param settings The key's settings.
   * @returns The game at that index, or `undefined` when the slot is empty.
   */
  async #gameFor(settings: SlotSettings): Promise<SteamGame | undefined> {
    const index = parseIndex(settings);
    if (index === undefined) {
      return undefined;
    }

    const shared = await getShared();
    const games = sortGames(await getInstalledGames(), shared.sortOrder ?? DEFAULT_SHARED.sortOrder);

    return games[index - 1]; // 1-based, so the numbers on the keys read the way people count
  }

  /**
   * Paints a key: the game at its index, or nothing at all.
   * @param target Key to draw on.
   * @param settings The key's settings.
   */
  async #draw(target: DialAction<SlotSettings> | KeyAction<SlotSettings>, settings: SlotSettings): Promise<void> {
    if (!target.isKey()) {
      return; // the manifest only offers this action on keypads
    }

    // No position typed in yet: leave the action's own icon showing, so a key dragged onto the
    // device reads as "configure me" rather than as a slot that happens to be empty.
    if (parseIndex(settings) === undefined) {
      await this.#paint(target, "unset", undefined, "");
      return;
    }

    const game = await this.#gameFor(settings);
    const shared = await getShared();

    if (game === undefined) {
      // A real position with nothing behind it, that is what the empty plate is for.
      await this.#paint(target, `empty:${shared.emptyImage ?? ""}`, await renderEmptyKey(shared.emptyImage), "");
      return;
    }

    const state = (await getAppStates()).get(game.appId);
    const badge: StatusBadge = badgeFor(shared.showStatus !== false, state);
    const style = shared.artStyle ?? DEFAULT_SHARED.artStyle;

    const image =
      style === "none"
        ? await renderEmptyKey(shared.emptyImage)
        : await renderKeyImage(game.appId, style, shared.artFit ?? DEFAULT_SHARED.artFit, badge);

    // Fetching who is running is a bit of extra work, so it only happens for a key whose own game
    // is actually running and only when the setting asks for it, never for the other thirty-one.
    const elapsed =
      shared.showPlayTime === true && state?.running === true ? await elapsedSince(game.appId) : undefined;

    const nameTitle = shared.showTitle === true || style === "none" ? wrapTitle(game.name, elapsed ? 2 : 3) : "";
    const title = elapsed === undefined ? nameTitle : nameTitle === "" ? elapsed : `${nameTitle}\n${elapsed}`;

    await this.#paint(
      target,
      `${game.appId}:${style}:${badge}:${title}`,
      image ?? (await renderEmptyKey(shared.emptyImage)),
      title,
    );
  }

  /**
   * Writes to a key only when something about it actually changed, which keeps a poll over a full
   * profile from pushing thirty-two identical images every four seconds.
   * @param target Key to draw on.
   * @param signature Value identifying what is being drawn.
   * @param image Image to set; `undefined` restores the action's icon from the manifest.
   * @param title Title to set.
   */
  async #paint(
    target: KeyAction<SlotSettings>,
    signature: string,
    image: string | undefined,
    title: string,
  ): Promise<void> {
    if (this.#drawn.get(target.id) === signature) {
      return;
    }

    await target.setImage(image);
    await target.setTitle(title);
    this.#drawn.set(target.id, signature);
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
 * Reads the settings shared by every key of this action, cached after the first read and kept in
 * step by the subscription the action sets up.
 * @returns The shared settings.
 */
async function getShared(): Promise<SharedSettings> {
  return (shared ??= await streamDeck.settings.getGlobalSettings<SharedSettings>());
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
