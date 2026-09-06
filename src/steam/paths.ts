import streamDeck from "@elgato/streamdeck";
import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * How long a single filesystem probe may take before being treated as unreachable. Generous enough
 * for a slow local disk, short enough that a scan, or the property inspector's picker, never sits
 * waiting on a drive that has stopped answering.
 */
const PROBE_TIMEOUT_MS = 4_000;

/** Thrown by {@link withTimeout} when the deadline passes, so callers can tell it apart from a real
 * filesystem error. */
class ProbeTimeoutError extends Error {}

/**
 * Races a promise against a timeout, rejecting with a {@link ProbeTimeoutError} if it takes too
 * long. A path can sit on a drive that never answers, a disconnected external disk, an unmounted
 * network share, a library entry Steam kept for a drive letter that no longer exists, and Node's
 * own filesystem calls have no timeout of their own. Left unbounded, one such call does not just
 * fail slowly: it ties up one of the handful of threads Node uses for all filesystem work, and
 * every other disk operation in the plugin, unrelated keys included, queues up behind it.
 *
 * This only bounds how long *we* wait; there is no way to cancel a filesystem call already handed
 * to the OS, so the underlying operation may still be running in the background afterwards. See
 * {@link exists}'s cooldown for how repeat probes against the same dead path are kept from piling
 * more of these up.
 * @param promise Operation to bound.
 * @param ms How long to allow before giving up.
 * @returns The operation's result, or a rejection once the deadline passes.
 */
export function withTimeout<T>(promise: Promise<T>, ms = PROBE_TIMEOUT_MS): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new ProbeTimeoutError(`Timed out after ${ms}ms`)), ms);
		timer.unref?.();

		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(err: unknown) => {
				clearTimeout(timer);
				reject(err as Error);
			},
		);
	});
}

/**
 * Paths whose existence check recently timed out, mapped to when {@link exists} may probe them
 * again. Without this, a permanently unreachable library keeps leaking a new stuck filesystem call
 * every scan, once a minute for as long as the plugin runs, since the timeout above only ever gives
 * up on our end, never on the OS's. Cleared by {@link forgetSteam}, so the property inspector's
 * refresh button always probes fresh rather than trusting a stale cooldown.
 */
const unreachable = new Map<string, number>();

/** How long a path that timed out is skipped before being probed again. */
const UNREACHABLE_COOLDOWN_MS = 30 * 60_000;

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
	unreachable.clear();
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
 *
 * Bounded by {@link withTimeout}: a path that never answers is treated as absent rather than left
 * to hang, and is skipped without probing again for {@link UNREACHABLE_COOLDOWN_MS} once that
 * happens.
 * @param target Path to test.
 * @returns `true` when the path is reachable.
 */
export async function exists(target: string): Promise<boolean> {
	const until = unreachable.get(target);
	if (until !== undefined) {
		if (Date.now() < until) {
			return false;
		}
		unreachable.delete(target);
	}

	try {
		await withTimeout(access(target, constants.R_OK));
		return true;
	} catch (err) {
		if (err instanceof ProbeTimeoutError) {
			streamDeck.logger.warn(
				`Timed out probing ${target}; treating it as unreachable for ${UNREACHABLE_COOLDOWN_MS / 60_000} minutes`,
			);
			unreachable.set(target, Date.now() + UNREACHABLE_COOLDOWN_MS);
		}
		return false;
	}
}
