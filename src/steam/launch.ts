import streamDeck from "@elgato/streamdeck";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

import { findSteam } from "./paths";
import { getAppStates } from "./status";

const execFileAsync = promisify(execFile);

/**
 * How long a launch gets to show up in Steam's own `Running` / `Updating` flags before it is
 * treated as lost and retried through the other route. Generous, since Steam may have to sync
 * cloud saves or install a prerequisite first, while a lost request never shows up at all.
 */
const LAUNCH_CONFIRM_MS = 20_000;

/** Same, for when Steam itself had to be started first, which takes a good while longer. */
const COLD_LAUNCH_CONFIRM_MS = 60_000;

/** How often the flags are checked while waiting. */
const LAUNCH_POLL_MS = 1_000;

/**
 * Launches a game through Steam.
 *
 * Resolves as soon as the request has been handed over, so the key never waits on the game. On
 * Windows the launch is then watched in the background: if Steam never flags the game as running
 * or updating, the request is taken to have been dropped, which is what happens when the Steam
 * executable found is not the running client's, or the two sit at different privilege levels, and
 * it is sent once more through the shell's `steam://` handler, the same route a desktop shortcut
 * takes. Steam ignores a second request for a game already starting, so the retry is harmless even
 * when the first one was merely slow.
 * @param appId Steam application id.
 */
export async function launchGame(appId: string): Promise<void> {
  if (!/^\d{1,10}$/.test(appId)) {
    throw new Error(`Refusing to launch invalid app id "${appId}"`);
  }

  const url = `steam://rungameid/${appId}`;
  const cold = process.platform === "win32" && !(await isSteamRunning());

  streamDeck.logger.info(`Launching app ${appId}${cold ? " (starting Steam first)" : ""}`);
  const route = await openSteamUrl(url);

  if (process.platform === "win32") {
    void confirmLaunch(appId, url, route, cold ? COLD_LAUNCH_CONFIRM_MS : LAUNCH_CONFIRM_MS);
  }
}

/**
 * The way a `steam://` URL reached Steam: handed straight to its executable, or through the
 * protocol handler Steam registered with the OS.
 */
type LaunchRoute = "executable" | "shell";

/**
 * Waits for Steam to pick a launch up, retrying through the other route once if it never does.
 * @param appId Steam application id being launched.
 * @param url The `steam://` URL that was opened.
 * @param route How it was opened.
 * @param timeoutMs How long to wait before giving up on it.
 */
async function confirmLaunch(appId: string, url: string, route: LaunchRoute, timeoutMs: number): Promise<void> {
  try {
    if (await waitForApp(appId, timeoutMs)) {
      streamDeck.logger.info(`Steam picked up app ${appId}`);
      return;
    }

    const retry: LaunchRoute = route === "executable" ? "shell" : "executable";
    streamDeck.logger.warn(`Steam did not pick up app ${appId} via the ${route}; retrying via the ${retry}`);

    if (!(await openVia(retry, url))) {
      streamDeck.logger.warn(`No ${retry} route available to retry app ${appId}`);
      return;
    }

    if (await waitForApp(appId, LAUNCH_CONFIRM_MS)) {
      streamDeck.logger.info(`Steam picked up app ${appId} on retry`);
    } else {
      streamDeck.logger.error(
        `Steam never picked up app ${appId}. If Steam or Stream Deck runs as administrator, run both the same way.`,
      );
    }
  } catch (err) {
    streamDeck.logger.error(`Could not confirm the launch of app ${appId}`, err);
  }
}

/**
 * Polls Steam's live flags until an app shows up as running or updating.
 * @param appId Steam application id.
 * @param timeoutMs How long to keep polling.
 * @returns Whether it showed up in time.
 */
async function waitForApp(appId: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, LAUNCH_POLL_MS));

    const state = (await getAppStates()).get(appId);
    if (state?.running || state?.updating) {
      return true;
    }
  }

  return false;
}

/**
 * Whether the Steam client is running, from the process id it keeps in the registry while open.
 * @returns `true` when it is, and also when that cannot be told, so a launch is never held back.
 */
async function isSteamRunning(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      "reg",
      ["query", "HKCU\\Software\\Valve\\Steam\\ActiveProcess", "/v", "pid"],
      { windowsHide: true, timeout: 5_000 },
    );

    const match = /REG_DWORD\s+0x([0-9a-f]+)/i.exec(stdout);
    return match === null || Number.parseInt(match[1]!, 16) !== 0;
  } catch {
    return true;
  }
}

/**
 * The `steam://` actions this plugin is willing to trigger.
 *
 * Every verb here was read out of `steamui.dll` rather than guessed, so the list matches what the
 * client actually handles. Anything outside it is refused, which keeps a URL from ever reaching
 * the system protocol handler by accident.
 *
 * The Community Market has no dedicated verb of its own; `steamui.dll` only exposes it through the
 * generic `openurl/%s` (opens a URL in Steam's own browser). That verb takes an arbitrary URL as
 * its argument, so rather than opening the allowlist to any URL, only the literal Market address is
 * permitted through it.
 */
const ALLOWED_URL =
  /^steam:\/\/(?:rungameid\/\d{1,10}|open\/[a-z]+|close\/bigpicture|friends\/status\/(?:online|away|invisible|offline)|nav\/[a-z]+|settings\/[a-z]+|checkforupdates|changeuser|startsteamvr|stopstreaming|store(?:\/\d{1,10})?|uninstall\/\d{1,10}|url\/GameHub\/\d{1,10}|openurl\/https:\/\/steamcommunity\.com\/market\/|exit)$/;

/**
 * Opens a `steam://` URL.
 *
 * Prefers handing the URL straight to the Steam executable: that is exactly what the client does
 * internally, it starts Steam first if it is closed, and it needs no shell, so nothing in the URL
 * can ever be interpreted as anything but a single argument. Registering the protocol with the OS
 * is only the fallback for an installation we could not locate.
 * @param url URL to open.
 * @returns The route it was opened through.
 */
export async function openSteamUrl(url: string): Promise<LaunchRoute> {
  if (!ALLOWED_URL.test(url)) {
    throw new Error(`Refusing to open unrecognised URL "${url}"`);
  }

  if (await openVia("executable", url)) {
    return "executable";
  }

  streamDeck.logger.info("Steam executable not found; falling back to the system protocol handler");
  await openVia("shell", url);
  return "shell";
}

/**
 * Opens an already validated `steam://` URL through one specific route.
 * @param route Route to use.
 * @param url URL to open.
 * @returns `false` when that route is unavailable, i.e. no Steam executable was found.
 */
async function openVia(route: LaunchRoute, url: string): Promise<boolean> {
  if (route === "shell") {
    const [command, args] = protocolHandler(url);
    await spawnDetached(command, args, true);
    return true;
  }

  const steam = await findSteam();
  if (steam?.executable === undefined) {
    return false;
  }

  // On Windows this mirrors the command line Steam registers for its own protocol,
  // `steam.exe -- "%1"`: without the `--`, the client can take the URL for an option of its own and
  // drop it without a word. The window is left alone, or a cold-started Steam comes up hidden.
  const args = process.platform === "win32" ? ["--", url] : [url];
  await spawnDetached(steam.executable, args, false);
  return true;
}

/**
 * Picks the platform's URL opener.
 * @param url URL to open.
 * @returns The command and arguments to run.
 */
function protocolHandler(url: string): [string, string[]] {
  switch (process.platform) {
    case "win32":
      // The empty string is `start`'s title argument; without it a quoted URL is taken as the title.
      return ["cmd", ["/c", "start", "", url]];
    case "darwin":
      return ["open", [url]];
    default:
      return ["xdg-open", [url]];
  }
}

/**
 * Spawns a process that outlives the plugin, resolving once it is running.
 * @param command Executable to run.
 * @param args Arguments to pass.
 * @param hide Whether to keep any window it opens hidden, only wanted for a console helper.
 */
function spawnDetached(command: string, args: string[], hide: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: hide,
    });

    child.once("error", reject);
    child.once("spawn", () => {
      child.unref(); // let the game keep running if Stream Deck restarts the plugin
      resolve();
    });
  });
}
