/**
 * What an engine's host and its clients say to each other (decisions 0012 §3, 0013 §2–§3): the frames,
 * and the contract both sides must agree on. Here, with nothing of Node in it, because three kinds of
 * client speak it — a process on this machine over the pipe, another machine's engine over a WebSocket,
 * and a phone or a browser tab (a device), which has neither `node:net` nor `node:crypto`.
 *
 * How the frames travel — length-prefixed on the pipe, one JSON frame per WebSocket message — and where
 * a host is found are `@jaira/service`'s (`enginePipe.ts`).
 */
import { IPC_CHANNELS, type PushMessage } from "./ipc";

/** What a host says about itself, in `engine.json`, in its welcome, and to `who` without a token. */
export interface EngineHostInfo {
  /** `desktop`: the app hosting the engine in its own process; `server`: `jaira serve`; `cli`: a CLI command running in-process. */
  kind: "desktop" | "server" | "cli";
  pid: number;
  /** The JaiRA version the host runs. */
  version: string;
  contract: string;
  /** The pipe it listens on; for a host that could not create one, where it would have been. */
  pipe: string;
  /** The loopback port it listens on instead, when it could not create its pipe (§4 step 3). */
  port?: number;
  /** Which base root it serves: a hash of it, so a port shared by every root can be told apart. */
  home: string;
  /** The executable it runs on: a desktop that installs an update over it must stop it first. */
  exe: string;
  startedAt: number;
}

/** A machine as another one remembers it (decision 0013 §1). */
export interface PeerMachine {
  id: string;
  label: string;
  os: "windows" | "mac" | "linux";
  tags: string[];
  /** Where its engine is reached: `wss://…/engine`. Absent while it is not reachable. */
  url?: string;
}

/** What kind of device a window is on, for the row that lists it. */
export type DeviceKind = "phone" | "browser";

/**
 * A phone or a browser tab (decision 0013, amended 2026-09-30): a WINDOW onto one engine, not an engine.
 * It has nothing to replicate and nothing connects back to it, so it says who it is and no more.
 */
export interface PairingDevice {
  /** An id the device made once and keeps: pairing again replaces its token rather than adding a row. */
  id: string;
  /** "Pixel 8", "Chrome on Windows". */
  label: string;
  kind: DeviceKind;
}

/** Client → host. `who` needs no token and is answered with the host's info alone. */
export type ClientFrame =
  | { t: "who" }
  | { t: "hello"; token: string; contract: string; version: string; client: string; pid?: number }
  | { t: "req"; id: number; channel: string; request: unknown }
  /**
   * Pairing (decision 0013 §3), before any hello: the code this machine was shown, who the asker is,
   * and the token the asker issued for this machine to use back.
   */
  | { t: "pair"; code: string; machine: PeerMachine; token: string }
  /** A device pairing: the same code, and no token — nothing connects back to a device. */
  | { t: "pair"; code: string; device: PairingDevice };

/** Host → client. */
export type HostFrame =
  | { t: "info"; host: EngineHostInfo }
  /** `limited`: the contracts differ, so only the `engine:*` channels answer — enough to say so and to stop the host. */
  | { t: "welcome"; host: EngineHostInfo; limited?: true }
  | { t: "refused"; reason: string }
  | { t: "res"; id: number; ok: true; result: unknown }
  | { t: "res"; id: number; ok: false; error: { message: string; name?: string } }
  | { t: "push"; message: PushMessage }
  /**
   * Paired: who this machine is, the token it issued for the asker, and the machines it knows, for
   * introductions. A device is told of no other machine: it is introduced to none.
   */
  | { t: "paired"; machine: PeerMachine; token: string; fleet: PeerMachine[] };

// --- the contract ---------------------------------------------------------------------------------------

const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74,
  0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d,
  0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e,
  0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/**
 * SHA-256 of ASCII text, as hex. Written out because the contract is computed where there is no
 * `node:crypto` (a phone) and must come to the same answer where there is: Web Crypto's digest is
 * asynchronous, and a constant cannot wait. Not for secrets — nothing secret is hashed with it.
 */
export function sha256Hex(text: string): string {
  const length = text.length;
  const padded = new Uint8Array((((length + 8) >> 6) + 1) << 6);
  for (let i = 0; i < length; i += 1) padded[i] = text.charCodeAt(i) & 0xff;
  padded[length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor((length * 8) / 0x1_0000_0000));
  view.setUint32(padded.length - 4, (length * 8) >>> 0);
  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));
  for (let block = 0; block < padded.length; block += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(block + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const a = w[i - 15]!;
      const b = w[i - 2]!;
      w[i] = (w[i - 16]! + (rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)) + w[i - 7]! + (rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10))) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h as [number, number, number, number, number, number, number, number];
    for (let i = 0; i < 64; i += 1) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i]! + w[i]!) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    const next = [a, b, c, d, e, f, g, hh];
    for (let i = 0; i < 8; i += 1) h[i] = (h[i]! + next[i]!) >>> 0;
  }
  return h.map((x) => x.toString(16).padStart(8, "0")).join("");
}

/** Which contract a side speaks: the channels it knows, hashed. Two sides agree when this does. */
export const ENGINE_CONTRACT = sha256Hex([...IPC_CHANNELS].sort().join("\n")).slice(0, 12);
