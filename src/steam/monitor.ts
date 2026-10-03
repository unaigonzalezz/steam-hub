import streamDeck from "@elgato/streamdeck";

import { getCurrentSession } from "./running";

/**
 * Called on each poll, to repaint whatever the caller owns.
 */
type Listener = () => void | Promise<void>;

/** How often listeners are woken. Steam flips its flags the moment a game starts or exits. */
const POLL_MS = 4_000;

/** How often clock listeners are woken, so an on-screen timer counts every second. */
const CLOCK_MS = 1_000;

/**
 * How far past the second boundary a clock tick lands, so the timer has already rolled over to the
 * next second by the time it is read, rather than racing it and repeating the previous one.
 */
const CLOCK_SLACK_MS = 20;

const listeners = new Set<Listener>();
let timer: NodeJS.Timeout | undefined;

const clockListeners = new Set<Listener>();
let clock: NodeJS.Timeout | undefined;

/**
 * Registers a listener to be called on every status poll.
 *
 * One timer is shared by every action, and it only exists while something is listening, so a
 * profile with no game keys on screen costs nothing at all.
 * @param listener Function to call on each poll.
 */
export function addStatusListener(listener: Listener): void {
  listeners.add(listener);

  if (timer === undefined && process.platform === "win32") {
    // The registry Steam publishes this through is Windows-only; elsewhere nothing is polled.
    timer = setInterval(() => run(listeners), POLL_MS);
    timer.unref?.(); // never hold the plugin open on this timer alone
  }
}

/**
 * Removes a listener, stopping the shared timer once the last one goes.
 * @param listener Listener to remove.
 */
export function removeStatusListener(listener: Listener): void {
  listeners.delete(listener);

  if (listeners.size === 0 && timer !== undefined) {
    clearInterval(timer);
    timer = undefined;
  }
}

/**
 * Registers a listener to be called once a second, for keys showing a running clock.
 *
 * Kept apart from the status poll because each poll shells out to `reg.exe`; a clock tick only
 * repaints from what the last poll already found, so it costs no process at all.
 * @param listener Function to call on each tick.
 */
export function addClockListener(listener: Listener): void {
  clockListeners.add(listener);

  if (clock === undefined && process.platform === "win32") {
    scheduleClock();
  }
}

/**
 * Removes a clock listener, stopping the clock once the last one goes.
 * @param listener Listener to remove.
 */
export function removeClockListener(listener: Listener): void {
  clockListeners.delete(listener);

  if (clockListeners.size === 0 && clock !== undefined) {
    clearTimeout(clock);
    clock = undefined;
  }
}

/**
 * Arms the next clock tick.
 *
 * A plain `setInterval` drifts a little every tick, and every so often that drift would show as a
 * second repeated or skipped. Aiming each tick just past the running session's next whole second
 * instead keeps the display stepping exactly once per second, however long the session runs.
 */
function scheduleClock(): void {
  const session = getCurrentSession();
  const delay =
    session === undefined ? CLOCK_MS : CLOCK_MS - ((Date.now() - session.since) % CLOCK_MS) + CLOCK_SLACK_MS;

  clock = setTimeout(() => {
    run(clockListeners);

    if (clockListeners.size > 0) {
      scheduleClock();
    } else {
      clock = undefined;
    }
  }, delay);
  clock.unref?.(); // never hold the plugin open on this timer alone
}

/**
 * Runs every listener in a set, keeping one failure from stopping the rest or the timer.
 * @param set Listeners to run.
 */
function run(set: Set<Listener>): void {
  for (const listener of set) {
    void (async () => {
      try {
        await listener();
      } catch (err) {
        streamDeck.logger.error("Status listener failed", err);
      }
    })();
  }
}
