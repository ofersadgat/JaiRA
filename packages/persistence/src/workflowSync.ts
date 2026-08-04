/**
 * What the description and the state files last agreed on, and which of them has moved since.
 *
 * `workflows/workflow.md` says, in English, what the workflows are supposed to do; the state files
 * say what they will actually run. `jaira workflow check` compares them and reports. The thing it
 * cannot report — because the files carry no memory — is which of the two is the one that changed.
 * That is the question a person actually has when the two disagree: "did I rewrite the plan and not
 * the workflows, or the other way round?" Answering it needs a baseline, and a baseline needs a
 * file.
 *
 * ## What is recorded
 *
 * The content hash of the description, and one per state file, as of the last sync somebody
 * ACCEPTED. Not as of the last sync somebody ran: a proposal that was produced and discarded left
 * both sides exactly where they were, and advancing the baseline for it would say the two agree when
 * nobody ever made them agree. That is the whole reason {@link commitSync} takes the hashes it is
 * committing rather than a timestamp — the caller re-reads the files at the moment of acceptance.
 *
 * ## Hashing
 *
 * Line endings are normalised and trailing whitespace at the end of the file is dropped before
 * hashing. A drift report that fired because git checked the tree out with CRLF would be noise of
 * exactly the kind that teaches people to ignore the marker.
 *
 * ## What it does not cover
 *
 * States supplied by the shared base root. A project's description is checked against the workflows
 * as they RESOLVE, base states included, but the baseline covers only the project's own
 * `workflows/` — a machine-wide edit would otherwise show up as drift in every project on it, with
 * no way for any of them to settle it.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SyncDirection, SyncStateChange } from "@jaira/shared";

/** The last accepted agreement between the description and the state files. */
export interface WorkflowSyncRecord {
  /** The description this is about, relative to the layer root. */
  document: string;
  documentHash: string;
  /** Hash per state file, keyed by path relative to the project's `workflows/`. */
  states: Record<string, string>;
  /** When it was accepted, in epoch milliseconds. */
  at: number;
  /** Which side that sync rewrote. */
  direction: SyncDirection;
}

/** Which side has moved, and what moved on it. */
export interface WorkflowSyncDrift {
  documentChanged: boolean;
  statesChanged: boolean;
  changedStates: SyncStateChange[];
  /**
   * The direction the drift implies — the side that should be REWRITTEN.
   *
   * Null when neither moved (nothing to do) and, deliberately, when both did: there is no
   * mechanical answer to which of two edited documents is now the truth, and choosing one would
   * throw away the other. The caller asks.
   */
  suggested: SyncDirection | null;
}

/** State file extensions the baseline covers — the ones the loader will read as a state. */
const STATE_FILE = /\.(json|jsonc|ya?ml)$/i;

/**
 * The content hash of one document.
 *
 * Normalised first: CRLF is the same file as LF, and so is the same file with one more blank line
 * at the end than the editor left. Everything else — including whitespace inside the document — is
 * a real difference, because a reindented state file is a state file somebody touched.
 */
export function hashText(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\s+$/, "");
  return createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 32);
}

/**
 * Hash every state file under a workflows directory, keyed by relative path.
 *
 * An unreadable file is skipped rather than thrown: this runs to answer "has anything changed?",
 * and a file that cannot be read right now is the sync's problem to report, not this function's to
 * fail on. An absent directory hashes to nothing, which is the honest answer for a project with no
 * workflows yet.
 */
export function stateHashes(workflowsDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string, prefix: string): void => {
    let entries: Array<{ name: string; isDirectory(): boolean }>;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = prefix.length > 0 ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), rel);
      } else if (STATE_FILE.test(entry.name)) {
        try {
          out[rel] = hashText(readFileSync(join(dir, entry.name), "utf8"));
        } catch {
          // Deleted or unreadable between the listing and the read. Absent is the same answer.
        }
      }
    }
  };
  walk(workflowsDir, "");
  return out;
}

/**
 * Compare where things are now against the last accepted sync.
 *
 * With no record, NEITHER side is reported as changed. That is not a hedge: "changed" is a claim
 * about a baseline, and inventing one — treating a first-time document as new, say — would push the
 * user toward a direction nobody has established. The caller shows both directions instead.
 */
export function syncDrift(
  record: WorkflowSyncRecord | undefined,
  now: { documentHash: string; states: Record<string, string> },
): WorkflowSyncDrift {
  if (record === undefined) {
    return { documentChanged: false, statesChanged: false, changedStates: [], suggested: null };
  }
  const changedStates: SyncStateChange[] = [];
  for (const [path, hash] of Object.entries(now.states)) {
    const before = record.states[path];
    if (before === undefined) changedStates.push({ path, change: "added" });
    else if (before !== hash) changedStates.push({ path, change: "edited" });
  }
  for (const path of Object.keys(record.states)) {
    if (now.states[path] === undefined) changedStates.push({ path, change: "removed" });
  }
  changedStates.sort((a, b) => a.path.localeCompare(b.path));

  const documentChanged = record.documentHash !== now.documentHash;
  const statesChanged = changedStates.length > 0;
  return {
    documentChanged,
    statesChanged,
    changedStates,
    // The side that changed is the one now telling the truth, so the OTHER one is what a sync
    // rewrites. Both, or neither, and there is nothing to suggest.
    suggested: documentChanged === statesChanged ? null : documentChanged ? "states" : "document",
  };
}

/**
 * Read the record, or `undefined` when there is none for this document.
 *
 * A file that will not parse is treated as absent rather than raised. The record is a convenience —
 * it decides which of two buttons is highlighted — and refusing to open the panel because a derived
 * file got corrupted would be a poor trade. The next accepted sync rewrites it.
 */
export function readSyncRecord(file: string, document: string): WorkflowSyncRecord | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<WorkflowSyncRecord>;
    if (typeof parsed.documentHash !== "string" || typeof parsed.document !== "string") return undefined;
    // Recorded per document. A record about another file says nothing about this one, and reading it
    // as if it did would report drift against a baseline that was never taken here.
    if (parsed.document.toLowerCase() !== document.toLowerCase()) return undefined;
    return {
      document: parsed.document,
      documentHash: parsed.documentHash,
      states: typeof parsed.states === "object" && parsed.states !== null ? parsed.states : {},
      at: typeof parsed.at === "number" ? parsed.at : 0,
      direction: parsed.direction === "states" ? "states" : "document",
    };
  } catch {
    return undefined;
  }
}

/** Write the record. Called when a proposal is accepted, never when one is produced. */
export function writeSyncRecord(file: string, record: WorkflowSyncRecord): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

/**
 * Record that the two are in step, as of what is on disk right now.
 *
 * Both sides are re-read by the caller and passed in together, because the point of the record is
 * that the pair agreed at one instant. Recording one side at the time of the run and the other at
 * the time of the save would produce a baseline that never existed.
 */
export function commitSync(
  file: string,
  what: { document: string; documentHash: string; states: Record<string, string>; direction: SyncDirection; at: number },
): WorkflowSyncRecord {
  const record: WorkflowSyncRecord = {
    document: what.document,
    documentHash: what.documentHash,
    states: what.states,
    at: what.at,
    direction: what.direction,
  };
  writeSyncRecord(file, record);
  return record;
}

/** True when a project has ever recorded a sync — what the UI's "never synced" line asks. */
export function hasSyncRecord(file: string): boolean {
  return existsSync(file);
}
