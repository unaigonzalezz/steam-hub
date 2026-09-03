import streamDeck from "@elgato/streamdeck";
import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * A located Steam installation.
 */
export type SteamInstall = {
	/** Root of the installation, e.g. `C:\Program Files (x86)\Steam`. */
	root: string;

	/** Absolute path to the Steam executable, when one was found. */
	executable?: string;
};

let cached: Promise<SteamInstall | undefined> | undefined;

/**
 * Locates the local Steam installation, caching the result for the lifetime of the plugin.
 * @returns The installation, or `undefined` when Steam is not installed.
 */
export function findSteam(): Promise<SteamInstall | undefined> {
	return (cached ??= locate());
}

/**
 * Discards the cached lookup so the next call re-probes the disk. Used by the property inspector's
 * refresh button, which is the natural thing to press after installing Steam or adding a library.
 */
export function forgetSteam(): void {
	cached = undefined;
}

/**
 * Probes the platform's well-known locations for Steam.
 * @returns The first candidate that looks like a real installation.
 */
async function locate(): Promise<SteamInstall | undefined> {
	const candidates = process.platform === "win32" ? await windowsCandidates() : unixCandidates();

	const seen = new Set<string>();
	for (const candidate of candidates) {
		const root = path.normalize(candidate.replace(/[\\/]+$/, ""));
		const key = process.platform === "win32" ? root.toLowerCase() : root;
		if (root === "" || seen.has(key)) {
			continue;
		}
		seen.add(key);

		// `steamapps` is the only directory we actually need, so it is the test that matters.
		if (await exists(path.join(root, "steamapps"))) {
			const install: SteamInstall = { root };
			const executable = await findExecutable(root);
			if (executable !== undefined) {
				install.executable = executable;
			}

			streamDeck.logger.info(`Found Steam at ${root}${executable ? ` (${path.basename(executable)})` : ""}`);
			return install;
		}
	}

	streamDeck.logger.warn("Could not locate a Steam installation");
	return undefined;
}

/**
 * Builds the Windows candidate list: registry first, then the default install locations.
 * @returns Candidate root directories, best guess first.
 */
async function windowsCandidates(): Promise<string[]> {
	const fromRegistry = await Promise.all([
		queryRegistry("HKCU\\Software\\Valve\\Steam", "SteamPath"),
		queryRegistry("HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam", "InstallPath"),
		queryRegistry("HKLM\\SOFTWARE\\Valve\\Steam", "InstallPath"),
	]);

	const programFilesX86 = process.env["ProgramFiles(x86)"];
	const programFiles = process.env["ProgramFiles"];

	return [
		...fromRegistry.filter((value): value is string => value !== undefined),
		...(programFilesX86 ? [path.join(programFilesX86, "Steam")] : []),
		...(programFiles ? [path.join(programFiles, "Steam")] : []),
		"C:\\Steam",
	];
}

/**
 * Builds the macOS / Linux candidate list.
 * @returns Candidate root directories, best guess first.
 */
function unixCandidates(): string[] {
	const home = homedir();

	if (process.platform === "darwin") {
		return [path.join(home, "Library", "Application Support", "Steam")];
	}

	return [
		path.join(home, ".steam", "steam"),
		path.join(home, ".local", "share", "Steam"),
		path.join(home, ".var", "app", "com.valvesoftware.Steam", "data", "Steam"),
	];
}

/**
 * Reads a single string value from the Windows registry via `reg.exe`.
 * @param key Full registry key, e.g. `HKCU\Software\Valve\Steam`.
 * @param value Value name to read.
 * @returns The value, or `undefined` when the key is missing.
 */
async function queryRegistry(key: string, value: string): Promise<string | undefined> {
	try {
		const { stdout } = await execFileAsync("reg", ["query", key, "/v", value], {
			windowsHide: true,
			timeout: 5_000,
		});

		// Output looks like: `    SteamPath    REG_SZ    c:/program files (x86)/steam`
		const match = /\s+REG_(?:SZ|EXPAND_SZ)\s+(.+?)\s*$/m.exec(stdout);
		return match?.[1];
	} catch {
		return undefined; // key absent, or not running on Windows
	}
}

/**
 * Finds the Steam executable inside an installation root.
 * @param root Installation root.
 * @returns Absolute path to the executable, or `undefined`.
 */
async function findExecutable(root: string): Promise<string | undefined> {
	const names =
		process.platform === "win32"
			? ["steam.exe"]
			: process.platform === "darwin"
				? ["Steam.AppBundle/Steam/Contents/MacOS/steam_osx"]
				: ["steam.sh", "steam"];

	for (const name of names) {
		const candidate = path.join(root, name);
		if (await exists(candidate)) {
			return candidate;
		}
	}

	return undefined;
}

/**
 * Tests whether a path exists and is readable.
 * @param target Path to test.
 * @returns `true` when the path is reachable.
 */
export async function exists(target: string): Promise<boolean> {
	try {
		await access(target, constants.R_OK);
		return true;
	} catch {
		return false;
	}
}
