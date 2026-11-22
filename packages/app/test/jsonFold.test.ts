/**
 * A value as the lines of its JSON, walked (`jsonFold.ts`): with every part off, exactly
 * `JSON.stringify(value, null, 2)`, coloured and hinted as `highlightJson` does that text; with them on,
 * folded to a budget, cut into chunks, and its long strings cut — each part on its own.
 */
import { describe, expect, it } from "vitest";
import { JSON_FOLDING, JSON_UNFOLDED, foldRows, foldingOf, initialFold, pathKey, stepped, type FoldRow } from "../src/renderer/jsonFold";
import { highlightJson } from "../src/renderer/jsonHighlight";
import { schemaDescriber } from "../src/renderer/valueViewMeta";

const pretty = (v: unknown): string => JSON.stringify(v, null, 2) ?? "undefined";
const textOf = (rows: FoldRow[]): string => rows.map((r) => r.tokens.map((t) => t.text).join("")).join("\n");
const unfolded = (v: unknown): FoldRow[] => foldRows(v, new Map(), JSON_UNFOLDED);

const SAMPLES: unknown[] = [
  null,
  0,
  -1.5,
  true,
  "a \"quoted\"\nline",
  [],
  {},
  [1, "two", null, undefined, () => 1, Symbol("s"), Number.NaN, Infinity, [[]], {}],
  { a: 1, skip: undefined, f: () => 1, b: { c: [1, { d: "e" }], empty: {}, none: [] }, s: Symbol("x"), z: "last" },
  { only: undefined },
  { date: new Date(0), boxed: [new Number(3), new String("s"), new Boolean(false)], custom: { toJSON: (k: string) => `key:${k}` } },
  { value: "x".repeat(500), entries: Array.from({ length: 40 }, (_, i) => ({ i, text: `entry ${i}` })) },
];

describe("foldRows, every part off", () => {
  it("is JSON.stringify(value, null, 2), token for token", () => {
    for (const v of SAMPLES) expect(textOf(unfolded(v))).toBe(pretty(v));
  });

  it("colours as highlightJson colours that text", () => {
    for (const v of SAMPLES) {
      const kinds = (rows: { tokens: { text: string; kind: string }[] }[]): string[] => rows.flatMap((r) => r.tokens.filter((t) => t.kind !== "plain").map((t) => `${t.kind}:${t.text}`));
      expect(kinds(unfolded(v))).toEqual(kinds(highlightJson(pretty(v))));
    }
  });

  it("hints each key from the schema as highlightJson does, an array borrowing its key for its items", () => {
    const schema = {
      type: "object",
      properties: {
        model: { description: "Which model" },
        steps: { type: "array", items: { type: "object", properties: { name: { description: "The step's name" } } } },
        nested: { type: "object", properties: { deep: { description: "Deep down" } } },
      },
    };
    const value = { model: "m", steps: [{ name: "a" }, { name: "b", other: 1 }], nested: { deep: true } };
    const describeIt = schemaDescriber(schema);
    expect(foldRows(value, new Map(), JSON_UNFOLDED, describeIt).map((r) => (r.kind === "line" ? (r.hint ?? null) : null))).toEqual(highlightJson(pretty(value), describeIt).map((l) => l.hint ?? null));
  });

  it("draws a value that contains itself, and a bigint, rather than throwing", () => {
    const loop: Record<string, unknown> = { a: 1 };
    loop["self"] = loop;
    expect(textOf(unfolded(loop))).toBe('{\n  "a": 1,\n  "self": "[Circular]"\n}');
    expect(textOf(unfolded({ n: 10n }))).toBe('{\n  "n": 10\n}');
  });
});

describe("foldRows, folded", () => {
  const answer = {
    value: "done",
    usage: { input: 1, output: 2 },
    entries: Array.from({ length: 342 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: [{ type: "text", text: `t${i}` }] })),
    tools: Array.from({ length: 186 }, (_, i) => `tool_${i}`),
  };

  it("opens, breadth-first, what fits in the budget, and closes the rest with a peek", () => {
    const folding = foldingOf(undefined);
    const rows = foldRows(answer, initialFold(answer, folding), folding);
    expect(rows.length).toBeLessThanOrEqual(JSON_FOLDING.fold !== false ? JSON_FOLDING.fold.budget : Infinity);
    const entries = rows.find((r) => r.tokens.some((t) => t.text === '"entries"'));
    expect(entries?.kind === "line" && entries.fold).toEqual({ path: pathKey("$", "entries"), open: false, size: 342, unit: "items" });
    expect(entries?.kind === "line" && entries.closed?.peek).toBe("");
    const usage = rows.find((r) => r.tokens.some((t) => t.text === '"usage"'));
    expect(usage?.kind === "line" && usage.fold?.open).toBe(true);
  });

  it("shows a chunk of an open array, then how many are left and the step", () => {
    const folding = foldingOf(undefined);
    const states = stepped(initialFold(answer, folding), pathKey("$", "entries"), (s) => ({ ...s, open: true }));
    const rows = foldRows(answer, states, folding);
    const more = rows.find((r) => r.kind === "more");
    expect(more).toMatchObject({ kind: "more", path: pathKey("$", "entries"), rest: 322, unit: "items", step: 20 });
    // The items a chunk shows arrive closed, each peeking at its first members.
    const item = rows.find((r) => r.kind === "line" && r.fold?.path === pathKey(pathKey("$", "entries"), 0));
    expect(item?.kind === "line" && item.closed?.peek).toBe('role: "user", content: [1]');
    const all = foldRows(answer, stepped(states, pathKey("$", "entries"), (s) => ({ ...s, shown: 342 })), folding);
    expect(all.some((r) => r.kind === "more" && r.path === pathKey("$", "entries"))).toBe(false);
  });

  it("cuts a long string, with how much is left, and shows more of it when asked", () => {
    const folding = foldingOf({ fold: false, chunk: false });
    const value = { big: "y".repeat(5_000) };
    const cut = foldRows(value, new Map(), folding)[1]!;
    expect(cut).toMatchObject({ cut: { path: pathKey("$", "big"), rest: 4_700 } });
    expect(cut.tokens.map((t) => t.text).join("")).toBe(`  "big": "${"y".repeat(300)}…"`);
    // Within the slack it is drawn whole.
    expect(foldRows({ s: "z".repeat(390) }, new Map(), folding)[1]!.tokens.map((t) => t.text).join("")).toBe(`  "s": "${"z".repeat(390)}"`);
    const more = foldRows(value, stepped(new Map(), pathKey("$", "big"), () => ({ chars: Infinity })), folding)[1]!;
    expect(more).not.toHaveProperty("cut");
  });

  it("turns each part off on its own", () => {
    // Chunks without folding: everything open, no chevrons, still "… N more".
    const chunked = foldRows(answer, new Map(), foldingOf({ fold: false, strings: false }));
    expect(chunked.some((r) => r.kind === "line" && r.fold !== undefined)).toBe(false);
    expect(chunked.filter((r) => r.kind === "more").map((r) => r.kind === "more" && r.rest)).toEqual([322, 166]);
    // Folding without chunks: what opens shows every member.
    const folding = foldingOf({ chunk: false });
    const open = foldRows(answer, stepped(initialFold(answer, folding), pathKey("$", "tools"), (s) => ({ ...s, open: true })), folding);
    expect(open.some((r) => r.kind === "more")).toBe(false);
    expect(open.filter((r) => r.tokens.some((t) => t.text.startsWith('"tool_'))).length).toBe(186);
  });
});
