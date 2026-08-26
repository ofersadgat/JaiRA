/**
 * How a transcript tells the time.
 *
 * Three devices answer three different questions and none of them may answer another's, which is the
 * whole reason the ruled separator that used to sit between messages is gone: it tried to be all
 * three and was legible as none of them. A floating chip says which DAY you are reading. A gap says
 * how long a PAUSE was. The rail's clock says when one MESSAGE was said.
 *
 * The two here are the pure ones. They are worth testing because their failures are quiet: a gap
 * with a bad threshold annotates every breath in a conversation, and one that measures from the
 * wrong end reports a working agent as a silence.
 */
import { describe, expect, it } from "vitest";
import type { JsonValue } from "@declarative-ai/json";
import { dayLabelOf, endOfBlock, gapBetween, startOfBlock, type TranscriptBlock } from "../src/renderer/transcript";

/** Fixed, because "is this within the last week" is the one thing here that is not pure. */
const NOW = new Date("2026-08-26T12:00:00").getTime();
const at = (iso: string): number => new Date(iso).getTime();

describe("the pause between two messages", () => {
  it("says nothing about the ordinary rhythm of a conversation", () => {
    // A reply four minutes later is a reply, not an absence. Annotating it is how a transcript ends
    // up with a grey line under every paragraph — the thing this design exists to avoid.
    expect(gapBetween(at("2026-08-26T10:00:00"), at("2026-08-26T10:04:00"), NOW)).toBeUndefined();
    expect(gapBetween(at("2026-08-26T10:00:00"), at("2026-08-26T10:00:03"), NOW)).toBeUndefined();
  });

  it("names a pause in minutes once one is long enough to have been a break", () => {
    expect(gapBetween(at("2026-08-26T10:00:00"), at("2026-08-26T10:26:00"), NOW)).toEqual({
      size: "mins",
      label: "26 minutes later",
    });
  });

  it("switches to hours, and gets the singular right", () => {
    expect(gapBetween(at("2026-08-26T09:00:00"), at("2026-08-26T12:00:00"), NOW)?.label).toBe("3 hours later");
    expect(gapBetween(at("2026-08-26T09:00:00"), at("2026-08-26T10:00:00"), NOW)?.label).toBe("1 hour later");
  });

  it("names a day boundary with the weekday, never with a duration", () => {
    // `15 hours later` across a midnight is arithmetic nobody wants to do, and a full date here
    // would duplicate the floating chip. The weekday is the one thing neither of those says.
    const gap = gapBetween(at("2026-08-25T17:30:00"), at("2026-08-26T09:12:00"), NOW);
    expect(gap?.size).toBe("day");
    expect(gap?.label).toBe("Wednesday");
  });

  it("crosses a day even when the pause itself was short", () => {
    // Eleven minutes, and a different day. The boundary is what matters, not the duration.
    expect(gapBetween(at("2026-08-25T23:55:00"), at("2026-08-26T00:06:00"), NOW)?.size).toBe("day");
  });

  it("takes the date back once a weekday has stopped locating anything", () => {
    const gap = gapBetween(at("2026-08-16T17:00:00"), at("2026-08-17T09:00:00"), NOW);
    expect(gap?.size).toBe("day");
    expect(gap?.label).not.toBe("Monday");
    expect(gap?.label).toContain("17");
  });

  it("says nothing where a record kept no time", () => {
    expect(gapBetween(undefined, at("2026-08-26T10:00:00"), NOW)).toBeUndefined();
    expect(gapBetween(at("2026-08-26T10:00:00"), undefined, NOW)).toBeUndefined();
    expect(gapBetween(0, at("2026-08-26T10:00:00"), NOW)).toBeUndefined();
  });

  it("treats a backwards delta as no gap rather than as a negative one", () => {
    // Records arrive out of order often enough — a journal fact stamped by main, a live fragment
    // stamped by the renderer — that this has to be a shrug rather than an assertion.
    expect(gapBetween(at("2026-08-26T10:05:00"), at("2026-08-26T10:00:00"), NOW)).toBeUndefined();
  });
});

describe("where a block starts and ends", () => {
  const tool = (when: string): TranscriptBlock =>
    ({
      kind: "work",
      entries: [
        { kind: "tool", name: "Read", summary: "a.ts", at: at(when) },
        { kind: "tool", name: "Write", summary: "b.ts", at: at(when) + 60_000 },
      ],
    }) as TranscriptBlock;

  it("measures a work block from its first call to its last", () => {
    const block = tool("2026-08-26T10:00:00");
    expect(startOfBlock(block)).toBe(at("2026-08-26T10:00:00"));
    expect(endOfBlock(block)).toBe(at("2026-08-26T10:01:00"));
  });

  it("does not report a working agent as a silence", () => {
    // The point of measuring block-to-block rather than message-to-message. Forty tool calls over
    // twenty minutes is a run, not a pause, and the gap after it is the six minutes nobody was here.
    const work = tool("2026-08-26T10:00:00");
    const reply = { kind: "message", role: "user", at: at("2026-08-26T10:07:00") } as TranscriptBlock;
    expect(gapBetween(endOfBlock(work), startOfBlock(reply), NOW)?.label).toBe("6 minutes later");
  });

  it("has no time for a live block, which has not been recorded yet", () => {
    const live = { kind: "live", text: "half an ans" } as unknown as TranscriptBlock;
    expect(startOfBlock(live)).toBeUndefined();
    expect(endOfBlock(live)).toBeUndefined();
  });

  it("skips entries a record left unstamped rather than answering with nothing", () => {
    const block = {
      kind: "work",
      entries: [
        { kind: "tool", name: "Read", summary: "a.ts" },
        { kind: "tool", name: "Write", summary: "b.ts", at: at("2026-08-26T10:00:00") },
        { kind: "tool", name: "Bash", summary: "ls" },
      ] as unknown as JsonValue[],
    } as unknown as TranscriptBlock;
    expect(startOfBlock(block)).toBe(at("2026-08-26T10:00:00"));
    expect(endOfBlock(block)).toBe(at("2026-08-26T10:00:00"));
  });

  it("answers for nothing at all, which is what the first block is compared against", () => {
    expect(startOfBlock(undefined)).toBeUndefined();
    expect(endOfBlock(undefined)).toBeUndefined();
  });
});

describe("which day the chip names", () => {
  it("says Today rather than a date for the day you are on", () => {
    expect(dayLabelOf(at("2026-08-26T09:12:00"), NOW)).toBe("Today");
  });

  it("names any other day, however recent", () => {
    // No "Yesterday": the chip is scanned while scrolling, and a thread spanning a week reads as a
    // column of dates with one word in the middle of it that has to be decoded against them.
    const label = dayLabelOf(at("2026-08-25T14:22:00"), NOW);
    expect(label).not.toBe("Today");
    expect(label).toContain("25");
  });

  it("has nothing to say about a message with no time on it", () => {
    expect(dayLabelOf(undefined, NOW)).toBeUndefined();
    expect(dayLabelOf(0, NOW)).toBeUndefined();
  });
});
