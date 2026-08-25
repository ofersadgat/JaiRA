/**
 * Anchoring, and what happens when the text moves under a note (decision 0002).
 *
 * The interesting cases are all drift: a note is written against text a model is about to rewrite,
 * so "the quote is still there but somewhere else" and "the quote is gone" are the normal states,
 * not the edge ones.
 */
import { describe, expect, it } from "vitest";
import { anchorNote, anchorNotes, checkNotes, noteJson, shortQuote, type ReviewNote } from "../src/reviewNotes";

const NOTE = (over: Partial<ReviewNote> = {}): ReviewNote => ({
  artifact: "plan_doc",
  quote: "cache the probe",
  body: "say which cache",
  author: "Ofer Sadgat",
  at: "2026-08-24T12:00:00.000Z",
  ...over,
});

describe("anchorNote", () => {
  it("takes the stored range when it still holds the same words", () => {
    const text = "we should cache the probe today";
    expect(anchorNote(text, NOTE({ range: { start: 10, end: 25 } }))).toEqual({ start: 10, end: 25 });
  });

  it("re-finds the quote when the text above it grew", () => {
    const text = "a new opening line\nwe should cache the probe today";
    // The stored offsets now point at the wrong words entirely — the quote is what saves it.
    const found = anchorNote(text, NOTE({ range: { start: 10, end: 25 } }));
    expect(found).toBeDefined();
    expect(text.slice(found!.start, found!.end)).toBe("cache the probe");
  });

  it("is undefined when the quote is gone — an orphan, not an error", () => {
    expect(anchorNote("nothing like it here", NOTE({ range: { start: 10, end: 25 } }))).toBeUndefined();
  });

  it("picks the repeat nearest where the note was written", () => {
    const text = `${"x".repeat(100)}cache the probe${"y".repeat(100)}cache the probe`;
    const near = anchorNote(text, NOTE({ range: { start: 210, end: 225 } }));
    expect(near?.start).toBe(215);
    const far = anchorNote(text, NOTE({ range: { start: 0, end: 15 } }));
    expect(far?.start).toBe(100);
  });

  it("takes the first repeat when there is no hint to choose by", () => {
    const text = "cache the probe, then cache the probe again";
    expect(anchorNote(text, NOTE())?.start).toBe(0);
  });

  it("refuses to anchor an empty quote", () => {
    expect(anchorNote("anything", NOTE({ quote: "" }))).toBeUndefined();
  });
});

describe("anchorNotes", () => {
  it("keeps orphans in place rather than dropping them", () => {
    const anchored = anchorNotes("cache the probe", [NOTE(), NOTE({ quote: "deleted sentence" })]);
    expect(anchored).toHaveLength(2);
    expect(anchored[0]!.resolved).toEqual({ start: 0, end: 15 });
    expect(anchored[1]!.resolved).toBeUndefined();
    // The orphan keeps its words: they are the reviewer's, and the artifact changing is not a
    // reason to throw them away.
    expect(anchored[1]!.body).toBe("say which cache");
  });
});

describe("checkNotes", () => {
  it("accepts absent notes as no notes", () => {
    expect(checkNotes(undefined)).toEqual({ ok: true, notes: [] });
  });

  it("accepts a well-formed note, range and side included", () => {
    const checked = checkNotes([{ ...NOTE({ range: { start: 1, end: 4 } }), side: "after" }]);
    expect(checked.ok).toBe(true);
    expect(checked.ok && checked.notes[0]!.side).toBe("after");
  });

  it("refuses a non-array", () => {
    expect(checkNotes("a note")).toMatchObject({ ok: false });
  });

  it("names the field and the index it refused", () => {
    const checked = checkNotes([NOTE(), { ...NOTE(), author: 7 }]);
    expect(checked).toMatchObject({ ok: false, errors: "notes[1].author must be a string" });
  });

  it("refuses an empty body — a note with nothing in it is a mis-click", () => {
    expect(checkNotes([{ ...NOTE(), body: "   " }])).toMatchObject({ ok: false, errors: "notes[0].body must not be empty" });
  });

  it("refuses an inverted or negative range", () => {
    expect(checkNotes([NOTE({ range: { start: 9, end: 2 } })])).toMatchObject({ ok: false });
    expect(checkNotes([NOTE({ range: { start: -1, end: 2 } })])).toMatchObject({ ok: false });
  });

  it("refuses a side that is neither half of a diff", () => {
    expect(checkNotes([{ ...NOTE(), side: "middle" }])).toMatchObject({ ok: false });
  });

  it("drops unknown fields rather than carrying them onto a state's outputs", () => {
    const checked = checkNotes([{ ...NOTE(), sneaky: true }]);
    expect(checked.ok).toBe(true);
    expect(checked.ok && Object.keys(checked.notes[0]!).sort()).toEqual(["artifact", "at", "author", "body", "quote"]);
  });
});

describe("shortQuote", () => {
  it("flattens the whitespace a selection dragged across lines picks up", () => {
    expect(shortQuote("  cache\n  the   probe \n")).toBe("cache the probe");
  });

  it("elides the middle, keeping both ends — they are what identify a passage", () => {
    const short = shortQuote(`${"a".repeat(60)} ${"b".repeat(60)}`);
    expect(short.startsWith("aaaa")).toBe(true);
    expect(short.endsWith("bbbb")).toBe(true);
    expect(short).toContain("…");
    expect(short.length).toBeLessThanOrEqual(90);
  });

  it("leaves a quote that already fits alone", () => {
    expect(shortQuote("cache the probe")).toBe("cache the probe");
  });
});

describe("noteJson", () => {
  it("omits the optional fields rather than writing nulls", () => {
    expect(noteJson(NOTE())).toEqual({
      artifact: "plan_doc",
      quote: "cache the probe",
      body: "say which cache",
      author: "Ofer Sadgat",
      at: "2026-08-24T12:00:00.000Z",
    });
  });
});

/**
 * A note is a THREAD (2026-08-24 review) — review comments get answered, and a shape with room for
 * only the opening line pushed every answer into a new note anchored to the same words.
 */
describe("replies", () => {
  const withReplies = {
    ...NOTE(),
    replies: [
      { author: "Ofer Sadgat", body: "I mean the second one", at: "2026-08-24T12:05:00.000Z" },
      { author: "the model", body: "changed it", at: "2026-08-24T12:09:00.000Z" },
    ],
  };

  it("accepts a thread and keeps its order", () => {
    const checked = checkNotes([withReplies]);
    expect(checked.ok).toBe(true);
    expect(checked.ok && checked.notes[0]!.replies?.map((r) => r.body)).toEqual(["I mean the second one", "changed it"]);
  });

  it("refuses a malformed reply, naming which one", () => {
    const bad = { ...NOTE(), replies: [{ author: "x", body: "ok", at: "t" }, { author: "x", at: "t" }] };
    expect(checkNotes([bad])).toMatchObject({ ok: false, errors: "notes[0].replies[1].body must be a string" });
  });

  it("refuses an empty reply — a blank message is a mis-click, not a contribution", () => {
    expect(checkNotes([{ ...NOTE(), replies: [{ author: "x", body: "  ", at: "t" }] }])).toMatchObject({ ok: false });
  });

  it("drops an empty replies array rather than carrying it onto a state's outputs", () => {
    const checked = checkNotes([{ ...NOTE(), replies: [] }]);
    expect(checked.ok && "replies" in checked.notes[0]!).toBe(false);
  });

  it("round-trips a thread through noteJson", () => {
    const json = noteJson(withReplies) as { replies?: unknown[] };
    expect(json.replies).toHaveLength(2);
    expect(noteJson(NOTE())).not.toHaveProperty("replies");
  });
});
