/**
 * Every comment JaiRA posts is signed (the rulings of 2026-09-25): a visible first line naming the
 * model that asked, and a hidden marker — which, not the account, is what makes a comment JaiRA's own.
 */
import { describe, expect, it } from "vitest";
import { commentMarker, commentSignatureOf, isJairaComment, signatureLine, signComment } from "../src/forge";

describe("signing a comment", () => {
  it("puts who asked on the first line and the marker last", () => {
    const signed = signComment("Looks right.", { model: "claude-opus-5-5", taskId: "t-abc" });
    expect(signed).toBe("🤖 claude-opus-5-5 · via JaiRA\n\nLooks right.\n\n<!-- jaira:comment model=claude-opus-5-5 task=t-abc -->");
    expect(signed.split("\n")[0]).toBe("🤖 claude-opus-5-5 · via JaiRA");
  });

  it("says JaiRA where no model asked — a person's words carried, the review's closing line", () => {
    expect(signatureLine({})).toBe("🤖 JaiRA");
    expect(signComment("Decided.", { taskId: "t-1" })).toBe("🤖 JaiRA\n\nDecided.\n\n<!-- jaira:comment model=JaiRA task=t-1 -->");
  });

  it("is signed once: a body that already carries the marker is left as it is", () => {
    const once = signComment("x", { model: "m" });
    expect(signComment(once, { model: "other" })).toBe(once);
  });

  it("keeps the marker an HTML comment whatever the model id says", () => {
    expect(commentMarker({ model: "evil --> <b>", taskId: "t 1" })).toBe("<!-- jaira:comment model=evil__b task=t_1 -->");
  });

  it("knows its own by the marker at the end — and nothing else by the account or the words", () => {
    expect(isJairaComment(signComment("a", { taskId: "t" }))).toBe(true);
    expect(isJairaComment(`${signComment("a", { taskId: "t" })}\n  `)).toBe(true);
    // Somebody quoting JaiRA part-way through their own comment is still somebody.
    expect(isJairaComment("> <!-- jaira:comment model=x -->\n\nno, keep the old key")).toBe(false);
    expect(isJairaComment("🤖 JaiRA\n\nwritten by hand to look like it")).toBe(false);
    expect(isJairaComment(undefined)).toBe(false);
    expect(commentSignatureOf(signComment("a", { model: "gpt-5.6-terra", taskId: "t-9" }))).toEqual({ model: "gpt-5.6-terra", taskId: "t-9" });
    expect(commentSignatureOf(signComment("a", { taskId: "t-9" }))).toEqual({ taskId: "t-9" });
    expect(commentSignatureOf("plain")).toBeUndefined();
  });
});
