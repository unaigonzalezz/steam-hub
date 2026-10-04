import streamDeck from "@elgato/streamdeck";
import { open, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { getActiveAccountId } from "./account";
import { isSteamRunning } from "./launch";
import { findSteam } from "./paths";
import { getRunningGame } from "./running";

/**
 * The friends-list state the signed-in user shows as, the four Steam's own menu offers, plus
 * "in game", which Steam shows on top of any of them while a game is running.
 */
export type PersonaState = "online" | "away" | "invisible" | "offline" | "ingame";

/**
 * Reads the signed-in user's state.
 *
 * Steam saves the chosen state to `userdata/<account>/config/localconfig.vdf`, as `ePersonaState`
 * in the `FriendStoreLocalPrefs_<account>` blob, within a second of it changing: 1 online, 3 away,
 * 7 invisible. Going offline is the exception, it is never saved, and the file goes on holding
 * whatever came before. When it is set through a `steam://friends/status/offline` link, though,
 * from this plugin or anything else, the client logs the command in `logs/console_log.txt`, so an
 * "offline" there newer than the last save of the file means offline. Set from Steam's own menu it
 * leaves no trace anywhere, and the previous state shows until the next change.
 * @returns The state, `offline` when Steam is not running, and `ingame` while a game is.
 */
export async function getPersonaState(): Promise<PersonaState> {
  if (!(await isSteamRunning())) {
    return "offline";
  }

  const steam = await findSteam();
  const account = await getActiveAccountId();
  if (steam === undefined || account === undefined) {
    return "online";
  }

  const configFile = path.join(steam.root, "userdata", account, "config", "localconfig.vdf");
  const [chosen, lastCommand] = await Promise.all([
    readChosenState(configFile, account),
    readLastStatusCommand(path.join(steam.root, "logs", "console_log.txt")),
  ]);

  const offline =
    lastCommand?.state === "offline" && (chosen === undefined || lastCommand.at >= floorToSecond(chosen.savedAt));

  if (offline) {
    return "offline";
  }

  const running = await getRunningGame();
  if (running?.badge === "running" && chosen?.state !== "invisible") {
    return "ingame"; // invisible keeps showing as invisible, the way friends see it
  }

  return chosen?.state ?? "online";
}

/** The state `localconfig.vdf` holds, and when the file was saved, in epoch milliseconds. */
type ChosenState = { state: Exclude<PersonaState, "offline" | "ingame">; savedAt: number };

let configCache: { file: string; mtime: number; value: ChosenState | undefined } | undefined;

/**
 * Reads the state saved in `localconfig.vdf`, re-reading the 200 KB file only when it changed.
 * @param file Absolute path to the account's `localconfig.vdf`.
 * @param account The account id the prefs blob is named after.
 * @returns The saved state, or `undefined` when the file or the blob is missing.
 */
async function readChosenState(file: string, account: string): Promise<ChosenState | undefined> {
  try {
    const { mtimeMs } = await stat(file);
    if (configCache?.file === file && configCache.mtime === mtimeMs) {
      return configCache.value;
    }

    // A full VDF parse of the whole file for one value would be wasted work; the blob is one line.
    const text = await readFile(file, "utf8");
    const match = new RegExp(`"FriendStoreLocalPrefs_${account}"\\s+"(.*)"`).exec(text);
    const code = /ePersonaState\\?"\s*:\s*(\d+)/.exec(match?.[1] ?? "")?.[1];

    const value: ChosenState | undefined =
      code === undefined ? undefined : { state: stateFromCode(Number(code)), savedAt: mtimeMs };

    configCache = { file, mtime: mtimeMs, value };
    return value;
  } catch (err) {
    streamDeck.logger.debug(`Could not read the persona state from ${file}`, err);
    return undefined;
  }
}

/**
 * Maps Steam's `EPersonaState` onto the states the friends menu offers. Busy and snooze, which the
 * current client no longer offers but older ones may have saved, read as away; looking to trade or
 * play as online.
 * @param code The saved value.
 * @returns The state.
 */
function stateFromCode(code: number): ChosenState["state"] {
  switch (code) {
    case 7:
      return "invisible";
    case 2:
    case 3:
    case 4:
      return "away";
    default:
      return "online";
  }
}

/** How much of the console log's tail is searched for the last status command. */
const CONSOLE_TAIL_BYTES = 64 * 1024;

const STATUS_COMMAND =
  /^\[(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\] ExecCommandLine: .*steam:\/\/friends\/status\/(online|away|invisible|offline)/;

let consoleCache: { file: string; mtime: number; value: { state: string; at: number } | undefined } | undefined;

/**
 * Finds the most recent `steam://friends/status/...` command in the console log.
 * @param file Absolute path to `console_log.txt`.
 * @returns The state it asked for and when, in epoch milliseconds, or `undefined` when there is none.
 */
async function readLastStatusCommand(file: string): Promise<{ state: string; at: number } | undefined> {
  try {
    const { size, mtimeMs } = await stat(file);
    if (consoleCache?.file === file && consoleCache.mtime === mtimeMs) {
      return consoleCache.value;
    }

    const handle = await open(file, "r");
    let text: string;
    try {
      const length = Math.min(size, CONSOLE_TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, size - length);
      text = buffer.toString("utf8");
    } finally {
      await handle.close();
    }

    let value: { state: string; at: number } | undefined;
    for (const line of text.split(/\r?\n/)) {
      const match = STATUS_COMMAND.exec(line);
      if (match !== null) {
        const [, year, month, day, hour, minute, second, state] = match;
        value = { state: state!, at: new Date(+year!, +month! - 1, +day!, +hour!, +minute!, +second!).getTime() };
      }
    }

    consoleCache = { file, mtime: mtimeMs, value };
    return value;
  } catch {
    return undefined;
  }
}

/**
 * Drops the milliseconds, to compare a file time against the log's whole-second stamps.
 * @param ms Epoch milliseconds.
 * @returns The same instant, rounded down to the second.
 */
function floorToSecond(ms: number): number {
  return Math.floor(ms / 1000) * 1000;
}
