import streamDeck from "@elgato/streamdeck";

/**
 * Called on each poll, to repaint whatever the caller owns.
 */
type Listener = () => void | Promise<void>;

/** How often listeners are woken. Steam flips its flags the moment a game starts or exits. */
const POLL_MS = 4_000;

const listeners = new Set<Listener>();
let timer: NodeJS.Timeout | undefined;

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
    timer = setInterval(tick, POLL_MS);
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
 * Runs every listener, keeping one failure from stopping the rest or the timer.
 */
function tick(): void {
  for (const listener of listeners) {
    void (async () => {
      try {
        await listener();
      } catch (err) {
        streamDeck.logger.error("Status listener failed", err);
      }
    })();
  }
}
