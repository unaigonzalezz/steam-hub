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

import { getLatestAchievement, type LatestAchievement } from "../steam/achievements";
import { renderAchievementKey } from "../steam/artwork";
import { openSteamUrl } from "../steam/launch";
import { addStatusListener, removeStatusListener } from "../steam/monitor";
import { getRunningGame } from "../steam/running";
import { paintKey } from "./common";

/**
 * Settings for {@link LastAchievement}.
 */
type LastAchievementSettings = {
  /** Whether the achievement's name is drawn under its icon. */
  showTitle?: boolean;
};

/** The running game and its latest unlocked achievement, paired for {@link LastAchievement.onKeyDown}. */
type Current = {
  appId: string;
  name: string;
  achievement: LatestAchievement;
};

/**
 * A key with no game to pick that follows whichever installed game is currently running, the same
 * way {@link NowPlaying} and {@link PlayTimer} do, and shows the icon of the most recently unlocked
 * achievement in that game. Idle whenever nothing is running, or the running game has nothing
 * unlocked yet, achievements Steam has not cached locally included, see `getLatestAchievement`.
 * Pressing it opens that game's Community Hub.
 */
@action({ UUID: "com.unai-gonzalez.steam-hub.lastachievement" })
export class LastAchievement extends SingletonAction<LastAchievementSettings> {
  /** Bound so the same reference can be added to and removed from the shared poll. */
  readonly #onPoll = (): Promise<void> => this.#redrawAll();

  /** Whether {@link LastAchievement.#onPoll} is currently registered. */
  #listening = false;

  /** What each key currently shows, so a poll only repaints what actually changed. */
  readonly #drawn = new Map<string, string>();

  /** The running game's latest achievement, if any, reused by {@link onKeyDown}. */
  #current: Current | undefined;

  /**
   * Draws the key when it comes into view, and starts following Steam's running app.
   * @param ev Event arguments.
   */
  override async onWillAppear(ev: WillAppearEvent<LastAchievementSettings>): Promise<void> {
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
  override onWillDisappear(ev: WillDisappearEvent<LastAchievementSettings>): void {
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
  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<LastAchievementSettings>): Promise<void> {
    await this.#draw(ev.action, ev.payload.settings);
  }

  /**
   * Opens the achievement's game's Community Hub. Silent when nothing is running, or nothing has
   * unlocked yet, and the key already shows that at a glance.
   * @param ev Event arguments.
   */
  override async onKeyDown(ev: KeyDownEvent<LastAchievementSettings>): Promise<void> {
    if (this.#current === undefined) {
      await ev.action.showAlert();
      return;
    }

    const { appId, name } = this.#current;

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
   * Repaints every visible key from whatever is running now.
   */
  async #redrawAll(): Promise<void> {
    this.#current = await resolveCurrent();

    await Promise.all(
      [...this.actions].map(async (target) => {
        if (target.isKey()) {
          await this.#paint(target, await target.getSettings());
        }
      }),
    );
  }

  /**
   * Draws a single key from the last resolved achievement, cached from the last poll rather than
   * re-fetched, so a key coming into view between polls does not race the next one.
   * @param target Key to draw on.
   * @param settings The key's settings.
   */
  async #draw(
    target: DialAction<LastAchievementSettings> | KeyAction<LastAchievementSettings>,
    settings: LastAchievementSettings,
  ): Promise<void> {
    if (!target.isKey()) {
      return; // the manifest only offers this action on keypads
    }

    this.#current ??= await resolveCurrent();
    await this.#paint(target, settings);
  }

  /**
   * Writes to a key only when something about it actually changed, which keeps a poll from pushing
   * an identical image every four seconds.
   * @param target Key to draw on.
   * @param settings The key's settings.
   */
  async #paint(target: KeyAction<LastAchievementSettings>, settings: LastAchievementSettings): Promise<void> {
    const current = this.#current;
    const signature = current === undefined ? "idle" : `${current.achievement.icon}:${settings.showTitle === true}`;

    if (this.#drawn.get(target.id) === signature) {
      return;
    }

    this.#drawn.set(target.id, signature);

    if (current === undefined) {
      await target.setImage(); // restores the action's default image from the manifest
      await target.setTitle("");
      return;
    }

    const image = await renderAchievementKey(current.appId, current.achievement.icon);
    await paintKey(target, image, settings.showTitle === true ? current.achievement.name : "", "lastachievement");
  }
}

/**
 * Resolves the running game's latest achievement, when there is one of each.
 * @returns The running game paired with its latest achievement, or `undefined`.
 */
async function resolveCurrent(): Promise<Current | undefined> {
  const running = await getRunningGame();
  if (running === undefined) {
    return undefined;
  }

  const achievement = await getLatestAchievement(running.game.appId);
  return achievement === undefined ? undefined : { appId: running.game.appId, name: running.game.name, achievement };
}
