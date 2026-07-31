import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteMemoCache, memoNamespace, openDb } from "../src/index";
import type { JairaDb } from "../src/index";

describe("SqliteMemoCache — a memo that outlives the process", () => {
  let dir: string;
  let db: JairaDb;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "jaira-memo-"));
    db = openDb(join(dir, "test.db"));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips a successful outcome", () => {
    const cache = new SqliteMemoCache(db);
    cache.set("k", { value: { text: "hello" }, metrics: { durationMs: 3 } });
    expect(cache.get("k")).toEqual({ value: { text: "hello" }, metrics: { durationMs: 3 } });
  });

  it("misses on an unknown key", () => {
    expect(new SqliteMemoCache(db).get("absent")).toBeUndefined();
  });

  it("is read by a DIFFERENT cache instance over the same file — the point of durability", () => {
    new SqliteMemoCache(db).set("k", { value: 42, metrics: { durationMs: 1 } });
    // A second process is what this stands in for: the entry outlives whoever wrote it.
    const reopened = openDb(join(dir, "test.db"));
    try {
      expect(new SqliteMemoCache(reopened).get("k")).toEqual({ value: 42, metrics: { durationMs: 1 } });
    } finally {
      reopened.close();
    }
  });

  it("refuses to persist a FAILURE, however it was handed one", () => {
    const cache = new SqliteMemoCache(db);
    cache.set("k", { error: { classification: "permanent", reason: "no" }, metrics: { durationMs: 1 } });
    // Durability raises the stakes: an in-memory mistake evaporates, a persisted failure would be
    // served to every later run until someone cleared the table.
    expect(cache.get("k")).toBeUndefined();
    expect(cache.size()).toBe(0);
  });

  it("treats an unreadable row as a miss rather than a crash", () => {
    db.prepare("INSERT INTO call_memo (key, outcome, created_at) VALUES (?, ?, ?)").run("k", "{not json", Date.now());
    expect(new SqliteMemoCache(db).get("k")).toBeUndefined();
  });

  it("overwrites rather than failing the second write of a key", () => {
    const cache = new SqliteMemoCache(db);
    cache.set("k", { value: 1, metrics: { durationMs: 1 } });
    cache.set("k", { value: 2, metrics: { durationMs: 1 } });
    expect(cache.get("k")).toEqual({ value: 2, metrics: { durationMs: 1 } });
    expect(cache.size()).toBe(1);
  });
});

describe("memoNamespace — what makes one executor's answers different from another's", () => {
  it("separates two different model defaults", () => {
    expect(memoNamespace({ model: "anthropic/a" })).not.toBe(memoNamespace({ model: "anthropic/b" }));
  });

  it("is stable across key ORDER, so an equivalent config shares its cache", () => {
    expect(memoNamespace({ model: "m", effort: "high" })).toBe(memoNamespace({ effort: "high", model: "m" }));
  });
});
