import streamDeck from "@elgato/streamdeck";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * What an app is doing right now.
 */
export type AppStatus = "idle" | "running" | "updating";

/**
 * Live state of a single app, as Steam reports it.
 */
type AppState = {
  running: boolean;
  updating: boolean;
};

/**
 * Registry key Steam keeps a live `Running` / `Updating` flag under, per app.
 *
 * This is how the Steam client itself drives the "Play / Stop" button, so it flips the instant a
 * game starts or exits, no process scanning, no polling of the game itself.
 */
const APPS_KEY = "HKCU\\Software\\Valve\\Steam\\Apps";

/** Matches the `HKEY_CURRENT_USER\...\Apps\<appid>` line that opens each block. */
const KEY_LINE = /^HKEY_CURRENT_USER\\.*\\Apps\\(\d{1,10})\s*$/i;

/**
 * Matches a DWORD value line. `reg.exe` separates the three columns with runs of spaces, and does
 * not localise the type names, so this holds on a non-English Windows too.
 */
const DWORD_LINE = /^\s+(\S.*?)\s{2,}REG_DWORD\s{2,}0x([0-9a-f]+)\s*$/i;

/**
 * How long a reading stays fresh. Short enough that a key reacts to a game starting within a
 * poll or two, long enough that several keys share one `reg.exe` call.
 */
const CACHE_TTL = 2_000;

let cache: { at: number; states: Map<string, AppState> } | undefined;
let reading: Promise<Map<string, AppState>> | undefined;

/**
 * Reads the live state of every app Steam is tracking.
 *
 * The whole subtree is read in one call rather than one call per key, so a full page of game keys
 * costs a single short-lived process every couple of seconds.
 * @returns App states by app id; empty on platforms without a Windows registry.
 */
export async function getAppStates(): Promise<Map<string, AppState>> {
  if (process.platform !== "win32") {
    return new Map(); // macOS and Linux would need process inspection; keys simply show no badge
  }

  if (cache !== undefined && Date.now() - cache.at < CACHE_TTL) {
    return cache.states;
  }

  if (reading === undefined) {
    const task = read()
      .then((states) => {
        cache = { at: Date.now(), states };
        return states;
      })
      .catch((err) => {
        streamDeck.logger.debug("Could not read Steam app states", err);
        return new Map<string, AppState>();
      })
      .finally(() => {
        if (reading === task) {
          reading = undefined;
        }
      });

    reading = task;
  }

  return reading;
}

/**
 * Resolves one app's status.
 * @param appId Steam application id.
 * @returns What that app is doing.
 */
export async function getAppStatus(appId: string): Promise<AppStatus> {
  const state = (await getAppStates()).get(appId);

  if (state?.updating === true) {
    return "updating";
  }

  return state?.running === true ? "running" : "idle";
}

/**
 * Shells out to `reg.exe` and parses its output.
 * @returns App states by app id.
 */
async function read(): Promise<Map<string, AppState>> {
  const { stdout } = await execFileAsync("reg", ["query", APPS_KEY, "/s"], {
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 8 * 1024 * 1024,
  });

  const states = new Map<string, AppState>();
  let current: AppState | undefined;

  for (const line of stdout.split(/\r?\n/)) {
    const key = KEY_LINE.exec(line);
    if (key !== null) {
      current = { running: false, updating: false };
      states.set(key[1]!, current);
      continue;
    }

    if (current === undefined) {
      continue;
    }

    const value = DWORD_LINE.exec(line);
    if (value !== null) {
      const set = Number.parseInt(value[2]!, 16) !== 0;
      if (/^Running$/i.test(value[1]!)) {
        current.running = set;
      } else if (/^Updating$/i.test(value[1]!)) {
        current.updating = set;
      }
    }
  }

  return states;
}
