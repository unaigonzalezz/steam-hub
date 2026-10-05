import streamDeck from "@elgato/streamdeck";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { getActiveAccountId } from "./account";
import { getObject, getString, parseBinVdf, type BinVdfObject } from "./binvdf";
import { findSteam } from "./paths";

/**
 * The most recently unlocked achievement in one game, for whoever is currently logged into Steam.
 */
export type LatestAchievement = {
  /** Localized display name. */
  name: string;

  /** Localized description. */
  description: string;

  /** Icon filename from the achievement schema, resolved against Steam's public image CDN. */
  icon: string;

  /** When it unlocked, in epoch milliseconds. */
  unlockedAt: number;
};

const APP_ID = /^\d{1,10}$/;

/**
 * How long a resolved achievement is trusted. Short enough that unlocking one while the key is on
 * screen shows up within a poll or two, long enough that several keys following the same running
 * game share one pair of file reads.
 */
const CACHE_TTL = 8_000;

type Entry = { at: number; achievement: LatestAchievement | undefined };

const cache = new Map<string, Entry>();
const inFlight = new Map<string, Promise<LatestAchievement | undefined>>();

/**
 * Resolves the most recently unlocked achievement in one game, for the currently signed-in account.
 *
 * Reads Steam's own local stat cache under `appcache/stats` rather than the Web API, so this needs
 * no API key: `UserGameStatsSchema_<appId>.bin` names and describes every achievement, bit by bit,
 * and `UserGameStats_<accountId>_<appId>.bin` records when each one unlocked. Both are populated by
 * the Steam client itself, only once it has actually fetched that game's stats, typically the first
 * time it is launched or its achievements page is opened, so a game never played this way resolves
 * to `undefined` even if it does have achievements.
 * @param appId Steam application id.
 * @returns The latest achievement, or `undefined` when none has unlocked yet, or nothing could be read.
 */
export async function getLatestAchievement(appId: string): Promise<LatestAchievement | undefined> {
  if (!APP_ID.test(appId)) {
    return undefined;
  }

  const cached = cache.get(appId);
  if (cached !== undefined && Date.now() - cached.at < CACHE_TTL) {
    return cached.achievement;
  }

  const existing = inFlight.get(appId);
  if (existing !== undefined) {
    return existing;
  }

  const task = resolve(appId)
    .catch((err) => {
      streamDeck.logger.debug(`Could not resolve the latest achievement for app ${appId}`, err);
      return undefined;
    })
    .finally(() => inFlight.delete(appId));

  inFlight.set(appId, task);

  const achievement = await task;
  cache.set(appId, { at: Date.now(), achievement });

  return achievement;
}

/** Per-app timestamp of the latest achievement {@link checkForNewAchievement} has already reported. */
const lastReported = new Map<string, number>();

/**
 * Checks whether an app's latest achievement is one {@link checkForNewAchievement} has not already
 * reported for it, so a caller polling this every few seconds learns about a fresh unlock exactly
 * once, rather than on every poll for as long as it stays the latest.
 *
 * The first call for a given app only seeds the baseline and never itself reports one: without that,
 * a game that already had achievements unlocked before the plugin started would flash the moment it
 * was first polled, as if that old achievement had just happened.
 * @param appId Steam application id.
 * @returns The newly unlocked achievement, or `undefined` when there is nothing new to report.
 */
export async function checkForNewAchievement(appId: string): Promise<LatestAchievement | undefined> {
  const achievement = await getLatestAchievement(appId);
  if (achievement === undefined) {
    return undefined;
  }

  const seen = lastReported.get(appId);
  lastReported.set(appId, achievement.unlockedAt);

  return seen !== undefined && achievement.unlockedAt > seen ? achievement : undefined;
}

/**
 * Reads both stat files for one app and picks the achievement with the latest timestamp.
 * @param appId Steam application id.
 * @returns The latest achievement, or `undefined`.
 */
async function resolve(appId: string): Promise<LatestAchievement | undefined> {
  const steam = await findSteam();
  const accountId = await getActiveAccountId();
  if (steam === undefined || accountId === undefined) {
    return undefined;
  }

  const statsDir = path.join(steam.root, "appcache", "stats");
  const [schema, stats] = await Promise.all([
    readBinVdfFile(path.join(statsDir, `UserGameStatsSchema_${appId}.bin`)),
    readBinVdfFile(path.join(statsDir, `UserGameStats_${accountId}_${appId}.bin`)),
  ]);

  // The schema's root block is keyed by the app id itself; the per-user file's is always "cache".
  const schemaStats = getObject(getObject(schema, appId), "stats");
  const statsCache = getObject(stats, "cache");
  if (schemaStats === undefined || statsCache === undefined) {
    return undefined;
  }

  let best: LatestAchievement | undefined;

  for (const [groupId, group] of Object.entries(statsCache)) {
    if (typeof group !== "object") {
      continue; // "crc" and "PendingChanges" sit alongside the real per-stat groups
    }

    const times = getObject(group, "AchievementTimes");
    const bits = getObject(getObject(schemaStats, groupId), "bits");
    if (times === undefined || bits === undefined) {
      continue; // a non-achievement stat group, or one the schema no longer lists
    }

    for (const [bit, when] of Object.entries(times)) {
      const seconds = typeof when === "number" ? when : typeof when === "bigint" ? Number(when) : undefined;
      if (seconds === undefined || seconds === 0) {
        continue; // no recorded time, so it cannot be compared as "latest"
      }

      const unlockedAt = seconds * 1000;
      if (best !== undefined && unlockedAt <= best.unlockedAt) {
        continue;
      }

      const definition = getObject(bits, bit);
      const display = getObject(definition, "display");
      const icon = getString(display, "icon");
      if (display === undefined || icon === undefined) {
        continue;
      }

      best = {
        name: localized(getObject(display, "name")) ?? getString(definition, "name") ?? `Achievement ${bit}`,
        description: localized(getObject(display, "desc")) ?? "",
        icon,
        unlockedAt,
      };
    }
  }

  return best;
}

/**
 * Picks a display string out of a `display.name` / `display.desc` block, which holds one entry per
 * language. English first since it is what every schema carries, then whatever comes first, rather
 * than nothing at all when English is missing.
 * @param names Localized strings, keyed by language.
 * @returns The chosen string, or `undefined` when the block is empty.
 */
function localized(names: BinVdfObject | undefined): string | undefined {
  if (names === undefined) {
    return undefined;
  }

  const english = getString(names, "english");
  if (english !== undefined && english !== "") {
    return english;
  }

  for (const value of Object.values(names)) {
    if (typeof value === "string" && value !== "") {
      return value;
    }
  }

  return undefined;
}

/**
 * Reads and parses a binary VDF file, treating any failure, missing file included, as "not there".
 * @param file Absolute path to the file.
 * @returns The parsed root object, or `undefined`.
 */
async function readBinVdfFile(file: string): Promise<BinVdfObject | undefined> {
  try {
    return parseBinVdf(await readFile(file));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      streamDeck.logger.debug(`Could not parse ${file}`, err);
    }
    return undefined;
  }
}

/** How many of a game's achievements the signed-in account has unlocked. */
export type AchievementProgress = { unlocked: number; total: number };

/**
 * How long a progress reading is trusted before the files' timestamps are checked again. A whole
 * page of keys asks on every poll, and the schema files can run to hundreds of kilobytes.
 */
const PROGRESS_TTL = 30_000;

const progressCache = new Map<
  string,
  { at: number; stamp: string; progress: AchievementProgress | undefined }
>();

/**
 * Counts how many of a game's achievements are unlocked, from the same two stat files
 * {@link getLatestAchievement} reads. An achievement counts as unlocked when its bit is set in its
 * group's `data` field or it has an unlock time, which in practice always agree.
 *
 * Steam only writes these files for games it has fetched stats for on this machine, so a game never
 * launched here, or one with no achievements, resolves to `undefined`.
 * @param appId Steam application id.
 * @returns The progress, or `undefined` when there is nothing to count.
 */
export async function getAchievementProgress(appId: string): Promise<AchievementProgress | undefined> {
  if (!APP_ID.test(appId)) {
    return undefined;
  }

  const cached = progressCache.get(appId);
  if (cached !== undefined && Date.now() - cached.at < PROGRESS_TTL) {
    return cached.progress;
  }

  const [steam, accountId] = await Promise.all([findSteam(), getActiveAccountId()]);
  if (steam === undefined || accountId === undefined) {
    return undefined;
  }

  const statsDir = path.join(steam.root, "appcache", "stats");
  const schemaFile = path.join(statsDir, `UserGameStatsSchema_${appId}.bin`);
  const statsFile = path.join(statsDir, `UserGameStats_${accountId}_${appId}.bin`);

  // Re-parsed only when either file actually changed since the last count.
  const stamps = await Promise.all(
    [schemaFile, statsFile].map((file) => stat(file).then((info) => info.mtimeMs, () => 0)),
  );
  const stamp = `${accountId}:${stamps.join(":")}`;
  if (cached !== undefined && cached.stamp === stamp) {
    cached.at = Date.now();
    return cached.progress;
  }

  const [schema, stats] = await Promise.all([readBinVdfFile(schemaFile), readBinVdfFile(statsFile)]);
  const progress = countAchievements(getObject(getObject(schema, appId), "stats"), getObject(stats, "cache"));

  progressCache.set(appId, { at: Date.now(), stamp, progress });
  return progress;
}

/**
 * Counts achievements across every group of a stat schema.
 * @param schemaStats The schema's `stats` block.
 * @param statsCache The per-user file's `cache` block.
 * @returns The progress, or `undefined` when the schema lists no achievements or the user's file is missing.
 */
function countAchievements(
  schemaStats: BinVdfObject | undefined,
  statsCache: BinVdfObject | undefined,
): AchievementProgress | undefined {
  if (schemaStats === undefined || statsCache === undefined) {
    return undefined;
  }

  let total = 0;
  let unlocked = 0;

  for (const [groupId, group] of Object.entries(schemaStats)) {
    const bits = typeof group === "object" ? getObject(group, "bits") : undefined;
    if (bits === undefined) {
      continue;
    }

    const userGroup = getObject(statsCache, groupId);
    const data = userGroup?.data;
    const mask = typeof data === "number" || typeof data === "bigint" ? BigInt(data) : 0n;
    const times = getObject(userGroup, "AchievementTimes");

    for (const bit of Object.keys(bits)) {
      total++;

      const when = times?.[bit];
      const timed = (typeof when === "number" || typeof when === "bigint") && Number(when) > 0;
      if (timed || ((mask >> BigInt(bit)) & 1n) === 1n) {
        unlocked++;
      }
    }
  }

  return total === 0 ? undefined : { unlocked, total };
}
