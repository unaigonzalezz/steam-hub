import { getAchievementProgress } from "../steam/achievements";
import { getPlayHistory, getPlaytime, getRecentPlaytime } from "../steam/history";
import { findGame } from "../steam/library";

/**
 * What a "Show installed games" key can write along its top or bottom edge while its game sits
 * idle, neither running nor updating:
 * - `none`: nothing.
 * - `name`: the game's name.
 * - `playtime`: how long the account has played it in total.
 * - `recentPlaytime`: how long the account has played it over the last two weeks.
 * - `lastPlayed`: how long ago it was last played.
 * - `lastUpdated`: how long ago Steam last installed or updated it.
 * - `achievements`: how many of its achievements are unlocked.
 * - `size`: how much space it takes on disk.
 */
export type KeyInfo =
  | "none"
  | "name"
  | "playtime"
  | "recentPlaytime"
  | "lastPlayed"
  | "lastUpdated"
  | "achievements"
  | "size";

/** Every value {@link KeyInfo} can take, to check settings against. */
export const KEY_INFOS: readonly KeyInfo[] = [
  "none",
  "name",
  "playtime",
  "recentPlaytime",
  "lastPlayed",
  "lastUpdated",
  "achievements",
  "size",
];

/** One value, split the way a caption draws a reading: the number large, its unit smaller. */
export type InfoReading = {
  main: string;
  suffix?: string;

  /** Whether it stands for "nothing yet", a game never played, and is drawn dimmer. */
  muted?: boolean;
};

const DAY_MS = 86_400_000;
const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

/**
 * Reads one value for a game. Every source is a cached local file, so a page of keys asking at once
 * costs one read of each, not one per key.
 * @param info Which value; `none` and `name` have nothing to read.
 * @param appId Steam application id.
 * @returns The value, or `undefined` when there is none to show, such as the size of a game that is
 * not installed.
 */
export async function readInfo(info: KeyInfo, appId: string): Promise<InfoReading | undefined> {
  switch (info) {
    case "playtime":
      return formatPlaytime((await getPlaytime()).get(appId) ?? 0);

    case "recentPlaytime":
      return formatPlaytime((await getRecentPlaytime()).get(appId) ?? 0);

    case "lastPlayed": {
      // The manifest is stamped the moment a game launches; localconfig.vdf also covers uninstalled games.
      const [game, history] = await Promise.all([findGame(appId), getPlayHistory()]);
      return formatDaysAgo(Math.max(game?.lastPlayed ?? 0, history.get(appId) ?? 0) * 1000, "Never");
    }

    case "lastUpdated": {
      const at = (await findGame(appId))?.lastUpdated ?? 0;
      return at > 0 ? formatDaysAgo(at * 1000, "") : undefined;
    }

    case "achievements": {
      const progress = await getAchievementProgress(appId);
      return progress === undefined
        ? undefined
        : { main: String(progress.unlocked), suffix: `/${progress.total}`, muted: progress.unlocked === 0 };
    }

    case "size": {
      const bytes = (await findGame(appId))?.sizeOnDisk ?? 0;
      return bytes > 0 ? formatSize(bytes) : undefined;
    }

    default:
      return undefined;
  }
}

/**
 * Writes a value as a single line, for a title or a small line of text.
 * @param reading The value.
 * @returns E.g. `"12 h"`.
 */
export function infoText(reading: InfoReading): string {
  return `${reading.main}${reading.suffix ?? ""}`;
}

/**
 * Formats a total play time: minutes under an hour, tenths of an hour under ten, whole hours after.
 * @param minutes Total minutes played.
 * @returns E.g. `45 min`, `2.5 h`, `130 h`.
 */
function formatPlaytime(minutes: number): InfoReading {
  if (minutes <= 0) {
    return { main: "0", suffix: " h", muted: true };
  }

  if (minutes < 60) {
    return { main: String(minutes), suffix: " min" };
  }

  const hours = minutes / 60;
  return { main: hours < 10 ? String(Math.round(hours * 10) / 10) : String(Math.round(hours)), suffix: " h" };
}

/**
 * Formats how long ago something happened, by calendar day.
 * @param at Epoch milliseconds; `0` for never.
 * @param never What to show for never.
 * @returns E.g. `Today`, `3 d ago`, `2 mo ago`, `Never`.
 */
function formatDaysAgo(at: number, never: string): InfoReading {
  if (at <= 0) {
    return { main: never, muted: true };
  }

  const startOfDay = (ms: number): number => new Date(ms).setHours(0, 0, 0, 0);
  const days = Math.max(0, Math.round((startOfDay(Date.now()) - startOfDay(at)) / DAY_MS));

  if (days === 0) {
    return { main: "Today" };
  }
  if (days === 1) {
    return { main: "Yesterday" };
  }
  if (days < 7) {
    return { main: String(days), suffix: " d ago" };
  }
  if (days < 30) {
    return { main: String(Math.floor(days / 7)), suffix: " wk ago" };
  }
  if (days < 365) {
    return { main: String(Math.floor(days / 30)), suffix: " mo ago" };
  }
  return { main: String(Math.floor(days / 365)), suffix: " y ago" };
}

/**
 * Formats a size on disk the way Steam does, in binary units.
 * @param bytes Size in bytes.
 * @returns E.g. `850 MB`, `12.4 GB`, `130 GB`.
 */
function formatSize(bytes: number): InfoReading {
  if (bytes < GIB) {
    return { main: String(Math.max(1, Math.round(bytes / MIB))), suffix: " MB" };
  }

  const gib = bytes / GIB;
  return { main: gib < 100 ? String(Math.round(gib * 10) / 10) : String(Math.round(gib)), suffix: " GB" };
}
