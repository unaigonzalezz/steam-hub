import streamDeck from "@elgato/streamdeck";
import { spawn } from "node:child_process";

import { findSteam } from "./paths";

/**
 * Launches a game through Steam.
 * @param appId Steam application id.
 */
export async function launchGame(appId: string): Promise<void> {
  if (!/^\d{1,10}$/.test(appId)) {
    throw new Error(`Refusing to launch invalid app id "${appId}"`);
  }

  streamDeck.logger.info(`Launching app ${appId}`);
  await openSteamUrl(`steam://rungameid/${appId}`);
}

/**
 * The `steam://` actions this plugin is willing to trigger.
 *
 * Every verb here was read out of `steamui.dll` rather than guessed, so the list matches what the
 * client actually handles. Anything outside it is refused, which keeps a URL from ever reaching
 * the system protocol handler by accident.
 */
const ALLOWED_URL =
  /^steam:\/\/(?:rungameid\/\d{1,10}|open\/[a-z]+|close\/bigpicture|friends\/status\/(?:online|away|invisible|offline)|nav\/[a-z]+|settings\/[a-z]+|checkforupdates|changeuser|startsteamvr|stopstreaming|store(?:\/\d{1,10})?|uninstall\/\d{1,10}|url\/GameHub\/\d{1,10}|exit)$/;

/**
 * Opens a `steam://` URL.
 *
 * Prefers handing the URL straight to the Steam executable: that is exactly what the client does
 * internally, it starts Steam first if it is closed, and it needs no shell, so nothing in the URL
 * can ever be interpreted as anything but a single argument. Registering the protocol with the OS
 * is only the fallback for an installation we could not locate.
 * @param url URL to open.
 */
export async function openSteamUrl(url: string): Promise<void> {
  if (!ALLOWED_URL.test(url)) {
    throw new Error(`Refusing to open unrecognised URL "${url}"`);
  }

  const steam = await findSteam();

  if (steam?.executable !== undefined) {
    await spawnDetached(steam.executable, [url]);
    return;
  }

  streamDeck.logger.info("Steam executable not found; falling back to the system protocol handler");
  const [command, args] = protocolHandler(url);
  await spawnDetached(command, args);
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
 */
function spawnDetached(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });

    child.once("error", reject);
    child.once("spawn", () => {
      child.unref(); // let the game keep running if Stream Deck restarts the plugin
      resolve();
    });
  });
}
