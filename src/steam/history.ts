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

let cache: { at: number; file: string; mtime: number; lastPlayed: Map<string, number> } | undefined;
let reading: Promise<Map<string, number>> | undefined;

/**
 * When the signed-in account last played each game it has ever launched, installed here or not.
 *
 * App manifests only exist for installed games, so this is the one local record of play history
 * that also covers games since uninstalled: Steam keeps it per account in
 * `userdata/<account>/config/localconfig.vdf`, under `Software/Valve/Steam/apps/<appid>/LastPlayed`.
 * @returns Epoch seconds by app id; games never played are simply absent.
 */
export async function getPlayHistory(): Promise<Map<string, number>> {
  if (cache !== undefined && Date.now() - cache.at < CHECK_TTL) {
    return cache.lastPlayed;
  }

  reading ??= load().finally(() => {
    reading = undefined;
  });

  return reading;
}

/**
 * Reads `localconfig.vdf`, skipping the parse when it has not changed since the last read.
 * @returns Epoch seconds by app id.
 */
async function load(): Promise<Map<string, number>> {
  const [steam, accountId] = await Promise.all([findSteam(), getActiveAccountId()]);
  const file =
    steam === undefined || accountId === undefined
      ? undefined
      : path.join(steam.root, "userdata", accountId, "config", "localconfig.vdf");

  if (file === undefined) {
    cache = { at: Date.now(), file: "", mtime: 0, lastPlayed: new Map() };
    return cache.lastPlayed;
  }

  try {
    const { mtimeMs } = await withTimeout(stat(file));
    if (cache !== undefined && cache.file === file && cache.mtime === mtimeMs) {
      cache.at = Date.now();
      return cache.lastPlayed;
    }

    const root = parseVdf(await withTimeout(readFile(file, "utf8")));
    const apps = getObject(
      getObject(getObject(getObject(getObject(root, "UserLocalConfigStore"), "Software"), "Valve"), "Steam"),
      "apps",
    );

    const lastPlayed = new Map<string, number>();
    for (const [appId, node] of Object.entries(apps ?? {})) {
      const at = typeof node === "object" ? getNumber(node, "LastPlayed") : 0;
      if (at > 0) {
        lastPlayed.set(appId, at);
      }
    }

    cache = { at: Date.now(), file, mtime: mtimeMs, lastPlayed };
    return lastPlayed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      streamDeck.logger.warn(`Could not read play history from ${file}`, err);
    }

    cache = { at: Date.now(), file, mtime: 0, lastPlayed: new Map() };
    return cache.lastPlayed;
  }
}
