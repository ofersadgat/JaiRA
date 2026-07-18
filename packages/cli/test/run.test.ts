/**
 * Phase-1 milestone (DESIGN §14.1): the SPEC §9 planning workflow runs
 * headless from a `jaira` CLI command via @ai-exec/hw, with a scripted
 * InteractionPort and a fake executor.
 */
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli, type CliIo } from "../src/cli";
import { blockedRules, happyRules, makePlanningProject } from "./fixtures";

let dir: string;

beforeEach(() => {
  dir = makePlanningProject();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function io(): CliIo & { out: () => string; err: () => string } {
  let out = "";
  let err = "";
  return {
    cwd: dir,
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
    out: () => out,
    err: () => err,
  };
}

describe("jaira run (headless planning workflow)", () => {
  it("runs the SPEC §9 planning workflow end-to-end with a fake executor (subprocess)", () => {
    writeFileSync(join(dir, "fake.json"), JSON.stringify(happyRules()), "utf8");
    const bin = fileURLToPath(new URL("../bin/jaira.js", import.meta.url));
    const stdout = execFileSync(
      process.execPath,
      [bin, "run", "--root", "feature/plan", "--inputs", '{"issue":"the issue"}', "--fake", "@fake.json"],
      { cwd: dir, encoding: "utf8" },
    );
    const report = JSON.parse(stdout) as Record<string, unknown>;
    expect(report["status"]).toBe("completed");
    expect((report["outputs"] as Record<string, unknown>)["outcome"]).toBe("complete");
    const artifacts = report["artifacts"] as Array<Record<string, unknown>>;
    expect(artifacts.some((a) => a["content"] === "# The Plan")).toBe(true);
  }, 60_000);

  it("routes a blocked critique through the scripted InteractionPort", async () => {
    const cli = io();
    const code = await runCli(
      [
        "run",
        "--root",
        "feature/plan",
        "--inputs",
        '{"issue":"the issue"}',
        "--fake",
        JSON.stringify(blockedRules()),
        "--interactions",
        '{"feature/plan/critique/human_review":[{"decision":"block"}]}',
      ],
      cli,
    );
    expect(cli.err()).toBe("");
    expect(code).toBe(0);
    const report = JSON.parse(cli.out()) as Record<string, unknown>;
    const outputs = report["outputs"] as Record<string, unknown>;
    expect(outputs["outcome"]).toBe("blocked");
    expect((outputs["critique"] as Record<string, unknown>)["human_decision"]).toBe("block");
  });

  it("fails when a ui state is reached with no interaction script", async () => {
    const cli = io();
    const code = await runCli(
      ["run", "--root", "feature/plan", "--inputs", '{"issue":"i"}', "--fake", JSON.stringify(blockedRules())],
      cli,
    );
    expect(code).toBe(1);
    const report = JSON.parse(cli.out()) as Record<string, unknown>;
    expect(report["status"]).toBe("failed");
    expect(JSON.stringify(report["failure"])).toMatch(/InteractionPort/);
  });

  it("rejects an invalid workflow before executing anything", async () => {
    writeFileSync(
      join(dir, ".jaira", "workflows", "feature", "plan.json"),
      JSON.stringify({ label: "Broken", transitions: [{ to: "nowhere" }] }),
      "utf8",
    );
    const cli = io();
    const code = await runCli(["run", "--root", "feature/plan", "--fake", "[]"], cli);
    expect(code).toBe(1);
    expect(cli.err()).toMatch(/validation failed/);
    expect(cli.err()).toMatch(/nowhere/);
  });

  it("reports usage errors distinctly", async () => {
    const cli = io();
    expect(await runCli(["run"], cli)).toBe(2);
    expect(cli.err()).toMatch(/--root/);
    expect(await runCli(["bogus"], io())).toBe(2);
  });
});
