/**
 * The local engine's pipe (decision 0012 §2–§4): what one host of the engine — the desktop, or `jaira
 * serve` — and its clients say to each other, and where they find each other.
 *
 * **One engine per person and `JAIRA_HOME`.** The host is whoever creates the pipe first: a named pipe
 * on Windows (`\\.\pipe\jaira-<user>-<home hash>`), a Unix socket elsewhere (in a `0700` directory under
 * `$XDG_RUNTIME_DIR` or `/tmp/jaira-<uid>`, so the path stays under the ~104-byte socket limit). A second
 * listen on the name fails with `EADDRINUSE` — measured on Windows 2026-09-27, across processes too —
 * so creating it IS the claim.
 *
 * **Every client proves it is the person.** Windows' default named-pipe DACL lets other accounts READ,
 * so the host sends nothing until a client's `hello` carries the token in `engine.json`
 * (`<base>/system/engine.json`, in the person's profile, `0600` where modes exist). A client that cannot
 * read that file cannot get past `hello`.
 *
 * **Frames** are length-prefixed JSON: a 4-byte big-endian length, then that many bytes of UTF-8.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import type { ClientFrame, EngineHostInfo, HostFrame } from "@jaira/shared";

// The frames and the contract are `@jaira/shared`'s (`engineFrames.ts`): a phone and a browser speak
// them too, and have no `node:` module to import this file through.
export { ENGINE_CONTRACT, type ClientFrame, type EngineHostInfo, type HostFrame, type PairingDevice, type PeerMachine } from "@jaira/shared";

/** `engine.json`: the host's info and the token a client needs. */
export interface EngineFile extends EngineHostInfo {
  token: string;
}

/**
 * The loopback port a host listens on when it cannot create its pipe (a sandbox without pipes), and
 * the one discovery tries third. The same for every person and root: `home` and the token tell them apart.
 */
export const ENGINE_PORT = 47_317;

/** A short, stable name for a base root, for the pipe's name. */
export function homeHash(baseDir: string): string {
  const key = process.platform === "win32" ? baseDir.toLowerCase() : baseDir;
  return createHash("sha256").update(key).digest("hex").slice(0, 10);
}

/** The pipe (Windows) or socket path for this person and base root. */
export function enginePipePath(baseDir: string): string {
  const hash = homeHash(baseDir);
  if (process.platform === "win32") {
    const user = userInfo().username.replace(/[^A-Za-z0-9_.-]/g, "_");
    return `\\\\.\\pipe\\jaira-${user}-${hash}`;
  }
  const runtime = process.env["XDG_RUNTIME_DIR"];
  const dir = runtime !== undefined && runtime !== "" ? join(runtime, "jaira") : join(tmpdir(), `jaira-${userInfo().uid}`);
  return join(dir, `${hash}.sock`);
}

/** Where a host describes itself: beside the other files the base root keeps for the machine. */
export function engineFilePath(baseDir: string): string {
  return join(baseDir, "system", "engine.json");
}

export function writeEngineFile(baseDir: string, file: EngineFile): void {
  const path = engineFilePath(baseDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

export function readEngineFile(baseDir: string): EngineFile | undefined {
  try {
    return JSON.parse(readFileSync(engineFilePath(baseDir), "utf8")) as EngineFile;
  } catch {
    return undefined;
  }
}

/** Remove `engine.json` if it still describes this process's host (another may have replaced it). */
export function removeEngineFile(baseDir: string, pid: number): void {
  if (readEngineFile(baseDir)?.pid === pid) rmSync(engineFilePath(baseDir), { force: true });
}

/** Encode one frame. */
export function encodeFrame(frame: ClientFrame | HostFrame): Buffer {
  const body = Buffer.from(JSON.stringify(frame), "utf8");
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length, 0);
  return Buffer.concat([head, body]);
}

/** The largest frame either side accepts, so a stray writer cannot make the other allocate without bound. */
export const MAX_FRAME_BYTES = 256 * 1024 * 1024;

/** Collects bytes and hands back whole frames. */
export class FrameReader {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const frames: unknown[] = [];
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0);
      if (length > MAX_FRAME_BYTES) throw new Error(`a frame of ${length} bytes is over the limit`);
      if (this.buffer.length < 4 + length) break;
      frames.push(JSON.parse(this.buffer.subarray(4, 4 + length).toString("utf8")));
      this.buffer = this.buffer.subarray(4 + length);
    }
    return frames;
  }
}
