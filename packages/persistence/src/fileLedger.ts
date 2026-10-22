/**
 * What JaiRA last left each concern file as (decision 0018 §11): its size and mtime after the last
 * write JaiRA made to it, or as it stood when the project opened. A file that is not what this says was
 * changed by something else — a `git pull` while JaiRA ran — and its concern is read in at the next
 * open (`fileStorage.ts`, `keepFingerprints`). Every writer of a concern file notes what it did here.
 */
import { readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";

const left = new Map<string, string>();
/** Files something else changed since JaiRA last left them: so they stay, whatever JaiRA writes after, until the next open. */
const moved = new Set<string>();

function stampOf(file: string): string | undefined {
  try {
    const stat = statSync(file);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return undefined;
  }
}

/**
 * JaiRA is about to append to this file: if it is not what JaiRA left — a pull landed in it — it is
 * marked moved, so JaiRA's own write after cannot pass the pull off as JaiRA's.
 */
export function noteWriting(file: string): void {
  if (moved.has(file)) return;
  const was = left.get(file);
  const now = stampOf(file);
  if (now !== was) moved.add(file);
}

/** JaiRA wrote this file (or found it so at open): this is what it left. */
export function noteWritten(file: string): void {
  if (moved.has(file)) return;
  const stamp = stampOf(file);
  if (stamp === undefined) left.delete(file);
  else left.set(file, stamp);
}

/** JaiRA removed this file, or a folder of them. */
export function noteRemoved(path: string): void {
  const under = (file: string): boolean => file === path || file.startsWith(path + sep);
  for (const file of [...left.keys()]) if (under(file)) left.delete(file);
  for (const file of [...moved]) if (under(file)) moved.delete(file);
}

/** Every file under `dir`, at any depth. */
function filesUnder(dir: string): string[] {
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => (entry.isDirectory() ? filesUnder(join(dir, entry.name)) : [join(dir, entry.name)]));
}

/** Take a concern's folder as it stands now as what JaiRA left — at open, once its files are the database's. */
export function noteFolder(dir: string): void {
  noteRemoved(dir);
  for (const file of filesUnder(dir)) noteWritten(file);
}

/** Whether every file under `dir` is as JaiRA left it, none added and none taken away. */
export function folderAsLeft(dir: string): boolean {
  if ([...moved].some((file) => file.startsWith(dir + sep))) return false;
  const known = [...left.keys()].filter((file) => file.startsWith(dir + sep));
  const present = filesUnder(dir);
  if (present.length !== known.length) return false;
  return present.every((file) => left.get(file) === stampOf(file));
}
