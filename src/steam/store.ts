import streamDeck from "@elgato/streamdeck";

import { findGame } from "./library";

/**
 * A game's basic identity as Steam's public storefront reports it. Only asked for once a game
 * turns out not to be installed here, since the local library is free to read and always correct
 * while it has an answer.
 */
export type StoreApp = {
  /** Display name as the store lists it. */
  name: string;
};

/** How long a resolved name is trusted. Names essentially never change once a game ships. */
const HIT_TTL = 24 * 60 * 60 * 1000;

/**
 * How long a miss, a bad id, an unpublished app, or a request Steam itself refused, is kept
 * before retrying. Short enough that fixing a typo and waiting a few minutes resolves it, long
 * enough that a key left pointed at a bad id does not hammer the storefront on every redraw.
 */
const MISS_TTL = 5 * 60 * 1000;

type Entry = { at: number; app: StoreApp | undefined };

const cache = new Map<string, Entry>();
const inFlight = new Map<string, Promise<StoreApp | undefined>>();

/** Bounds the cache; a session would have to look up hundreds of one-off ids to ever fill this. */
const MAX_CACHED = 256;

/** A Steam app id: digits only, and short enough that it cannot be anything else. */
const APP_ID = /^\d{1,10}$/;

/**
 * Resolves an app id's display name, preferring the installed library and falling back to Steam's
 * public storefront for an id that is not installed here, a hand-typed id pointed at a game the
 * user does not yet own on this machine, most often.
 * @param appId Steam application id.
 * @returns The resolved name, or `undefined` when nothing local or remote knows the id.
 */
export async function resolveGameName(appId: string): Promise<string | undefined> {
  const local = await findGame(appId);
  if (local !== undefined) {
    return local.name;
  }

  return (await lookupStoreApp(appId))?.name;
}

/**
 * Looks an app id up on Steam's public storefront.
 *
 * Unauthenticated and rate-limited by Steam on its own terms, so results are cached aggressively
 * and concurrent lookups for the same id share a single request, the property inspector's live
 * check and a key's own redraw can easily ask for the same id moments apart.
 * @param appId Steam application id.
 * @returns The app, or `undefined` when the id does not resolve to anything.
 */
export async function lookupStoreApp(appId: string): Promise<StoreApp | undefined> {
  if (!APP_ID.test(appId)) {
    return undefined;
  }

  const cached = cache.get(appId);
  if (cached !== undefined && Date.now() - cached.at < (cached.app !== undefined ? HIT_TTL : MISS_TTL)) {
    return cached.app;
  }

  const existing = inFlight.get(appId);
  if (existing !== undefined) {
    return existing;
  }

  const task = fetchApp(appId).finally(() => inFlight.delete(appId));
  inFlight.set(appId, task);

  const app = await task;

  if (cache.size >= MAX_CACHED) {
    cache.delete(cache.keys().next().value!);
  }
  cache.set(appId, { at: Date.now(), app });

  return app;
}

/**
 * Calls Steam's public `appdetails` endpoint for a single id.
 * @param appId Steam application id.
 * @returns The resolved app, or `undefined` when Steam has nothing for that id, or the request failed.
 */
async function fetchApp(appId: string): Promise<StoreApp | undefined> {
  try {
    const response = await fetch(
      `https://store.steampowered.com/api/appdetails?appids=${appId}&filters=basic&l=english`,
      { signal: AbortSignal.timeout(8_000) },
    );

    if (!response.ok) {
      streamDeck.logger.debug(`Store lookup for app ${appId} returned HTTP ${response.status}`);
      return undefined;
    }

    const body = (await response.json()) as Record<string, { success?: boolean; data?: { name?: string } }>;
    const name = body[appId]?.data?.name;

    return body[appId]?.success === true && typeof name === "string" && name !== "" ? { name } : undefined;
  } catch (err) {
    streamDeck.logger.debug(`Could not look up app ${appId} on the Steam store`, err);
    return undefined;
  }
}
