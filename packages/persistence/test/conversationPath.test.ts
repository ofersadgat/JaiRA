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
import { testHome } from "@jaira/testing";
import type { EngineEvent } from "@declarative-ai/hw";
import { initProject, openProject, type Project } from "../src/project";
import { conversationView } from "../src/conversation";

let dir: string;
let project: Project;
const now = 1_800_000_000_000;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jaira-convo-"));
  initProject(dir, testHome());
  project = openProject(dir, { baseDir: testHome() });
});

afterEach(() => {
  project.close();
  rmSync(dir, { recursive: true, force: true });
});

const entered = (id: string, stateId: string, parent?: string, childKey?: string): EngineEvent => ({
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
  project.runtime.beginTask("t-1", "hash", now);
  const recorder = project.events.recorder("t-1");
  events.forEach((event, i) => recorder.record(event, now + i));
  project.runtime.endTask("t-1", "error", now + events.length);
  return conversationView(project, "t-1").turns;
}

describe("a turn's mount path", () => {
  it("spells an element of a fan-out as key[i], the way the engine addresses it", () => {
    const element = (id: string, element: number): EngineEvent => ({
      type: "instance.entered",
      instanceId: id,
      stateId: "feature/ui/component",
      parentInstanceId: "1",
      childKey: "component",
      element,
      inputs: {},
    });
    const turns = turnsOf([entered("1", "feature/ui"), element("2", 0), element("3", 1), entered("4", "feature/ui/component/draft", "3", "draft")]);
    expect(turns.map((t) => t.path)).toEqual(["", "component[0]", "component[1]", "component[1]/draft"]);
  });

  it("is the chain of child keys, and the empty string at the root", () => {
    const turns = turnsOf([
      entered("1", "feature"),
      entered("2", "feature/product", "1", "product"),
      entered("3", "feature/product/context", "2", "context"),
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
      entered("1", "feature"),
      entered("2", "feature/product", "1", "product"),
      {
        type: "instance.blocked",
        stateId: "explore",
        parentInstanceId: "2",
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
      entered("1", "feature"),
      { type: "instance.blocked", stateId: "feature/product/draft", reason: "nope" },
    ]);
    expect(turns.find((t) => t.kind === "blocked")?.path).toBeUndefined();
  });

  it("keeps a state ENTERING even when it goes on to start an operation", () => {
    // Dropping it was a decision about the transcript, taken in the projection. The transcript
    // ignores a `started` turn anyway, and the canvas draws entering as a step in the run's path —
    // that a conversation opens underneath it is a second fact, not the same one.
    const turns = turnsOf([
      entered("1", "feature"),
      entered("2", "feature/product/context", "1", "context"),
      { type: "operation.started", instanceId: "2", stateId: "feature/product/context", op: "prompt" },
    ]);
    // On the KIND, not on the text. These two were one kind told apart by matching `text` against
    // the literal "entered", which is a discriminated union spelled as a magic string — and an
    // assertion written that way could not tell the rename from the regression.
    expect(turns.filter((t) => t.stateId === "feature/product/context").map((t) => t.kind)).toEqual(["entered", "started"]);
  });
});

/**
 * The instance a turn is about — the join the error routing is a lookup into.
 *
 * `stateId` names a state DEFINITION, so a loop that ran `draft` four times produced four
 * indistinguishable sets of turns. The instance is the thing that actually happened, and whether it
 * has one at all is what separates "this failed" from "this never ran".
 */
describe("which instance a turn names", () => {
  it("carries the instance on every turn that has one", () => {
    const turns = turnsOf([
      entered("1", "feature"),
      entered("2", "feature/product/context", "1", "context"),
      { type: "operation.started", instanceId: "2", stateId: "feature/product/context", op: "prompt" },
      {
        type: "operation.failed",
        instanceId: "2",
        stateId: "feature/product/context",
        op: "prompt",
        failure: { classification: "permanent", reason: "boom" },
      },
    ]);
    expect(turns.map((t) => [t.kind, t.instanceId])).toEqual([
      ["entered", "1"],
      ["entered", "2"],
      ["started", "2"],
      ["failure", "2"],
    ]);
  });

  it("carries NONE for a blocked child, because there never was one", () => {
    // The engine's event carries no id at all here. Absent is the honest projection of that: a
    // reader looking the instance up finds nothing, which is exactly the answer — no panel ever.
    const turns = turnsOf([
      entered("1", "feature"),
      { type: "instance.blocked", stateId: "feature/product/draft", reason: "nope", parentInstanceId: "1", childKey: "draft" },
    ]);
    expect(turns.find((t) => t.kind === "blocked")?.instanceId).toBeUndefined();
  });

  it("tells two passes of one looping state apart", () => {
    // The whole reason this field exists. Both turns name `draft`; only the instance says which run
    // of it failed.
    const turns = turnsOf([
      entered("1", "plan"),
      entered("2", "plan/draft", "1", "draft"),
      entered("3", "plan/draft", "1", "draft"),
      {
        type: "operation.failed",
        instanceId: "3",
        stateId: "plan/draft",
        op: "prompt",
        failure: { classification: "permanent", reason: "boom" },
      },
    ]);
    expect(turns.find((t) => t.kind === "failure")?.instanceId).toBe("3");
  });
});

describe("a re-stated entry", () => {
  it("is folded into the instance it continues, not narrated again", () => {
    // Until 2026-09-08 a resume re-entered the live spine with the SAME ids and journaled that.
    // Every open of the app that finds a task waiting on a person resumes it, so a projection that
    // narrated such a journal as written grew "entered product" and "entered product → ask" at its
    // tail once per reload. hw no longer writes them; the journals that hold them are still read.
    const turns = turnsOf([
      entered("1", "feature"),
      entered("2", "feature/product", "1", "product"),
      entered("3", "feature/product/ask", "2", "ask"),
      { type: "operation.started", instanceId: "3", stateId: "feature/product/ask", op: "function" },
      // The app is reloaded: an older continuing run re-states the spine.
      entered("1", "feature"),
      entered("2", "feature/product", "1", "product"),
      entered("3", "feature/product/ask", "2", "ask"),
      { type: "operation.started", instanceId: "3", stateId: "feature/product/ask", op: "function" },
    ]);
    expect(turns.filter((t) => t.kind === "entered").map((t) => [t.instanceId, t.path])).toEqual([
      ["1", ""],
      ["2", "product"],
      ["3", "product/ask"],
    ]);
  });

  it("still tells a loop's second pass apart, because that pass has its own id", () => {
    const turns = turnsOf([
      entered("1", "plan"),
      entered("2", "plan/draft", "1", "draft"),
      entered("3", "plan/draft", "1", "draft"),
    ]);
    expect(turns.filter((t) => t.kind === "entered").map((t) => t.instanceId)).toEqual(["1", "2", "3"]);
  });
});
