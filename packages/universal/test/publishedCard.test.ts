/**
 * Which version a call's card for a published artifact shows, and whether a later call replaced it.
 * Only Claude's publishes replace a call: the person's saves follow the newest call's card (2026-11-07:
 * a canvas the person had saved once read "v16 is newer" on every card, and no card drew v16).
 */
import { describe, expect, it } from "vitest";
import { callCardOf } from "../src/components/panel/publishedCard";

const v = (version: number, author: "model" | "person") => ({ version, author });

describe("a call's card", () => {
  it("is replaced by a later call's publish, and shows its own version", () => {
    expect(callCardOf([v(1, "model"), v(2, "model"), v(3, "model")], 2)).toEqual({ replacedBy: 3, shows: 2, newest: 3 });
  });

  it("is not replaced by the person's saves after it, and shows the newest of them", () => {
    expect(callCardOf([v(14, "model"), v(15, "model"), v(16, "person")], 15)).toEqual({ replacedBy: null, shows: 16, newest: 16 });
  });

  it("is replaced when a call published after the person's saves", () => {
    expect(callCardOf([v(15, "model"), v(16, "person"), v(17, "model")], 15)).toEqual({ replacedBy: 17, shows: 15, newest: 17 });
  });

  it("shows its own version when it is the newest", () => {
    expect(callCardOf([v(1, "model")], 1)).toEqual({ replacedBy: null, shows: 1, newest: 1 });
    expect(callCardOf([], 4)).toEqual({ replacedBy: null, shows: 4, newest: 4 });
  });
});
