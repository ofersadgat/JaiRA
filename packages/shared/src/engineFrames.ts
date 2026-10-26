/**
 * What an engine's host and its clients say to each other (decisions 0012 §3, 0013 §2–§3): the frames,
 * and the protocol both sides must speak. Here, with nothing of Node in it, because three kinds of
 * client speak it — a process on this machine over the pipe, another machine's engine over a WebSocket,
 * and a phone or a browser tab (a device), which has neither `node:net` nor `node:crypto`.
 *
 * How the frames travel — length-prefixed on the pipe, one JSON frame per WebSocket message — and where
 * a host is found are `@jaira/service`'s (`enginePipe.ts`).
 */
import type { PushMessage } from "./ipc";

/** What a host says about itself, in `engine.json`, in its welcome, and to `who` without a token. */
export interface EngineHostInfo {
  /** `desktop`: the app hosting the engine in its own process; `server`: `jaira serve`; `cli`: a CLI command running in-process. */
  kind: "desktop" | "server" | "cli";
  pid: number;
  /** The JaiRA version the host runs: said, never compared — {@link protocol} is what must agree. */
  version: string;
  /** The protocol it speaks ({@link ENGINE_PROTOCOL}); absent from a JaiRA from before protocol numbers. */
  protocol?: number;
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
  /** What it is (`MachineForm`). Absent from a machine that predates the field: read as a desktop. */
  form?: "desktop" | "laptop" | "mini" | "server";
  tags: string[];
  /** Where its engine is reached: `wss://…/engine`. Absent while it is not reachable. */
  url?: string;
}

/** What kind of device a window is on, for the row that lists it. A browser is not one until the website exists (decision 0022 §6). */
export type DeviceKind = "phone";

/**
 * A phone (decisions 0013, amended 2026-09-30, and 0022 §6): it runs no engine and keeps no copy, so it
 * says who it is and no more.
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
  | { t: "hello"; token: string; protocol: number; version: string; client: string; pid?: number }
  | { t: "req"; id: number; channel: string; request: unknown }
  /**
   * Pairing (decision 0013 §3), before any hello: the code this machine was shown, who the asker is,
   * and the token the asker issued for this machine to use back.
   */
  | { t: "pair"; code: string; machine: PeerMachine; token: string }
  /** A device pairing: the same code, and no token — nothing connects back to a device. */
  | { t: "pair"; code: string; device: PairingDevice }
  /**
   * Pair was pressed on the asker for this machine (decision 0022 §5): show a one-time code, which the
   * person types on the asker. Who asks is said so the code's pop-up can name it.
   */
  | { t: "pair-ask"; machine: PeerMachine }
  | { t: "pair-ask"; device: PairingDevice; os?: "android" | "ios" }
  /** The asker gave up: stop showing the code. */
  | { t: "pair-cancel"; id: string };

/** Host → client. */
export type HostFrame =
  | { t: "info"; host: EngineHostInfo }
  /** `limited`: the protocols differ, so only the `engine:*` channels answer — enough to say so and to stop the host. */
  | { t: "welcome"; host: EngineHostInfo; limited?: true }
  | { t: "refused"; reason: string }
  | { t: "res"; id: number; ok: true; result: unknown }
  | { t: "res"; id: number; ok: false; error: { message: string; name?: string } }
  | { t: "push"; message: PushMessage }
  /**
   * Paired: who this machine is, the token it issued for the asker, and the machines it knows, for
   * introductions. A device is told of no other machine: it is introduced to none.
   */
  | { t: "paired"; machine: PeerMachine; token: string; fleet: PeerMachine[] }
  /** A code is showing on this machine now, until `expiresAt`. */
  | { t: "asked"; expiresAt: number }
  /** `pair-cancel` heard. */
  | { t: "ok" };

// --- the protocol ---------------------------------------------------------------------------------------

/**
 * Which protocol a side speaks: how the frames go, and what each channel and push carries. Two sides
 * talk when it is the same, whatever versions or builds they run (the person, 2026-10-26: "They
 * shouldnt need to be the exact same version. The only boundary for communication is whether the
 * communication protocol or data protocol has a breaking change. Not the app version.").
 *
 * Raise it for a BREAKING change only: a frame or a channel removed or renamed, or a request, response,
 * push or frame reshaped so the other side would misread it (a field it reads dropped, renamed or given
 * another meaning). Adding a channel, a push or an optional field is not one: an older side never asks
 * for what it does not know, a channel a newer side asks of an older host is answered "this engine does
 * not answer", and a push or field a side does not know is passed over. `engineProtocol.test.ts` holds
 * the channels of this protocol, and fails when one is gone without a raise.
 */
export const ENGINE_PROTOCOL = 1;

/**
 * Why two sides cannot talk, said so the person knows which to update: the one on the older protocol.
 * `theirs` is absent for a JaiRA from before protocol numbers, which said a hash of its channels.
 */
export function protocolMismatch(other: string, theirs: number | undefined, self = "this JaiRA", ours = ENGINE_PROTOCOL): string {
  return theirs === undefined || theirs < ours
    ? `${other} runs an older JaiRA, whose protocol ${self} no longer speaks: update JaiRA on ${other}`
    : `${other} runs a newer JaiRA, whose protocol ${self} does not speak yet: update ${self}`;
}
