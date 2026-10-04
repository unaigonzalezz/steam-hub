import { DeviceType } from "@elgato/streamdeck";

import { LABEL_LINE_LENGTH, pluginPath, renderCaption, renderImageFile, type StatusBadge } from "../steam/artwork";
import { findCollection, getCollections } from "../steam/collections";
import { getPlayHistory } from "../steam/history";
import { getInstalledGames, getInstallingGames, sortGames, type SortOrder } from "../steam/library";

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
  [DeviceType.StreamDeckXL]: "Steam Hub XL",
  [DeviceType.StreamDeckPlus]: "Steam Hub +",
  [DeviceType.StreamDeckPlusXL]: "Steam Hub + XL",
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
 * Paints a key whose look is chosen by a named value rather than by a game, the Steam shortcuts.
 *
 * Each value gets its own file under the action's image folder, so any of them can be given custom
 * artwork by overwriting one PNG. A missing or unreadable file leaves the manifest's icon in place
 * rather than blanking the key.
 * @param target Key to draw on.
 * @param folder Name of the action's folder under `imgs/actions`.
 * @param value Value selecting the image, used as the filename.
 * @param text Text to draw on the key, empty for none.
 */
export async function drawNamedKey(target: Drawable, folder: string, value: string, text: string): Promise<void> {
  const image = await renderImageFile(pluginPath("imgs", "actions", folder, `${value}.png`));
  await paintKey(target, image, text, folder);
}

/**
 * Paints a key with its text drawn into the image, in the plugin's own font and style, the way
 * every key but the library's numbered ones writes text; those can also write it as a title.
 *
 * Leaves the Stream Deck title empty, which also clears a title from versions that wrote one.
 * @param target Key to draw on.
 * @param image The key's image, or `undefined` for the action's own icon from the manifest.
 * @param text Text to draw, empty for none. Line breaks are ignored; it is wrapped to fit.
 * @param folder The action's folder under `imgs/actions`, whose `key@2x.png`, the manifest's icon,
 * is drawn onto when `image` is `undefined` and there is text to show.
 * @param options `clearTitle: false` leaves the title alone, for a key whose title may be the user's.
 */
export async function paintKey(
  target: Drawable,
  image: string | undefined,
  text: string,
  folder: string,
  options: { clearTitle?: boolean } = {},
): Promise<void> {
  const base = text === "" ? image : (image ?? (await renderImageFile(pluginPath("imgs", "actions", folder, "key@2x.png"))));

  await target.setImage(text === "" || base === undefined ? image : renderCaption(base, { label: drawnLines(text) }));

  if (options.clearTitle !== false) {
    await target.setTitle("");
  }
}

/**
 * Wraps text for drawing into a key, which fits more per line than a title.
 * @param text The text; line breaks in it are treated as spaces.
 * @returns At most two lines.
 */
export function drawnLines(text: string): string[] {
  return wrapTitle(text.replace(/\s*\n\s*/g, " "), 2, LABEL_LINE_LENGTH).split("\n");
}

/** Roughly how many characters of the Stream Deck's default title font fit across one key. */
const TITLE_LINE_LENGTH = 10;

/**
 * Wraps a game name over the key, breaking on spaces so it stays readable at key size.
 * @param name Name to wrap.
 * @param maxLines Most lines to use before truncating with an ellipsis. Lower this when the title
 * has to share the key with something else, such as an elapsed-time line underneath.
 * @param lineLength Most characters per line; a name drawn into the image in a smaller font fits more.
 * @returns The wrapped name, capped at `maxLines` lines.
 */
export function wrapTitle(name: string, maxLines = 3, lineLength = TITLE_LINE_LENGTH): string {
  const lines: string[] = [];
  let line = "";

  for (const word of name.split(/\s+/)) {
    if (line === "") {
      line = word;
    } else if (line.length + 1 + word.length <= lineLength) {
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
    lines[maxLines - 1] = `${lines[maxLines - 1]!.slice(0, lineLength - 1)}…`;
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
 * One entry in a library listing that may include a game still downloading for the first time,
 * alongside the already-installed library. Both a numbered key grid and a scrolling dial need
 * exactly this list, so it is built once here rather than twice.
 */
export type LibrarySlot = {
  appId: string;
  name: string;

  /** Whether this is a first install still in progress, rather than a launchable game. */
  installing: boolean;

  /**
   * Whether this is a game from the chosen collection that is not on this machine at all. Its
   * `name` is only a placeholder, `App <id>`, since nothing local knows it; see `resolveGameName`.
   */
  missing?: boolean;

  /** Download progress in `[0, 1]`, when known. Only ever set while `installing` is `true`. */
  fraction?: number;
};

/**
 * Builds the combined list a library-browsing action numbers or scrolls through: games installing
 * for the first time up front, followed by the already-installed library in the requested order.
 *
 * Installing entries sit ahead of the sorted list rather than interleaved into it: it is the only
 * way to make a game with no real place in `sortOrder` yet, no final size, no play history, show up
 * at all. That does shift every already-installed slot down for as long as something is installing,
 * which is why `includeInstalling` exists as an opt-out.
 * @param sortOrder How the already-installed part of the list is ordered.
 * @param includeInstalling Whether first installs in progress get a slot at all.
 * @param collection Id of a Steam collection to narrow the list down to; empty or `undefined` for
 * the whole library. A collection that no longer exists yields an empty list rather than quietly
 * falling back to everything, so the keys read as "this needs looking at".
 * @param includeMissing Whether the collection's games that are not installed get a slot too, after
 * every installed one. Ignored without a collection: there is no local list of every game an account
 * owns to draw them from.
 * @returns The combined list.
 */
export async function librarySlots(
  sortOrder: SortOrder,
  includeInstalling: boolean,
  collection?: string,
  includeMissing = false,
): Promise<LibrarySlot[]> {
  const inCollection = await collectionFilter(collection);

  const installing: LibrarySlot[] = includeInstalling
    ? (await getInstallingGames()).filter(inCollection).map((game) => ({
        appId: game.appId,
        name: game.name,
        installing: true,
        fraction: game.fraction,
      }))
    : [];

  const installed: LibrarySlot[] = sortGames((await getInstalledGames()).filter(inCollection), sortOrder).map((game) => ({
    appId: game.appId,
    name: game.name,
    installing: false,
  }));

  const missing = includeMissing && collection ? await missingSlots(collection, [...installing, ...installed]) : [];

  return [...installing, ...installed, ...missing];
}

/**
 * Lists a collection's games that are on neither list already, most recently played first, since
 * that is the only ordering local data can give a game that is not installed: no name, no size.
 * Never-played games follow by app id, which keeps the order stable from one poll to the next.
 * @param collection Collection id.
 * @param present Slots already listed, installed or installing.
 * @returns The remaining games as slots.
 */
async function missingSlots(collection: string, present: LibrarySlot[]): Promise<LibrarySlot[]> {
  const found = await findCollection(collection);
  if (found === undefined) {
    return [];
  }

  const listed = new Set(present.map((slot) => slot.appId));
  const history = await getPlayHistory();

  return [...found.appIds]
    .filter((appId) => !listed.has(appId) && /^\d{1,10}$/.test(appId))
    .sort((a, b) => (history.get(b) ?? 0) - (history.get(a) ?? 0) || Number(a) - Number(b))
    .map((appId) => ({ appId, name: `App ${appId}`, installing: false, missing: true }));
}

/**
 * Builds the membership test for {@link librarySlots}, and for anything else that picks games out
 * of a collection.
 * @param collection Collection id, or empty / `undefined` for the whole library.
 * @returns A predicate over anything carrying an app id.
 */
export async function collectionFilter(collection: string | undefined): Promise<(game: { appId: string }) => boolean> {
  if (collection === undefined || collection === "") {
    return () => true;
  }

  const found = await findCollection(collection);
  if (found === undefined) {
    return () => false;
  }

  return (game) => found.appIds.has(game.appId);
}

/**
 * Builds the items for a property inspector's collection picker: the whole library first, then
 * every static collection the signed-in account has, by name. Each one says how many of its games
 * are installed out of how many it holds, since only the installed ones show up by default.
 * @param refresh Whether to re-read the collections rather than reuse the last read.
 * @returns Items for the property inspector's select.
 */
export async function collectionPickerItems(refresh: boolean): Promise<{ value: string; label: string }[]> {
  const [collections, games] = await Promise.all([getCollections(refresh), getInstalledGames(refresh)]);
  const installed = new Set(games.map((game) => game.appId));

  return [
    { value: "", label: `Whole library (${installed.size})` },
    ...collections.map((collection) => {
      const total = collection.appIds.size;
      const here = [...collection.appIds].filter((appId) => installed.has(appId)).length;

      return { value: collection.id, label: `${collection.name} (${here} of ${total})` };
    }),
  ];
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
