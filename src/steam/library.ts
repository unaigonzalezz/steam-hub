import streamDeck from "@elgato/streamdeck";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { exists, findSteam, forgetSteam, type SteamInstall, withTimeout } from "./paths";
import { getNumber, getObject, getString, parseVdf, type VdfObject } from "./vdf";

/**
 * A game installed on this machine.
 */
export type SteamGame = {
  /** Steam application id, e.g. `"1113000"`. */
  appId: string;

  /** Display name as Steam knows it. */
  name: string;

  /** Library the game lives in, e.g. `E:\SteamLibrary`. */
  library: string;

  /** Installed size in bytes; `0` when Steam has not recorded one. */
  sizeOnDisk: number;

  /** Unix timestamp of the last session; `0` when never played. */
  lastPlayed: number;
};

/** Bit 2 of `StateFlags`, set once a depot is fully on disk, and stays set during updates. */
const STATE_FULLY_INSTALLED = 4;

/**
 * Depots that ship as apps but are never launchable. Matched on name because the app ids churn
 * with every new Proton / runtime release, and a stale id list silently starts leaking entries.
 */
const NOT_A_GAME = /^(?:proton|steam linux runtime|steam runtime|steamworks|steamvr\b)/i;

/** How long a scan stays fresh. Keys redraw far more often than libraries change. */
const CACHE_TTL = 60_000;

let cache: { at: number; games: SteamGame[] } | undefined;
let scanning: Promise<SteamGame[]> | undefined;
let generation = 0;

/**
 * Returns the installed games, reusing a recent scan when there is one. Concurrent callers, a
 * page of keys appearing at once, say, share a single scan rather than each walking the disk.
 * @param refresh Discards everything cached, including the located Steam installation, and rescans.
 * @returns Installed games, sorted by name.
 */
export async function getInstalledGames(refresh = false): Promise<SteamGame[]> {
  if (refresh) {
    // A scan already in flight was started against the stale state, so it must not be reused,
    // nor be allowed to write its result over the fresh one it is racing.
    cache = undefined;
    scanning = undefined;
    generation++;
    forgetSteam();
  } else if (cache !== undefined && Date.now() - cache.at < CACHE_TTL) {
    return cache.games;
  }

  if (scanning === undefined) {
    const era = generation;
    const task: Promise<SteamGame[]> = listInstalledGames()
      .then((games) => {
        if (era === generation) {
          cache = { at: Date.now(), games };
        }
        return games;
      })
      .catch((err) => {
        // Every caller treats this as "nothing to show" rather than a rejection to handle, same as
        // `getAppStates` does for the registry read. Letting this reject instead would leave a key
        // press or a property inspector request permanently unresolved.
        streamDeck.logger.error("Could not scan for installed games", err);
        return [];
      })
      .finally(() => {
        if (scanning === task) {
          scanning = undefined;
        }
      });

    scanning = task;
  }

  return scanning;
}

/**
 * Looks a single game up by id.
 * @param appId Steam application id.
 * @returns The game, or `undefined` when it is not installed.
 */
export async function findGame(appId: string): Promise<SteamGame | undefined> {
  return (await getInstalledGames()).find((game) => game.appId === appId);
}

/** One entry in a property inspector's game picker. */
export type PickerItem = {
  value: string;
  label: string;
};

/** A labelled group of picker entries, rendered as an `<optgroup>`. */
export type PickerGroup = {
  label: string;
  children: PickerItem[];
};

/** How many games the picker's "Recently played" group holds before the full list takes over. */
const RECENT_COUNT = 8;

/**
 * Builds a property inspector's game picker, putting the games actually played recently within
 * immediate reach and keeping the complete alphabetical list underneath. Recent games appear in
 * both groups on purpose: the top group is a shortcut, not a filter.
 * @param games Installed games, sorted by name.
 * @returns Items for the property inspector's select.
 */
export function groupForPicker(games: SteamGame[]): PickerItem[] | PickerGroup[] {
  const all = games.map((game) => ({ value: game.appId, label: game.name }));

  const recent = games
    .filter((game) => game.lastPlayed > 0)
    .sort((a, b) => b.lastPlayed - a.lastPlayed)
    .slice(0, RECENT_COUNT)
    .map((game) => ({ value: game.appId, label: game.name }));

  if (recent.length === 0) {
    return all; // nothing has been played yet, so a flat list is less noise
  }

  return [
    { label: "Recently played", children: recent },
    { label: "All games", children: all },
  ];
}

/**
 * Orders a library listing.
 */
export type SortOrder = "name" | "recent" | "size";

/**
 * Sorts games for display, always breaking ties by name so that the same library produces the same
 * order every time, which is what lets a whole profile of indexed keys stay stable between scans.
 * @param games Games to sort.
 * @param order Ordering to apply.
 * @returns A new, sorted array.
 */
export function sortGames(games: SteamGame[], order: SortOrder): SteamGame[] {
  const byName = (a: SteamGame, b: SteamGame): number =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" });

  return [...games].sort((a, b) => {
    switch (order) {
      case "recent":
        return b.lastPlayed - a.lastPlayed || byName(a, b);
      case "size":
        return b.sizeOnDisk - a.sizeOnDisk || byName(a, b);
      default:
        return byName(a, b);
    }
  });
}

/**
 * Scans every Steam library on this machine for installed games.
 * @returns Installed games, sorted by name.
 */
export async function listInstalledGames(): Promise<SteamGame[]> {
  const entries = await scanManifests();

  // The same app can appear twice if a library was copied rather than moved; first one wins.
  const games = new Map<string, SteamGame>();
  for (const entry of entries) {
    const game = toInstalledGame(entry);
    if (game !== undefined && !games.has(game.appId)) {
      games.set(game.appId, game);
    }
  }

  const result = [...games.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  const libraryCount = new Set(entries.map((entry) => entry.library)).size;
  streamDeck.logger.info(`Found ${result.length} installed game(s) across ${libraryCount} library folder(s)`);

  return result;
}

/**
 * Resolves every library folder, including the one inside the Steam installation itself.
 * @param steam Located Steam installation.
 * @returns Absolute library paths, de-duplicated.
 */
export async function listLibraries(steam: SteamInstall): Promise<string[]> {
  const found = [steam.root];

  // Modern Steam keeps this under `steamapps`; older builds kept it under `config`.
  for (const location of [
    path.join(steam.root, "steamapps", "libraryfolders.vdf"),
    path.join(steam.root, "config", "libraryfolders.vdf"),
  ]) {
    const parsed = await readVdfFile(location);
    if (parsed === undefined) {
      continue;
    }

    // The file has a single root block, named `libraryfolders` or `LibraryFolders`.
    const root = getObject(parsed, "libraryfolders") ?? firstObject(parsed);
    for (const [key, node] of Object.entries(root ?? {})) {
      if (!/^\d+$/.test(key)) {
        continue; // skips the bookkeeping keys old versions mixed in
      }

      // Old format: `"1" "D:\\SteamLibrary"`. New format: `"1" { "path" "D:\\SteamLibrary" }`.
      const library = typeof node === "string" ? node : getString(node, "path");
      if (library !== undefined && library !== "") {
        found.push(library);
      }
    }

    break; // first file that parses wins
  }

  const seen = new Set<string>();
  const libraries: string[] = [];
  for (const entry of found) {
    const normalised = path.normalize(entry.replace(/[\\/]+$/, ""));
    const key = process.platform === "win32" ? normalised.toLowerCase() : normalised;
    if (!seen.has(key) && (await exists(path.join(normalised, "steamapps")))) {
      seen.add(key);
      libraries.push(normalised);
    }
  }

  return libraries;
}

/**
 * One parsed `appmanifest_*.acf`, before any installed/launchable filtering is applied. Shared by
 * {@link listInstalledGames} and the install-progress scan below, since both start from exactly the
 * same files and there is no reason to walk every library's `steamapps` folder twice.
 */
type ManifestEntry = {
  appId: string;
  name: string;
  library: string;
  state: VdfObject;
};

/**
 * Parses every app manifest across every library on this machine. Unfiltered: a manifest for a
 * queued or mid-download app comes back just the same as an installed one, it is up to the caller
 * to decide what counts.
 * @returns Every manifest entry found.
 */
async function scanManifests(): Promise<ManifestEntry[]> {
  const steam = await findSteam();
  if (steam === undefined) {
    return [];
  }

  const libraries = await listLibraries(steam);
  const perLibrary = await Promise.all(libraries.map((library) => readLibraryManifests(library)));

  return perLibrary.flat();
}

/**
 * Reads every app manifest in a single library folder.
 * @param library Absolute path to the library, e.g. `E:\SteamLibrary`.
 * @returns Manifest entries found there.
 */
async function readLibraryManifests(library: string): Promise<ManifestEntry[]> {
  const steamapps = path.join(library, "steamapps");

  // `exists` already bounds a dead library's own probe; this covers the rarer case where that
  // check answered but the actual listing then hangs, a slow network share, say.
  let entries: string[];
  try {
    entries = await withTimeout(readdir(steamapps));
  } catch (err) {
    streamDeck.logger.warn(`Could not read library ${steamapps}`, err);
    return [];
  }

  const manifests = entries.filter((entry) => /^appmanifest_\d+\.acf$/i.test(entry));
  const parsed = await Promise.all(manifests.map((entry) => readManifestEntry(path.join(steamapps, entry), library)));

  return parsed.filter((entry): entry is ManifestEntry => entry !== undefined);
}

/**
 * Parses a single `appmanifest_*.acf` into a {@link ManifestEntry}.
 * @param file Absolute path to the manifest.
 * @param library Library the manifest belongs to.
 * @returns The entry, or `undefined` when the file could not be read as a manifest with an app id.
 */
async function readManifestEntry(file: string, library: string): Promise<ManifestEntry | undefined> {
  const parsed = await readVdfFile(file);
  if (parsed === undefined) {
    return undefined;
  }

  const state = getObject(parsed, "AppState") ?? firstObject(parsed);
  const appId = getString(state, "appid")?.trim();
  if (state === undefined || appId === undefined || !/^\d{1,10}$/.test(appId)) {
    return undefined;
  }

  // Fall back to the app id so a manifest with a missing name is still usable rather than blank.
  const name = getString(state, "name")?.trim() || `App ${appId}`;

  return { appId, name, library, state };
}

/**
 * Applies the installed/launchable filter to a manifest entry, the same rules
 * {@link listInstalledGames} has always used.
 * @param entry Manifest entry to filter.
 * @returns The game, or `undefined` when the entry should not be offered to the user.
 */
function toInstalledGame(entry: ManifestEntry): SteamGame | undefined {
  const { appId, name, library, state } = entry;

  if ((getNumber(state, "StateFlags") & STATE_FULLY_INSTALLED) === 0) {
    return undefined; // queued or mid-download, launching it would just open a progress bar
  }

  if (NOT_A_GAME.test(name) || getString(state, "installdir")?.startsWith("Steamworks Shared")) {
    return undefined;
  }

  return {
    appId,
    name,
    library,
    sizeOnDisk: getNumber(state, "SizeOnDisk"),
    lastPlayed: getNumber(state, "LastPlayed"),
  };
}

/** Live install/update progress for one app, straight off its manifest. */
type ManifestProgress = {
  appId: string;
  name: string;
  fullyInstalled: boolean;

  /** Fraction downloaded, in `[0, 1]`; `undefined` when `BytesToDownload` is `0` or absent. */
  fraction?: number;

  /** When Steam last launched the app, in epoch seconds; `0` when never. */
  lastPlayed: number;
};

/**
 * How long a progress scan stays fresh. Much shorter than {@link getInstalledGames}'s own cache:
 * bytes downloaded moves continuously during an active transfer, where the list of installed games
 * barely changes minute to minute. Just under the once-a-second clock that repaints download rings,
 * so each tick reads fresh numbers while keys painted in the same tick still share one scan.
 */
const PROGRESS_TTL = 800;

let progressCache: { at: number; progress: Map<string, ManifestProgress> } | undefined;
let progressScanning: Promise<Map<string, ManifestProgress>> | undefined;

/**
 * App ids that were not yet fully installed as of the previous scan, so a transition to fully
 * installed, or the manifest simply disappearing, can be told apart from "still downloading".
 */
let previouslyIncomplete = new Set<string>();

/**
 * Reads every manifest's install/update progress, cached briefly so several keys or a dial polling
 * at once share one disk scan rather than each re-reading every `.acf` file.
 * @returns Progress by app id.
 */
async function getManifestProgress(): Promise<Map<string, ManifestProgress>> {
  if (progressCache !== undefined && Date.now() - progressCache.at < PROGRESS_TTL) {
    return progressCache.progress;
  }

  if (progressScanning === undefined) {
    const task = scanManifests()
      .then((entries) => {
        const progress = new Map<string, ManifestProgress>();
        const incomplete = new Set<string>();

        for (const entry of entries) {
          if (NOT_A_GAME.test(entry.name)) {
            continue;
          }

          const fullyInstalled = (getNumber(entry.state, "StateFlags") & STATE_FULLY_INSTALLED) !== 0;
          if (!fullyInstalled) {
            incomplete.add(entry.appId);
          }

          const toDownload = getNumber(entry.state, "BytesToDownload");
          const downloaded = getNumber(entry.state, "BytesDownloaded");
          const fraction = toDownload > 0 ? Math.min(1, Math.max(0, downloaded / toDownload)) : undefined;

          const lastPlayed = getNumber(entry.state, "LastPlayed");

          progress.set(entry.appId, { appId: entry.appId, name: entry.name, fullyInstalled, fraction, lastPlayed });
        }

        // An app that was mid-install last scan and is not any more, whether it finished or its
        // manifest vanished outright, means `getInstalledGames`'s own 60s cache is now stale: left
        // alone, the game would disappear from both lists for up to a minute. Busting it here keeps
        // the gap to a single progress-scan tick.
        for (const appId of previouslyIncomplete) {
          if (!incomplete.has(appId)) {
            cache = undefined;
            break;
          }
        }
        previouslyIncomplete = incomplete;

        return progress;
      })
      .catch((err) => {
        streamDeck.logger.debug("Could not read Steam install progress", err);
        return new Map<string, ManifestProgress>();
      })
      .finally(() => {
        if (progressScanning === task) {
          progressScanning = undefined;
        }
      });

    progressScanning = task;
  }

  const progress = await progressScanning;
  progressCache = { at: Date.now(), progress };
  return progress;
}

/** A game whose first install, not an update to one already installed, is still in progress. */
export type InstallingGame = {
  appId: string;
  name: string;

  /** Fraction downloaded, in `[0, 1]`; `undefined` when Steam hasn't sized the download yet. */
  fraction?: number;
};

/**
 * Games currently being installed for the first time, i.e. not yet in {@link getInstalledGames} at
 * all. Excludes anything Steam hasn't started sizing yet, which would otherwise show as a slot stuck
 * at an unknown, un-fillable 0%.
 * @returns Installing games, sorted by name.
 */
export async function getInstallingGames(): Promise<InstallingGame[]> {
  const progress = await getManifestProgress();

  return [...progress.values()]
    .filter((entry) => !entry.fullyInstalled && entry.fraction !== undefined)
    .map((entry) => ({ appId: entry.appId, name: entry.name, fraction: entry.fraction }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

/**
 * Live download progress for one app, whether it is installing for the first time or updating one
 * already installed.
 * @param appId Steam application id.
 * @returns Fraction downloaded, in `[0, 1]`, or `undefined` when unknown.
 */
export async function getDownloadFraction(appId: string): Promise<number | undefined> {
  return (await getManifestProgress()).get(appId)?.fraction;
}

/**
 * When Steam last launched an app, read fresh off its manifest rather than from
 * {@link getInstalledGames}'s minute-long cache. Steam stamps `LastPlayed` the moment it launches a
 * game, not when the game exits, so while the game is running this is when its session began.
 * @param appId Steam application id.
 * @returns Epoch milliseconds, or `undefined` when the app has never been launched or is unknown.
 */
export async function getLastPlayed(appId: string): Promise<number | undefined> {
  const seconds = (await getManifestProgress()).get(appId)?.lastPlayed ?? 0;
  return seconds > 0 ? seconds * 1000 : undefined;
}

/**
 * Reads and parses a VDF file, treating any failure as "not there".
 * @param file Absolute path to the file.
 * @returns The parsed object, or `undefined`.
 */
async function readVdfFile(file: string): Promise<VdfObject | undefined> {
  try {
    return parseVdf(await readFile(file, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      streamDeck.logger.warn(`Could not parse ${file}`, err);
    }
    return undefined;
  }
}

/**
 * Returns the first nested block of an object, used when the root key is not the one we expect.
 * @param obj Object to inspect.
 * @returns The first nested block, or `undefined`.
 */
function firstObject(obj: VdfObject): VdfObject | undefined {
  for (const value of Object.values(obj)) {
    if (typeof value === "object") {
      return value;
    }
  }

  return undefined;
}
