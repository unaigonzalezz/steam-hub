import streamDeck from "@elgato/streamdeck";
import jpegCodec from "@jimp/js-jpeg";
import pngCodec from "@jimp/js-png";
import { Jimp } from "jimp";
import { readFileSync } from "node:fs";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import opentype from "opentype.js";

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

/**
 * Dimensions of a render target, in pixels.
 *
 * Art is composited at the size it will actually be shown at rather than always at key size,
 * because anything drawn square and then displayed in a wide slot, an encoder's touch strip
 * being the case in point, is stretched by the difference.
 */
export type Size = { readonly w: number; readonly h: number };

/** The square every key scales from. */
const KEY: Size = { w: KEY_SIZE, h: KEY_SIZE };

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
const CDN_NAMES = new Set(["library_600x900_2x.jpg", "library_600x900.jpg", "header.jpg", "library_hero.jpg", "logo.png"]);

type ArtKind = keyof typeof SOURCES;

/** Steam's public art CDN. The second host is a fallback for networks that block the first. */
const CDN_HOSTS = ["https://cdn.cloudflare.steamstatic.com/steam/apps", "https://cdn.akamai.steamstatic.com/steam/apps"];

/** Same CDN, different tree: achievement icons live under the community image path, not `steam/apps`. */
const ACHIEVEMENT_CDN_HOSTS = [
  "https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps",
  "https://cdn.akamai.steamstatic.com/steamcommunity/public/images/apps",
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
 * Creates a canvas of a single colour.
 * @param color Packed RGBA colour.
 * @param size Canvas dimensions; a key by default.
 * @returns The canvas.
 */
function blank(color: number, size: Size = KEY): Image {
  return new Jimp({ width: size.w, height: size.h, color }) as unknown as Image;
}

const rendered = new Map<string, string>();
const inFlight = new Map<string, Promise<string | undefined>>();

/**
 * Keeps the render cache bounded. Room for three pages of the largest device, 36 keys on a Stream
 * Deck + XL: the one on screen and the two either side that are rendered ahead of a page turn, with
 * headroom for dials and the odd status variant.
 */
const MAX_CACHED_RENDERS = 160;

let tempCounter = 0;

/**
 * Colour of the border drawn around a key whose game is doing something. Chosen to read at a
 * glance against store art, which is usually dark and rarely saturated at the very edge.
 */
const STATUS_COLOURS = {
  running: [0x35, 0x9b, 0x43],
  updating: [0xf5, 0xa6, 0x23],
} as const satisfies Record<Exclude<StatusBadge, "idle" | "missing">, readonly [number, number, number]>;

/** Border width in key pixels, heavy enough to read across the room, light enough to frame. */
const BORDER_WIDTH = 11;

/**
 * How dark the unfilled part of a progress ring's track is, relative to the badge colour, so a
 * download barely started still shows a full ring rather than a bare sliver.
 */
const TRACK_BRIGHTNESS = 0.3;

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
 * Whether to frame the key, and in what colour. `missing` is the odd one out: rather than a frame,
 * it turns the whole key black and white, for a game that is not installed at all.
 */
export type StatusBadge = "idle" | "running" | "updating" | "missing";

/**
 * Renders the key image for a game, composited and encoded ready for `setImage`.
 *
 * Results are memoised per `(app, style, fit, badge)` and concurrent requests for the same image
 * share a single render, so a page of keys appearing at once does the work exactly once.
 * @param appId Steam application id.
 * @param style Which art to use.
 * @param fit How to fit it into the key.
 * @param badge Status border to draw around the art.
 * @param progress Fraction of an update or install completed, in `[0, 1]`; only meaningful, and only
 * drawn, when `badge` is `"updating"`. `undefined` falls back to the plain solid ring.
 * @returns A `data:` URI, or `undefined` when no art could be found.
 */
async function renderSized(
  appId: string,
  style: ArtStyle,
  fit: ArtFit,
  badge: StatusBadge,
  size: Size,
  progress: number | undefined,
): Promise<string | undefined> {
  if (style === "none" || !/^\d{1,10}$/.test(appId)) {
    return undefined;
  }

  // Size belongs in the key: the same art at key size and at strip size are different images,
  // and leaving it out hands whichever asked first to whoever asks second. Progress is bucketed to
  // a whole percent so a fraction that barely moved between polls does not miss the cache.
  const progressKey = progress === undefined ? "-" : Math.round(progress * 100);
  const key = `${appId}:${style}:${fit}:${badge}:${size.w}x${size.h}:${progressKey}`;
  const cached = rendered.get(key);
  if (cached !== undefined) {
    return cached;
  }

  const existing = inFlight.get(key);
  if (existing !== undefined) {
    return existing;
  }

  const task = render(appId, style, fit, badge, size, progress)
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
 * Renders a game's art for a key.
 * @param appId Steam application id.
 * @param style Which art to use.
 * @param fit How to fit it into the key.
 * @param badge Status border to draw around the art.
 * @param progress Fraction of an update or install completed, in `[0, 1]`; see {@link renderSized}.
 * @returns A `data:` URI, or `undefined` when no art could be found.
 */
export function renderKeyImage(
  appId: string,
  style: ArtStyle,
  fit: ArtFit,
  badge: StatusBadge = "idle",
  progress?: number,
): Promise<string | undefined> {
  return renderSized(appId, style, fit, badge, KEY, progress);
}

/**
 * Renders a game's art for a slot on an encoder's touch strip.
 *
 * Composited at the strip's own dimensions rather than at key size. A square key image shown in a
 * wide slot is stretched by the ratio between them, which on a Stream Deck + is severe enough to
 * make every piece of box art look wrong; rendering at the target size crops instead, so the art
 * keeps its proportions. `hero` suits the widest slots, `header` the squarer ones.
 * @param appId Steam application id.
 * @param style Which art to use.
 * @param fit How to fit it into the slot.
 * @param size Dimensions of the slot, matching the `rect` of the layout item it fills.
 * @param badge Status border to draw around the art, scaled to the slot.
 * @param progress Fraction of an update or install completed, in `[0, 1]`; see {@link renderSized}.
 * @returns A `data:` URI, or `undefined` when no art could be found.
 */
export function renderStripImage(
  appId: string,
  style: ArtStyle,
  fit: ArtFit,
  size: Size,
  badge: StatusBadge = "idle",
  progress?: number,
): Promise<string | undefined> {
  return renderSized(appId, style, fit, badge, size, progress);
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
 * Text drawn onto a key: a short reading, a name, or both.
 *
 * The reading is a page position, a play time or a download percentage. `main` is the part that
 * changes and is drawn large; `suffix`, if any, follows it smaller and dimmer, the "/20" of "3/20"
 * or the "%" of "42%". The label is a game name, already wrapped into lines, drawn small.
 */
export type Caption = {
  main?: string;
  suffix?: string;

  /** Font size of `main`, in key pixels. Defaults to 30; a long reading like "1:23:45" wants less. */
  size?: number;

  /** Lines of a name, drawn small along the bottom edge. */
  label?: readonly string[];

  /** Lines drawn small along the top edge, the way {@link Caption.label} is along the bottom. */
  heading?: readonly string[];

  /** Whether the reading goes along the top even with no label below it. */
  top?: boolean;

  /**
   * Whether the key wears a status frame, the green or amber border. The text then keeps further
   * in from the edges, so it does not sit hard against the frame.
   */
  framed?: boolean;

  /** Whether the reading goes across the middle of the key instead of along an edge. Ignored with a label. */
  middle?: boolean;

  /** Whether the reading is drawn in the dimmer colour, for a placeholder such as an idle clock. */
  muted?: boolean;
};

/** Gap between the text and the key's edge band, in key pixels; wider inside a status frame. */
const CAPTION_MARGIN = { plain: 3, framed: 9 } as const;

/** Font size of a {@link Caption} label, in key pixels. */
const LABEL_SIZE = 15;

/** Roughly how many characters of a {@link Caption} label fit across one key. */
export const LABEL_LINE_LENGTH = 14;

/**
 * Draws a {@link Caption} onto a key image: the label along the bottom edge, the heading along the
 * top, and the reading along the bottom too, or along the top when there is a label to make room for.
 *
 * Done as an SVG wrapped around the existing image rather than through Jimp, which would need a
 * bitmap font shipped and decoded just to print a few words; the Stream Deck renders SVG keys
 * natively. The colours are those of the stock page arrows, the light end of their chevron and the
 * ring's stroke, so everything the plugin writes looks alike on every key.
 * @param base A `data:` URI of the key image underneath.
 * @param caption What to write.
 * @returns A `data:` URI of the composed SVG.
 */
export function renderCaption(base: string, caption: Caption): string {
  const font = captionFont("bold");
  const size = caption.size ?? 30;
  const label = caption.label ?? [];

  // Baselines are placed by hand, since Qt's SVG renderer ignores dominant-baseline: clear of the
  // status frame BORDER_WIDTH draws along either edge, by the font's cap height at the top.
  const capHeight = font === undefined ? 0.72 : (font.tables.os2?.sCapHeight ?? 700) / font.unitsPerEm;
  const margin = caption.framed === true ? CAPTION_MARGIN.framed : CAPTION_MARGIN.plain;
  const bottom = KEY_SIZE - BORDER_WIDTH - margin;
  const top = BORDER_WIDTH + margin + Math.round(size * capHeight);
  const middle = KEY_SIZE / 2 + Math.round((size * capHeight) / 2);
  const heading = caption.heading ?? [];
  const headingTop = BORDER_WIDTH + margin + Math.round(LABEL_SIZE * capHeight);
  const readingBaseline = label.length > 0 || caption.top === true ? top : caption.middle === true ? middle : bottom;

  // Qt's SVG renderer has no filters either, so the shadow that lifts the text off whatever art is
  // underneath is a second, offset copy of it.
  const layer = (dx: number, bright: string, dim: string): string => {
    const opacity = dx === 0 ? undefined : 0.75;
    let out = "";

    if (caption.main) {
      // The changing value bold, what qualifies it, the "/20" or the "%", in the regular weight.
      const runs: TextRun[] = [{ text: caption.main, size, fill: caption.muted === true ? dim : bright, weight: "bold" }];
      if (caption.suffix) {
        runs.push({ text: caption.suffix, size: Math.round(size * 0.67), fill: dim, weight: "regular" });
      }
      out += drawLine(runs, readingBaseline + dx, dx, opacity);
    }

    label.forEach((line, i) => {
      const y = bottom - (label.length - 1 - i) * (LABEL_SIZE + 2);
      out += drawLine([{ text: line, size: LABEL_SIZE, fill: bright, weight: "regular" }], y + dx, dx, opacity);
    });

    heading.forEach((line, i) => {
      const y = headingTop + i * (LABEL_SIZE + 2);
      out += drawLine([{ text: line, size: LABEL_SIZE, fill: bright, weight: "regular" }], y + dx, dx, opacity);
    });

    return out;
  };

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${KEY_SIZE}" height="${KEY_SIZE}" viewBox="0 0 ${KEY_SIZE} ${KEY_SIZE}">` +
    `<image x="0" y="0" width="${KEY_SIZE}" height="${KEY_SIZE}" xlink:href="${base}"/>` +
    layer(1.5, "#001a3a", "#001a3a") +
    layer(0, "#d2e2f6", "#8fb0de") +
    `</svg>`;

  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

/**
 * The fonts captions are drawn in, one file per weight, shipped in the plugin's `fonts` folder so
 * keys look the same on every machine whether or not they are installed. Replace the files, or point
 * these at others, to change them; static TrueType fonts are the safest, opentype.js does not apply a
 * variable font's weight axis. A missing regular weight falls back to the bold one.
 */
const CAPTION_FONT_FILES = { bold: "Gila Bold.ttf", regular: "Gila.ttf" } as const;

/** A caption font weight, one of {@link CAPTION_FONT_FILES}. */
type FontWeight = keyof typeof CAPTION_FONT_FILES;

/** Fallback when the font file is missing or unreadable: drawn as text with a system font. */
const FALLBACK_FONT_FAMILY = "Arial";

/** Widest a line of caption text may be before it is shrunk to fit, in key pixels. */
const CAPTION_MAX_WIDTH = KEY_SIZE - 2 * (BORDER_WIDTH + CAPTION_MARGIN.plain);

/** The parsed caption fonts, by weight: absent before the first read, `null` once one failed to load. */
const captionFontCache = new Map<FontWeight, opentype.Font | null>();

/**
 * Loads a caption font, once per weight.
 * @param weight Which weight.
 * @returns The font, the bold one in place of a missing regular, or `undefined` when neither can be
 * read, so captions fall back to a system font.
 */
function captionFont(weight: FontWeight): opentype.Font | undefined {
  if (!captionFontCache.has(weight)) {
    const file = pluginPath("fonts", CAPTION_FONT_FILES[weight]);
    try {
      const bytes = readFileSync(file);
      captionFontCache.set(
        weight,
        opentype.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
      );
    } catch (err) {
      streamDeck.logger.warn(`Cannot load the caption font "${file}"`, err);
      captionFontCache.set(weight, null);
    }
  }

  return captionFontCache.get(weight) ?? (weight === "bold" ? undefined : captionFont("bold"));
}

/** A stretch of caption text in one size, colour and weight. */
type TextRun = { text: string; size: number; fill: string; weight: FontWeight };

/**
 * Draws one line of text, centred across the key, as outlines in the caption fonts, so it renders
 * the same whatever is installed. Shrunk as a whole when it would not fit across the key. Falls back
 * to SVG text in a system font when the fonts cannot be loaded.
 * @param runs The line's pieces, drawn one after another.
 * @param baseline Baseline, in key pixels.
 * @param dx Horizontal offset, for the shadow copy.
 * @param opacity Fill opacity, or `undefined` for opaque.
 * @returns SVG markup.
 */
function drawLine(runs: readonly TextRun[], baseline: number, dx: number, opacity: number | undefined): string {
  const fillOpacity = opacity === undefined ? "" : ` fill-opacity="${opacity}"`;

  const fonts = runs.map((run) => captionFont(run.weight));
  if (fonts.some((font) => font === undefined)) {
    return (
      `<text x="${KEY_SIZE / 2 + dx}" y="${baseline}" text-anchor="middle" font-family="${FALLBACK_FONT_FAMILY}"${fillOpacity}>` +
      runs
        .map(
          (run) =>
            `<tspan font-size="${run.size}" font-weight="${run.weight === "bold" ? "bold" : "normal"}" fill="${run.fill}">${escapeXml(run.text)}</tspan>`,
        )
        .join("") +
      `</text>`
    );
  }

  const widths = runs.map((run, i) => fonts[i]!.getAdvanceWidth(run.text, run.size));
  const total = widths.reduce((sum, width) => sum + width, 0);
  const scale = total > CAPTION_MAX_WIDTH ? CAPTION_MAX_WIDTH / total : 1;

  let x = KEY_SIZE / 2 + dx - (total * scale) / 2;
  return runs
    .map((run, i) => {
      const d = fonts[i]!.getPath(run.text, x, baseline, run.size * scale).toPathData(2);
      x += widths[i]! * scale;
      return `<path d="${d}" fill="${run.fill}"${fillOpacity}/>`;
    })
    .join("");
}

/**
 * Escapes text for an SVG text node.
 * @param value Raw text.
 * @returns The escaped text.
 */
function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Rendered avatar keys, keyed by every file's path and modification time. */
const avatarKeys = new Map<string, string>();

/** The image files an avatar key is built from, each optional. */
export type AvatarLayers = {
  /** The avatar, a JPEG or PNG. */
  avatar?: string;

  /**
   * A frame laid over the avatar: a key-sized PNG, opaque where the frame is and transparent where
   * the avatar shows through. The avatar is fitted to the transparent hole, so the frame can be
   * redrawn with a hole of any size or place.
   */
  frame?: string;

  /**
   * A status bubble, any PNG with transparency, laid over the frame. One drawn at key size covers
   * the whole key, so it can sit anywhere; a smaller one goes in the bottom-right corner.
   */
  bubble?: string;

  /**
   * How the avatar itself is toned, so a state reads even before the frame's colour does: `dim`
   * darkens it, `grey` turns it black and white, `faded` does both.
   */
  effect?: AvatarEffect;
};

/** A tone applied to the avatar; see {@link AvatarLayers.effect}. */
export type AvatarEffect = "none" | "dim" | "grey" | "faded";

/** How bright a dimmed avatar stays, as a fraction of the original. */
const AVATAR_DIM = 0.6;

/**
 * Renders a user's avatar for a key: the avatar, toned if asked, the frame over it and an optional
 * bubble on top. Any missing or unreadable layer is simply left out, so a missing avatar still
 * shows the frame.
 * @param layers The files to build it from.
 * @returns A `data:` URI.
 */
export async function renderAvatarKey(layers: AvatarLayers): Promise<string> {
  // Keyed on modification times too, so a new avatar, or a file edited in place, shows on the next draw.
  const stamp = async (file: string | undefined): Promise<string> => {
    try {
      return file === undefined ? "-" : `${file}:${(await stat(file)).mtimeMs}`;
    } catch {
      return `${file}:missing`;
    }
  };
  const effect = layers.effect ?? "none";
  const key = `${(await Promise.all([layers.avatar, layers.frame, layers.bubble].map(stamp))).join("|")}|${effect}`;

  const cached = avatarKeys.get(key);
  if (cached !== undefined) {
    return cached;
  }

  const load = async (file: string | undefined): Promise<Image | undefined> => {
    const bytes = file === undefined ? undefined : await readIfImage(file);
    return bytes === undefined ? undefined : decode(bytes);
  };
  const [avatar, frame, bubble] = await Promise.all([load(layers.avatar), load(layers.frame), load(layers.bubble)]);

  const key144 = blank(FALLBACK_BACKDROP);
  const fittedFrame = frame?.cover({ w: KEY_SIZE, h: KEY_SIZE });

  if (avatar !== undefined) {
    const hole = fittedFrame === undefined ? undefined : transparentBounds(fittedFrame);
    const area = hole ?? { x: 0, y: 0, w: KEY_SIZE, h: KEY_SIZE };
    const fitted = avatar.cover({ w: area.w, h: area.h });
    if (effect === "grey" || effect === "faded") {
      markMissing(fitted);
    }
    if (effect === "dim" || effect === "faded") {
      fitted.brightness(AVATAR_DIM);
    }
    key144.composite(fitted, area.x, area.y);
  }

  if (fittedFrame !== undefined) {
    key144.composite(fittedFrame, 0, 0);
  }

  if (bubble !== undefined) {
    const fitted =
      bubble.width > KEY_SIZE || bubble.height > KEY_SIZE ? bubble.scaleToFit({ w: KEY_SIZE, h: KEY_SIZE }) : bubble;
    key144.composite(fitted, KEY_SIZE - fitted.width, KEY_SIZE - fitted.height);
  }

  const image = await toDataUri(key144, "avatar");

  if (avatarKeys.size >= MAX_CACHED_RENDERS) {
    avatarKeys.clear();
  }
  avatarKeys.set(key, image);

  return image;
}

/**
 * Finds the transparent hole in a frame: the bounding box of its see-through pixels, grown by a
 * pixel each way so the avatar runs under the frame's anti-aliased inner edge rather than stopping
 * short of it.
 * @param frame The frame, at key size.
 * @returns The hole, or `undefined` when the frame has none.
 */
function transparentBounds(frame: Image): { x: number; y: number; w: number; h: number } | undefined {
  const { data, width, height } = frame.bitmap;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3]! < 128) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }

  if (maxX < 0) {
    return undefined;
  }

  const x = Math.max(0, minX - 1);
  const y = Math.max(0, minY - 1);
  return { x, y, w: Math.min(width, maxX + 2) - x, h: Math.min(height, maxY + 2) - y };
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
 * @param progress Fraction of an update or install completed, in `[0, 1]`; see {@link renderSized}.
 * @returns A `data:` URI, or `undefined` when the game has no art at all.
 */
async function render(
  appId: string,
  style: Exclude<ArtStyle, "none">,
  fit: ArtFit,
  badge: StatusBadge,
  size: Size = KEY,
  progress?: number,
): Promise<string | undefined> {
  if (style === "logo") {
    const logo = await loadArt(appId, "logo");
    if (logo !== undefined) {
      // A logo is a transparent wordmark: it always sits over a backdrop, never cropped.
      const backdrop = await loadFirst(appId, ["hero", "header", "capsule"]);
      return compose(logo, backdrop, "fit", 0.84, 0.42, badge, `${appId}-logo-${badge}`, size, progress);
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
  return fit === "fill"
    ? compose(art, undefined, "fill", 1, 1, badge, label, size, progress)
    : compose(art, art, "fit", 1, 0.55, badge, label, size, progress);
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
 * @param size Dimensions to composite at; a key by default.
 * @param progress Fraction of an update or install completed, in `[0, 1]`; see {@link renderSized}.
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
  size: Size = KEY,
  progress?: number,
): Promise<string> {
  if (fit === "fill") {
    return toDataUri(outline(decode(foreground).cover({ w: size.w, h: size.h }), badge, progress), label);
  }

  const canvas =
    backdrop !== undefined
      ? decode(backdrop).cover({ w: size.w, h: size.h }).blur(5).brightness(dim)
      : blank(FALLBACK_BACKDROP, size);

  // `scaleToFit` keeps the aspect ratio without padding, so the composite stays exactly centred.
  // Scaling against the shorter side keeps the art inside a non-square target on both axes.
  const box = Math.round(Math.min(size.w, size.h) * scale);
  const art = decode(foreground).scaleToFit({ w: box, h: box });

  canvas.composite(art, Math.round((size.w - art.width) / 2), Math.round((size.h - art.height) / 2));

  return toDataUri(outline(canvas, badge, progress), label);
}

/**
 * Draws a status border around the edge of a finished key image, in place.
 *
 * Painted onto the bitmap directly rather than composited: it is a handful of solid pixel runs, and
 * doing it here keeps the border out of the blur and scaling that produced the art underneath.
 * @param image Image to frame.
 * @param badge Which border to draw; `idle` leaves the image untouched.
 * @param progress Fraction of an update or install completed, in `[0, 1]`. Only ever used with
 * `badge === "updating"`: instead of a solid ring, the border sweeps clockwise from the top, bright
 * where progress has reached and dim ahead of it, like a clock face filling in. `undefined` (unknown
 * size, or any other badge) draws the plain solid ring exactly as before.
 * @returns The same image, for chaining.
 */
function outline(image: Image, badge: StatusBadge, progress?: number): Image {
  if (badge === "idle") {
    return image;
  }

  if (badge === "missing") {
    return markMissing(image);
  }

  const [r, g, b] = STATUS_COLOURS[badge];
  const { data, width, height } = image.bitmap;

  const sweep = badge === "updating" && progress !== undefined ? Math.min(1, Math.max(0, progress)) : undefined;
  const dim: readonly [number, number, number] = [
    Math.round(r * TRACK_BRIGHTNESS),
    Math.round(g * TRACK_BRIGHTNESS),
    Math.round(b * TRACK_BRIGHTNESS),
  ];

  // Border weight is proportional to the image, not fixed, so the frame reads the same on an
  // encoder's touch strip as it does on a key. At key size this is exactly the old constants;
  // on a strip barely a third as tall, a fixed 11px would swallow most of the height and a
  // fixed 20px inner radius would exceed what is left, overlapping into nonsense.
  const scale = Math.min(width, height) / KEY_SIZE;
  const inset = Math.max(2, Math.round(BORDER_WIDTH * scale));
  const radius = Math.max(0, Math.round(BORDER_INNER_RADIUS * scale));

  // The hole the art shows through: the image inset by the border, with rounded corners.
  const left = inset;
  const top = inset;
  const right = width - inset;
  const bottom = height - inset;

  // Centre and half-extents a swept pixel's angle is measured against. Normalising by these before
  // taking the angle treats the ring as sitting on an ellipse inscribed in the image rather than a
  // circle in raw pixels, which is what keeps the sweep looking even on a square key and on a much
  // wider encoder strip alike: a raw pixel angle would spend almost the whole sweep crossing the
  // two short top/bottom edges of a wide strip and barely any of it on the long sides.
  const cx = width / 2;
  const cy = height / 2;
  const halfW = width / 2;
  const halfH = height / 2;

  /**
   * Picks the colour for one border pixel: the badge colour when there is no sweep to draw, or
   * when the sweep has reached this pixel's clockwise position; the dim track colour otherwise.
   */
  const colourAt = (x: number, y: number): readonly [number, number, number] => {
    if (sweep === undefined) {
      return [r, g, b];
    }

    // atan2's operands are swapped from the usual (y, x) so 0 points straight up rather than right,
    // and negated on the y axis so increasing angle sweeps clockwise rather than counterclockwise.
    const theta = Math.atan2((x - cx) / halfW, (cy - y) / halfH);
    const fraction = theta < 0 ? theta / (2 * Math.PI) + 1 : theta / (2 * Math.PI);

    return fraction <= sweep ? [r, g, b] : dim;
  };

  for (let y = 0; y < height; y++) {
    // Rows clear of the corners are two straight runs, so they skip the sampling entirely.
    if (y >= top + radius && y < bottom - radius) {
      for (let x = 0; x < left; x++) {
        const [cr, cg, cb] = colourAt(x, y);
        paintBorder(data, width, x, y, cr, cg, cb, 1);
      }
      for (let x = right; x < width; x++) {
        const [cr, cg, cb] = colourAt(x, y);
        paintBorder(data, width, x, y, cr, cg, cb, 1);
      }
      continue;
    }

    for (let x = 0; x < width; x++) {
      // Coverage of the border is whatever the rounded hole does not cover.
      const coverage = 1 - holeCoverage(x, y, left, top, right, bottom, radius);
      if (coverage > 0) {
        const [cr, cg, cb] = colourAt(x, y);
        paintBorder(data, width, x, y, cr, cg, cb, coverage);
      }
    }
  }

  return image;
}

/**
 * Turns a key black and white, in place: the look of a game from a collection that is not
 * installed, otherwise drawn exactly like every other game so the page keeps one style.
 * @param image Image to convert.
 * @returns The same image, for chaining.
 */
function markMissing(image: Image): Image {
  const { data } = image.bitmap;

  for (let offset = 0; offset < data.length; offset += 4) {
    // Rec. 601 luma: cheap, and plenty for art that only needs to read as "not available".
    const luma = Math.round(0.299 * data[offset]! + 0.587 * data[offset + 1]! + 0.114 * data[offset + 2]!);
    data[offset] = luma;
    data[offset + 1] = luma;
    data[offset + 2] = luma;
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
 * @param hosts CDN hosts to try, in order. Defaults to the game art tree.
 * @param cacheName Filename to cache the result under. Defaults to `<appId>_<name>`.
 * @returns The image bytes, or `undefined` when the asset does not exist.
 */
async function download(
  appId: string,
  name: string,
  hosts: readonly string[] = CDN_HOSTS,
  cacheName = `${appId}_${name}`,
): Promise<Buffer | undefined> {
  for (const host of hosts) {
    const url = `${host}/${appId}/${name}`;
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        break; // a 404 here means the asset does not exist; the other host will not have it either
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      if (!isImage(buffer)) {
        break; // an error page served with a 200
      }

      await writeCache(cacheName, buffer);
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
 * Resolves one achievement's icon, preferring a copy already cached on disk from a previous render.
 * @param appId Steam application id the achievement belongs to.
 * @param icon Icon filename from the achievement schema.
 * @returns The image bytes, or `undefined` when the icon could not be fetched.
 */
async function loadAchievementIcon(appId: string, icon: string): Promise<Buffer | undefined> {
  const cacheName = `${appId}_achievement_${icon}`;

  const cached = await readIfImage(path.join(await getCacheDir(), cacheName));
  if (cached !== undefined) {
    return cached;
  }

  return download(appId, icon, ACHIEVEMENT_CDN_HOSTS, cacheName);
}

/**
 * Renders an achievement's icon on a key, centred over a dark plate.
 *
 * Achievement icons are small, usually 64x64, so they are fit rather than covered the way store art
 * is: stretching one edge to edge across a 144px key would make the compression blocks obvious.
 *
 * Results are memoised per `(app, icon)`, the same way {@link renderKeyImage} memoises store art.
 * @param appId Steam application id the achievement belongs to.
 * @param icon Icon filename from the achievement schema.
 * @returns A `data:` URI, or `undefined` when the icon could not be fetched.
 */
export async function renderAchievementKey(appId: string, icon: string): Promise<string | undefined> {
  if (!/^\d{1,10}$/.test(appId) || icon === "") {
    return undefined;
  }

  const key = `achievement:${appId}:${icon}`;
  const cached = rendered.get(key);
  if (cached !== undefined) {
    return cached;
  }

  const existing = inFlight.get(key);
  if (existing !== undefined) {
    return existing;
  }

  const task = (async (): Promise<string | undefined> => {
    const bytes = await loadAchievementIcon(appId, icon);
    return bytes === undefined ? undefined : compose(bytes, undefined, "fit", 0.62, 1, "idle", key, KEY);
  })()
    .catch((err) => {
      streamDeck.logger.error(`Failed to render achievement icon for app ${appId}`, err);
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
