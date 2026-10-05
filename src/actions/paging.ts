/**
 * Page state shared between the numbered library keys and the keys that turn their page.
 *
 * A page is a whole device's worth of numbered keys: key 1 on page 3 shows what key 1 + 2 × (page
 * size) would. Kept per device, so two devices browse independently, and in memory only, so every
 * start opens on the first page. This module is only the meeting point: the numbered keys know how
 * long their list is and how to repaint, the page keys only ask to move.
 */

/** Where a device currently is. `count` is always at least one, an empty list is one empty page. */
export type PageInfo = {
  /** 0-based. */
  page: number;
  count: number;
};

/**
 * What the numbered keys provide: how many pages a device's list spans, and a way to repaint them
 * once the page moves.
 */
export type PageProvider = {
  /**
   * @param deviceId Device to describe.
   * @returns How many pages the device's list spans, or `undefined` when no numbered key is on screen
   * there, which leaves nothing to page through.
   */
  pageCount(deviceId: string): Promise<number | undefined>;

  /**
   * Repaints every numbered key on a device for its current page.
   * @param deviceId Device to repaint.
   */
  redraw(deviceId: string): Promise<void>;
};

const pages = new Map<string, number>();
const listeners = new Set<() => void>();
let provider: PageProvider | undefined;

/**
 * Registers the numbered keys as the source of page counts. There is only ever one.
 * @param value The provider.
 */
export function setPageProvider(value: PageProvider): void {
  provider = value;
}

/**
 * Subscribes to page changes, so a key showing "3 / 20" can follow along.
 * @param listener Called after any device's page moves or resets.
 */
export function addPageListener(listener: () => void): void {
  listeners.add(listener);
}

/**
 * Unsubscribes a listener added with {@link addPageListener}.
 * @param listener The same reference.
 */
export function removePageListener(listener: () => void): void {
  listeners.delete(listener);
}

/**
 * The page a device's numbered keys draw, kept inside the list's current length: a library that
 * shrank since the page was turned lands on the last page rather than past the end.
 * @param deviceId Device to look up.
 * @param count How many pages the list spans right now.
 * @returns The 0-based page.
 */
export function currentPage(deviceId: string, count: number): number {
  return Math.min(pages.get(deviceId) ?? 0, Math.max(0, count - 1));
}

/**
 * Whether a device has been paged forward at all, before knowing how long its list is.
 * @param deviceId Device to look up.
 * @returns `true` when its numbered keys are shifted by at least one page.
 */
export function isPastFirstPage(deviceId: string): boolean {
  return (pages.get(deviceId) ?? 0) > 0;
}

/**
 * Describes where a device currently is.
 * @param deviceId Device to describe.
 * @returns The page and page count, or `undefined` when there is nothing to page through.
 */
export async function describePage(deviceId: string): Promise<PageInfo | undefined> {
  const count = await provider?.pageCount(deviceId);
  return count === undefined ? undefined : { page: currentPage(deviceId, count), count };
}

/**
 * Moves a device by some number of pages, wrapping at both ends, so a single "next" key reaches
 * every page and comes back round to the first.
 * @param deviceId Device to move.
 * @param delta Pages to move; negative goes back.
 * @returns Where the device ended up, or `undefined` when there was nothing to page through.
 */
export async function turnPage(deviceId: string, delta: number): Promise<PageInfo | undefined> {
  const info = await describePage(deviceId);
  if (info === undefined) {
    return undefined;
  }

  const page = (((info.page + delta) % info.count) + info.count) % info.count;
  pages.set(deviceId, page);

  await provider?.redraw(deviceId);
  notify();

  return { page, count: info.count };
}

/**
 * Jumps a device straight to its first page, the shortcut back from deep in a long library.
 * @param deviceId Device to move.
 * @returns Where the device ended up, or `undefined` when there was nothing to page through.
 */
export async function goToFirstPage(deviceId: string): Promise<PageInfo | undefined> {
  const info = await describePage(deviceId);
  return info === undefined ? undefined : turnPage(deviceId, -info.page);
}

/**
 * Jumps a device straight to its last page, the shortcut to the far end of a long library.
 * @param deviceId Device to move.
 * @returns Where the device ended up, or `undefined` when there was nothing to page through.
 */
export async function goToLastPage(deviceId: string): Promise<PageInfo | undefined> {
  const info = await describePage(deviceId);
  return info === undefined ? undefined : turnPage(deviceId, info.count - 1 - info.page);
}

/**
 * Sends a device back to its first page, used when what it lists changes underneath it: another
 * collection or another order makes the old page number meaningless.
 * @param deviceId Device to reset, or `undefined` for every device.
 */
export function resetPage(deviceId?: string): void {
  const changed = deviceId === undefined ? pages.size > 0 : (pages.get(deviceId) ?? 0) !== 0;

  if (deviceId === undefined) {
    pages.clear();
  } else {
    pages.delete(deviceId);
  }

  if (changed) {
    notify();
  }
}

/**
 * Tells every listener the page moved, or that the page count may have, because numbered keys came
 * into view or left it.
 */
export function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}
