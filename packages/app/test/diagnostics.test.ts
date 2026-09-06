/**
 * Somewhere for a swallowed failure to be seen.
 *
 * The app had no logger, no console output and no channel — several failure paths are swallowed ON
 * PURPOSE (a snapshot that will not load must not blank the board; a throwing observer must not
 * change a command's outcome) and the second half of that bargain was missing.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LogEntry, LogPolicy } from "@jaira/shared";
import { Diagnostics } from "../src/main/diagnostics";

/** A directory that lives as long as one test. The mirror is the thing under test in most of these. */
const withDir = (body: (dir: string) => void): void => {
  const dir = mkdtempSync(join(tmpdir(), "jaira-diag-"));
  try {
    body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/** One day's mirror, written the way a previous launch would have left it. */
const write = (dir: string, day: string, entries: Partial<LogEntry>[]): void =>
  writeFileSync(join(dir, `jaira-${day}.log`), entries.map((e) => `${JSON.stringify(e)}\n`).join(""), "utf8");

const said = (d: Diagnostics, query = {}): string[] => d.read(query).entries.map((e) => e.message);

describe("Diagnostics", () => {
  it("reads back NEWEST FIRST, which is the end a log is read from", () => {
    const d = new Diagnostics();
    d.log({ level: "info", source: "app", message: "one" });
    d.log({ level: "warn", source: "app", message: "two" });

    expect(said(d)).toEqual(["two", "one"]);
  });

  it("filters by level as 'this and worse', not 'this exactly'", () => {
    const d = new Diagnostics();
    d.log({ level: "debug", source: "a", message: "d" });
    d.log({ level: "warn", source: "a", message: "w" });
    d.log({ level: "error", source: "a", message: "e" });

    // Nobody wants errors hidden because they asked to see warnings.
    expect(said(d, { level: "warn" })).toEqual(["e", "w"]);
  });

  it("matches a source as a family, not only as a word", () => {
    const d = new Diagnostics();
    d.log({ level: "info", source: "jaira.persistence.views", message: "a view" });
    d.log({ level: "info", source: "jaira.persistence", message: "the layer" });
    d.log({ level: "info", source: "run", message: "a run" });

    // "Show me persistence" means the family. Four scopes typed out is not a filter anybody uses.
    expect(said(d, { source: "jaira.persistence" })).toEqual(["the layer", "a view"]);
    expect(said(d, { source: "run" })).toEqual(["a run"]);
  });

  it("searches the DETAIL as well as the message, which is where a file name lives", () => {
    const d = new Diagnostics();
    d.log({ level: "error", source: "crash", message: "it broke", detail: { stack: "at readFile (fs.ts:12)" } });
    d.log({ level: "error", source: "crash", message: "something else" });

    expect(said(d, { text: "fs.ts" })).toEqual(["it broke"]);
  });

  it("publishes each entry, which is how the renderer hears without polling", () => {
    const got: string[] = [];
    const d = new Diagnostics({ publish: (e) => got.push(e.message) });
    d.log({ level: "info", source: "a", message: "pushed" });
    expect(got).toEqual(["pushed"]);
  });

  it("never throws, because its callers are catch blocks", () => {
    // A reporting channel that can fail is one every caller has to defend against — which is how the
    // silence started. A listener that throws must not take the reporter down with it.
    const d = new Diagnostics({
      publish: () => {
        throw new Error("listener exploded");
      },
    });
    expect(() => d.log({ level: "error", source: "a", message: "still recorded" })).not.toThrow();
    expect(said(d)).toEqual(["still recorded"]);
  });

  it("mirrors to NDJSON, which survives a crash and greps without the app", () => {
    withDir((dir) => {
      const d = new Diagnostics({ dir, now: () => Date.UTC(2026, 0, 2, 3, 4, 5) });
      d.log({ level: "error", source: "ipc", message: "task:detail: unknown task" });

      const file = readdirSync(dir).find((f) => f.endsWith(".log"))!;
      expect(file).toBe("jaira-2026-01-02.log");
      const line = JSON.parse(readFileSync(join(dir, file), "utf8").trim()) as { message: string; source: string };
      expect(line).toMatchObject({ source: "ipc", message: "task:detail: unknown task" });
    });
  });

  it("says so once when the file cannot be written, rather than failing every entry", () => {
    // A read-only or full disk must not turn every diagnostic into a second failure — but the absence
    // of a file has to be visible somewhere, or a bug report arrives with no log and no explanation.
    const d = new Diagnostics({ dir: "\0not-a-path" });
    d.log({ level: "info", source: "a", message: "one" });
    d.log({ level: "info", source: "a", message: "two" });

    expect(said(d).filter((m) => m.includes("in memory only"))).toHaveLength(1);
  });

  describe("reading the mirror", () => {
    it("spans the launches BEFORE this one, oldest day last", () => {
      withDir((dir) => {
        write(dir, "2026-01-01", [{ id: 1, at: 1, level: "info", source: "app", message: "older" }]);
        write(dir, "2026-01-02", [{ id: 1, at: 2, level: "warn", source: "app", message: "newer" }]);

        // The panel used to be served from memory, so the question it answered was only ever "what
        // happened since I started it" — and the question being asked is about the run before.
        expect(said(new Diagnostics({ dir }))).toEqual(["newer", "older"]);
      });
    });

    it("pages backwards through the cursor, and says when there is no more", () => {
      withDir((dir) => {
        write(
          dir,
          "2026-01-01",
          [1, 2, 3, 4, 5].map((n) => ({ id: n, at: n, level: "info" as const, source: "app", message: `m${n}` })),
        );
        const d = new Diagnostics({ dir });

        const first = d.read({ limit: 2 });
        expect(first.entries.map((e) => e.message)).toEqual(["m5", "m4"]);
        expect(first.cursor).toBeDefined();

        const second = d.read({ limit: 2, before: first.cursor! });
        expect(second.entries.map((e) => e.message)).toEqual(["m3", "m2"]);

        const third = d.read({ limit: 2, before: second.cursor! });
        expect(third.entries.map((e) => e.message)).toEqual(["m1"]);
        // No cursor is the reader's ONLY way of saying "that is the beginning of the log".
        expect(third.cursor).toBeUndefined();
      });
    });

    it("pages across a day boundary without repeating or skipping an entry", () => {
      withDir((dir) => {
        write(dir, "2026-01-01", [
          { id: 1, at: 1, level: "info", source: "app", message: "a" },
          { id: 2, at: 2, level: "info", source: "app", message: "b" },
        ]);
        write(dir, "2026-01-02", [{ id: 1, at: 3, level: "info", source: "app", message: "c" }]);
        const d = new Diagnostics({ dir });

        const seen: string[] = [];
        let cursor: string | undefined;
        do {
          const page = d.read({ limit: 1, ...(cursor === undefined ? {} : { before: cursor }) });
          seen.push(...page.entries.map((e) => e.message));
          cursor = page.cursor;
        } while (cursor !== undefined);

        expect(seen).toEqual(["c", "b", "a"]);
      });
    });

    it("walks a file bigger than one chunk without losing an entry at the seam", () => {
      withDir((dir) => {
        // A day's mirror is read backwards in fixed byte steps, and a step lands mid-line by
        // construction — so the fragment at the front of one chunk has to be joined onto the back of
        // the next. Get that wrong and exactly one entry per 128 KB disappears, silently, and only
        // for people whose logs are big enough to have a seam at all.
        const many = Array.from({ length: 4000 }, (_, i) => ({
          id: i,
          at: i + 1,
          level: "info" as const,
          source: "app",
          message: `entry ${i} ${"x".repeat(40)}`,
        }));
        write(dir, "2026-01-01", many);
        const d = new Diagnostics({ dir });

        const seen: string[] = [];
        let cursor: string | undefined;
        do {
          const page = d.read({ limit: 500, ...(cursor === undefined ? {} : { before: cursor }) });
          seen.push(...page.entries.map((e) => e.message));
          cursor = page.cursor;
        } while (cursor !== undefined);

        expect(seen).toHaveLength(many.length);
        expect(seen[0]).toContain("entry 3999");
        expect(seen.at(-1)).toContain("entry 0");
        // No repeats either: a cursor that pointed at the entry it had already returned would page
        // forever, one row at a time.
        expect(new Set(seen).size).toBe(many.length);
      });
    });

    it("filters where the entries ARE, so a search reaches the past", () => {
      withDir((dir) => {
        write(dir, "2026-01-01", [
          { id: 1, at: 1, level: "debug", source: "run", message: "entered plan" },
          { id: 2, at: 2, level: "error", source: "crash", message: "boom" },
          { id: 3, at: 3, level: "debug", source: "run", message: "entered build" },
        ]);
        const d = new Diagnostics({ dir });

        expect(said(d, { level: "error" })).toEqual(["boom"]);
        expect(said(d, { source: "run" })).toEqual(["entered build", "entered plan"]);
        expect(said(d, { text: "plan" })).toEqual(["entered plan"]);
      });
    });

    it("keeps the detail, which is the half worth reading back", () => {
      withDir((dir) => {
        write(dir, "2026-01-01", [
          { id: 1, at: 1, level: "error", source: "crash", message: "boom", detail: { stack: "Error: boom\n  at x" } },
        ]);
        expect(new Diagnostics({ dir }).read().entries[0]!.detail).toEqual({ stack: "Error: boom\n  at x" });
      });
    });

    it("survives the half-written last line a crash leaves behind", () => {
      withDir((dir) => {
        writeFileSync(
          join(dir, "jaira-2026-01-01.log"),
          `${JSON.stringify({ id: 1, at: 1, level: "info", source: "app", message: "whole" })}\n{"id":2,"at":2,"lev`,
          "utf8",
        );
        // A truncated tail is the NORMAL state of the file after the crash you are investigating.
        expect(said(new Diagnostics({ dir }))).toEqual(["whole"]);
      });
    });

    it("reads what THIS launch just wrote, without waiting for a restart", () => {
      withDir((dir) => {
        write(dir, "2026-01-01", [{ id: 1, at: 1, level: "info", source: "app", message: "from before" }]);
        const d = new Diagnostics({ dir });
        d.log({ level: "info", source: "app", message: "just now" });

        // The mirror is written on every entry, so it is the whole record and not a snapshot: one
        // reader, one answer, rather than a live list beside a stale file.
        expect(said(d)).toEqual(["just now", "from before"]);
      });
    });

    it("ignores anything in the directory that is not a day of the mirror", () => {
      withDir((dir) => {
        writeFileSync(join(dir, "notes.txt"), "not ndjson at all", "utf8");
        write(dir, "2026-01-01", [{ id: 1, at: 1, level: "info", source: "app", message: "kept" }]);
        expect(said(new Diagnostics({ dir }))).toEqual(["kept"]);
      });
    });
  });

  describe("what is worth keeping", () => {
    const policy = (over: Partial<LogPolicy> = {}): LogPolicy => ({ minLevel: "info", overrides: [], ...over });

    it("drops below the floor, before anything is written", () => {
      withDir((dir) => {
        const d = new Diagnostics({ dir, policy: policy() });
        d.log({ level: "debug", source: "run", message: "entered plan" });
        d.log({ level: "info", source: "run", message: "started" });

        expect(said(d)).toEqual(["started"]);
        // Not written down, not merely hidden — what it costs to keep is the point of the setting.
        expect(readFileSync(join(dir, readdirSync(dir)[0]!), "utf8")).not.toContain("entered plan");
      });
    });

    it("lets a scope disagree with the floor, in both directions", () => {
      const d = new Diagnostics({
        policy: policy({ minLevel: "warn", overrides: [{ match: "scope", key: "run", minLevel: "debug" }] }),
      });
      d.log({ level: "debug", source: "run", message: "the run's own trace" });
      d.log({ level: "info", source: "project", message: "opened something" });

      expect(said(d)).toEqual(["the run's own trace"]);
    });

    it("gives the longest matching scope the last word", () => {
      const d = new Diagnostics({
        policy: policy({
          minLevel: "error",
          overrides: [
            { match: "scope", key: "jaira", minLevel: "error" },
            { match: "scope", key: "jaira.persistence", minLevel: "debug" },
          ],
        }),
      });
      d.log({ level: "debug", source: "jaira.persistence.views", message: "kept" });
      d.log({ level: "debug", source: "jaira.runtime", message: "dropped" });

      // Without this a broad rule could not be written at all: every narrow one would be shadowed.
      expect(said(d)).toEqual(["kept"]);
    });

    it("lets a tag beat a scope, being the more specific statement", () => {
      const d = new Diagnostics({
        policy: policy({
          minLevel: "error",
          overrides: [
            { match: "scope", key: "llm", minLevel: "error" },
            { match: "tag", key: "cost", minLevel: "debug" },
          ],
        }),
      });
      d.log({ level: "debug", source: "llm.generate", message: "a call", detail: { tag: "cost" } });
      d.log({ level: "debug", source: "llm.generate", message: "everything else" });

      expect(said(d)).toEqual(["a call"]);
    });

    it("NEVER drops an error, whatever the policy says", () => {
      // A policy that can lose an error makes every absence in the file ambiguous, and a log you
      // cannot reason about the absences in is not evidence of anything.
      const d = new Diagnostics({
        policy: policy({
          minLevel: "error",
          overrides: [{ match: "scope", key: "run", minLevel: "error", samplingRate: 0 }],
        }),
        random: () => 0.99,
      });
      d.log({ level: "error", source: "run", message: "a failure" });
      expect(said(d)).toEqual(["a failure"]);
    });

    it("samples a chatty scope, keeping the shape without the flood", () => {
      let roll = 0;
      const d = new Diagnostics({
        policy: policy({
          minLevel: "debug",
          overrides: [{ match: "scope", key: "run", minLevel: "debug", samplingRate: 0.5 }],
        }),
        // Alternating, so the assertion is about the rule and not about a random number.
        random: () => (roll++ % 2 === 0 ? 0.1 : 0.9),
      });
      for (const n of [1, 2, 3, 4]) d.log({ level: "debug", source: "run", message: `m${n}` });

      expect(said(d)).toEqual(["m3", "m1"]);
    });

    it("changes what is kept without a restart, which is the whole point of the control", () => {
      const d = new Diagnostics({ policy: policy({ minLevel: "info" }) });
      d.log({ level: "debug", source: "run", message: "dropped" });
      d.setPolicy({ minLevel: "debug", overrides: [] });
      d.log({ level: "debug", source: "run", message: "kept" });

      expect(said(d)).toEqual(["kept"]);
    });
  });
});
