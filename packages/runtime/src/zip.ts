/**
 * Just enough of the zip format to unpack a CI artifact (decision 0016 §2): the central directory,
 * stored and deflated entries, read with Node's own `zlib`. Not a general archiver — no zip64, no
 * encryption — and it refuses a name that would land outside the folder it is unpacked into.
 *
 * A dependency for this was weighed and not taken: the one in `node_modules` is electron-builder's,
 * which the installed app does not carry, and a GitHub artifact or a GitLab archive is a plain zip.
 */
import { inflateRawSync } from "node:zlib";

export interface ZipEntry {
  /** `/`-separated, relative, never climbing out (`..`) — checked. */
  name: string;
  data: Uint8Array;
}

export interface ZipLimits {
  maxEntries?: number;
  /** The unpacked size, all entries together. */
  maxBytes?: number;
}

export class ZipError extends Error {}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/** Whether these bytes start like a zip. */
export function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/** A name safe to write under a folder, or `undefined`: absolute, drive-lettered, or climbing out is refused. */
export function safeEntryName(name: string): string | undefined {
  const parts = name.replace(/\\/g, "/").split("/").filter((part) => part.length > 0 && part !== ".");
  if (name.startsWith("/") || name.startsWith("\\") || /^[A-Za-z]:/.test(name) || parts.some((part) => part === "..") || parts.length === 0) return undefined;
  return parts.join("/");
}

/** Every file in the archive (folders are implied by names). */
export function readZip(bytes: Uint8Array, limits: ZipLimits = {}): ZipEntry[] {
  const maxEntries = limits.maxEntries ?? 10_000;
  const maxBytes = limits.maxBytes ?? 512 * 1024 * 1024;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  // The end record is at most 22 + 65 535 (its comment) bytes from the end.
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 65_535); at--) {
    if (view.getUint32(at, true) === EOCD) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new ZipError("not a zip archive (no end of central directory)");
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  if (count === 0xffff || at === 0xffffffff) throw new ZipError("a zip64 archive, which is not read here");
  if (count > maxEntries) throw new ZipError(`the archive holds ${count} files, more than ${maxEntries}`);
  const decoder = new TextDecoder();
  const out: ZipEntry[] = [];
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (view.getUint32(at, true) !== CENTRAL) throw new ZipError("a damaged central directory");
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const compressed = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const raw = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extraLength + commentLength;
    if (raw.endsWith("/")) continue;
    if ((flags & 1) !== 0) throw new ZipError(`${raw} is encrypted`);
    const name = safeEntryName(raw);
    if (name === undefined) throw new ZipError(`${raw} would land outside the folder it is unpacked into`);
    total += size;
    if (total > maxBytes) throw new ZipError(`the archive unpacks to more than ${Math.round(maxBytes / 1024 / 1024)} MB`);
    if (view.getUint32(local, true) !== LOCAL) throw new ZipError(`a damaged entry: ${raw}`);
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const packed = bytes.subarray(start, start + compressed);
    let data: Uint8Array;
    if (method === 0) data = packed;
    else if (method === 8) data = new Uint8Array(inflateRawSync(packed));
    else throw new ZipError(`${raw} is packed with method ${method}, which is not read here`);
    out.push({ name, data });
  }
  return out;
}
