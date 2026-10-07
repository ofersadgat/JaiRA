/**
 * Large values answered as placeholders (decision 0018 §6, `service/src/lazy.ts`).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dehydrate, openDb, type JairaDb } from "@jaira/persistence";
import { isLazy, LAZY_KEY, lazyHashes, withLazyFilled, type SessionView } from "@jaira/shared";
import { LazyValues } from "@jaira/service";

let dir: string;
let db: JairaDb;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jaira-lazy-"));
  db = openDb(join(dir, "jaira.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const big = (c: string, n = 10_000): string => c.repeat(n);
const view = (): SessionView =>
  ({
    taskId: "t-a",
    instanceId: "i",
    stateId: "s",
    sessionId: "x",
    seq: 0,
    turns: [
      { role: "assistant", text: big("said "), parts: [{ type: "text", text: big("said ") }, { type: "tool_use", id: "c1", name: "Read", input: { file_path: "/a.ts" } }] },
      { role: "user", parts: [{ type: "tool_result", tool_use_id: "c1", content: big("file "), is_error: false }] },
    ],
  }) as unknown as SessionView;

describe("a session view for a reader", () => {
  it("has its tools' large values as placeholders, and what was said whole", () => {
    const lazy = new LazyValues(() => db);
    const out = lazy.session(view(), 4096);
    const [said, answered] = out.turns as Array<{ text?: string; parts: Array<Record<string, unknown>> }>;
    expect(said!.text).toBe(big("said "));
    expect(said!.parts[0]!["text"]).toBe(big("said "));
    expect(said!.parts[1]).toEqual({ type: "tool_use", id: "c1", name: "Read", input: { file_path: "/a.ts" } });
    const content = answered!.parts[0]!["content"];
    expect(isLazy(content)).toBe(true);
    expect(answered!.parts[0]!["is_error"]).toBe(false);
    expect((content as { [LAZY_KEY]: { size: number; preview: string } })[LAZY_KEY]).toMatchObject({ size: 50_000, preview: big("file ").slice(0, 160) });
  });

  it("is whole under a threshold no value reaches", () => {
    const lazy = new LazyValues(() => db);
    expect(lazyHashes(lazy.session(view(), 1_000_000)).size).toBe(0);
  });

  it("gets its strings back by hash, and filled in is what it was", () => {
    const lazy = new LazyValues(() => db);
    const out = lazy.session(view(), 4096);
    const known = new Map([...lazyHashes(out)].map((hash) => [hash, lazy.value(hash)]));
    expect(withLazyFilled(out.turns as never, known)).toEqual(view().turns);
  });

  it("answers a hash this process never made from the blob a record stored", () => {
    const text = big("stored ");
    dehydrate(db, { text } as never);
    const hash = createHash("sha256").update(text, "utf8").digest("hex");
    expect(new LazyValues(() => db).value(hash)).toBe(text);
  });

  it("refuses a hash it has nothing for", () => {
    expect(() => new LazyValues(() => db).value("0".repeat(64))).toThrow(/read the view again/);
  });
});
