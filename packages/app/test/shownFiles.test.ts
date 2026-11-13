/**
 * What a `show_artifact` call that SHOWED files draws (2026-11-13): `shownOf` reads its `shown` and
 * `refused`, a shown file is named by its type, what a subagent showed is collected for its line, and a
 * call that showed several is replaced only when every one of them was shown again.
 */
import { describe, expect, it } from "vitest";
import { keptUnderSummary, replacedPublishes, shownInChain, shownKindOf, shownMimeOf, shownOf, toolLineOf } from "../src/renderer/transcriptRows";
import type { ToolEntry, TranscriptEntry } from "../src/renderer/transcript";

const item = (id: string, entry: string, version = 1, extra: Record<string, unknown> = {}) => ({ url: `artifact://t-1/@${id}`, id, version, kind: "file", title: entry.split("/").pop(), entry, source: entry, ...extra });
const showCall = (shown: unknown[], refused: unknown[] = [], caption?: string): ToolEntry =>
  ({
    kind: "tool",
    name: "mcp__dai__show_artifact",
    summary: "",
    ok: true,
    args: { artifacts: [] },
    result: [{ type: "text", text: JSON.stringify({ answer: "Shown in this conversation: …", ...(caption !== undefined ? { caption } : {}), shown, refused }) }],
  }) as unknown as ToolEntry;

describe("shownOf", () => {
  it("reads each file shown, its caption and where it came from, and each refused with why", () => {
    const entry = showCall(
      [item("a-1", "shots/before.png", 1, { caption: "Before" }), item("a-2", "https://e.com/x?id=3", 2, { from: "e.com", title: "x.png" })],
      [{ source: "docs/q.pdf", why: "Not shown: JaiRA has no view for q.pdf (application/pdf). …" }],
      "Icons before and after",
    );
    expect(shownOf(entry.result)).toEqual({
      caption: "Icons before and after",
      items: [
        { taskId: "t-1", id: "a-1", url: "artifact://t-1/@a-1", version: 1, kind: "file", title: "before.png", entry: "shots/before.png", caption: "Before" },
        { taskId: "t-1", id: "a-2", url: "artifact://t-1/@a-2", version: 2, kind: "file", title: "x.png", entry: "https://e.com/x?id=3", from: "e.com" },
      ],
      refused: [{ source: "docs/q.pdf", why: "Not shown: JaiRA has no view for q.pdf (application/pdf). …" }],
    });
    expect(toolLineOf(entry, false, false).shown).toBe("published");
    expect(keptUnderSummary(entry, {})).toBe(true);
  });

  it("is nothing for a page's or a canvas's publish, which answers `artifact`, or a refusal", () => {
    expect(shownOf({ answer: "…", artifact: { url: "artifact://t-1/@a-1", version: 1, kind: "page", entry: "p.html" } })).toBeUndefined();
    expect(shownOf({ error: "Not shown: …" })).toBeUndefined();
  });
});

describe("a shown file's type and kind", () => {
  it("is a data: URI's own type, else its source's name, a web address's query aside", () => {
    expect(shownMimeOf("https://e.com/raw?id=3", "data:image/png;base64,AA==")).toBe("image/png");
    expect(shownMimeOf("https://e.com/a/b.csv?x=1#y", "a,b")).toBe("text/csv");
    expect(shownMimeOf("C:\\work\\src\\a.ts", undefined)).toBe(shownMimeOf("src/a.ts", undefined));
  });

  it("is named the way the title bar says it", () => {
    expect(["image/png", "video/webm", "audio/mpeg", "text/x-diff", "text/csv", "application/json", shownMimeOf("a.ts", undefined), "text/plain"].map((m) => shownKindOf(m).word)).toEqual([
      "picture",
      "clip",
      "track",
      "diff",
      "table",
      "data",
      "code",
      "text",
    ]);
  });
});

describe("shownInChain", () => {
  it("collects what a subagent and the subagents it started showed, the newest version of each, and nothing refused", () => {
    const inner: TranscriptEntry[] = [showCall([item("a-2", "after.png")])];
    const outer: TranscriptEntry[] = [
      showCall([item("a-1", "before.png", 1)]),
      { kind: "tool", name: "Agent", summary: "", ok: true, sidechain: "c-2" } as unknown as TranscriptEntry,
      showCall([item("a-1", "before.png", 2)]),
      { ...showCall([item("a-9", "x.png")]), ok: false } as unknown as TranscriptEntry,
    ];
    const files = shownInChain(outer, (call) => (call === "c-2" ? inner : undefined));
    expect(files?.items.map((i) => `${i.id} v${i.version}`)).toEqual(["a-2 v1", "a-1 v2"]);
    expect(files?.refused).toEqual([]);
    expect(shownInChain([], () => undefined)).toBeUndefined();
  });
});

describe("a call that showed several, replaced", () => {
  it("only when every file it showed was shown again before the person spoke", () => {
    const both = showCall([item("a-1", "a.png"), item("a-2", "b.png")]);
    const one = showCall([item("a-1", "a.png", 2)]);
    const two = showCall([item("a-2", "b.png", 2)]);
    expect(replacedPublishes([both, one]).has(both)).toBe(false);
    expect(replacedPublishes([both, one, two]).has(both)).toBe(true);
    expect(replacedPublishes([both, { kind: "message", role: "user", text: "ok" } as unknown as TranscriptEntry, one, two]).has(both)).toBe(false);
  });
});
