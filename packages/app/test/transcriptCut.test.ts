/**
 * An armed rewind in a TRANSCRIPT — the part of it a model says.
 *
 * What the transcript does with an armed cut — fading every message from the turn on under one line
 * that counts them — it works out as it draws (the universal tree's `SessionTranscript.tsx`), and is
 * not covered here. What is: the sentence each of the two verbs is offered under, which is the one
 * thing about a cut that differs by the role of the message it falls at.
 */
import { describe, expect, it } from "vitest";
import { cutTitleOf } from "../src/renderer/messageReading";

describe("a transcript with a rewind armed", () => {
  it("offers rewind and fork where the host names a cut, with the sentence for the role", () => {
    // A message that begins a turn is cut BEFORE: it and everything after it go.
    expect(cutTitleOf("rewind", "before")).toEqual({ label: "Rewind to before this message", title: "Rewind to before this message — it and everything after it are deleted" });
    expect(cutTitleOf("fork", "before")).toEqual({ label: "Fork before this message", title: "Fork before this message — a new conversation that shares everything up to here" });
    // A reply ends one and is cut AFTER: it stays, and everything after it goes.
    expect(cutTitleOf("rewind", "after")).toEqual({ label: "Rewind to this reply", title: "Rewind to this reply — everything after it is deleted" });
    expect(cutTitleOf("fork", "after")).toEqual({ label: "Fork after this reply", title: "Fork after this reply — a new conversation that shares everything up to here" });
  });
});
