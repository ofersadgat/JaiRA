/**
 * The one key a transcript is cached under, and the invalidation that has to agree with it.
 *
 * The disagreement is the bug: three call sites spelled the key, two the same way and one not, and
 * the odd one out was the invalidation. So a panel opened while a call was in flight kept whatever
 * the record held mid-call for the rest of the session — the settled answer never replaced it, and
 * the interrupted marker under the half transcript stayed there describing a state that had long
 * since finished. Watching a workflow run, that is every panel you looked at.
 */
import { describe, expect, it } from "vitest";
import type { SessionView } from "@jaira/shared/browser";
import { sessionKey, withoutSession } from "../src/renderer/sessionCache";

const view = (instanceId: number): SessionView =>
  ({ taskId: "t", runId: 7, instanceId, stateId: "plan/draft", sessionId: `#i${instanceId}`, seq: 0, turns: [] }) as SessionView;

describe("sessionKey", () => {
  it("pairs the run with the instance, because ids are minted per run", () => {
    expect(sessionKey({ runId: 7, instanceId: 2 })).toBe("7:2");
    expect(sessionKey({ runId: 7, instanceId: 2 })).not.toBe(sessionKey({ runId: 8, instanceId: 2 }));
  });

  it("uses the instance alone where a projection stamps no run", () => {
    expect(sessionKey({ instanceId: 2 })).toBe("2");
  });
});

describe("withoutSession", () => {
  it("drops the entry a task-level projection filed under run and instance", () => {
    // The case that was broken. The transcript panel reads a FOLDED tree, so every node carries its
    // run and every cached transcript is keyed `runId:instanceId` — and the invalidation used to
    // spell the bare id, which matched nothing here and dropped nothing.
    const rest = withoutSession({ "7:2": view(2) }, { runId: 7, instanceId: 2 });
    expect(rest).toEqual({});
  });

  it("drops the entry a single-run projection filed under the instance alone", () => {
    expect(withoutSession({ "2": view(2) }, { runId: 7, instanceId: 2 })).toEqual({});
  });

  it("leaves another run's instance of the same id alone", () => {
    const sessions = { "8:2": view(2) };
    expect(withoutSession(sessions, { runId: 7, instanceId: 2 })).toBe(sessions);
  });

  it("returns the same object when it held nothing, so nothing re-renders", () => {
    const sessions = { "7:3": view(3) };
    expect(withoutSession(sessions, { runId: 7, instanceId: 2 })).toBe(sessions);
  });
});
