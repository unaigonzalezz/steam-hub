import streamDeck from "@elgato/streamdeck";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { getActiveAccountId } from "./account";
import { findSteam, withTimeout } from "./paths";
import { getNumber, getObject, parseVdf } from "./vdf";

/**
 * How long a read is trusted before the file's timestamp is checked again. Only games that are not
 * installed lean on this, and their play history cannot change until they are installed again.
 */
const CHECK_TTL = 60_000;

/** What `localconfig.vdf` records per game, by app id. */
type History = {
  /** Epoch seconds of the last session; games never played are absent. */
  lastPlayed: Map<string, number>;

  /** Total minutes played; games never played are absent. */
  playtime: Map<string, number>;

  /** Minutes played over the last two weeks; games not played in that time are absent. */
  playtime2wks: Map<string, number>;
};

let cache: ({ at: number; file: string; mtime: number } & History) | undefined;
let reading: Promise<History> | undefined;

/**
 * When the signed-in account last played each game it has ever launched, installed here or not.
 *
 * App manifests only exist for installed games, so this is the one local record of play history
 * that also covers games since uninstalled: Steam keeps it per account in
 * `userdata/<account>/config/localconfig.vdf`, under `Software/Valve/Steam/apps/<appid>/LastPlayed`.
 * @returns Epoch seconds by app id; games never played are simply absent.
 */
export async function getPlayHistory(): Promise<Map<string, number>> {
  return (await getHistory()).lastPlayed;
}

/**
 * How long the signed-in account has played each game, in total, from the same file as
 * {@link getPlayHistory}: `Software/Valve/Steam/apps/<appid>/Playtime`. Steam writes it when a
 * session ends rather than as it goes, so it does not count up while a game is running.
 * @returns Minutes by app id; games never played are simply absent.
 */
export async function getPlaytime(): Promise<Map<string, number>> {
  return (await getHistory()).playtime;
}

/**
 * How long the signed-in account has played each game over the last two weeks, from the same file
 * as {@link getPlayHistory}: `Software/Valve/Steam/apps/<appid>/Playtime2wks`. Like the total, it
 * only moves when a session ends.
 * @returns Minutes by app id; games not played in that time are simply absent.
 */
export async function getRecentPlaytime(): Promise<Map<string, number>> {
  return (await getHistory()).playtime2wks;
}

/**
 * Returns the parsed history, reusing a recent read.
 * @returns Both maps.
 */
async function getHistory(): Promise<History> {
  if (cache !== undefined && Date.now() - cache.at < CHECK_TTL) {
    return cache;
  }

  reading ??= load().finally(() => {
    reading = undefined;
  });

  return reading;
}

/**
 * Reads `localconfig.vdf`, skipping the parse when it has not changed since the last read.
 * @returns What it records, by app id.
 */
async function load(): Promise<History> {
  const [steam, accountId] = await Promise.all([findSteam(), getActiveAccountId()]);
  const file =
    steam === undefined || accountId === undefined
      ? undefined
      : path.join(steam.root, "userdata", accountId, "config", "localconfig.vdf");

  if (file === undefined) {
    cache = { at: Date.now(), file: "", mtime: 0, ...emptyHistory() };
    return cache;
  }

  try {
    const { mtimeMs } = await withTimeout(stat(file));
    if (cache !== undefined && cache.file === file && cache.mtime === mtimeMs) {
      cache.at = Date.now();
      return cache;
    }

    const root = parseVdf(await withTimeout(readFile(file, "utf8")));
    const apps = getObject(
      getObject(getObject(getObject(getObject(root, "UserLocalConfigStore"), "Software"), "Valve"), "Steam"),
      "apps",
    );

    const lastPlayed = new Map<string, number>();
    const playtime = new Map<string, number>();
    const playtime2wks = new Map<string, number>();
    for (const [appId, node] of Object.entries(apps ?? {})) {
      if (typeof node !== "object") {
        continue;
      }

      const at = getNumber(node, "LastPlayed");
      if (at > 0) {
        lastPlayed.set(appId, at);
      }

      const minutes = getNumber(node, "Playtime");
      if (minutes > 0) {
        playtime.set(appId, minutes);
      }

      const recent = getNumber(node, "Playtime2wks");
      if (recent > 0) {
        playtime2wks.set(appId, recent);
      }
    }

    cache = { at: Date.now(), file, mtime: mtimeMs, lastPlayed, playtime, playtime2wks };
    return cache;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      streamDeck.logger.warn(`Could not read play history from ${file}`, err);
    }

    cache = { at: Date.now(), file, mtime: 0, ...emptyHistory() };
    return cache;
  }
}

/**
 * A history with nothing in it, for when there is no file to read.
 * @returns Empty maps.
 */
function emptyHistory(): History {
  return { lastPlayed: new Map(), playtime: new Map(), playtime2wks: new Map() };
}
