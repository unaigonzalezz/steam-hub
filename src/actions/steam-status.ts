import streamDeck, {
  action,
  type DidReceiveSettingsEvent,
  type KeyDownEvent,
  SingletonAction,
  type WillAppearEvent,
} from "@elgato/streamdeck";

import { openSteamUrl } from "../steam/launch";
import { drawNamedKey } from "./common";

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

/**
 * Settings for {@link SteamStatus}.
 */
type SteamStatusSettings = {
  /** Which state to switch to. */
  state?: State;

  /**
   * Whether the state's name is drawn on the key. Off by default, since each state has its own
   * icon.
   */
  showTitle?: boolean;
};

/**
 * A key that sets your Steam presence.
 *
 * Note that this only ever *sets* a state. Steam keeps the current one server-side, it appears in
 * neither the registry nor `localconfig.vdf`, so a key cannot reflect what you are currently set
 * to, only change it.
 */
@action({ UUID: "com.unai-gonzalez.steam-hub.status" })
export class SteamStatus extends SingletonAction<SteamStatusSettings> {
  /**
   * Draws the key when it comes into view.
   * @param ev Event arguments.
   */
  override async onWillAppear(ev: WillAppearEvent<SteamStatusSettings>): Promise<void> {
    await this.draw(ev);
  }

  /**
   * Redraws the key when the state changes.
   * @param ev Event arguments.
   */
  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<SteamStatusSettings>): Promise<void> {
    await this.draw(ev);
  }

  /**
   * Switches Steam to the chosen state.
   * @param ev Event arguments.
   */
  override async onKeyDown(ev: KeyDownEvent<SteamStatusSettings>): Promise<void> {
    const state = resolve(ev.payload.settings);

    try {
      streamDeck.logger.info(`Setting Steam status to ${state}`);
      await openSteamUrl(STATES[state].url);
      await ev.action.showOk();
    } catch (err) {
      streamDeck.logger.error(`Could not set Steam status to "${state}"`, err);
      await ev.action.showAlert();
    }
  }

  /**
   * Paints the key with the state's own icon.
   * @param ev Event carrying the action and its settings.
   */
  private async draw(
    ev: WillAppearEvent<SteamStatusSettings> | DidReceiveSettingsEvent<SteamStatusSettings>,
  ): Promise<void> {
    const { settings } = ev.payload;
    const state = resolve(settings);

    if (ev.action.isKey()) {
      await drawNamedKey(ev.action, "status", state, settings.showTitle === true ? STATES[state].title : "");
    }
  }
}

/**
 * Resolves the configured state, falling back to the default for an unset or unknown value.
 * @param settings Current settings.
 * @returns A state that definitely exists.
 */
function resolve(settings: SteamStatusSettings): State {
  const state = settings.state;
  return state !== undefined && state in STATES ? state : DEFAULT_STATE;
}
