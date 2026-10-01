/**
 * "Still running" is said only of what IS still running (the person, 2026-09-25: "it is very important
 * that 'still running' is accurate everywhere it appears").
 *
 * A call with no answer is one of two facts: still running (the record is still being written and the
 * call is in its last stretch), or never answered (the record went on, or ended, without one). A chat
 * whose last turn ended on an unanswered `bash` call pulsed "Running git fetch…" for good — so every
 * place the transcript says something is live now asks the same question, and only the caller (a
 * chat's task status) or the record's own status can answer it.
 */
import { describe, expect, it } from "vitest";
import type { ToolEntry, TranscriptEntry } from "../src/renderer/transcript";
import { liveStatusOf } from "../src/renderer/transcript";
import { toolLineOf } from "../src/renderer/transcriptRows";

const t0 = Date.parse("2026-09-25T17:42:08Z");
const unanswered: TranscriptEntry = { kind: "tool", name: "Bash", summary: "git fetch origin", args: { command: "git fetch origin" }, at: t0 };
const answered: TranscriptEntry = { kind: "tool", name: "Bash", summary: "git status", args: { command: "git status" }, at: t0 - 1000, ok: true, result: "clean" };
const ask: TranscriptEntry = { kind: "message", role: "user", text: "check the branches" };
const reply: TranscriptEntry = { kind: "message", role: "assistant", text: "Done." };

/**
 * The call's row, as `toolLineOf` says it. `open` is the transcript's to say — the call's stretch is
 * the last thing in a record still being written — and the row's words follow from it: `running` is
 * the "still running" under the row, and the mark `cut` is the dash that reads "No result was recorded".
 */
const rowOf = (entry: TranscriptEntry, open: boolean) => toolLineOf(entry as ToolEntry, open, false);

describe("a call with no answer", () => {
  it("is marked as never answered when the record is not being written", () => {
    expect(rowOf(unanswered, false)).toMatchObject({ unanswered: true, running: false, mark: "cut" });
  });

  it("is still running while the record is being written and it is in the last stretch", () => {
    expect(rowOf(unanswered, true)).toMatchObject({ unanswered: true, running: true, mark: "waiting" });
    // A call that answered is neither, wherever its stretch is.
    expect(rowOf(answered, true)).toMatchObject({ unanswered: false, running: false, mark: "ok" });
    expect(rowOf(answered, false)).toMatchObject({ unanswered: false, running: false, mark: "ok" });
  });
});

describe("the status bar", () => {
  it("does not name a call from an earlier turn that never answered", () => {
    // Running, a new turn has started and made no call yet: the old unanswered call is not what it is doing.
    expect(liveStatusOf([ask, unanswered, reply, ask], null, true)).toEqual({ kind: "working" });
    // The current turn's own unanswered call is.
    expect(liveStatusOf([ask, unanswered], null, true)).toMatchObject({ kind: "running", summary: "git fetch origin" });
  });
});
