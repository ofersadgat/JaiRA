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
  ({ taskId: "t", instanceId: String(instanceId), stateId: "plan/draft", sessionId: `#i`, seq: 0, turns: [] }) as SessionView;

describe("sessionKey", () => {
  it("is the durable instance id — unique for the task's whole life", () => {
    expect(sessionKey({ instanceId: "2" })).toBe("2");
  });
});

describe("withoutSession", () => {
  it("drops the entry filed under the instance", () => {
    const rest = withoutSession({ "2": view(2) }, { instanceId: "2" });
    expect(rest).toEqual({});
  });

  it("returns the same object when it held nothing, so nothing re-renders", () => {
    const sessions = { "3": view(3) };
    expect(withoutSession(sessions, { instanceId: "2" })).toBe(sessions);
  });
});
