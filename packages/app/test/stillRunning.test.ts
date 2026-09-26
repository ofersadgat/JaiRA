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
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TranscriptEntry } from "../src/renderer/transcript";
import { liveStatusOf } from "../src/renderer/transcript";
import { Transcript } from "../src/renderer/transcriptView";

const t0 = Date.parse("2026-09-25T17:42:08Z");
const unanswered: TranscriptEntry = { kind: "tool", name: "Bash", summary: "git fetch origin", args: { command: "git fetch origin" }, at: t0 };
const answered: TranscriptEntry = { kind: "tool", name: "Bash", summary: "git status", args: { command: "git status" }, at: t0 - 1000, ok: true, result: "clean" };
const ask: TranscriptEntry = { kind: "message", role: "user", text: "check the branches" };
const reply: TranscriptEntry = { kind: "message", role: "assistant", text: "Done." };
const draw = (entries: TranscriptEntry[], working?: boolean): string =>
  renderToStaticMarkup(createElement(Transcript, { entries, ...(working !== undefined ? { working } : {}) }));

describe("a call with no answer", () => {
  it("is marked as never answered when the record is not being written", () => {
    const html = draw([ask, unanswered]);
    expect(html).toContain('title="No result was recorded"');
  });

  it("is still running while the record is being written and it is in the last stretch", () => {
    const html = draw([ask, unanswered], true);
    expect(html).not.toContain("No result was recorded");
  });

  it("is never answered once a message has come after it, even while the record is being written", () => {
    // The turn went on: a later message means this call's stretch is over, answered or not.
    const html = draw([ask, unanswered, reply, ask], true);
    expect(html).toContain('title="No result was recorded"');
  });

  it("reads the record's own status when the caller says nothing", () => {
    const session = (status: "running" | "success") => ({ taskId: "t", instanceId: "i", stateId: "s", sessionId: "x", seq: 1, turns: [], status });
    const running = renderToStaticMarkup(createElement(Transcript, { entries: [ask, unanswered], session: session("running") as never }));
    const ended = renderToStaticMarkup(createElement(Transcript, { entries: [ask, unanswered], session: session("success") as never }));
    expect(running).not.toContain("No result was recorded");
    expect(ended).toContain('title="No result was recorded"');
  });
});

describe("the other things that say they are live", () => {
  it("counts a thought up only while the record is being written", () => {
    const thinking: TranscriptEntry = { kind: "thought", text: "", live: true, startedAt: t0 };
    expect(draw([ask, thinking])).not.toContain("ts-think-live");
    expect(draw([ask, thinking], true)).toContain("ts-think-live");
  });

  it("says a call being written stopped, when the record is not being written", () => {
    const writing: TranscriptEntry = { kind: "writing", name: "Write", path: "page.html", chars: 2048 };
    const stopped = draw([ask, writing]);
    expect(stopped).toContain("stopped while being written");
    expect(stopped).not.toContain("ts-think-live");
    expect(draw([ask, writing], true)).toContain("ts-think-live");
  });

  it("pulses an answer being written only while the record is being written", () => {
    const tail: TranscriptEntry = { kind: "live", text: "Half an ans" };
    expect(draw([ask, tail])).not.toContain("ts-live-line");
    expect(draw([ask, tail], true)).toContain("ts-live-line");
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
