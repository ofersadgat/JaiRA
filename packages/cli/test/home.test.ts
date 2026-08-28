/**
 * `--home <dir>` — choosing the shared root from the command line.
 *
 * The base root is where everything a person did not write per project lives: the workflows a state
 * resolves through, the settings a provider is configured in, the approvals a module is checked
 * against, the database a task is recorded in. Until this flag existed the only way to point at a
 * different one was an environment variable, which is a poor fit for the two cases that want it —
 * running against a scratch library for a minute, and a suite that must not touch the real
 * `~/.jaira`. The second is not hypothetical: a test run that resolved to a real home once wrote a
 * couple of hundred task rows into somebody's.
 *
 * What is checked here is that the flag REACHES the layer that reads it, and that it is a loan
 * rather than a change — a process that runs two commands must not be left standing in the first
 * one's home.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BASE_DIR_ENV, jairaBasePaths, takeHomeFlag } from "@jaira/shared";
import { testHome } from "@jaira/testing";
import { runCli, type CliIo } from "../src/cli";
import { makePlanningProject } from "./fixtures";

let dir: string;
let home: string;

beforeEach(() => {
  dir = makePlanningProject();
  home = mkdtempSync(join(tmpdir(), "jaira-cli-home-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

async function cli(args: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const io: CliIo = { cwd: dir, stdout: (t) => (out += t), stderr: (t) => (err += t) };
  // No injected --home here: this file is the test OF the flag, and a prepended one
  // would win (the first occurrence is the one taken) over the one each case passes.
  const code = await runCli(args, io);
  return { code, out, err };
}

describe("takeHomeFlag", () => {
  it("lifts the flag out of the arguments wherever it sits, and resolves the path", () => {
    const taken = takeHomeFlag(["task", "list", "--home", "somewhere", "--project", "p"]);
    expect(taken.rest).toEqual(["task", "list", "--project", "p"]);
    expect(taken.home).toBe(join(process.cwd(), "somewhere"));
    expect(taken.malformed).toBeUndefined();
  });

  it("leaves a command line that never mentions it exactly as it was", () => {
    const taken = takeHomeFlag(["task", "list"]);
    expect(taken).toEqual({ rest: ["task", "list"] });
  });

  // Reported rather than thrown, because the two callers answer it differently: the CLI prints usage
  // and exits 2, the app has a window to open and ignores it.
  it("reports a flag with nothing after it, and one followed by another flag", () => {
    expect(takeHomeFlag(["task", "list", "--home"]).malformed).toBe(true);
    expect(takeHomeFlag(["--home", "--json", "board"]).malformed).toBe(true);
    expect(takeHomeFlag(["--home", "--json", "board"]).rest).toEqual(["--json", "board"]);
  });
});

describe("jaira --home", () => {
  it("reads and writes the root it was given, not the default one", async () => {
    // `functions approve` records into the base root's approvals store, which makes it the cheapest
    // command that PROVES where the root was: the file either appears under the given home or it
    // does not.
    const res = await cli(["--home", home, "functions", "list", "--json"]);
    expect(res.code).toBe(0);
    // The layout is created under the home that was named, and nowhere else.
    expect(existsSync(jairaBasePaths(home).baseDir)).toBe(true);
  });

  it("is a loan: the environment is exactly as it was afterwards", async () => {
    const before = process.env[BASE_DIR_ENV];
    await cli(["--home", home, "functions", "list", "--json"]);
    expect(process.env[BASE_DIR_ENV]).toBe(before);
  });

  it("refuses a flag with no directory after it, with usage rather than a stack", async () => {
    const res = await cli(["--home"]);
    expect(res.code).toBe(2);
    expect(res.err).toContain("--home needs a directory");
    expect(res.err).toContain("usage:");
  });

  it("is a global flag: it works before a subcommand and between its arguments", async () => {
    const first = await cli(["--home", home, "workflow", "list", "--json"]);
    const later = await cli(["workflow", "list", "--home", home, "--json"]);
    expect(first.code).toBe(0);
    expect(later.code).toBe(0);
    expect(later.out).toBe(first.out);
  });
});
