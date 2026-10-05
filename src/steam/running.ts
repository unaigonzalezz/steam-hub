import type { StatusBadge } from "./artwork";
import { getInstalledGames, getLastPlayed, type SteamGame } from "./library";
import { getAppStates } from "./status";

/**
 * An installed game Steam is currently doing something with.
 */
export type RunningGame = {
  game: SteamGame;
  badge: Exclude<StatusBadge, "idle">;

  /**
   * When the session began, in epoch milliseconds: Steam's own launch stamp once its manifest
   * confirms it, until then the moment this plugin first saw the game running. Only set while
   * `badge` is `"running"`, merely updating does not start a session, any more than sitting in a
   * download queue does.
   */
  since?: number;
};

/**
 * How far before the last idle poll a launch stamp may still fall and count as this session's.
 * Steam writes `LastPlayed` a few seconds into the launch, so it normally lands after that poll;
 * this only absorbs clock jitter, and is far too short to mistake the previous session's stamp.
 */
const LAUNCH_SLACK_MS = 5_000;

/**
 * The session in progress, if any. Kept at module scope, rather than inside whichever action last
 * asked, so every key timing the same game agrees on the same start instant, and a key that
 * appears mid-session still reports it from the real start, not from when it joined.
 *
 * `confirmed` means `since` came from Steam's `LastPlayed`; until then it is a local estimate, and
 * each poll checks the manifest again, since Steam may write the stamp after raising `Running`.
 */
let session: { appId: string; since: number; confirmed: boolean; notBefore: number } | undefined;

/**
 * When a poll last found nothing running, so a launch stamp older than that is known to belong to
 * an earlier session. `undefined` until the first such poll, i.e. when the plugin started with a
 * game already open, in which case the stamp on its manifest is exactly the session to report.
 */
let lastIdleAt: number | undefined;

/**
 * The session in progress as of the last {@link getRunningGame} call, without touching the
 * registry, for the clock ticks that repaint a timer between polls.
 * @returns The running game's id and start instant, or `undefined` when nothing is being timed.
 */
export function getCurrentSession(): { appId: string; since: number } | undefined {
  return session;
}

/**
 * Finds the installed game Steam is currently running or updating, for the keys that follow
 * whatever is active rather than a game the user picked.
 *
 * More than one app is often flagged at once: Steam pauses a pending update while a game is being
 * played but leaves that app's `Updating` flag raised. A game running outranks one updating, since
 * the game being played is what these keys follow, and any further tie goes to whichever was played
 * most recently, so the pick stays stable rather than depending on scan order.
 * @returns The running game and what it is doing, or `undefined` when nothing is.
 */
export async function getRunningGame(): Promise<RunningGame | undefined> {
  const states = await getAppStates();
  if (states.size === 0) {
    session = undefined;
    return undefined;
  }

  const games = await getInstalledGames();
  let best: RunningGame | undefined;

  for (const game of games) {
    const state = states.get(game.appId);
    if (state === undefined || (!state.running && !state.updating)) {
      continue;
    }

    const badge: Exclude<StatusBadge, "idle"> = state.updating ? "updating" : "running";
    const outranks =
      best === undefined ||
      (badge === "running" && best.badge === "updating") ||
      (badge === best.badge && game.lastPlayed > best.game.lastPlayed);

    if (outranks) {
      best = { game, badge };
    }
  }

  if (best === undefined || best.badge !== "running") {
    session = undefined;
    lastIdleAt = Date.now();
  } else {
    if (session?.appId !== best.game.appId) {
      const notBefore = lastIdleAt === undefined ? 0 : lastIdleAt - LAUNCH_SLACK_MS;
      session = { appId: best.game.appId, since: Date.now(), confirmed: false, notBefore };
    }

    if (!session.confirmed) {
      await confirmSession(session);
    }

    best.since = session.since;
  }

  return best;
}

/**
 * Swaps a session's local start estimate for Steam's own launch stamp, once the manifest carries
 * one that belongs to this session, so the timer matches Steam's record and survives a plugin
 * restart mid-game.
 * @param current The session to confirm, updated in place.
 */
async function confirmSession(current: NonNullable<typeof session>): Promise<void> {
  const launched = await getLastPlayed(current.appId);

  if (launched !== undefined && launched >= current.notBefore && launched <= Date.now()) {
    current.since = launched;
    current.confirmed = true;
  }
}
