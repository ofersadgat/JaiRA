import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { InlineFamily, Operation } from "@declarative-ai/exec";
import { SqliteMemoCache, memoNamespace, openDb, type JairaDb } from "@jaira/persistence";
import { buildPromptExecutor } from "../src/wiring";

/** A prompt op whose rendered tail carries `text`, so a fake rule can match it. */
const promptOp = (text: string): Operation<InlineFamily> => ({
  kind: "prompt",
  user: text,
  config: { model: "fake/model" },
  input: {},
  output: { name: "output", kind: "json" },
});

describe("prompt memoization is wired end to end", () => {
  let dir: string;
  let db: JairaDb;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "jaira-promptmemo-"));
    db = openDb(join(dir, "test.db"));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const executor = (cache: SqliteMemoCache, namespace = memoNamespace({ model: "fake/model" })) =>
    buildPromptExecutor({
      fakeRules: [{ promptIncludes: "hello", output: "world" }],
      memo: { cache, namespace },
    });

  it("answers a repeated prompt from the store instead of the provider", async () => {
    const cache = new SqliteMemoCache(db);
    const first = await executor(cache).start(promptOp("hello"), {}).result;
    expect(first.value).toBe("world");
    expect(cache.size()).toBe(1);

    // The second executor CANNOT answer — no rule matches — and it is a separate instance over the
    // same store, standing in for a later run or another process. So a value here can only have come
    // from the cache, which `cache.size()` alone would not have shown: an overwrite looks like a hit.
    const unanswerable = buildPromptExecutor({
      fakeRules: [{ promptIncludes: "nothing matches this", output: "unused" }],
      memo: { cache: new SqliteMemoCache(db), namespace: memoNamespace({ model: "fake/model" }) },
    });
    const second = await unanswerable.start(promptOp("hello"), {}).result;
    expect(second.value).toBe("world");
  });

  it("would fail without the cache — the control for the test above", async () => {
    const unanswerable = buildPromptExecutor({ fakeRules: [{ promptIncludes: "nothing matches this", output: "unused" }] });
    const out = await unanswerable.start(promptOp("hello"), {}).result;
    expect(out.value).not.toBe("world");
  });

  it("does not confuse two different prompts", async () => {
    const cache = new SqliteMemoCache(db);
    const exec = executor(cache);
    await exec.start(promptOp("hello"), {}).result;
    const other = await exec.start(promptOp("hello there"), {}).result;
    expect(other.value).toBe("world");
    expect(cache.size()).toBe(2);
  });

  it("separates answers by NAMESPACE, so a different model does not read this one's cache", async () => {
    const cache = new SqliteMemoCache(db);
    await executor(cache, memoNamespace({ model: "a" })).start(promptOp("hello"), {}).result;
    await executor(cache, memoNamespace({ model: "b" })).start(promptOp("hello"), {}).result;
    // Same operation, two entries: the namespace is what keeps one model's answer out of another's.
    expect(cache.size()).toBe(2);
  });

  it("writes nothing when no memo is configured — the default stays off", async () => {
    const cache = new SqliteMemoCache(db);
    await buildPromptExecutor({ fakeRules: [{ promptIncludes: "hello", output: "world" }] }).start(promptOp("hello"), {})
      .result;
    expect(cache.size()).toBe(0);
  });
});
