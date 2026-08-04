/**
 * The baseline behind "which of these changed?".
 *
 * Everything here is about one decision: a sync is recorded when it is ACCEPTED, not when it is
 * run. Get that wrong in either direction and the panel lies — advance too eagerly and a discarded
 * proposal reads as "in step", never advance and the two can never be reported as agreeing at all.
 *
 * The other case worth pinning is the absent record. "Changed" is a claim about a baseline, and with
 * no baseline the honest answer is that neither side has changed and nothing is recommended — not a
 * guess that the newest file is the truth.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  commitSync,
  hashText,
  readSyncRecord,
  stateHashes,
  syncDrift,
  type WorkflowSyncRecord,
} from "../src/workflowSync";

let dir: string;
let workflowsDir: string;
let syncFile: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jaira-sync-"));
  workflowsDir = join(dir, "workflows");
  mkdirSync(join(workflowsDir, "feature"), { recursive: true });
  syncFile = join(dir, "sync.json");
  writeFileSync(join(workflowsDir, "plan.json"), '{"label":"Plan"}\n', "utf8");
  writeFileSync(join(workflowsDir, "feature", "critique.json"), '{"label":"Critique"}\n', "utf8");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const DOCUMENT = "workflows/workflow.md";

/** A record of "everything as it is right now", which is what an accepted sync writes. */
function baseline(documentText: string, direction: "document" | "states" = "document"): WorkflowSyncRecord {
  return commitSync(syncFile, {
    document: DOCUMENT,
    documentHash: hashText(documentText),
    states: stateHashes(workflowsDir),
    direction,
    at: 1_700_000_000_000,
  });
}

describe("stateHashes", () => {
  it("covers every state file under the directory, keyed by relative path", () => {
    expect(Object.keys(stateHashes(workflowsDir)).sort()).toEqual(["feature/critique.json", "plan.json"]);
  });

  it("ignores what is not a state file", () => {
    writeFileSync(join(workflowsDir, "workflow.md"), "# The flow\n", "utf8");
    writeFileSync(join(workflowsDir, "notes.txt"), "scratch", "utf8");
    // The description is not one of the things it is being compared against — counting it would
    // make every edit to it look like a workflow change as well.
    expect(Object.keys(stateHashes(workflowsDir)).sort()).toEqual(["feature/critique.json", "plan.json"]);
  });

  it("answers for a directory that does not exist", () => {
    expect(stateHashes(join(dir, "nowhere"))).toEqual({});
  });
});

describe("hashText", () => {
  it("treats a line-ending difference as the same file", () => {
    // Otherwise a checkout with CRLF would report every state as changed, which is the fastest way
    // to teach someone to ignore the marker.
    expect(hashText('{"a":1}\n')).toBe(hashText('{"a":1}\r\n'));
    expect(hashText('{"a":1}\n')).toBe(hashText('{"a":1}\n\n\n'));
  });

  it("treats a real edit as a different file", () => {
    expect(hashText('{"a":1}')).not.toBe(hashText('{"a": 1}'));
  });
});

describe("syncDrift", () => {
  it("recommends nothing when the two have never been synced", () => {
    const drift = syncDrift(undefined, { documentHash: hashText("# anything"), states: stateHashes(workflowsDir) });
    expect(drift).toEqual({ documentChanged: false, statesChanged: false, changedStates: [], suggested: null });
  });

  it("reports the two as in step immediately after a sync is accepted", () => {
    const record = baseline("# The flow");
    const drift = syncDrift(record, { documentHash: hashText("# The flow"), states: stateHashes(workflowsDir) });
    expect(drift.documentChanged).toBe(false);
    expect(drift.statesChanged).toBe(false);
    expect(drift.suggested).toBeNull();
  });

  it("points at the states when the description is what moved", () => {
    const record = baseline("# The flow");
    const drift = syncDrift(record, { documentHash: hashText("# The flow, revised"), states: stateHashes(workflowsDir) });
    expect(drift.documentChanged).toBe(true);
    expect(drift.statesChanged).toBe(false);
    // The side that changed is the one telling the truth, so the OTHER one is what a sync rewrites.
    expect(drift.suggested).toBe("states");
  });

  it("points at the description when the workflows are what moved, and names the files", () => {
    const record = baseline("# The flow");
    writeFileSync(join(workflowsDir, "plan.json"), '{"label":"Plan","description":"now with a step"}\n', "utf8");
    writeFileSync(join(workflowsDir, "gate.json"), '{"label":"Gate"}\n', "utf8");
    rmSync(join(workflowsDir, "feature", "critique.json"));

    const drift = syncDrift(record, { documentHash: hashText("# The flow"), states: stateHashes(workflowsDir) });
    expect(drift.statesChanged).toBe(true);
    expect(drift.suggested).toBe("document");
    expect(drift.changedStates).toEqual([
      { path: "feature/critique.json", change: "removed" },
      { path: "gate.json", change: "added" },
      { path: "plan.json", change: "edited" },
    ]);
  });

  it("refuses to choose when both sides have moved", () => {
    const record = baseline("# The flow");
    writeFileSync(join(workflowsDir, "plan.json"), '{"label":"Planning"}\n', "utf8");
    const drift = syncDrift(record, { documentHash: hashText("# Something else"), states: stateHashes(workflowsDir) });
    expect(drift.documentChanged).toBe(true);
    expect(drift.statesChanged).toBe(true);
    // There is no mechanical answer to which of two edited documents is right, and picking one
    // would silently overwrite the other.
    expect(drift.suggested).toBeNull();
  });
});

describe("readSyncRecord", () => {
  it("reads back what was committed", () => {
    baseline("# The flow", "states");
    const record = readSyncRecord(syncFile, DOCUMENT);
    expect(record?.direction).toBe("states");
    expect(record?.at).toBe(1_700_000_000_000);
    expect(Object.keys(record?.states ?? {})).toHaveLength(2);
  });

  it("ignores a record taken against a different document", () => {
    baseline("# The flow");
    // A baseline for another file says nothing about this one, and reading it as if it did would
    // report drift against a comparison that was never made.
    expect(readSyncRecord(syncFile, "workflows/other.md")).toBeUndefined();
  });

  it("treats an absent or corrupt record as no record", () => {
    expect(readSyncRecord(syncFile, DOCUMENT)).toBeUndefined();
    writeFileSync(syncFile, "{not json", "utf8");
    // Derived state: refusing to show the panel because this got corrupted would be a poor trade,
    // and the next accepted sync rewrites it.
    expect(readSyncRecord(syncFile, DOCUMENT)).toBeUndefined();
  });
});
