/**
 * What the sync panel decides before it draws anything.
 *
 * Two rules, and both are the difference between a useful panel and a misleading one. An unsaved
 * draft is a change to the description — main can only see files, so a panel that ignored the
 * editor's own text would report "in step" about a document nobody has on screen. And with both
 * sides changed, or with no baseline at all, there is no direction to recommend: highlighting one
 * would push someone into overwriting the half they had just written.
 */
import { describe, expect, it } from "vitest";
import type { WorkflowSyncStatus } from "@jaira/shared/browser";
import { agoOf, driftOf, syncSentence } from "../src/renderer/syncState";

const status = (over: Partial<WorkflowSyncStatus> = {}): WorkflowSyncStatus => ({
  layer: "project",
  path: "workflows/workflow.md",
  exists: true,
  synced: true,
  at: 1_700_000_000_000,
  documentChanged: false,
  statesChanged: false,
  changedStates: [],
  suggested: null,
  ...over,
});

describe("driftOf", () => {
  it("recommends rewriting the workflows when the description is what moved", () => {
    const drift = driftOf(status({ documentChanged: true, suggested: "states" }), false);
    expect(drift.suggested).toBe("states");
  });

  it("recommends rewriting the description when the workflows moved", () => {
    const drift = driftOf(
      status({ statesChanged: true, changedStates: [{ path: "plan.json", change: "edited" }], suggested: "document" }),
      false,
    );
    expect(drift).toMatchObject({ statesChanged: true, suggested: "document", changedStates: 1 });
  });

  it("counts unsaved typing as a change to the description", () => {
    const drift = driftOf(status(), true);
    expect(drift.documentChanged).toBe(true);
    expect(drift.suggested).toBe("states");
  });

  it("drops the recommendation when the draft makes it a two-sided disagreement", () => {
    // Main saw only the state edit and suggested rewriting the document. The unsaved draft means
    // that would throw away what the person is typing.
    const answered = status({ statesChanged: true, changedStates: [{ path: "plan.json", change: "edited" }], suggested: "document" });
    expect(driftOf(answered, false).suggested).toBe("document");
    expect(driftOf(answered, true).suggested).toBeNull();
  });

  it("recommends nothing at all with no baseline, however dirty the editor is", () => {
    // Without a baseline, "changed" only means "you typed something" — which says nothing about
    // whether the workflows agree with it.
    expect(driftOf(status({ synced: false }), true).suggested).toBeNull();
  });
});

describe("syncSentence", () => {
  const say = (over: Partial<WorkflowSyncStatus>, dirty = false): string => {
    const s = status(over);
    return syncSentence(s, driftOf(s, dirty));
  };

  it("says which side moved, in the words that decide which button to press", () => {
    expect(say({ documentChanged: true })).toMatch(/description has changed.*workflows have not/);
    expect(say({ statesChanged: true, changedStates: [{ path: "plan.json", change: "edited" }] })).toMatch(
      /1 workflow file changed.*description has not/,
    );
  });

  it("counts the changed files", () => {
    expect(
      say({
        statesChanged: true,
        changedStates: [
          { path: "a.json", change: "edited" },
          { path: "b.json", change: "added" },
        ],
      }),
    ).toContain("2 workflow files");
  });

  it("says plainly when there is nothing to do", () => {
    expect(say({})).toBe("The description and the workflows are in step.");
  });

  it("hands a two-sided disagreement back to the person", () => {
    expect(say({ documentChanged: true, statesChanged: true, changedStates: [{ path: "a.json", change: "edited" }] })).toMatch(
      /Only you can say which is right/,
    );
  });

  it("prefers a blocked reason over any drift it might have computed", () => {
    expect(say({ blocked: "open a project to sync its workflows", statesChanged: true })).toBe(
      "open a project to sync its workflows",
    );
  });

  it("says there is no baseline before the first sync", () => {
    expect(say({ synced: false })).toMatch(/never been synced/);
  });
});

describe("agoOf", () => {
  it("stays coarse", () => {
    const now = 1_700_000_000_000;
    expect(agoOf(now, now)).toBe("just now");
    expect(agoOf(now - 5 * 60_000, now)).toBe("5 minutes ago");
    expect(agoOf(now - 3 * 3_600_000, now)).toBe("3 hours ago");
    expect(agoOf(now - 4 * 86_400_000, now)).toBe("4 days ago");
  });
});
