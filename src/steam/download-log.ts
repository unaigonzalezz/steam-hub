import streamDeck from "@elgato/streamdeck";
import { open, stat } from "node:fs/promises";
import path from "node:path";

import { findSteam } from "./paths";

/**
 * Live download progress, estimated from Steam's content log.
 *
 * Steam only rewrites an app's manifest, `BytesDownloaded` included, when a download stops: on
 * pause, on completion, on quitting. While bytes are actually flowing the manifest stays frozen at
 * wherever the last stop left it, so a ring fed from it alone sits still for the whole download.
 * The content log is written as things happen, though: the exact byte count when a download starts
 * ("update started : download 6798117984/13679447648"), and the transfer rate as it changes and
 * about once a minute regardless. Integrating the rate from that starting count gives a running
 * estimate, a few percent shy of the true figure in practice, and corrected by the manifest each time
 * the download stops.
 */

/** How much of the log's tail is read the first time, enough to reach back to the current download's start. */
const INITIAL_TAIL_BYTES = 512 * 1024;

/**
 * How long the last rate seen keeps being extrapolated. Steam logs the rate about once a minute while
 * downloading, so a longer silence means it stopped writing, and the estimate holds still rather than
 * running on.
 */
const MAX_EXTRAPOLATION_MS = 90_000;

/** The download in progress, as read from the log so far. */
type Session = {
  appId: string;

  /** Bytes already downloaded when this run started. */
  base: number;

  /** Bytes the whole download comes to. */
  total: number;

  /** Bits transferred since the run started, up to {@link Session.rateAt}. */
  bits: number;

  /** The latest rate logged, in megabits per second. */
  rate: number;

  /** When that rate was logged, in epoch milliseconds. */
  rateAt: number;
};

/** A download's estimated progress. */
export type LiveDownload = {
  appId: string;

  /** Fraction downloaded, in `[0, 1]`. */
  fraction: number;
};

let session: Session | undefined;

/** Where the next read of the log starts, `undefined` before the first read. */
let offset: number | undefined;

/** The end of the last read when it stopped mid-line, kept for the next one. */
let remainder = "";

let reading: Promise<void> | undefined;

/**
 * Estimates the progress of whatever Steam is downloading right now.
 * @returns The app and its estimated progress, or `undefined` when nothing is downloading or the log
 * cannot be read.
 */
export async function getLiveDownload(): Promise<LiveDownload | undefined> {
  await (reading ??= readNewLines().finally(() => (reading = undefined)));

  if (session === undefined || session.total <= 0) {
    return undefined;
  }

  const now = Date.now();
  const since = Math.min(Math.max(0, now - session.rateAt), MAX_EXTRAPOLATION_MS);
  const bits = session.bits + session.rate * 1e6 * (since / 1000);
  const downloaded = Math.min(session.total, session.base + bits / 8);

  return { appId: session.appId, fraction: downloaded / session.total };
}

/**
 * Reads whatever was appended to the log since the last call, and plays it into {@link session}.
 */
async function readNewLines(): Promise<void> {
  const steam = await findSteam();
  if (steam === undefined) {
    return;
  }

  const file = path.join(steam.root, "logs", "content_log.txt");

  try {
    const { size } = await stat(file);

    // First read, or the log was rotated and started over: begin again from its tail.
    if (offset === undefined || size < offset) {
      offset = Math.max(0, size - INITIAL_TAIL_BYTES);
      remainder = "";
      session = undefined;
    }

    if (size === offset) {
      return;
    }

    const handle = await open(file, "r");
    try {
      const buffer = Buffer.alloc(size - offset);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      offset += bytesRead;

      const lines = (remainder + buffer.subarray(0, bytesRead).toString("utf8")).split(/\r?\n/);
      remainder = lines.pop() ?? "";
      lines.forEach(playLine);
    } finally {
      await handle.close();
    }
  } catch (err) {
    streamDeck.logger.debug(`Could not read Steam's content log at ${file}`, err);
  }
}

/** `[2026-10-04 12:21:34] rest of the line`, in local time. */
const LINE = /^\[(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\] (.*)$/;

const STARTED = /^AppID (\d+) update started : download (\d+)\/(\d+)/;
const STOPPED = /^AppID (\d+) (?:update canceled|App update changed : None)/;

/** "Current download rate: 83.542 Mbps", and the connection tuning lines' "(rate was 24.019, now 44.981)". */
const RATE = /^Current download rate: ([\d.]+) Mbps|\(rate was [\d.]+, now ([\d.]+)\)/;

/**
 * Applies one log line to {@link session}.
 * @param raw The line.
 */
function playLine(raw: string): void {
  const line = LINE.exec(raw);
  if (line === null) {
    return;
  }

  const [, year, month, day, hour, minute, second, text] = line;
  const at = new Date(+year!, +month! - 1, +day!, +hour!, +minute!, +second!).getTime();

  const started = STARTED.exec(text!);
  if (started !== null) {
    session = { appId: started[1]!, base: +started[2]!, total: +started[3]!, bits: 0, rate: 0, rateAt: at };
    return;
  }

  const stopped = STOPPED.exec(text!);
  if (stopped !== null) {
    if (session?.appId === stopped[1]) {
      session = undefined;
    }
    return;
  }

  const rate = RATE.exec(text!);
  if (rate !== null && session !== undefined) {
    session.bits += session.rate * 1e6 * (Math.max(0, at - session.rateAt) / 1000);
    session.rate = Number.parseFloat(rate[1] ?? rate[2]!);
    session.rateAt = at;
  }
}
