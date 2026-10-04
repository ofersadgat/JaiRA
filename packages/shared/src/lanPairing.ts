/**
 * Pairing a phone over the local network (decision 0013, amended 2026-10-04): the machine showing a
 * pairing code announces itself on the local network, a phone on the same network lists it, and the
 * person types the code the machine shows. The code never crosses the network. It is the password of a
 * PAKE — CPace over ristretto255 — which gives both sides one key only if both hold the same code. A
 * neighbour on the Wi-Fi who announces a JaiRA of its own learns nothing from what the phone sends, and
 * gets one guess per connection, five per code.
 *
 * The exchange, on a WebSocket to the machine's pairing listener (`/pair`, JSON, one frame per message):
 *
 *   machine → phone  hi       { v, sid, machine }                      a fresh session id
 *   phone → machine  pake     { y }                                    the phone's share
 *   machine → phone  pake     { y, mac }                               the machine's share, and its proof
 *   phone → machine  confirm  { mac }                                  the phone's proof
 *   …then each way   box      { n, d }                                 sealed frames, below
 *
 * The sealed frames ({@link LanSealed}): the phone says who it is (`device`), the machine answers with
 * the token it issued and the engine's tailnet address (`paired`); the phone, joining the tailnet with
 * Tailscale built in, hands over its sign-in page (`login`) for the machine to open in the person's
 * browser, where they are signed in already (`opened`); `done` ends it.
 *
 * Pure: no Node, no DOM, no platform randomness. Both sides pass their own random bytes, so the same
 * file runs in the engine and on a phone (Hermes has BigInt, which the curve needs).
 */
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { ristretto255, ristretto255_hasher } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256, sha512 } from "@noble/hashes/sha2.js";
import { normalizePairingCode } from "./machines";

/** The service type a pairing machine announces: `_jaira._tcp`. */
export const LAN_SERVICE_TYPE = "jaira";
/** The protocol's version, in `hi` and in the announcement's `v` field. */
export const LAN_PAIRING_VERSION = 1;
/** The pairing listener's WebSocket path. */
export const LAN_PAIRING_PATH = "/pair";
/**
 * The port the pairing listener tries first, so that a machine's local address alone is enough to type
 * where discovery cannot see it (`192.168.1.32`). Taken, it uses another and says which.
 */
export const LAN_PAIRING_PORT = 47_319;

const DSI = "JaiRA-LAN-pairing-CPace-ristretto255-v1";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** What a pairing machine says in its announcement's TXT record, as a phone reads it back. */
export interface LanAnnouncement {
  /** The machine's id. */
  id: string;
  label: string;
  os: string;
  /** The pairing listener's port. */
  port: number;
  /** The machine's addresses on the local network, the likeliest first. */
  addresses: string[];
  /** {@link LAN_PAIRING_VERSION}. */
  v: number;
}

/** The TXT record for {@link LanAnnouncement}: short keys, each value well under the 255-byte limit. */
export function announcementTxt(a: LanAnnouncement): Record<string, string> {
  return { id: a.id, label: a.label.slice(0, 63), os: a.os, port: String(a.port), addr: a.addresses.slice(0, 6).join(","), v: String(a.v) };
}

/** An announcement's TXT record read back, when it is one of ours: anyone on the network can announce anything. */
export function announcementOf(txt: Record<string, unknown> | undefined, fallback?: { host?: string; port?: number }): LanAnnouncement | undefined {
  if (txt === undefined || txt === null) return undefined;
  const text = (key: string): string => {
    const value = txt[key];
    if (typeof value === "string") return value;
    if (value instanceof Uint8Array) return decoder.decode(value);
    return "";
  };
  const id = text("id");
  const port = Number(text("port") || fallback?.port);
  const v = Number(text("v"));
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(id) || !Number.isInteger(port) || port <= 0 || port > 65535 || v !== LAN_PAIRING_VERSION) return undefined;
  const addresses = text("addr")
    .split(",")
    .map((a) => a.trim())
    .filter((a) => /^\d{1,3}(\.\d{1,3}){3}$/.test(a) || /^[0-9a-f:]+$/i.test(a));
  if (fallback?.host !== undefined && !addresses.includes(fallback.host)) addresses.unshift(fallback.host);
  if (addresses.length === 0) return undefined;
  const label = text("label").replace(/\s+/g, " ").trim().slice(0, 63);
  return { id, label: label === "" ? "JaiRA" : label, os: text("os") || "machine", port, addresses, v };
}

/** The URL a phone opens to pair with one of an announcement's addresses. */
export function lanPairingUrl(address: string, port: number): string {
  return `ws://${address.includes(":") ? `[${address}]` : address}:${port}${LAN_PAIRING_PATH}`;
}

/**
 * A machine's local-network address as a person types it — `192.168.1.32`, or `192.168.1.32:52000` when
 * the machine said another port — read as a machine to pair with nearby, whose id and name are not
 * known until it answers. Undefined for anything else: a tailnet address (100.64/10), loopback, a name.
 */
export function typedLanMachine(address: string): LanAnnouncement | undefined {
  const parts = /^\s*(?:ws:\/\/|http:\/\/)?(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?\/?\s*$/.exec(address);
  if (parts === null) return undefined;
  const octets = parts[1]!.split(".").map(Number) as [number, number, number, number];
  if (octets.some((o) => o > 255)) return undefined;
  const [a, b] = octets;
  const local = a === 10 || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168);
  if (!local) return undefined;
  const port = parts[2] !== undefined ? Number(parts[2]) : LAN_PAIRING_PORT;
  if (port <= 0 || port > 65535) return undefined;
  return { id: "", label: parts[1]!, os: "machine", port, addresses: [parts[1]!], v: LAN_PAIRING_VERSION };
}

// --- frames ---------------------------------------------------------------------------------------------

/** Who the machine is, as it says in `hi`: not trusted until the exchange proves the code. */
export interface LanMachine {
  id: string;
  label: string;
  os: string;
}

/** Frames before the key: hex for bytes, which keeps them readable in a log. */
export type LanFrame =
  | { t: "hi"; v: number; sid: string; machine: LanMachine }
  | { t: "pake"; y: string; mac?: string }
  | { t: "confirm"; mac: string }
  | { t: "box"; n: number; d: string }
  /** Said by the machine before it closes: the code was wrong, expired, or tried too often. */
  | { t: "refused"; reason: string };

/** What travels sealed, once both sides hold the key. */
export type LanSealed =
  | { t: "device"; device: { id: string; label: string; kind: "phone" } }
  /** `address`: the engine on the tailnet, `https://desk.tail4c2e.ts.net`. */
  | { t: "paired"; machine: LanMachine; token: string; address: string }
  /** The phone's Tailscale sign-in page, for the machine to open in the person's browser. */
  | { t: "login"; url: string }
  | { t: "opened" }
  | { t: "done" }
  | { t: "refused"; reason: string };

/**
 * A sign-in page the machine will open for a phone: Tailscale's own, and only that. Anything else a
 * phone sent would be a page the machine opened on a stranger's say-so.
 */
export function isTailscaleLogin(url: string): boolean {
  return /^https:\/\/login\.tailscale\.com\/a\/[A-Za-z0-9]+$/.test(url);
}

// --- bytes ----------------------------------------------------------------------------------------------

export function toHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

export function fromHex(hex: string): Uint8Array {
  if (typeof hex !== "string" || hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) throw new Error("not hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Length-prefixed concatenation, so no two different inputs hash alike. */
function lv(...parts: Uint8Array[]): Uint8Array {
  const size = parts.reduce((n, p) => n + 4 + p.length, 0);
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    new DataView(out.buffer).setUint32(at, p.length);
    out.set(p, at + 4);
    at += 4 + p.length;
  }
  return out;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

// --- CPace ----------------------------------------------------------------------------------------------

type Point = InstanceType<typeof ristretto255.Point>;
const Fn = ristretto255.Point.Fn;

/** The generator both sides derive from the code: unknown to anyone without it. */
function generator(code: string, sid: Uint8Array, machineId: string): Point {
  return ristretto255_hasher.hashToCurve(lv(encoder.encode(normalizePairingCode(code)), sid, encoder.encode(machineId)), { DST: encoder.encode(DSI) });
}

/** A scalar from 64 random bytes, reduced: uniform, and never zero. */
function scalarOf(random: Uint8Array): bigint {
  if (random.length < 64) throw new Error("a scalar needs 64 random bytes");
  let n = 0n;
  for (let i = 63; i >= 0; i -= 1) n = (n << 8n) | BigInt(random[i]!);
  const s = Fn.create(n);
  return s === 0n ? 1n : s;
}

function pointOf(hex: string): Point {
  const p = ristretto255.Point.fromBytes(fromHex(hex));
  if (p.is0()) throw new Error("the share is the identity");
  return p;
}

/** The keys one exchange agrees on. */
export interface LanKeys {
  /** Seals what the phone sends. */
  phone: Uint8Array;
  /** Seals what the machine sends. */
  machine: Uint8Array;
  /** The machine's proof that it holds the code: the phone checks it. */
  machineMac: Uint8Array;
  /** The phone's proof: the machine checks it. */
  phoneMac: Uint8Array;
}

function keysOf(k: Point, sid: Uint8Array, yPhone: Uint8Array, yMachine: Uint8Array): LanKeys {
  if (k.is0()) throw new Error("the exchange came to nothing");
  const isk = sha512(lv(encoder.encode(`${DSI}_ISK`), sid, k.toBytes(), yPhone, yMachine));
  const okm = hkdf(sha256, isk, sid, encoder.encode(`${DSI} keys`), 96);
  const confirm = okm.slice(64, 96);
  const transcript = lv(yPhone, yMachine);
  return {
    phone: okm.slice(0, 32),
    machine: okm.slice(32, 64),
    machineMac: hmac(sha256, confirm, lv(encoder.encode("machine"), transcript)),
    phoneMac: hmac(sha256, confirm, lv(encoder.encode("phone"), transcript)),
  };
}

/** The phone's half of the exchange: one per connection. */
export class PakePhone {
  private readonly scalar: bigint;
  private readonly g: Point;
  /** The phone's share, to send in `pake`. */
  readonly share: string;
  private readonly sid: Uint8Array;

  constructor(code: string, hi: { sid: string; machine: LanMachine }, random: Uint8Array) {
    this.sid = fromHex(hi.sid);
    this.g = generator(code, this.sid, hi.machine.id);
    this.scalar = scalarOf(random);
    this.share = toHex(this.g.multiply(this.scalar).toBytes());
  }

  /** The machine's answer: its share and proof. Throws when the proof is wrong — another code, or not that machine. */
  finish(answer: { y: string; mac?: string }): LanKeys {
    const theirs = pointOf(answer.y);
    const keys = keysOf(theirs.multiply(this.scalar), this.sid, fromHex(this.share), fromHex(answer.y));
    if (answer.mac === undefined || !equalBytes(keys.machineMac, fromHex(answer.mac))) throw new Error("wrong code");
    return keys;
  }
}

/** The machine's half: given the phone's share, its own share, its proof, and the keys. */
export function pakeMachine(code: string, sid: Uint8Array, machineId: string, phoneShare: string, random: Uint8Array): { share: string; keys: LanKeys } {
  const g = generator(code, sid, machineId);
  const theirs = pointOf(phoneShare);
  const scalar = scalarOf(random);
  const share = g.multiply(scalar).toBytes();
  return { share: toHex(share), keys: keysOf(theirs.multiply(scalar), sid, fromHex(phoneShare), share) };
}

/** The phone's proof, checked by the machine. */
export function phoneProofHolds(keys: LanKeys, mac: string): boolean {
  try {
    return equalBytes(keys.phoneMac, fromHex(mac));
  } catch {
    return false;
  }
}

// --- the sealed channel ---------------------------------------------------------------------------------

function nonce(n: number): Uint8Array {
  const out = new Uint8Array(12);
  new DataView(out.buffer).setBigUint64(4, BigInt(n));
  return out;
}

/**
 * One direction of the sealed channel: ChaCha20-Poly1305 under that direction's key, the nonce a
 * counter. A frame out of order, replayed or altered does not open.
 */
export class LanBox {
  private sent = 0;
  private received = 0;

  constructor(
    private readonly sendKey: Uint8Array,
    private readonly receiveKey: Uint8Array,
  ) {}

  static forPhone(keys: LanKeys): LanBox {
    return new LanBox(keys.phone, keys.machine);
  }

  static forMachine(keys: LanKeys): LanBox {
    return new LanBox(keys.machine, keys.phone);
  }

  seal(message: LanSealed): LanFrame {
    const n = this.sent;
    this.sent += 1;
    return { t: "box", n, d: toHex(chacha20poly1305(this.sendKey, nonce(n)).encrypt(encoder.encode(JSON.stringify(message)))) };
  }

  open(frame: { n: number; d: string }): LanSealed {
    if (frame.n !== this.received) throw new Error("a sealed frame out of order");
    const plain = chacha20poly1305(this.receiveKey, nonce(frame.n)).decrypt(fromHex(frame.d));
    this.received += 1;
    return JSON.parse(decoder.decode(plain)) as LanSealed;
  }
}
