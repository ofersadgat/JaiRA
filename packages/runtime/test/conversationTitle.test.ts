import { describe, expect, it } from "vitest";
import { CONVERSATION_TITLE_MODEL, conversationTitleFrom, conversationTitleOperation, titleRulesOf } from "../src/conversationTitle";

describe("the call that names a conversation", () => {
  it("asks the simple preset bare: tools off, its own system prompt, no settings loaded, no session kept", () => {
    const op = conversationTitleOperation("Why does the sidebar flicker when I resize it?");
    expect(op.config).toMatchObject({
      model: "simple",
      toolChoice: "none",
      providerOptions: { claudeCode: { settingSources: [], extraArgs: { "no-session-persistence": null } } },
    });
    const bag = (op.config as { providerOptions: { claudeCode: { systemPrompt?: unknown } } }).providerOptions.claudeCode;
    expect(typeof bag.systemPrompt).toBe("string");
    expect(op.user).toContain("Why does the sidebar flicker when I resize it?");
    expect(op.output.name).toBe("title");
  });

  it("reads the gist of a long opening, not all of it", () => {
    const op = conversationTitleOperation(`first line\n${"x".repeat(10_000)}`);
    expect(op.user.length).toBeLessThan(5_000);
    expect(op.user).toContain("[…]");
  });
});

describe("the name out of the answer", () => {
  it("takes `title`, or a plain-text answer", () => {
    expect(conversationTitleFrom({ title: "Sidebar flicker on resize" })).toBe("Sidebar flicker on resize");
    expect(conversationTitleFrom("Sidebar flicker on resize")).toBe("Sidebar flicker on resize");
  });

  it("drops wrapping quotes, a closing full stop and every line after the first", () => {
    expect(conversationTitleFrom({ title: '"Sidebar flicker on resize."' })).toBe("Sidebar flicker on resize");
    expect(conversationTitleFrom({ title: "\n  Side panel designs\nand more" })).toBe("Side panel designs");
  });

  it("cuts a long one at the birth name's limit", () => {
    const title = conversationTitleFrom({ title: "word ".repeat(30) });
    expect(title?.length).toBeLessThanOrEqual(60);
    expect(title?.endsWith("…")).toBe(true);
  });

  it("has nothing for an answer with no name in it", () => {
    expect(conversationTitleFrom(undefined)).toBeUndefined();
    expect(conversationTitleFrom(null)).toBeUndefined();
    expect(conversationTitleFrom({ title: '  ""  ' })).toBeUndefined();
    expect(conversationTitleFrom({ name: "Sidebar" })).toBeUndefined();
  });
});

describe("a scripted run's rules", () => {
  it("answer the title call only when they name its model — a catch-all is the run's, not the name's", () => {
    const named = { model: CONVERSATION_TITLE_MODEL, output: { title: "T" } };
    expect(titleRulesOf([{ output: "hi" }, { model: "opus", output: "x" }, named])).toEqual([named]);
  });
});
