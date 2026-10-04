import streamDeck, {
  action,
  type DidReceiveSettingsEvent,
  type KeyAction,
  type KeyDownEvent,
  type KeyUpEvent,
  SingletonAction,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";

import { pluginPath, renderCaption, renderImageFile } from "../steam/artwork";
import { addStatusListener, removeStatusListener } from "../steam/monitor";
import { addPageListener, describePage, goToFirstPage, type PageInfo, removePageListener, turnPage } from "./paging";

/**
 * Settings for {@link PageTurn}.
 */
type PageTurnSettings = {
  /** Which way a press moves. Defaults to forward. */
  direction?: "next" | "prev";

  /** Whether the key shows where the device is, e.g. "3 / 20". Defaults to on. */
  showPosition?: boolean;

  /**
   * Whether "previous" on the first page leaves for the profile the user came from instead of
   * wrapping to the last page, the way out of the library once there is nowhere further back to go.
   * Defaults to on; ignored by "next".
   */
  backOnFirst?: boolean;
};

/** How long a key must stay down before it counts as a hold, the same as the numbered keys use. */
const LONG_PRESS_MS = 500;

/**
 * How long page-key repaints are held back, so a page of numbered keys appearing one after another
 * repaints the page keys once rather than once per key.
 */
const REPAINT_DELAY_MS = 50;

/**
 * A key that pages every numbered "Show installed games" key on its device forward or back, so one
 * page of keys can reach a library of any length instead of needing a profile page per screenful.
 * Wraps at both ends: "next" on the last page comes back to the first. Holding either key jumps
 * straight back to the first page.
 */
@action({ UUID: "com.unai-gonzalez.steam-hub.page" })
export class PageTurn extends SingletonAction<PageTurnSettings> {
  /** Bound so the same reference can be added to and removed from the shared listeners. */
  readonly #onChange = (): void => this.#scheduleRepaint();

  #listening = false;
  #repaintTimer: NodeJS.Timeout | undefined;

  /** What each key currently shows, so a repaint only writes what actually changed. */
  readonly #drawn = new Map<string, string>();

  /** Keys currently held down, waiting to see whether the press turns into a hold. */
  readonly #pressTimers = new Map<string, NodeJS.Timeout>();

  /**
   * Draws the key when it comes into view, and starts following page changes.
   * @param ev Event arguments.
   */
  override async onWillAppear(ev: WillAppearEvent<PageTurnSettings>): Promise<void> {
    if (!this.#listening) {
      this.#listening = true;
      addPageListener(this.#onChange);
      addStatusListener(this.#onChange); // the library can grow or shrink, and the page count with it
    }

    if (ev.action.isKey()) {
      await this.#draw(ev.action, ev.payload.settings);
    }
  }

  /**
   * Stops following page changes once the last key of this action leaves the screen.
   * @param ev Event arguments.
   */
  override onWillDisappear(ev: WillDisappearEvent<PageTurnSettings>): void {
    this.#drawn.delete(ev.action.id);
    this.#cancelPress(ev.action.id);

    // `actions` still includes the departing key at this point, hence the count of one.
    if (this.#listening && [...this.actions].length <= 1) {
      this.#listening = false;
      removePageListener(this.#onChange);
      removeStatusListener(this.#onChange);
      clearTimeout(this.#repaintTimer);
      this.#repaintTimer = undefined;
    }
  }

  /**
   * Redraws when the property inspector changes the direction or the position line.
   * @param ev Event arguments.
   */
  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<PageTurnSettings>): Promise<void> {
    if (ev.action.isKey()) {
      await this.#draw(ev.action, ev.payload.settings);
    }
  }

  /**
   * Waits to see whether the press is a tap or a hold. Nothing happens yet: only a release before
   * {@link LONG_PRESS_MS} is a tap, handled by {@link PageTurn.onKeyUp}.
   * @param ev Event arguments.
   */
  override onKeyDown(ev: KeyDownEvent<PageTurnSettings>): void {
    this.#cancelPress(ev.action.id);

    const target = ev.action;
    this.#pressTimers.set(
      target.id,
      setTimeout(() => {
        this.#pressTimers.delete(target.id);
        void this.#hold(target).catch((err) => streamDeck.logger.error("Could not jump to the first page", err));
      }, LONG_PRESS_MS),
    );
  }

  /**
   * Resolves a press that let go before turning into a hold. A release with nothing pending means
   * the hold already fired, and there is nothing left to do.
   * @param ev Event arguments.
   */
  override async onKeyUp(ev: KeyUpEvent<PageTurnSettings>): Promise<void> {
    if (this.#cancelPress(ev.action.id)) {
      await this.#tap(ev.action, ev.payload.settings);
    }
  }

  /**
   * Cancels a key's pending hold timer, if it has one.
   * @param actionId Id of the key.
   * @returns Whether a timer was actually pending.
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
   * Jumps straight back to the first page, whichever way the key normally turns.
   * @param target Key that was held.
   */
  async #hold(target: KeyAction<PageTurnSettings>): Promise<void> {
    const info = await goToFirstPage(target.device.id);

    if (info === undefined) {
      await target.showAlert(); // nothing on screen to page through
      return;
    }

    await target.showOk();
  }

  /**
   * Turns the page, or, for "previous" on the first page, goes back to the profile the user came
   * from. A device with no numbered keys on screen has nothing to page, which the key says with an
   * alert rather than silently doing nothing.
   * @param target Key that was tapped.
   * @param settings The key's settings.
   */
  async #tap(target: KeyAction<PageTurnSettings>, settings: PageTurnSettings): Promise<void> {
    if (leavesOnPress(settings, await describePage(target.device.id))) {
      try {
        // `undefined` returns to the previously active profile, as the "Back" shortcut does.
        streamDeck.logger.info("Leaving the library for the previous profile");
        await streamDeck.profiles.switchToProfile(target.device.id, undefined);
      } catch (err) {
        streamDeck.logger.error("Could not switch back to the previous profile", err);
        await target.showAlert();
      }
      return;
    }

    const delta = settings.direction === "prev" ? -1 : 1;
    const info = await turnPage(target.device.id, delta);

    if (info === undefined) {
      streamDeck.logger.info("Page key pressed with no numbered keys on screen to page through");
      await target.showAlert();
    }
  }

  /**
   * Repaints every visible page key shortly, coalescing a burst of changes into one pass.
   */
  #scheduleRepaint(): void {
    if (this.#repaintTimer !== undefined) {
      return;
    }

    this.#repaintTimer = setTimeout(() => {
      this.#repaintTimer = undefined;

      void Promise.all(
        [...this.actions].map(async (target) => {
          if (target.isKey()) {
            await this.#draw(target, await target.getSettings());
          }
        }),
      ).catch((err) => streamDeck.logger.error("Could not repaint the page keys", err));
    }, REPAINT_DELAY_MS);
  }

  /**
   * Paints a key: its arrow, with where the device is drawn onto it when asked for, or just the
   * "back" arrow when a press would leave the library, since a page number on a way out would read
   * as a page to turn to.
   * @param target Key to draw on.
   * @param settings The key's settings.
   */
  async #draw(target: KeyAction<PageTurnSettings>, settings: PageTurnSettings): Promise<void> {
    const info = await describePage(target.device.id);
    const leaves = leavesOnPress(settings, info);
    const image = leaves ? "back" : settings.direction === "prev" ? "prev" : "next";
    const position = leaves || info === undefined || settings.showPosition === false ? undefined : info;
    const signature = `${image}:${position === undefined ? "" : `${position.page}/${position.count}`}`;

    if (this.#drawn.get(target.id) === signature) {
      return;
    }

    // Each look has its own file, so any of them can be given custom art by overwriting one PNG.
    const base = await renderImageFile(pluginPath("imgs", "actions", "page", `${image}.png`));

    await target.setImage(
      base === undefined || position === undefined
        ? base
        : renderCaption(base, { main: String(position.page + 1), suffix: `/${position.count}` }),
    );
    await target.setTitle(""); // clears the title earlier versions wrote the position in

    this.#drawn.set(target.id, signature);
  }
}

/**
 * Whether a press leaves the library rather than turning the page: "previous" on the first page, or
 * with no numbered keys on screen to page at all, unless the key was set to wrap instead.
 * @param settings The key's settings.
 * @param info Where the device is, or `undefined` when it has nothing to page.
 * @returns `true` when a press goes back to the previous profile.
 */
function leavesOnPress(settings: PageTurnSettings, info: PageInfo | undefined): boolean {
  return settings.direction === "prev" && settings.backOnFirst !== false && (info === undefined || info.page === 0);
}
