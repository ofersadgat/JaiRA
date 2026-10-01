/**
 * The tokens this machine has issued (decision 0013 §3): who may connect to its engine over the network —
 * the machines it is paired with, and the phones and browsers that are windows onto it (`device`). Only
 * a hash of each token is kept, in `<base>/system/machine-peers.json`; the token itself lives with
 * whoever it was given to. Revoking one refuses its holder's next hello and drops its connections.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DeviceKind } from "@jaira/shared";

export interface IssuedToken {
  /** The machine it was issued to, or the device's own id. */
  machineId: string;
  label: string;
  /** Issued to a device, not a machine: it is a window, and is never linked to, copied from or placed on. */
  device?: DeviceKind;
  hash: string;
  issuedAt: number;
  lastUsedAt?: number;
}

interface PeersFile {
  issued: IssuedToken[];
}

/** Who a token says its holder is: a paired machine, or — with `device` — a phone or a browser. */
export interface TokenHolder {
  id: string;
  label: string;
  device?: DeviceKind;
}

export function peersFile(baseDir: string): string {
  return join(baseDir, "system", "machine-peers.json");
}

const hashOf = (token: string): string => createHash("sha256").update(token).digest("hex");

export class MachineTokens {
  constructor(private readonly baseDir: string) {}

  private read(): PeersFile {
    try {
      const raw = JSON.parse(readFileSync(peersFile(this.baseDir), "utf8")) as Partial<PeersFile>;
      return { issued: Array.isArray(raw.issued) ? raw.issued : [] };
    } catch {
      return { issued: [] };
    }
  }

  private write(file: PeersFile): void {
    const path = peersFile(this.baseDir);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(`${path}.tmp`, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  }

  list(): IssuedToken[] {
    return this.read().issued;
  }

  /** A new token for a machine or a device, replacing any it had. The caller hands it over; only its hash stays here. */
  issue(machineId: string, label: string, device?: DeviceKind): string {
    const token = randomBytes(32).toString("base64url");
    const file = this.read();
    file.issued = [
      ...file.issued.filter((t) => t.machineId !== machineId),
      { machineId, label, ...(device !== undefined ? { device } : {}), hash: hashOf(token), issuedAt: Date.now() },
    ];
    this.write(file);
    return token;
  }

  /** Who a token was issued to, or undefined. Constant-time over every issued hash. */
  verify(token: string): TokenHolder | undefined {
    const given = Buffer.from(hashOf(String(token)), "hex");
    let found: IssuedToken | undefined;
    const file = this.read();
    for (const issued of file.issued) {
      const expected = Buffer.from(issued.hash, "hex");
      if (expected.length === given.length && timingSafeEqual(expected, given)) found = issued;
    }
    if (found === undefined) return undefined;
    found.lastUsedAt = Date.now();
    this.write(file);
    return { id: found.machineId, label: found.label, ...(found.device !== undefined ? { device: found.device } : {}) };
  }

  /** Forget a machine or a device: its token no longer opens anything. */
  revoke(machineId: string): boolean {
    const file = this.read();
    const kept = file.issued.filter((t) => t.machineId !== machineId);
    if (kept.length === file.issued.length) return false;
    this.write({ issued: kept });
    return true;
  }

  rename(machineId: string, label: string): void {
    const file = this.read();
    for (const issued of file.issued) if (issued.machineId === machineId) issued.label = label;
    this.write(file);
  }
}
