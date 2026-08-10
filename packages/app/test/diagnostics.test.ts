/**
 * Somewhere for a swallowed failure to be seen.
 *
 * The app had no logger, no console output and no channel — several failure paths are swallowed ON
 * PURPOSE (a snapshot that will not load must not blank the board; a throwing observer must not
 * change a command's outcome) and the second half of that bargain was missing.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Diagnostics } from "../src/main/diagnostics";

describe("Diagnostics", () => {
  it("keeps a tail and hands it back oldest first", () => {
    const d = new Diagnostics();
    d.log({ level: "info", source: "app", message: "one" });
    d.log({ level: "warn", source: "app", message: "two" });

    expect(d.list().map((e) => e.message)).toEqual(["one", "two"]);
    expect(d.list().map((e) => e.id)).toEqual([1, 2]);
  });

  it("filters by level as 'this and worse', not 'this exactly'", () => {
    const d = new Diagnostics();
    d.log({ level: "debug", source: "a", message: "d" });
    d.log({ level: "warn", source: "a", message: "w" });
    d.log({ level: "error", source: "a", message: "e" });

    // Nobody wants errors hidden because they asked to see warnings.
    expect(d.list({ level: "warn" }).map((e) => e.message)).toEqual(["w", "e"]);
  });

  it("is a cursor, so a panel that is following along asks only for what is new", () => {
    const d = new Diagnostics();
    d.log({ level: "info", source: "a", message: "first" });
    const seen = d.list().at(-1)!.id;
    d.log({ level: "info", source: "a", message: "second" });

    expect(d.list({ afterId: seen }).map((e) => e.message)).toEqual(["second"]);
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
    expect(d.list().map((e) => e.message)).toEqual(["still recorded"]);
  });

  it("mirrors to NDJSON, which survives a crash and greps without the app", () => {
    const dir = mkdtempSync(join(tmpdir(), "jaira-diag-"));
    try {
      const d = new Diagnostics({ dir, now: () => Date.UTC(2026, 0, 2, 3, 4, 5) });
      d.log({ level: "error", source: "ipc", message: "task:detail: unknown task" });

      const file = readdirSync(dir).find((f) => f.endsWith(".log"))!;
      expect(file).toBe("jaira-2026-01-02.log");
      const line = JSON.parse(readFileSync(join(dir, file), "utf8").trim()) as { message: string; source: string };
      expect(line).toMatchObject({ source: "ipc", message: "task:detail: unknown task" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("says so once when the file cannot be written, rather than failing every entry", () => {
    // A read-only or full disk must not turn every diagnostic into a second failure — but the absence
    // of a file has to be visible somewhere, or a bug report arrives with no log and no explanation.
    const d = new Diagnostics({ dir: "\0not-a-path" });
    d.log({ level: "info", source: "a", message: "one" });
    d.log({ level: "info", source: "a", message: "two" });

    const warnings = d.list().filter((e) => e.message.includes("in memory only"));
    expect(warnings).toHaveLength(1);
  });
});
