import { DeviceType } from "@elgato/streamdeck";

import { pluginPath, renderImageFile, type StatusBadge } from "../steam/artwork";

/**
 * Name of the profile shipped with this plugin, keyed by the device type it targets, as declared
 * under `Profiles` in the manifest.
 *
 * Stream Deck only lets a plugin switch to profiles it distributes itself, never to one the user
 * made, and it matches by name against the entry declared for that specific device type — so a
 * profile built for, say, the Stream Deck XL needs its own entry here even though it plays the
 * same role as the original's. Supporting a new device is meant to stop at three things: its
 * `.streamDeckProfile` file, a matching `Profiles` entry in the manifest, and one line here.
 */
const PROFILE_BY_DEVICE: Partial<Record<DeviceType, string>> = {
  [DeviceType.StreamDeck]: "Steam Hub",
};

/**
 * Resolves which bundled profile a device should jump back to, so the "back to the library" keys
 * work on every device this plugin ships a profile for, not just the one it shipped first.
 * @param deviceType Type of the device asking, i.e. `action.device.type`.
 * @returns The profile's name, exactly as declared under `Profiles` in the manifest. Falls back to
 * the original Stream Deck's profile when the device has none of its own yet, which is wrong more
 * often than it's right, but a wrong guess is still more useful than silently doing nothing.
 */
export function profileFor(deviceType: DeviceType): string {
  return PROFILE_BY_DEVICE[deviceType] ?? PROFILE_BY_DEVICE[DeviceType.StreamDeck]!;
}

/**
 * The part of a key this module draws on. Structural rather than `KeyAction<T>`, so it fits any
 * action's settings type without threading a generic through.
 */
type Drawable = {
  setImage(image?: string): Promise<void>;
  setTitle(title?: string): Promise<void>;
};

/**
 * Paints a key whose look is chosen by a named value rather than by a game, the Steam shortcuts
 * and the status keys.
 *
 * Each value gets its own file under the action's image folder, so any of them can be given custom
 * artwork by overwriting one PNG. A missing or unreadable file leaves the manifest's icon in place
 * rather than blanking the key.
 * @param target Key to draw on.
 * @param folder Name of the action's folder under `imgs/actions`.
 * @param value Value selecting the image, used as the filename.
 * @param title Title to write, empty for none.
 */
export async function drawNamedKey(target: Drawable, folder: string, value: string, title: string): Promise<void> {
  const image = await renderImageFile(pluginPath("imgs", "actions", folder, `${value}.png`));

  await target.setImage(image);
  await target.setTitle(title);
}

/** Roughly how many characters of the Stream Deck's default title font fit across one key. */
const TITLE_LINE_LENGTH = 10;

/**
 * Wraps a game name over the key, breaking on spaces so it stays readable at key size.
 * @param name Name to wrap.
 * @param maxLines Most lines to use before truncating with an ellipsis. Lower this when the title
 * has to share the key with something else, such as an elapsed-time line underneath.
 * @returns The wrapped name, capped at `maxLines` lines.
 */
export function wrapTitle(name: string, maxLines = 3): string {
  const lines: string[] = [];
  let line = "";

  for (const word of name.split(/\s+/)) {
    if (line === "") {
      line = word;
    } else if (line.length + 1 + word.length <= TITLE_LINE_LENGTH) {
      line += ` ${word}`;
    } else {
      lines.push(line);
      line = word;
    }
  }

  if (line !== "") {
    lines.push(line);
  }

  if (lines.length > maxLines) {
    lines.length = maxLines;
    lines[maxLines - 1] = `${lines[maxLines - 1]!.slice(0, TITLE_LINE_LENGTH - 1)}…`;
  }

  return lines.join("\n");
}

/**
 * Formats a duration the way a stopwatch reads: minutes and seconds, growing an hours place once
 * the session runs long enough to need one.
 * @param ms Elapsed milliseconds.
 * @returns The formatted duration.
 */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value: number): string => value.toString().padStart(2, "0");

  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/**
 * Decides which border a key should carry.
 * @param enabled Whether the user wants the status border at all.
 * @param state Live state of the app, when known.
 * @returns The badge to draw.
 */
export function badgeFor(enabled: boolean, state: { running: boolean; updating: boolean } | undefined): StatusBadge {
  if (!enabled || state === undefined) {
    return "idle";
  }

  if (state.updating) {
    return "updating";
  }

  return state.running ? "running" : "idle";
}

/**
 * Which page of a specific game a `steam://` URL should open.
 */
export type GamePagePage = "store" | "hub" | "uninstall";

/**
 * Builds the `steam://` URL for one game's page. `uninstall` still opens Steam's own confirmation
 * dialog, nothing is removed by the request alone.
 * @param page Page to open.
 * @param appId Steam application id.
 * @returns The URL to hand to `openSteamUrl`.
 */
export function steamPageUrl(page: GamePagePage, appId: string): string {
  switch (page) {
    case "hub":
      return `steam://url/GameHub/${appId}`;
    case "uninstall":
      return `steam://uninstall/${appId}`;
    default:
      return `steam://store/${appId}`;
  }
}
