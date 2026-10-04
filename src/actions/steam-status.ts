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

import { getActiveAvatarPath } from "../steam/account";
import { type AvatarEffect, LABEL_LINE_LENGTH, pluginPath, renderAvatarKey, renderCaption } from "../steam/artwork";
import { openSteamUrl } from "../steam/launch";
import { addStatusListener, removeStatusListener } from "../steam/monitor";
import { exists } from "../steam/paths";
import { getPersonaState, type PersonaState } from "../steam/persona";
import { getRunningGame } from "../steam/running";
import { wrapTitle } from "./common";
import { getTextStyle } from "./text-style";

/**
 * The states Steam's own protocol handler accepts.
 *
 * Read out of `steamui.dll` rather than guessed: the client understands exactly these four, and
 * none of the other presence values the friends list can display (busy, snooze, looking to trade).
 */
const STATES = {
  online: { url: "steam://friends/status/online", title: "Online" },
  away: { url: "steam://friends/status/away", title: "Away" },
  invisible: { url: "steam://friends/status/invisible", title: "Invisible" },
  offline: { url: "steam://friends/status/offline", title: "Offline" },
} as const satisfies Record<string, { url: string; title: string }>;

type State = keyof typeof STATES;

const DEFAULT_STATE: State = "online";

/** Titles for every state a key can show, including "in game", which can be shown but not set. */
const TITLES: Record<PersonaState, string> = {
  online: STATES.online.title,
  away: STATES.away.title,
  invisible: STATES.invisible.title,
  offline: STATES.offline.title,
  ingame: "In game",
};

/**
 * How the avatar is toned for each state, so it reads before the frame's colour does: away dims it,
 * invisible turns it black and white, offline both.
 */
const EFFECTS: Record<PersonaState, AvatarEffect> = {
  online: "none",
  ingame: "none",
  away: "dim",
  invisible: "grey",
  offline: "faded",
};

/**
 * What a press does when cycling: the state after the current one. Offline is left out, since it
 * drops the friends list altogether and is easy to land on by accident while cycling; a key can
 * still be set to it explicitly.
 */
const NEXT: Record<PersonaState, State> = {
  online: "away",
  away: "invisible",
  invisible: "online",
  offline: "online",
  ingame: "away",
};

/**
 * What a key does:
 * - `cycle`: shows the current state, and a press moves to the next one.
 * - `set`: always switches to one chosen state, and shows that state.
 */
type StatusMode = "cycle" | "set";

/**
 * Settings for {@link SteamStatus}.
 */
type SteamStatusSettings = {
  /**
   * What the key does. Absent on keys set up before this setting existed: those that had a state
   * chosen keep setting it, the rest cycle.
   */
  mode?: StatusMode;

  /** Which state to switch to, in `set` mode. */
  state?: State;

  /** Whether the state's name is written on the key. Off by default, since the bubble shows it. */
  showTitle?: boolean;
};

/** How long a key must stay down before it counts as a hold, the same as the other keys use. */
const LONG_PRESS_MS = 500;

/**
 * How long a state just picked on a key is shown before what Steam saved takes over again. Steam
 * saves within a second or so; until it does, the old state would otherwise flash back.
 */
const PENDING_MS = 5_000;

/**
 * A key showing the signed-in user's avatar with a bubble for their Steam state.
 *
 * By default it shows the current state, followed live, and a tap moves to the next of online,
 * away and invisible. It can instead be set to always switch to one state, which a row of keys,
 * one per state, used to be the only way to do. Holding either kind opens the friends list.
 */
@action({ UUID: "com.unai-gonzalez.steam-hub.status" })
export class SteamStatus extends SingletonAction<SteamStatusSettings> {
  /** Bound so the same reference can be added to and removed from the shared poll. */
  readonly #onPoll = (): Promise<void> => this.#redrawAll();

  #listening = false;
  #watchingStyle = false;

  /** What each key currently shows, so a poll only repaints what actually changed. */
  readonly #drawn = new Map<string, string>();

  /** Keys currently held down, waiting to see whether the press turns into a hold. */
  readonly #pressTimers = new Map<string, NodeJS.Timeout>();

  /** A state just picked from a key, shown until Steam has had time to save it. */
  #pending: { state: State; until: number } | undefined;

  /**
   * Draws the key when it comes into view, and starts following the user's state.
   * @param ev Event arguments.
   */
  override async onWillAppear(ev: WillAppearEvent<SteamStatusSettings>): Promise<void> {
    if (!this.#listening) {
      this.#listening = true;
      addStatusListener(this.#onPoll);
    }

    if (!this.#watchingStyle) {
      this.#watchingStyle = true;
      streamDeck.settings.onDidReceiveGlobalSettings(() => void this.#redrawAll()); // the shared text style
    }

    if (ev.action.isKey()) {
      await this.#draw(ev.action, ev.payload.settings);
    }
  }

  /**
   * Stops following once the last key of this action leaves the screen.
   * @param ev Event arguments.
   */
  override onWillDisappear(ev: WillDisappearEvent<SteamStatusSettings>): void {
    this.#drawn.delete(ev.action.id);
    this.#cancelPress(ev.action.id);

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
  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<SteamStatusSettings>): Promise<void> {
    if (ev.action.isKey()) {
      await this.#draw(ev.action, ev.payload.settings);
    }
  }

  /**
   * Waits to see whether the press is a tap or a hold; only a release before {@link LONG_PRESS_MS}
   * is a tap, handled by {@link SteamStatus.onKeyUp}.
   * @param ev Event arguments.
   */
  override onKeyDown(ev: KeyDownEvent<SteamStatusSettings>): void {
    this.#cancelPress(ev.action.id);

    const target = ev.action;
    this.#pressTimers.set(
      target.id,
      setTimeout(() => {
        this.#pressTimers.delete(target.id);
        void this.#openFriends(target);
      }, LONG_PRESS_MS),
    );
  }

  /**
   * Resolves a press that let go before turning into a hold: switches state.
   * @param ev Event arguments.
   */
  override async onKeyUp(ev: KeyUpEvent<SteamStatusSettings>): Promise<void> {
    if (!this.#cancelPress(ev.action.id)) {
      return; // the hold already fired
    }

    const { settings } = ev.payload;
    const state = modeOf(settings) === "cycle" ? NEXT[await this.#currentState()] : stateOf(settings);

    try {
      streamDeck.logger.info(`Setting Steam status to ${state}`);
      await openSteamUrl(STATES[state].url);
      this.#pending = { state, until: Date.now() + PENDING_MS };
      await ev.action.showOk();
      await this.#redrawAll();
    } catch (err) {
      streamDeck.logger.error(`Could not set Steam status to "${state}"`, err);
      await ev.action.showAlert();
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
   * Opens Steam's friends list, what a hold does.
   * @param target Key that was held.
   */
  async #openFriends(target: KeyAction<SteamStatusSettings>): Promise<void> {
    try {
      await openSteamUrl("steam://open/friends");
      await target.showOk();
    } catch (err) {
      streamDeck.logger.error("Could not open the friends list", err);
      await target.showAlert();
    }
  }

  /**
   * The user's state as it stands: one just picked from a key while Steam saves it, otherwise what
   * Steam reports.
   * @returns The state.
   */
  async #currentState(): Promise<PersonaState> {
    if (this.#pending !== undefined && Date.now() < this.#pending.until) {
      return this.#pending.state;
    }

    this.#pending = undefined;
    return getPersonaState();
  }

  /**
   * Repaints every visible key, after a poll or a change of state.
   */
  async #redrawAll(): Promise<void> {
    await Promise.all(
      [...this.actions].map(async (target) => {
        if (target.isKey()) {
          await this.#draw(target, await target.getSettings());
        }
      }),
    ).catch((err) => streamDeck.logger.error("Could not repaint the status keys", err));
  }

  /**
   * Paints a key: the signed-in user's avatar inside the status frame, with the bubble of the state
   * it shows, the current one when cycling, its own when set to one. The state's name, when asked
   * for, is drawn in or written as the title like every other key's text, following the shared text
   * style.
   * @param target Key to draw on.
   * @param settings The key's settings.
   */
  async #draw(target: KeyAction<SteamStatusSettings>, settings: SteamStatusSettings): Promise<void> {
    const shown: PersonaState = modeOf(settings) === "cycle" ? await this.#currentState() : stateOf(settings);
    const name = settings.showTitle === true ? await nameFor(shown) : "";
    const drawn = (await getTextStyle()) === "drawn";

    // Each state has its own frame, so any of them can be redrawn by overwriting one PNG; a state
    // without one falls back to the shared frame.
    const stateFrame = pluginPath("imgs", "actions", "status", "frame", `${shown}.png`);
    const art = await renderAvatarKey({
      avatar: await getActiveAvatarPath(),
      frame: (await exists(stateFrame)) ? stateFrame : pluginPath("imgs", "actions", "status", "frame.png"),
      effect: EFFECTS[shown],
    });

    // The rendered image is a data URI cached per file version, so comparing it catches a new avatar,
    // frame or bubble as well as a new state.
    const signature = `${shown}:${name}:${drawn}:${art}`;
    if (this.#drawn.get(target.id) === signature) {
      return;
    }
    this.#drawn.set(target.id, signature);

    // Wrapped like the library keys' names, since a game's can be long.
    const label = name === "" ? [] : wrapTitle(name, 2, LABEL_LINE_LENGTH).split("\n");
    await target.setImage(drawn && label.length > 0 ? renderCaption(art, { label }) : art);
    await target.setTitle(drawn ? "" : wrapTitle(name));
  }
}

/**
 * Resolves what a key does, reading keys from before {@link SteamStatusSettings.mode} existed the
 * way they always worked when a state was chosen on them.
 * @param settings Current settings.
 * @returns The mode.
 */
function modeOf(settings: SteamStatusSettings): StatusMode {
  if (settings.mode === "cycle" || settings.mode === "set") {
    return settings.mode;
  }

  return settings.state !== undefined ? "set" : "cycle";
}

/**
 * Resolves the configured state, falling back to the default for an unset or unknown value.
 * @param settings Current settings.
 * @returns A state that definitely exists.
 */
function stateOf(settings: SteamStatusSettings): State {
  const state = settings.state;
  return state !== undefined && state in STATES ? state : DEFAULT_STATE;
}

/**
 * The text a key writes for a state: its name, or, in game, the game's.
 * @param state The state shown.
 * @returns The text.
 */
async function nameFor(state: PersonaState): Promise<string> {
  if (state === "ingame") {
    const running = await getRunningGame();
    if (running?.badge === "running") {
      return running.game.name;
    }
  }

  return TITLES[state];
}
