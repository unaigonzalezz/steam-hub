import streamDeck from "@elgato/streamdeck";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { exists, findSteam, forgetSteam, type SteamInstall } from "./paths";
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
  const steam = await findSteam();
  if (steam === undefined) {
    return [];
  }

  const libraries = await listLibraries(steam);
  const perLibrary = await Promise.all(libraries.map((library) => readLibrary(library)));

  // The same app can appear twice if a library was copied rather than moved; first one wins.
  const games = new Map<string, SteamGame>();
  for (const game of perLibrary.flat()) {
    if (!games.has(game.appId)) {
      games.set(game.appId, game);
    }
  }

  const result = [...games.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  streamDeck.logger.info(`Found ${result.length} installed game(s) across ${libraries.length} library folder(s)`);

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
 * Reads every app manifest in a single library folder.
 * @param library Absolute path to the library, e.g. `E:\SteamLibrary`.
 * @returns Installed games found there.
 */
async function readLibrary(library: string): Promise<SteamGame[]> {
  const steamapps = path.join(library, "steamapps");

  let entries: string[];
  try {
    entries = await readdir(steamapps);
  } catch (err) {
    streamDeck.logger.warn(`Could not read library ${steamapps}`, err);
    return [];
  }

  const manifests = entries.filter((entry) => /^appmanifest_\d+\.acf$/i.test(entry));
  const games = await Promise.all(manifests.map((entry) => readManifest(path.join(steamapps, entry), library)));

  return games.filter((game): game is SteamGame => game !== undefined);
}

/**
 * Parses a single `appmanifest_*.acf` into a game, filtering out anything that is not launchable.
 * @param file Absolute path to the manifest.
 * @param library Library the manifest belongs to.
 * @returns The game, or `undefined` when the entry should not be offered to the user.
 */
async function readManifest(file: string, library: string): Promise<SteamGame | undefined> {
  const parsed = await readVdfFile(file);
  if (parsed === undefined) {
    return undefined;
  }

  const state = getObject(parsed, "AppState") ?? firstObject(parsed);
  const appId = getString(state, "appid")?.trim();
  if (appId === undefined || !/^\d{1,10}$/.test(appId)) {
    return undefined;
  }

  if ((getNumber(state, "StateFlags") & STATE_FULLY_INSTALLED) === 0) {
    return undefined; // queued or mid-download, launching it would just open a progress bar
  }

  // Fall back to the app id so a manifest with a missing name is still usable rather than blank.
  const name = getString(state, "name")?.trim() || `App ${appId}`;
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
