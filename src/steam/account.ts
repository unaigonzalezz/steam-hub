import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { findSteam } from "./paths";
import { getObject, getString, parseVdf } from "./vdf";

const execFileAsync = promisify(execFile);

/** How long a resolved account id is trusted before being looked up again. */
const ACCOUNT_TTL = 5 * 60_000;

/** Offset between a 64-bit SteamID and the 32-bit account id it carries in its low bits. */
const STEAMID64_BASE = 76561197960265728n;

let accountCache: { at: number; id: string | undefined } | undefined;

/**
 * Resolves the account id (the 32-bit SteamID3 form) of whoever is using the local Steam client.
 * This is the id `appcache/stats` filenames and `userdata` folders carry, not the full 64-bit
 * SteamID, and it is what lets a shared machine's files be matched to the right account.
 *
 * Asks the running client first, through the registry, since that is the account actually signed
 * in right now. With Steam closed, or off Windows, falls back to the account Steam marks as the most
 * recent login, and failing that to the only `userdata` folder there is, if there is just one.
 * @returns The account id, or `undefined` when no account can be told apart.
 */
export async function getActiveAccountId(): Promise<string | undefined> {
  if (accountCache !== undefined && Date.now() - accountCache.at < ACCOUNT_TTL) {
    return accountCache.id;
  }

  const id = (await fromRegistry()) ?? (await fromLoginUsers()) ?? (await fromSoleUserdata());

  accountCache = { at: Date.now(), id };
  return id;
}

/**
 * Reads the account the running client has signed in, on Windows.
 * @returns The account id, or `undefined` when Steam is not running or nobody is signed in.
 */
async function fromRegistry(): Promise<string | undefined> {
  if (process.platform !== "win32") {
    return undefined; // the registry key this reads is Windows-only
  }

  try {
    const { stdout } = await execFileAsync(
      "reg",
      ["query", "HKCU\\Software\\Valve\\Steam\\ActiveProcess", "/v", "ActiveUser"],
      { windowsHide: true, timeout: 5_000 },
    );

    const match = /REG_DWORD\s+0x([0-9a-f]+)/i.exec(stdout);
    const value = match !== null ? Number.parseInt(match[1]!, 16) : 0;
    return value > 0 ? String(value) : undefined;
  } catch {
    return undefined; // Steam not installed, not signed in, or the key is otherwise unreadable
  }
}

/**
 * Reads the account `config/loginusers.vdf` flags as the most recent login.
 * @returns The account id, or `undefined` when the file is missing or flags nobody.
 */
async function fromLoginUsers(): Promise<string | undefined> {
  const steam = await findSteam();
  if (steam === undefined) {
    return undefined;
  }

  try {
    const parsed = parseVdf(await readFile(path.join(steam.root, "config", "loginusers.vdf"), "utf8"));
    const users = getObject(parsed, "users") ?? {};

    for (const [steamId, node] of Object.entries(users)) {
      if (typeof node === "object" && getString(node, "MostRecent") === "1" && /^\d{17}$/.test(steamId)) {
        return String(BigInt(steamId) - STEAMID64_BASE);
      }
    }
  } catch {
    // missing or unreadable, the caller moves on to the next guess
  }

  return undefined;
}

/**
 * Picks the account behind `userdata` when it holds exactly one, which on most machines it does.
 * @returns The account id, or `undefined` when there are none, or several to choose between.
 */
async function fromSoleUserdata(): Promise<string | undefined> {
  const steam = await findSteam();
  if (steam === undefined) {
    return undefined;
  }

  try {
    const accounts = (await readdir(path.join(steam.root, "userdata"))).filter((entry) => /^[1-9]\d*$/.test(entry));
    return accounts.length === 1 ? accounts[0] : undefined;
  } catch {
    return undefined;
  }
}
