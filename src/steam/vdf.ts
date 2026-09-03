/**
 * Minimal parser for Valve's KeyValues (VDF) text format, which backs `libraryfolders.vdf`
 * and every `appmanifest_*.acf`.
 *
 * The parser is deliberately tolerant: these files are machine-written, but Steam rewrites them
 * while it runs, so we can catch one mid-flush. A malformed file should cost us a single game,
 * never the whole scan.
 */

export type VdfNode = string | VdfObject;

export type VdfObject = {
  [key: string]: VdfNode;
};

/** Guards against stack exhaustion on a corrupt file with unbalanced braces. */
const MAX_DEPTH = 64;

/**
 * Parses KeyValues text into a plain object. Nested blocks become nested objects, everything else
 * stays a string, Steam stores numbers as quoted strings anyway.
 * @param text Raw file contents, BOM tolerated.
 * @returns The parsed root object.
 */
export function parseVdf(text: string): VdfObject {
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const len = text.length;

  const skipTrivia = (): void => {
    while (i < len) {
      const c = text[i];
      if (c === " " || c === "\t" || c === "\r" || c === "\n") {
        i++;
      } else if (c === "/" && text[i + 1] === "/") {
        while (i < len && text[i] !== "\n") {
          i++;
        }
      } else {
        return;
      }
    }
  };

  // Reads a quoted token, resolving the escapes Steam actually emits (\\ and \" in paths, \n \t \r).
  const readQuoted = (): string => {
    i++; // opening quote
    let out = "";
    while (i < len) {
      const c = text[i];
      if (c === '"') {
        i++;
        return out;
      }
      if (c === "\\") {
        const next = text[i + 1];
        i += 2;
        switch (next) {
          case "n":
            out += "\n";
            break;
          case "t":
            out += "\t";
            break;
          case "r":
            out += "\r";
            break;
          case undefined:
            break;
          default:
            out += next; // covers \\ and \" plus anything unknown
        }
      } else {
        out += c;
        i++;
      }
    }
    return out; // unterminated string at EOF, take what we have
  };

  const isBareEnd = (c: string): boolean =>
    c === " " || c === "\t" || c === "\r" || c === "\n" || c === "{" || c === "}" || c === '"';

  const readBare = (): string => {
    const start = i;
    while (i < len && !isBareEnd(text[i])) {
      i++;
    }
    return text.slice(start, i);
  };

  const parseBlock = (depth: number): VdfObject => {
    const obj: VdfObject = {};
    if (depth > MAX_DEPTH) {
      throw new Error("VDF nesting too deep");
    }

    for (;;) {
      skipTrivia();
      if (i >= len) {
        return obj;
      }
      if (text[i] === "}") {
        i++;
        return obj;
      }
      if (text[i] === "{") {
        i++; // stray opening brace with no key, skip it rather than desync
        continue;
      }

      const cursor = i;
      const key = text[i] === '"' ? readQuoted() : readBare();
      if (i === cursor) {
        i++; // never let a zero-width read spin forever
        continue;
      }

      skipTrivia();
      if (i >= len) {
        obj[key] = "";
        return obj;
      }

      const c = text[i];
      if (c === "{") {
        i++;
        obj[key] = parseBlock(depth + 1);
      } else if (c === "}") {
        obj[key] = ""; // dangling key at the end of a block
      } else if (c === '"') {
        obj[key] = readQuoted();
      } else {
        obj[key] = readBare();
      }
    }
  };

  return parseBlock(0);
}

/**
 * Looks a key up ignoring case. Steam is inconsistent across file versions, `libraryfolders`
 * vs `LibraryFolders`, `appid` vs `AppID`, so every read goes through here.
 * @param obj Object to search.
 * @param key Key to find.
 * @returns The matching value, or `undefined`.
 */
export function get(obj: VdfObject | undefined, key: string): VdfNode | undefined {
  if (obj === undefined) {
    return undefined;
  }
  if (key in obj) {
    return obj[key];
  }

  const lower = key.toLowerCase();
  for (const name of Object.keys(obj)) {
    if (name.toLowerCase() === lower) {
      return obj[name];
    }
  }

  return undefined;
}

/**
 * Reads a key as a string, or `undefined` when it is missing or a nested block.
 * @param obj Object to search.
 * @param key Key to find.
 * @returns The string value.
 */
export function getString(obj: VdfObject | undefined, key: string): string | undefined {
  const node = get(obj, key);
  return typeof node === "string" ? node : undefined;
}

/**
 * Reads a key as a nested block, or `undefined` when it is missing or a plain string.
 * @param obj Object to search.
 * @param key Key to find.
 * @returns The nested object.
 */
export function getObject(obj: VdfObject | undefined, key: string): VdfObject | undefined {
  const node = get(obj, key);
  return typeof node === "object" ? node : undefined;
}

/**
 * Reads a key as a number, tolerating the quoted-integer form Steam writes.
 * @param obj Object to search.
 * @param key Key to find.
 * @param fallback Value to use when absent or unparseable.
 * @returns The numeric value.
 */
export function getNumber(obj: VdfObject | undefined, key: string, fallback = 0): number {
  const value = Number.parseInt(getString(obj, key) ?? "", 10);
  return Number.isFinite(value) ? value : fallback;
}
