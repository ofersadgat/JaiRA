/**
 * The tokens this machine has issued to other machines (decision 0013 §3): who may connect to its engine
 * over the network. Only a hash of each token is kept, in `<base>/system/machine-peers.json`; the token
 * itself lives with the machine it was given to. Revoking one refuses that machine's next hello and
 * drops its connections.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface IssuedToken {
  /** The machine it was issued to. */
  machineId: string;
  label: string;
  hash: string;
  issuedAt: number;
  lastUsedAt?: number;
}

interface PeersFile {
  issued: IssuedToken[];
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

  /** A new token for a machine, replacing any it had. The caller hands it over; only its hash stays here. */
  issue(machineId: string, label: string): string {
    const token = randomBytes(32).toString("base64url");
    const file = this.read();
    file.issued = [...file.issued.filter((t) => t.machineId !== machineId), { machineId, label, hash: hashOf(token), issuedAt: Date.now() }];
    this.write(file);
    return token;
  }

  /** The machine a token was issued to, or undefined. Constant-time over every issued hash. */
  verify(token: string): { id: string; label: string } | undefined {
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
    return { id: found.machineId, label: found.label };
  }

  /** Forget a machine: its token no longer opens anything. */
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
