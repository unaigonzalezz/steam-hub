import type { StatusBadge } from "./artwork";
import { getInstalledGames, type SteamGame } from "./library";
import { getAppStates } from "./status";

/**
 * An installed game Steam is currently doing something with.
 */
export type RunningGame = {
  game: SteamGame;
  badge: Exclude<StatusBadge, "idle">;

  /**
   * When this plugin first saw the game actually running, in epoch milliseconds. Only set while
   * `badge` is `"running"`, merely updating does not start a session, any more than sitting in a
   * download queue does.
   */
  since?: number;
};

/**
 * The session in progress, if any. Kept at module scope, rather than inside whichever action last
 * asked, so every key timing the same game agrees on the same start instant, and a key that
 * appears mid-session still reports it from when the plugin first noticed, not from when it joined.
 */
let session: { appId: string; since: number } | undefined;

/**
 * Finds the installed game Steam is currently running or updating, for the keys that follow
 * whatever is active rather than a game the user picked.
 *
 * Steam normally flags at most one app at a time. On the rare chance more than one comes back,
 * updating outranks running, mirroring `badgeFor`'s own precedence, and any further tie goes to
 * whichever was played most recently, so the pick stays stable rather than depending on scan order.
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
      (badge === "updating" && best.badge === "running") ||
      (badge === best.badge && game.lastPlayed > best.game.lastPlayed);

    if (outranks) {
      best = { game, badge };
    }
  }

  if (best === undefined || best.badge !== "running") {
    session = undefined;
  } else {
    if (session?.appId !== best.game.appId) {
      session = { appId: best.game.appId, since: Date.now() };
    }

    best.since = session.since;
  }

  return best;
}
