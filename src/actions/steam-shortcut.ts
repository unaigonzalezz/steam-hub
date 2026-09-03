import streamDeck, {
  action,
  type DidReceiveSettingsEvent,
  type KeyDownEvent,
  SingletonAction,
  type WillAppearEvent,
} from "@elgato/streamdeck";

import { openSteamUrl } from "../steam/launch";
import { drawNamedKey, profileFor } from "./common";

/**
 * Places in the Steam client a key can jump to.
 *
 * Each entry pairs the `steam://` URL with the short label drawn on the key, so adding a
 * destination is a one-line change here plus an `<option>` in the property inspector.
 */
const DESTINATIONS = {
  // Stream Deck profiles. `"games"` is a marker rather than a literal profile name, because the
  // actual name depends on which device the key is pressed on; see `profileFor` in `./common`.
  gamesprofile: { profile: "games", title: "Games\nProfile" },
  previousprofile: { profile: null, title: "Back" },

  // Library
  library: { url: "steam://open/games", title: "Library" },
  downloads: { url: "steam://open/downloads", title: "Down\nloads" },
  workshop: { url: "steam://open/workshop", title: "Work\nshop" },
  addnonsteamgame: { url: "steam://open/addnonsteamgame", title: "Add\nGame" },

  // Community and captures
  friends: { url: "steam://open/friends", title: "Friends" },
  inventory: { url: "steam://open/inventory", title: "Inven\ntory" },
  screenshots: { url: "steam://open/screenshots", title: "Screen\nshots" },
  media: { url: "steam://open/media", title: "Clips" },
  recording: { url: "steam://open/recording", title: "Record\ning" },
  servers: { url: "steam://open/servers", title: "Servers" },

  // Store
  store: { url: "steam://store", title: "Store" },
  activateproduct: { url: "steam://open/activateproduct", title: "Activate\nKey" },

  // Big Picture and VR
  bigpicture: { url: "steam://open/bigpicture", title: "Big\nPicture" },
  closebigpicture: { url: "steam://close/bigpicture", title: "Exit Big\nPicture" },
  startvr: { url: "steam://startsteamvr", title: "Start\nSteamVR" },

  // Client
  settings: { url: "steam://open/settings", title: "Steam\nSettings" },
  console: { url: "steam://open/console", title: "Console" },
  changeuser: { url: "steam://changeuser", title: "Switch\nAccount" },
  exit: { url: "steam://exit", title: "Quit\nSteam" },

  // Only opens when a music library exists; Steam ignores it otherwise.
  music: { url: "steam://open/musicplayer", title: "Music" },
} as const satisfies Record<string, { title: string } & ({ url: string } | { profile: "games" | null })>;

type Destination = keyof typeof DESTINATIONS;

const DEFAULT_DESTINATION: Destination = "bigpicture";

/**
 * Settings for {@link SteamShortcut}.
 */
type SteamShortcutSettings = {
  /** Which part of Steam to open. */
  destination?: Destination;

  /**
   * Whether the destination's name is drawn on the key. Off by default: each destination has its
   * own icon, so a label on top is usually redundant.
   */
  showTitle?: boolean;
};

/**
 * A key that opens a part of the Steam client.
 */
@action({ UUID: "com.unai-gonzalez.steam-hub.shortcut" })
export class SteamShortcut extends SingletonAction<SteamShortcutSettings> {
  /**
   * Labels the key when it comes into view.
   * @param ev Event arguments.
   */
  override async onWillAppear(ev: WillAppearEvent<SteamShortcutSettings>): Promise<void> {
    await this.draw(ev);
  }

  /**
   * Relabels the key when the destination changes.
   * @param ev Event arguments.
   */
  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<SteamShortcutSettings>): Promise<void> {
    await this.draw(ev);
  }

  /**
   * Opens the chosen destination.
   * @param ev Event arguments.
   */
  override async onKeyDown(ev: KeyDownEvent<SteamShortcutSettings>): Promise<void> {
    const destination = resolve(ev.payload.settings);
    const target: { title: string } & ({ url: string } | { profile: "games" | null }) = DESTINATIONS[destination];

    try {
      if ("profile" in target) {
        // `undefined` rather than `null` is what returns to the previously active profile.
        const profile = target.profile === "games" ? profileFor(ev.action.device.type) : undefined;
        streamDeck.logger.info(`Switching to profile ${profile ?? "(previous)"}`);
        await streamDeck.profiles.switchToProfile(ev.action.device.id, profile);
      } else {
        streamDeck.logger.info(`Opening ${target.url}`);
        await openSteamUrl(target.url);
        await ev.action.showOk();
      }
    } catch (err) {
      streamDeck.logger.error(`Could not run Steam shortcut "${destination}"`, err);
      await ev.action.showAlert();
    }
  }

  /**
   * Writes the destination's name onto the key.
   * @param ev Event carrying the action and its settings.
   */
  private async draw(
    ev: WillAppearEvent<SteamShortcutSettings> | DidReceiveSettingsEvent<SteamShortcutSettings>,
  ): Promise<void> {
    const { settings } = ev.payload;
    const destination = resolve(settings);

    if (ev.action.isKey()) {
      await drawNamedKey(
        ev.action,
        "shortcut",
        destination,
        settings.showTitle === true ? DESTINATIONS[destination].title : "",
      );
    }
  }
}

/**
 * Resolves the configured destination, falling back to the default for an unset or unknown value.
 * @param settings Current settings.
 * @returns A destination that definitely exists.
 */
function resolve(settings: SteamShortcutSettings): Destination {
  const destination = settings.destination;
  return destination !== undefined && destination in DESTINATIONS ? destination : DEFAULT_DESTINATION;
}
