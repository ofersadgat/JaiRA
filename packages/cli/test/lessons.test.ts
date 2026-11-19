/**
 * `jaira lessons` — what a project has learned from corrections (decision 0029, "Revisit when"), read
 * from its lesson files: in words by default, the whole report with `--json`.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testHome } from "@jaira/testing";
import { formatLesson } from "@jaira/persistence";
import type { LearningMeasures } from "@jaira/shared";
import { runCli, type CliIo } from "../src/cli";
import { makePlanningProject } from "./fixtures";

let dir: string;

beforeEach(() => {
  dir = makePlanningProject();
  mkdirSync(join(dir, ".jaira", "lessons"), { recursive: true });
  writeFileSync(
    join(dir, ".jaira", "lessons", "never-push-to-main.md"),
    formatLesson(
      {
        rule: "Never push to main",
        lever: "permission",
        target: "ask-first",
        status: "applied",
        changes: [{ file: "permission-sets/ask-first.json", hash: "h", date: "2026-11-18" }],
        occurrences: [{ date: "2026-11-18", outcome: "applied" }, { date: "2026-11-19", outcome: "declined", inEffect: true }],
      },
      "Asked twice.",
    ),
    "utf8",
  );
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function cli(args: string[]): Promise<{ code: number; out: string }> {
  let out = "";
  const io: CliIo = { cwd: dir, stdout: (t) => (out += t), stderr: () => undefined };
  const code = await runCli(["--home", testHome(), ...args], io);
  return { code, out };
}

describe("jaira lessons", () => {
  it("says what each lesson did, and the totals", async () => {
    const { code, out } = await cli(["lessons"]);
    expect(code).toBe(0);
    expect(out).toContain("Never push to main  [permission → ask-first, project]  1 applied, 1 turned down, came back 1× after a fix (1× with it in effect)");
    expect(out).toContain("Proposals: 1 applied, 1 turned down.");
  });

  it("gives the whole report with --json", async () => {
    const { code, out } = await cli(["lessons", "--json"]);
    expect(code).toBe(0);
    const report = JSON.parse(out) as LearningMeasures;
    expect(report.lessons).toEqual([expect.objectContaining({ rule: "Never push to main", recurred: 1, recurredInEffect: 1 })]);
    expect(report.handoffs).toEqual({ offered: 0, adopted: 0, withinPass: 0, neverAdopted: 0, declines: 0 });
  });
});
