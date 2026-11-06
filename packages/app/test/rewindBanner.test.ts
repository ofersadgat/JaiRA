/**
 * What the banner over the box says while a rewind is armed (the person, 2026-10-29: with agents or
 * workflows running, "wait for agents to finish, stop agents, cancel"; with none, rewind or cancel).
 */
import { describe, expect, it } from "vitest";
import { armingText, runningText, type Arming } from "../src/renderer/chatThreadModel";

const before: Arming = { kind: "rewind", seq: 9, from: 3, was: "start the gate\nand more", side: "before" };
const after: Arming = { ...before, side: "after" };

describe("what still runs, said", () => {
  it("names the agent, a workflow it started, both, or nothing", () => {
    expect(runningText({ agent: true, workflow: false })).toBe("The agent is still answering");
    expect(runningText({ agent: false, workflow: true })).toBe("A workflow it started is still running");
    expect(runningText({ agent: true, workflow: true })).toBe("The agent and a workflow it started are still running");
    expect(runningText({ agent: false, workflow: false })).toBeNull();
  });
});

describe("an armed rewind's banner", () => {
  it("says what goes, with nothing running", () => {
    expect(armingText(before)).toBe("Rewind to before “start the gate” — it and everything after it are deleted, and it goes back in the box. This cannot be undone.");
    expect(armingText(after)).toBe("Rewind to “start the gate” — everything after it is deleted. This cannot be undone.");
  });
  it("says what still runs, and that it can be waited for or stopped", () => {
    expect(armingText(after, "A workflow it started is still running")).toBe(
      "Rewind to “start the gate” — everything after it is deleted. This cannot be undone. A workflow it started is still running: wait for it to finish, or stop it now.",
    );
  });
  it("says the whole conversation goes before the message it opened with — and its worktree, where it has one", () => {
    const start: Arming = { ...before, side: "start" };
    expect(armingText(start)).toBe("Rewind to before “start the gate” — the whole conversation is deleted, and the message goes back in the box of a new one. This cannot be undone.");
    expect(armingText(start, null, true)).toBe(
      "Rewind to before “start the gate” — the whole conversation is deleted, with its worktree, and the message goes back in the box of a new one. This cannot be undone.",
    );
    expect(armingText({ kind: "fork", seq: 9, from: 0, was: "start the gate", side: "start" })).toBe(
      "Forking before “start the gate” — your next message starts a new conversation that shares nothing with this one. This one is not changed.",
    );
  });
  it("says it is waiting, and on what", () => {
    expect(armingText({ ...before, waiting: true }, "The agent is still answering")).toBe("Rewinding to before “start the gate” once nothing is running here — the agent is still answering.");
    expect(armingText({ ...before, waiting: true })).toBe("Rewinding to before “start the gate” once nothing is running here.");
  });
});
