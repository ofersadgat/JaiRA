/**
 * This machine, as the fleet knows it (decision 0013 §1): a durable id, a label, its operating system
 * and the tags a workflow can require. Kept in `<base>/system/machine.json`, made on first read.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";

export type MachineOs = "windows" | "mac" | "linux";

export interface MachineIdentity {
  id: string;
  label: string;
  os: MachineOs;
  /** The person's own tags; the OS is always a tag too (see {@link machineTags}). */
  tags: string[];
  /**
   * Whether this machine keeps a copy of the fleet's tasks (decision 0013 §6) — the person's choice,
   * absent when they have not made one and the host's default stands (a window's engine does, a
   * `jaira serve` does not).
   */
  replicate?: boolean;
  createdAt: number;
}

export function thisOs(platform: NodeJS.Platform = process.platform): MachineOs {
  return platform === "win32" ? "windows" : platform === "darwin" ? "mac" : "linux";
}

/** Every tag a machine answers to: its OS first, then the person's. */
export function machineTags(identity: Pick<MachineIdentity, "os" | "tags">): string[] {
  return [identity.os, ...identity.tags.filter((t) => t !== identity.os)];
}

export function machineFile(baseDir: string): string {
  return join(baseDir, "system", "machine.json");
}

function write(baseDir: string, identity: MachineIdentity): void {
  const file = machineFile(baseDir);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, `${JSON.stringify(identity, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
}

/** A label people read: the host name, lower-cased, without a `.local` or domain tail. */
export function defaultLabel(): string {
  const name = hostname().split(".")[0] ?? "machine";
  return name.toLowerCase() || "machine";
}

/** This machine's identity, made the first time it is asked for. */
export function machineIdentity(baseDir: string): MachineIdentity {
  try {
    const raw = JSON.parse(readFileSync(machineFile(baseDir), "utf8")) as Partial<MachineIdentity>;
    if (typeof raw.id === "string" && raw.id !== "") {
      return {
        id: raw.id,
        label: typeof raw.label === "string" && raw.label.trim() !== "" ? raw.label : defaultLabel(),
        os: thisOs(),
        tags: Array.isArray(raw.tags) ? raw.tags.filter((t): t is string => typeof t === "string") : [],
        createdAt: typeof raw.createdAt === "number" ? raw.createdAt : Date.now(),
      };
    }
  } catch {
    // Not made yet, or unreadable: a new identity replaces it.
  }
  const identity: MachineIdentity = { id: randomUUID(), label: defaultLabel(), os: thisOs(), tags: [], createdAt: Date.now() };
  write(baseDir, identity);
  return identity;
}

/** Rename this machine or change its tags. A tag is lower-case letters, digits and dashes. */
export function updateMachineIdentity(baseDir: string, patch: { label?: string; tags?: string[]; replicate?: boolean }): MachineIdentity {
  const current = machineIdentity(baseDir);
  const label = patch.label !== undefined ? patch.label.trim() : current.label;
  if (label === "") throw new Error("a machine needs a name");
  const tags = patch.tags !== undefined ? [...new Set(patch.tags.map((t) => t.trim().toLowerCase()).filter((t) => t !== ""))] : current.tags;
  for (const tag of tags) if (!/^[a-z0-9][a-z0-9-]*$/.test(tag)) throw new Error(`'${tag}' is not a tag: use lower-case letters, digits and dashes`);
  const next = { ...current, label, tags: tags.filter((t) => t !== current.os), ...(patch.replicate !== undefined ? { replicate: patch.replicate } : {}) };
  write(baseDir, next);
  return next;
}
