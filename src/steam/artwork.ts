import streamDeck from "@elgato/streamdeck";
import jpegCodec from "@jimp/js-jpeg";
import pngCodec from "@jimp/js-png";
import { Jimp } from "jimp";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { findSteam } from "./paths";

/**
 * Which piece of a game's store art to put on the key.
 */
export type ArtStyle = "capsule" | "header" | "hero" | "logo" | "none";

/**
 * How the art is fitted into the square key.
 *
 * - `fill` crops the art to the key, edge to edge.
 * - `fit`  shows all of it over a blurred, dimmed copy of itself.
 */
export type ArtFit = "fill" | "fit";

/** Stream Deck keys top out at 144x144 (72pt @2x), which is what every model scales from. */
const KEY_SIZE = 144;

/** JPEG rather than PNG: the composite is always opaque, and it cuts the payload ~7x. */
const JPEG_QUALITY = 90;

/** Colour behind art that has no usable backdrop, matches Steam's own dark chrome. */
const FALLBACK_BACKDROP = 0x0f1419ff;

/**
 * Dev toggle: when on, every key image this module renders is also written to disk via
 * {@link exportImage}, so the exact bytes sent to a key can be inspected without attaching a
 * debugger to the Stream Deck app.
 */
const EXPORT_IMAGES = false;

/**
 * A single layer of source art. Steam names the same asset differently across client versions, so
 * each kind lists every filename worth trying, best quality first.
 */
const SOURCES = {
  capsule: ["library_600x900_2x.jpg", "library_600x900.jpg", "library_capsule.jpg"],
  header: ["header.jpg", "library_header.jpg", "capsule_616x353.jpg"],
  hero: ["library_hero.jpg"],
  logo: ["logo.png", "logo_2x.png"],
} as const satisfies Record<Exclude<ArtStyle, "none">, readonly string[]>;

/**
 * Names the CDN actually serves. The local cache holds a few that the public CDN does not, and
 * asking for those only buys a round trip and a 404.
 */
const CDN_NAMES = new Set([
  "library_600x900_2x.jpg",
  "library_600x900.jpg",
  "header.jpg",
  "library_hero.jpg",
  "logo.png",
]);

type ArtKind = keyof typeof SOURCES;

/** Steam's public art CDN. The second host is a fallback for networks that block the first. */
const CDN_HOSTS = [
  "https://cdn.cloudflare.steamstatic.com/steam/apps",
  "https://cdn.akamai.steamstatic.com/steam/apps",
];

/**
 * The slice of Jimp's surface this module uses.
 *
 * Jimp v1 gives `new Jimp(...)`, `Jimp.read(...)`, and the value returned by each chained method
 * structurally different types that the compiler considers unrelated, so compositing one onto
 * another is not expressible in its own typings. Narrowing to the operations we actually call
 * confines that to the two factories below, and keeps the render path properly typed.
 */
type Image = {
  readonly width: number;
  readonly height: number;
  readonly bitmap: { data: Buffer; width: number; height: number };
  cover(size: { w: number; h: number }): Image;
  scaleToFit(size: { w: number; h: number }): Image;
  blur(radius: number): Image;
  brightness(amount: number): Image;
  composite(source: Image, x: number, y: number): Image;
  getBuffer(mime: "image/jpeg", options: { quality: number }): Promise<Buffer>;
};

/**
 * Decoders, resolved once.
 *
 * Jimp's own `read` / `fromBuffer` sniff the format through a dynamic `import("file-type")`, which
 * does not survive being bundled into the single file the manifest's `CodePath` points at, it
 * resolves to `undefined` at runtime and every decode throws. We already know the format from the
 * magic bytes checked on the way in, so the codecs are driven directly.
 */
const JPEG = jpegCodec();
const PNG = pngCodec();

/**
 * Decodes image bytes.
 * @param data Encoded JPEG or PNG, already validated by {@link isJpeg} or {@link isPng}.
 * @returns The decoded image.
 */
function decode(data: Buffer): Image {
  return new Jimp(isJpeg(data) ? JPEG.decode(data) : PNG.decode(data)) as unknown as Image;
}

/**
 * Creates a key-sized canvas of a single colour.
 * @param color Packed RGBA colour.
 * @returns The canvas.
 */
function blank(color: number): Image {
  return new Jimp({ width: KEY_SIZE, height: KEY_SIZE, color }) as unknown as Image;
}

const rendered = new Map<string, string>();
const inFlight = new Map<string, Promise<string | undefined>>();

/** Keeps the render cache bounded; a full 32-key profile never comes close to this. */
const MAX_CACHED_RENDERS = 96;

let tempCounter = 0;

/**
 * Colour of the border drawn around a key whose game is doing something. Chosen to read at a
 * glance against store art, which is usually dark and rarely saturated at the very edge.
 */
const STATUS_COLOURS = {
  running: [0x35, 0x9b, 0x43],
  updating: [0xf5, 0xa6, 0x23],
} as const satisfies Record<Exclude<StatusBadge, "idle">, readonly [number, number, number]>;

/** Border width in key pixels, heavy enough to read across the room, light enough to frame. */
const BORDER_WIDTH = 11;

/**
 * Corner radius of the border's inner edge.
 *
 * Stream Deck rounds the key itself, so a square hole inside a square frame reads as a mismatch.
 * Curving the inside by roughly the key's own radius less the border width makes the frame look
 * concentric with the button around it.
 */
const BORDER_INNER_RADIUS = 20;

/** Samples per axis when measuring how much of a pixel the rounded corner covers. */
const BORDER_SAMPLES = 4;

/**
 * Whether to frame the key, and in what colour.
 */
export type StatusBadge = "idle" | "running" | "updating";

/**
 * Renders the key image for a game, composited and encoded ready for `setImage`.
 *
 * Results are memoised per `(app, style, fit, badge)` and concurrent requests for the same image
 * share a single render, so a page of keys appearing at once does the work exactly once.
 * @param appId Steam application id.
 * @param style Which art to use.
 * @param fit How to fit it into the key.
 * @param badge Status border to draw around the art.
 * @returns A `data:` URI, or `undefined` when no art could be found.
 */
export async function renderKeyImage(
  appId: string,
  style: ArtStyle,
  fit: ArtFit,
  badge: StatusBadge = "idle",
): Promise<string | undefined> {
  if (style === "none" || !/^\d{1,10}$/.test(appId)) {
    return undefined;
  }

  const key = `${appId}:${style}:${fit}:${badge}`;
  const cached = rendered.get(key);
  if (cached !== undefined) {
    return cached;
  }

  const existing = inFlight.get(key);
  if (existing !== undefined) {
    return existing;
  }

  const task = render(appId, style, fit, badge)
    .catch((err) => {
      streamDeck.logger.error(`Failed to render artwork for app ${appId}`, err);
      return undefined;
    })
    .finally(() => inFlight.delete(key));

  inFlight.set(key, task);

  const image = await task;
  if (image !== undefined) {
    if (rendered.size >= MAX_CACHED_RENDERS) {
      rendered.delete(rendered.keys().next().value!);
    }
    rendered.set(key, image);
  }

  return image;
}

/**
 * Drops every memoised render, so art that failed to resolve, because the machine was offline,
 * say, is attempted again. Art already cached on disk is kept and simply re-composited.
 */
export function clearRenderCache(): void {
  rendered.clear();
}

/** Rendered images loaded from disk, keyed by path and modification time. */
const fileImages = new Map<string, string | undefined>();

/**
 * Renders the key used for a position with no game behind it.
 *
 * Defaults to a dark plate that reads as a deliberate gap rather than a broken key, and can be
 * replaced with any image the user picks.
 * @param customPath Absolute path to an image to use instead of the default.
 * @returns A `data:` URI.
 */
export async function renderEmptyKey(customPath?: string): Promise<string> {
  // The stock plate is just another image file, so replacing it needs no special case.
  const wanted = customPath?.trim() || pluginPath("imgs", "actions", "slot", "emptyLogo.png");
  const image = await renderImageFile(wanted);

  if (image === undefined && customPath?.trim()) {
    // A picked file that is missing, or is neither a JPEG nor a PNG. Falling back keeps the
    // profile looking intentional instead of leaving a row of broken keys.
    streamDeck.logger.warn(`Cannot use "${wanted}" as the empty-slot image; expected a readable JPEG or PNG`);
  }

  if (image !== undefined) {
    return image;
  }

  // Last resort, when even the shipped plate has been deleted or replaced with something unreadable.
  return (emptyKey ??= toDataUri(defaultEmptyKey(), "empty-default"));
}

let emptyKey: Promise<string> | undefined;

/**
 * Loads an image file and fits it to a key.
 *
 * Used for artwork that lives on disk rather than coming from Steam, the empty-slot plate and the
 * shortcut icons, all of which are meant to be replaced by simply overwriting the file.
 * @param file Absolute path to a JPEG or PNG.
 * @returns A `data:` URI, or `undefined` when the file is missing or not a supported image.
 */
export async function renderImageFile(file: string): Promise<string | undefined> {
  // Keyed on the file's modification time as well as its path, so replacing the image on disk
  // without renaming it takes effect on the next redraw.
  let key = file;
  try {
    key = `${file}:${(await stat(file)).mtimeMs}`;
  } catch {
    key = file; // unreadable; cached as a miss so a missing file is not re-checked every poll
  }

  if (fileImages.has(key)) {
    return fileImages.get(key);
  }

  const bytes = await readIfImage(file);
  const image =
    bytes === undefined
      ? undefined
      : await toDataUri(decode(bytes).cover({ w: KEY_SIZE, h: KEY_SIZE }), path.basename(file));

  if (fileImages.size >= MAX_CACHED_RENDERS) {
    fileImages.clear();
  }
  fileImages.set(key, image);

  return image;
}

/**
 * Resolves a path inside the plugin folder.
 * @param segments Path segments below the plugin root.
 * @returns The absolute path.
 */
export function pluginPath(...segments: string[]): string {
  // The bundle sits at `<plugin>.sdPlugin/bin/plugin.js`, so the plugin root is one level up.
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ...segments);
}

/**
 * Draws the stock empty-slot plate: a soft vertical gradient in Steam's own greys, darkened
 * towards the corners so a grid of them reads as texture rather than as flat black.
 * @returns The plate.
 */
function defaultEmptyKey(): Image {
  const plate = blank(0x000000ff);
  const { data, width, height } = plate.bitmap;

  const top = [0x1e, 0x27, 0x33];
  const bottom = [0x0c, 0x10, 0x15];
  const centre = (width - 1) / 2;
  const maxDistance = Math.hypot(centre, centre);

  for (let y = 0; y < height; y++) {
    const down = y / (height - 1);

    for (let x = 0; x < width; x++) {
      // Gentle vignette: full brightness at the middle, ~70% at the corners.
      const distance = Math.hypot(x - centre, y - centre) / maxDistance;
      const vignette = 1 - 0.3 * distance * distance;

      const offset = (y * width + x) * 4;
      for (let channel = 0; channel < 3; channel++) {
        data[offset + channel] = Math.round((top[channel]! + (bottom[channel]! - top[channel]!) * down) * vignette);
      }
      data[offset + 3] = 0xff;
    }
  }

  return plate;
}

/**
 * Builds the composite for one game.
 * @param appId Steam application id.
 * @param style Which art to use.
 * @param fit How to fit it into the key.
 * @param badge Status border to draw around the art.
 * @returns A `data:` URI, or `undefined` when the game has no art at all.
 */
async function render(
  appId: string,
  style: Exclude<ArtStyle, "none">,
  fit: ArtFit,
  badge: StatusBadge,
): Promise<string | undefined> {
  if (style === "logo") {
    const logo = await loadArt(appId, "logo");
    if (logo !== undefined) {
      // A logo is a transparent wordmark: it always sits over a backdrop, never cropped.
      const backdrop = await loadFirst(appId, ["hero", "header", "capsule"]);
      return compose(logo, backdrop, "fit", 0.84, 0.42, badge, `${appId}-logo-${badge}`);
    }

    // Not every app publishes a logo; a header reads better than an empty key.
    style = "header";
  }

  // Preference order per style, so a game missing its first choice still gets a sensible key.
  const order: Record<Exclude<ArtStyle, "logo" | "none">, ArtKind[]> = {
    capsule: ["capsule", "header", "hero"],
    header: ["header", "capsule", "hero"],
    hero: ["hero", "header", "capsule"],
  };

  const art = await loadFirst(appId, order[style]);
  if (art === undefined) {
    return undefined;
  }

  const label = `${appId}-${style}-${fit}-${badge}`;
  return fit === "fill" ? compose(art, undefined, "fill", 1, 1, badge, label) : compose(art, art, "fit", 1, 0.55, badge, label);
}

/**
 * Composites the final key image.
 * @param foreground Source art shown in front.
 * @param backdrop Source art blurred behind, when fitting.
 * @param fit Whether to crop the foreground or letterbox it.
 * @param scale Fraction of the key the foreground may occupy when fitting.
 * @param dim Brightness multiplier applied to the backdrop.
 * @param badge Status border to draw around the result.
 * @param label Short description of the result, passed through to {@link toDataUri}.
 * @returns A `data:` URI.
 */
async function compose(
  foreground: Buffer,
  backdrop: Buffer | undefined,
  fit: ArtFit,
  scale: number,
  dim: number,
  badge: StatusBadge,
  label: string,
): Promise<string> {
  if (fit === "fill") {
    return toDataUri(outline(decode(foreground).cover({ w: KEY_SIZE, h: KEY_SIZE }), badge), label);
  }

  const canvas =
    backdrop !== undefined
      ? decode(backdrop).cover({ w: KEY_SIZE, h: KEY_SIZE }).blur(5).brightness(dim)
      : blank(FALLBACK_BACKDROP);

  // `scaleToFit` keeps the aspect ratio without padding, so the composite stays exactly centred.
  const box = Math.round(KEY_SIZE * scale);
  const art = decode(foreground).scaleToFit({ w: box, h: box });

  canvas.composite(art, Math.round((KEY_SIZE - art.width) / 2), Math.round((KEY_SIZE - art.height) / 2));

  return toDataUri(outline(canvas, badge), label);
}

/**
 * Draws a status border around the edge of a finished key image, in place.
 *
 * Painted onto the bitmap directly rather than composited: it is a handful of solid pixel runs, and
 * doing it here keeps the border out of the blur and scaling that produced the art underneath.
 * @param image Image to frame.
 * @param badge Which border to draw; `idle` leaves the image untouched.
 * @returns The same image, for chaining.
 */
function outline(image: Image, badge: StatusBadge): Image {
  if (badge === "idle") {
    return image;
  }

  const [r, g, b] = STATUS_COLOURS[badge];
  const { data, width, height } = image.bitmap;

  // The hole the art shows through: the key inset by the border, with rounded corners.
  const left = BORDER_WIDTH;
  const top = BORDER_WIDTH;
  const right = width - BORDER_WIDTH;
  const bottom = height - BORDER_WIDTH;

  for (let y = 0; y < height; y++) {
    // Rows clear of the corners are two straight runs, so they skip the sampling entirely.
    if (y >= top + BORDER_INNER_RADIUS && y < bottom - BORDER_INNER_RADIUS) {
      for (let x = 0; x < left; x++) {
        paintBorder(data, width, x, y, r, g, b, 1);
      }
      for (let x = right; x < width; x++) {
        paintBorder(data, width, x, y, r, g, b, 1);
      }
      continue;
    }

    for (let x = 0; x < width; x++) {
      // Coverage of the border is whatever the rounded hole does not cover.
      const coverage = 1 - holeCoverage(x, y, left, top, right, bottom, BORDER_INNER_RADIUS);
      if (coverage > 0) {
        paintBorder(data, width, x, y, r, g, b, coverage);
      }
    }
  }

  return image;
}

/**
 * Blends the border colour into one pixel.
 * @param data Bitmap bytes.
 * @param width Bitmap width.
 * @param x Pixel x.
 * @param y Pixel y.
 * @param r Border red.
 * @param g Border green.
 * @param b Border blue.
 * @param alpha How much of the pixel the border covers, in [0, 1].
 */
function paintBorder(
  data: Buffer,
  width: number,
  x: number,
  y: number,
  r: number,
  g: number,
  b: number,
  alpha: number,
): void {
  const offset = (y * width + x) * 4;
  data[offset] = Math.round(data[offset]! * (1 - alpha) + r * alpha);
  data[offset + 1] = Math.round(data[offset + 1]! * (1 - alpha) + g * alpha);
  data[offset + 2] = Math.round(data[offset + 2]! * (1 - alpha) + b * alpha);
  data[offset + 3] = 0xff;
}

/**
 * How much of a pixel falls inside the rounded hole, sampled on a grid so the curves come out
 * smooth rather than stepped.
 * @param x Pixel x.
 * @param y Pixel y.
 * @param left Hole's left edge.
 * @param top Hole's top edge.
 * @param right Hole's right edge.
 * @param bottom Hole's bottom edge.
 * @param radius Corner radius.
 * @returns Coverage in [0, 1].
 */
function holeCoverage(
  x: number,
  y: number,
  left: number,
  top: number,
  right: number,
  bottom: number,
  radius: number,
): number {
  let hits = 0;

  for (let sy = 0; sy < BORDER_SAMPLES; sy++) {
    for (let sx = 0; sx < BORDER_SAMPLES; sx++) {
      const px = x + (sx + 0.5) / BORDER_SAMPLES;
      const py = y + (sy + 0.5) / BORDER_SAMPLES;

      if (px < left || px > right || py < top || py > bottom) {
        continue;
      }

      // Only outside the hole when past the corner arc on both axes at once.
      const dx = Math.max(left + radius - px, px - (right - radius), 0);
      const dy = Math.max(top + radius - py, py - (bottom - radius), 0);
      if (dx * dx + dy * dy <= radius * radius) {
        hits++;
      }
    }
  }

  return hits / (BORDER_SAMPLES * BORDER_SAMPLES);
}

/**
 * Encodes an image as a `data:` URI Stream Deck can render.
 * @param image Image to encode.
 * @param label Short description of the image, used to name the file dumped to disk when
 * {@link EXPORT_IMAGES} is on; see {@link exportImage}.
 * @returns The encoded URI.
 */
async function toDataUri(image: Image, label: string): Promise<string> {
  const buffer = await image.getBuffer("image/jpeg", { quality: JPEG_QUALITY });
  exportImage(label, buffer);
  return `data:image/jpeg;base64,${buffer.toString("base64")}`;
}

/** Directory rendered images are dumped to when {@link EXPORT_IMAGES} is on, created on first use. */
let exportDir: Promise<string> | undefined;

/**
 * Resolves the directory exported images are written to, creating it on first use.
 * @returns Absolute path to the export directory.
 */
function getExportDir(): Promise<string> {
  return (exportDir ??= (async () => {
    const dir = pluginPath("cache", "exports");
    await mkdir(dir, { recursive: true });
    return dir;
  })());
}

/** Tags each exported filename with a unique, sortable suffix so same-labelled renders don't collide. */
let exportCounter = 0;

/**
 * Dumps a rendered key image to {@link getExportDir} when {@link EXPORT_IMAGES} is on.
 *
 * Fire-and-forget and best-effort: exporting is a debug aid, never something a failed write should
 * be allowed to break the render over.
 * @param label Short description of the image, used in the filename; sanitised, so it need not be
 * filesystem-safe already.
 * @param buffer Encoded JPEG bytes, exactly as sent to the key.
 */
function exportImage(label: string, buffer: Buffer): void {
  if (!EXPORT_IMAGES) {
    return;
  }

  void (async () => {
    try {
      const dir = await getExportDir();
      const safeLabel = label.replace(/[^a-z0-9_-]+/gi, "_");
      const name = `${Date.now()}-${exportCounter++}-${safeLabel}.jpg`;

      await writeFile(path.join(dir, name), buffer);
    } catch (err) {
      streamDeck.logger.warn(`Could not export rendered image "${label}"`, err);
    }
  })();
}

/**
 * Loads the first art kind that resolves.
 * @param appId Steam application id.
 * @param kinds Kinds to try, in order.
 * @returns The image bytes, or `undefined`.
 */
async function loadFirst(appId: string, kinds: ArtKind[]): Promise<Buffer | undefined> {
  for (const kind of kinds) {
    const art = await loadArt(appId, kind);
    if (art !== undefined) {
      return art;
    }
  }

  return undefined;
}

/**
 * Resolves one kind of art, preferring what Steam already has on disk so a key can be drawn
 * offline and instantly, and only reaching for the CDN when the local cache has nothing.
 * @param appId Steam application id.
 * @param kind Kind of art to load.
 * @returns The image bytes, or `undefined`.
 */
async function loadArt(appId: string, kind: ArtKind): Promise<Buffer | undefined> {
  const names = SOURCES[kind];

  for (const directory of await localArtDirectories(appId)) {
    for (const name of names) {
      const local = await readIfImage(path.join(directory, name));
      if (local !== undefined) {
        return local;
      }
    }
  }

  // Clients before 2023 kept everything flat, as `librarycache/<appid>_<name>`.
  const steam = await findSteam();
  if (steam !== undefined) {
    for (const name of names) {
      const legacy = await readIfImage(path.join(steam.root, "appcache", "librarycache", `${appId}_${name}`));
      if (legacy !== undefined) {
        return legacy;
      }
    }
  }

  for (const name of names) {
    const downloaded = await readIfImage(path.join(await getCacheDir(), `${appId}_${name}`));
    if (downloaded !== undefined) {
      return downloaded;
    }
  }

  for (const name of names) {
    if (CDN_NAMES.has(name)) {
      const fetched = await download(appId, name);
      if (fetched !== undefined) {
        return fetched;
      }
    }
  }

  return undefined;
}

/** Directories of Steam's own art cache, per app, resolved once each. */
const localDirectories = new Map<string, Promise<string[]>>();

/**
 * Lists the places Steam may have put an app's art, newest layout first.
 *
 * The layout has changed twice: it was flat (`librarycache/<appid>_header.jpg`), then grouped per
 * app (`librarycache/<appid>/header.jpg`), and current clients nest each asset in its own
 * content-hashed directory (`librarycache/<appid>/<sha1>/library_capsule.jpg`). All three are
 * searched, because a long-lived install accumulates a mixture of them.
 * @param appId Steam application id.
 * @returns Directories to search, in order.
 */
function localArtDirectories(appId: string): Promise<string[]> {
  let resolved = localDirectories.get(appId);
  if (resolved !== undefined) {
    return resolved;
  }

  resolved = (async () => {
    const steam = await findSteam();
    if (steam === undefined) {
      return [];
    }

    const libraryCache = path.join(steam.root, "appcache", "librarycache");
    const perApp = path.join(libraryCache, appId);
    const directories = [perApp];

    try {
      for (const entry of await readdir(perApp, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          directories.push(path.join(perApp, entry.name));
        }
      }
    } catch {
      // No per-app directory: an older client, or an app whose art was never cached.
    }

    return directories;
  })();

  localDirectories.set(appId, resolved);
  return resolved;
}

/**
 * Downloads art from Steam's CDN and caches it on disk for next time.
 * @param appId Steam application id.
 * @param name Asset filename.
 * @returns The image bytes, or `undefined` when the asset does not exist.
 */
async function download(appId: string, name: string): Promise<Buffer | undefined> {
  for (const host of CDN_HOSTS) {
    const url = `${host}/${appId}/${name}`;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) {
        break; // a 404 here means the asset does not exist; the other host will not have it either
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      if (!isImage(buffer)) {
        break; // an error page served with a 200
      }

      await writeCache(`${appId}_${name}`, buffer);
      streamDeck.logger.debug(`Downloaded ${name} for app ${appId}`);

      return buffer;
    } catch (err) {
      streamDeck.logger.debug(`Could not fetch ${url}`, err);
      // network error rather than a missing asset, worth trying the other host
    }
  }

  return undefined;
}

/**
 * Reads a file, returning it only when the contents really are a JPEG or PNG.
 * @param file Absolute path to read.
 * @returns The image bytes, or `undefined`.
 */
async function readIfImage(file: string): Promise<Buffer | undefined> {
  try {
    const buffer = await readFile(file);
    return isImage(buffer) ? buffer : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Checks the magic bytes of a buffer. Guards against caching an HTML error page, which would
 * otherwise poison the on-disk cache until it was cleared by hand.
 * @param buffer Bytes to test.
 * @returns `true` for a JPEG or PNG.
 */
function isImage(buffer: Buffer): boolean {
  return isJpeg(buffer) || isPng(buffer);
}

/** JPEG magic bytes. */
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

/** PNG magic bytes. */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Tests whether a buffer holds a JPEG.
 * @param buffer Bytes to test.
 * @returns `true` for a JPEG.
 */
function isJpeg(buffer: Buffer): boolean {
  return buffer.subarray(0, JPEG_MAGIC.length).equals(JPEG_MAGIC);
}

/**
 * Tests whether a buffer holds a PNG.
 * @param buffer Bytes to test.
 * @returns `true` for a PNG.
 */
function isPng(buffer: Buffer): boolean {
  return buffer.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC);
}

let cacheDir: Promise<string> | undefined;

/**
 * Resolves the directory downloaded art is cached in, creating it on first use. Lives beside the
 * plugin, falling back to the system temp directory if that location is not writable.
 * @returns Absolute path to the cache directory.
 */
function getCacheDir(): Promise<string> {
  return (cacheDir ??= (async () => {
    // The bundle sits at `<plugin>.sdPlugin/bin/plugin.js`, so the plugin root is one level up.
    const preferred = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "cache");

    try {
      await mkdir(preferred, { recursive: true });
      return preferred;
    } catch (err) {
      streamDeck.logger.warn(`Could not use ${preferred} for the artwork cache`, err);
      const fallback = path.join(tmpdir(), "steam-rundeck-cache");
      await mkdir(fallback, { recursive: true });

      return fallback;
    }
  })());
}

/**
 * Writes a file into the artwork cache. Written to a temporary name and renamed so a crash
 * mid-write cannot leave a truncated image behind.
 * @param name Filename within the cache directory.
 * @param buffer Bytes to write.
 */
async function writeCache(name: string, buffer: Buffer): Promise<void> {
  try {
    const dir = await getCacheDir();
    const target = path.join(dir, name);
    const temp = `${target}.${process.pid}-${tempCounter++}.tmp`;

    await writeFile(temp, buffer);
    await rename(temp, target);
  } catch (err) {
    streamDeck.logger.warn(`Could not cache artwork ${name}`, err);
    // Caching is an optimisation; failing to write it must not fail the render.
  }
}
