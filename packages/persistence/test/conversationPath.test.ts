/**
 * Where each turn HAPPENED, as the chain of child keys from the run's root.
 *
 * A turn used to be addressed by its state id alone, and a state id names a FILE. One file is
 * mounted under several keys in several parents — `explore` sits under all six phases of the feature
 * workflow — so "explore could not be entered" named the definition and said nothing about which of
 * the six was running it. The mount is the address; the id is what it runs.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EngineEvent } from "@declarative-ai/hw";
import { initProject, openProject, type Project } from "../src/project";
import { conversationView } from "../src/conversation";

let dir: string;
let project: Project;
const now = 1_800_000_000_000;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jaira-convo-"));
  initProject(dir);
  project = openProject(dir);
});

afterEach(() => {
  project.close();
  rmSync(dir, { recursive: true, force: true });
});

const entered = (id: number, stateId: string, parent?: number, childKey?: string): EngineEvent => ({
  type: "instance.entered",
  instanceId: id,
  stateId,
  ...(parent !== undefined ? { parentInstanceId: parent } : {}),
  ...(childKey !== undefined ? { childKey } : {}),
  inputs: {},
});

/** Record a run and read it back as turns. */
function turnsOf(events: EngineEvent[]) {
  project.runtime.insert("t-1", now);
  const runId = project.runtime.beginRun("t-1", "hash", now);
  const recorder = project.events.recorder("t-1", runId);
  events.forEach((event, i) => recorder.record(event, now + i));
  project.runtime.endRun(runId, "error", now + events.length);
  return conversationView(project, "t-1").turns;
}

describe("a turn's mount path", () => {
  it("is the chain of child keys, and the empty string at the root", () => {
    const turns = turnsOf([
      entered(1, "feature"),
      entered(2, "feature/product", 1, "product"),
      entered(3, "feature/product/context", 2, "context"),
    ]);
    expect(turns.map((t) => [t.stateId, t.path])).toEqual([
      ["feature", ""],
      ["feature/product", "product"],
      ["feature/product/context", "product/context"],
    ]);
  });

  it("names the MOUNT of a blocked child, not the state file it would have run", () => {
    // `explore` lives at the top of the tree and is mounted under `product`. Before the engine
    // reported the mount, this said `explore` and left the reader to guess which phase.
    const turns = turnsOf([
      entered(1, "feature"),
      entered(2, "feature/product", 1, "product"),
      {
        type: "instance.blocked",
        instanceId: -1,
        stateId: "explore",
        parentInstanceId: 2,
        childKey: "explore",
        reason: "explore: input 'prior_findings': child 'critique' has not run",
      },
    ]);
    const blocked = turns.find((t) => t.kind === "blocked");
    expect(blocked).toMatchObject({ stateId: "explore", path: "product/explore" });
  });

  it("leaves the path UNSET when the journal does not record one", () => {
    // Runs written before the blocked event carried its mount. Absent is not the same answer as the
    // root, and reading it as the root would put every historical block on the module itself.
    const turns = turnsOf([
      entered(1, "feature"),
      { type: "instance.blocked", instanceId: -1, stateId: "feature/product/draft", reason: "nope" },
    ]);
    expect(turns.find((t) => t.kind === "blocked")?.path).toBeUndefined();
  });

  it("keeps a state ENTERING even when it goes on to start an operation", () => {
    // Dropping it was a decision about the transcript, taken in the projection. The transcript
    // ignores `operation` turns anyway, and the canvas draws entering as a step in the run's path —
    // that a conversation opens underneath it is a second fact, not the same one.
    const turns = turnsOf([
      entered(1, "feature"),
      entered(2, "feature/product/context", 1, "context"),
      { type: "operation.started", instanceId: 2, stateId: "feature/product/context", op: "prompt" },
    ]);
    expect(turns.filter((t) => t.stateId === "feature/product/context").map((t) => t.text)).toEqual(["entered", "prompt"]);
  });
});
