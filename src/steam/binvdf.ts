/**
 * Minimal parser for Valve's binary KeyValues (VDF) format, which backs the achievement schema and
 * per-user stat cache Steam keeps under `appcache/stats`.
 *
 * Distinct from the text KeyValues format `vdf.ts` parses: manifests and library folders are
 * hand-editable text, this is packed binary the client writes and rewrites on every stat change.
 * Format: a one-byte type tag, a NUL-terminated key, then the value; an object ends with a lone
 * `0x08` in place of a type tag.
 */

export type BinVdfNode = string | number | bigint | BinVdfObject;

export type BinVdfObject = {
  [key: string]: BinVdfNode;
};

const TYPE_OBJECT = 0x00;
const TYPE_STRING = 0x01;
const TYPE_INT32 = 0x02;
const TYPE_FLOAT32 = 0x03;
const TYPE_UINT64 = 0x07;
const TYPE_END = 0x08;

/** Guards against stack exhaustion on a truncated or corrupt file with unbalanced objects. */
const MAX_DEPTH = 64;

/**
 * Parses a binary KeyValues buffer into a plain object.
 * @param buf Raw file contents.
 * @returns The parsed root object.
 */
export function parseBinVdf(buf: Buffer): BinVdfObject {
  let pos = 0;

  const readCString = (): string => {
    const start = pos;
    while (pos < buf.length && buf[pos] !== 0) {
      pos++;
    }
    const value = buf.toString("utf8", start, pos);
    pos++; // skip the terminating NUL
    return value;
  };

  const readObject = (depth: number): BinVdfObject => {
    if (depth > MAX_DEPTH) {
      throw new Error("Binary VDF nesting too deep");
    }

    const obj: BinVdfObject = {};

    while (pos < buf.length) {
      const type = buf[pos++]!;
      if (type === TYPE_END) {
        return obj;
      }

      const key = readCString();
      switch (type) {
        case TYPE_OBJECT:
          obj[key] = readObject(depth + 1);
          break;
        case TYPE_STRING:
          obj[key] = readCString();
          break;
        case TYPE_INT32:
          obj[key] = buf.readInt32LE(pos);
          pos += 4;
          break;
        case TYPE_FLOAT32:
          obj[key] = buf.readFloatLE(pos);
          pos += 4;
          break;
        case TYPE_UINT64:
          obj[key] = buf.readBigUInt64LE(pos);
          pos += 8;
          break;
        default:
          throw new Error(`Unknown binary VDF type 0x${type.toString(16)} at offset ${pos - 1}`);
      }
    }

    return obj; // EOF without a closing marker at the root, tolerated like the text parser does
  };

  return readObject(0);
}

/**
 * Reads a key as a nested block, or `undefined` when it is missing or not one.
 * @param obj Object to search.
 * @param key Key to find.
 * @returns The nested object.
 */
export function getObject(obj: BinVdfObject | undefined, key: string): BinVdfObject | undefined {
  const node = obj?.[key];
  return typeof node === "object" ? node : undefined;
}

/**
 * Reads a key as a string, or `undefined` when it is missing or not one.
 * @param obj Object to search.
 * @param key Key to find.
 * @returns The string value.
 */
export function getString(obj: BinVdfObject | undefined, key: string): string | undefined {
  const node = obj?.[key];
  return typeof node === "string" ? node : undefined;
}
