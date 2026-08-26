/**
 * What the CLI prints when a library declines.
 *
 * `@declarative-ai/log`'s default sink writes every record to stderr, which is right for a library
 * with no application around it and wrong inside one that already reports its own failures. When
 * `@jaira/persistence` and `@jaira/runtime` gained a voice, every refusal they made started arriving
 * twice — once as `[warn] [jaira.persistence.project] …` and again as the `error: …` this CLI
 * writes — with the first copy exposing internal module scopes to whoever ran the command.
 *
 * So the CLI installs its own sink, and this is the pair of tests that says which one.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli, type CliIo } from "../src/cli";

let dir: string;

beforeEach(() => {
  // Deliberately NOT a project: the first thing any task command does is resolve one, and failing
  // that is the shortest path to a refusal raised inside `@jaira/persistence`.
  dir = mkdtempSync(join(tmpdir(), "jaira-sink-"));
});

afterEach(() => {
  delete process.env["JAIRA_LOG"];
  rmSync(dir, { recursive: true, force: true });
});

async function cli(args: string[]): Promise<{ code: number; err: string }> {
  let err = "";
  const io: CliIo = { cwd: dir, stdout: () => {}, stderr: (t) => (err += t) };
  const code = await runCli(args, io);
  return { code, err };
}

describe("a library's refusal, as the CLI reports it", () => {
  it("says it ONCE, in the CLI's own words", async () => {
    const { code, err } = await cli(["task", "cancel", "t-nope"]);
    expect(code).toBe(1);
    expect(err).toContain("is not a JaiRA project");
    // The message appears exactly once. Two copies is what the default library sink produced, and it
    // is the kind of regression nobody writes a test for until they have seen it.
    expect(err.match(/is not a JaiRA project/g)).toHaveLength(1);
    // …and the module scope stays inside the app. `[warn] [jaira.persistence.project]` is a sentence
    // for whoever is debugging the library, not for whoever typed the command.
    expect(err).not.toContain("[warn]");
    expect(err).not.toContain("jaira.persistence");
  });

  it("hands the library stream back when asked for it", async () => {
    // The point of silencing it by default is that it can be turned on, not that it is gone: with
    // `JAIRA_LOG` set, the records go to stderr with their scopes, which is what debugging one wants.
    process.env["JAIRA_LOG"] = "1";
    const { err } = await cli(["task", "cancel", "t-nope"]);
    expect(err).toContain("[warn]");
    expect(err).toContain("jaira.persistence.project");
    expect(err.match(/is not a JaiRA project/g)).toHaveLength(2);
  });
});
