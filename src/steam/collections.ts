import streamDeck from "@elgato/streamdeck";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { getActiveAccountId } from "./account";
import { findSteam, withTimeout } from "./paths";

/**
 * A collection from the Steam library's sidebar, as the signed-in account has it.
 */
export type SteamCollection = {
  /** Steam's own id, e.g. `"uc-1a2b3c4d5e6f"`, or `"favorite"` / `"hidden"` for the built-in two. */
  id: string;

  /** Name as shown in Steam, already localized for the built-in ones (e.g. "Favoritos"). */
  name: string;

  /** App ids in the collection, installed or not. */
  appIds: Set<string>;
};

/**
 * How long a read is trusted before the file's timestamp is checked again. Keys resolve their
 * collection on every redraw, so this keeps a poll over a full profile down to one `stat`.
 */
const CHECK_TTL = 10_000;

/** Prefix Steam gives every collection entry in its cloud-storage namespace. */
const KEY_PREFIX = "user-collections.";

let cache: { at: number; file: string; mtime: number; collections: SteamCollection[] } | undefined;
let reading: Promise<SteamCollection[]> | undefined;

/**
 * Returns the signed-in account's static collections, sorted by name.
 *
 * Dynamic collections are left out: Steam stores those as a filter over store metadata the client
 * downloads on its own (genres, features, Deck compatibility…), not as a list of games, so there is
 * nothing local to evaluate them against.
 * @param refresh Ignores anything cached and reads the file again.
 * @returns The collections, or an empty list when Steam, the account or the file cannot be found.
 */
export async function getCollections(refresh = false): Promise<SteamCollection[]> {
  if (refresh) {
    cache = undefined;
  } else if (cache !== undefined && Date.now() - cache.at < CHECK_TTL) {
    return cache.collections;
  }

  reading ??= load().finally(() => {
    reading = undefined;
  });

  return reading;
}

/**
 * Looks one collection up by id.
 * @param id Collection id, as stored in a key's settings.
 * @returns The collection, or `undefined` when it no longer exists, deleted or renamed away in Steam.
 */
export async function findCollection(id: string): Promise<SteamCollection | undefined> {
  return (await getCollections()).find((collection) => collection.id === id);
}

/**
 * Reads the collections file, skipping the parse when it has not changed since the last read.
 * @returns The collections.
 */
async function load(): Promise<SteamCollection[]> {
  const file = await collectionsFile();
  if (file === undefined) {
    cache = { at: Date.now(), file: "", mtime: 0, collections: [] };
    return [];
  }

  try {
    const { mtimeMs } = await withTimeout(stat(file));
    if (cache !== undefined && cache.file === file && cache.mtime === mtimeMs) {
      cache.at = Date.now();
      return cache.collections;
    }

    const collections = parseCollections(await withTimeout(readFile(file, "utf8")));
    cache = { at: Date.now(), file, mtime: mtimeMs, collections };
    streamDeck.logger.info(`Found ${collections.length} Steam collection(s)`);

    return collections;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      streamDeck.logger.warn(`Could not read Steam collections from ${file}`, err);
    }

    cache = { at: Date.now(), file, mtime: 0, collections: [] };
    return [];
  }
}

/**
 * Resolves where the signed-in account's collections live. Steam keeps them in the first of its
 * cloud-storage namespaces, the same file it syncs across machines, under the account's `userdata`.
 * @returns Absolute path, or `undefined` when there is no Steam or no account to look under.
 */
async function collectionsFile(): Promise<string | undefined> {
  const [steam, accountId] = await Promise.all([findSteam(), getActiveAccountId()]);
  if (steam === undefined || accountId === undefined) {
    return undefined;
  }

  return path.join(steam.root, "userdata", accountId, "config", "cloudstorage", "cloud-storage-namespace-1.json");
}

/**
 * Parses the cloud-storage namespace into collections.
 *
 * The file is a JSON array of `[key, entry]` pairs, where each collection's entry carries its own
 * definition as a JSON string in `value`: `{ id, name, added: number[], removed: number[] }` for a
 * static collection, `{ id, name, filterSpec }` for a dynamic one. A deleted collection stays in the
 * file, flagged `is_deleted`, until Steam gets round to compacting it.
 * @param text Raw file contents.
 * @returns Static, live collections, sorted by name.
 */
export function parseCollections(text: string): SteamCollection[] {
  const root: unknown = JSON.parse(text);
  if (!Array.isArray(root)) {
    return [];
  }

  const collections: SteamCollection[] = [];

  for (const pair of root) {
    if (!Array.isArray(pair) || typeof pair[0] !== "string" || !pair[0].startsWith(KEY_PREFIX)) {
      continue;
    }

    const entry = pair[1] as { is_deleted?: boolean; value?: unknown } | undefined;
    if (entry === undefined || entry.is_deleted === true || typeof entry.value !== "string") {
      continue;
    }

    let value: { id?: unknown; name?: unknown; added?: unknown; removed?: unknown };
    try {
      value = JSON.parse(entry.value) as typeof value;
    } catch {
      continue; // one malformed entry should not cost the user every other collection
    }

    if (typeof value.id !== "string" || !Array.isArray(value.added)) {
      continue; // dynamic, or a partner placeholder with no games of its own
    }

    const removed = new Set(Array.isArray(value.removed) ? value.removed.map(String) : []);
    const appIds = new Set(value.added.map(String).filter((appId) => !removed.has(appId)));
    const name = typeof value.name === "string" && value.name.trim() !== "" ? value.name.trim() : value.id;

    collections.push({ id: value.id, name, appIds });
  }

  return collections.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}
