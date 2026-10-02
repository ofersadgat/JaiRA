/**
 * The log cleaner and the zip reader behind `download_pipeline_artifact` (decision 0016), on the
 * formats as MEASURED: GitLab's per-line prefix with `+` continuations, GitHub's byte-order mark and
 * timestamps, both machine blocks — and a zip GitHub served.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cleanGithubLog, cleanGitlabLog, machineFromLog } from "../src/ciLog";
import { isZip, readZip, safeEntryName, ZipError } from "../src/zip";

const ESC = String.fromCharCode(27);
const BOM = String.fromCharCode(0xfeff);

describe("cleanGitlabLog", () => {
  it("takes the prefix off, joins a continuation to its line, and drops sections and colour", () => {
    const raw = [
      `2026-09-25T07:33:00.992977Z 00O ${ESC}[0KRunning with gitlab-runner 19.5.0 (a8432a3e)${ESC}[0;m`,
      `2026-09-25T07:33:00.993294Z 00O section_start:1790321580:prepare_executor\r${ESC}[0K`,
      `2026-09-25T07:33:00.993302Z 00O+${ESC}[0K${ESC}[36;1mPreparing the "docker+machine" executor${ESC}[0;m${ESC}[0;m`,
      `2026-09-25T07:33:40.587399Z 01E progress 10%\rprogress 100%`,
      `2026-09-25T07:33:40.587399Z 00O section_end:1790321620:step_script\r${ESC}[0K`,
      `2026-09-25T07:33:41.122066Z 00O ${ESC}[31;1mERROR: Job failed: exit code 1${ESC}[0;m`,
      "",
    ].join("\n");
    expect(cleanGitlabLog(raw).split("\n")).toEqual([
      "Running with gitlab-runner 19.5.0 (a8432a3e)",
      'Preparing the "docker+machine" executor',
      "progress 100%",
      // The line that held only a section's end is not a line on GitLab's page, so not here either.
      "ERROR: Job failed: exit code 1",
    ]);
  });

  it("leaves a line with no prefix as it is — a runner too old to write one", () => {
    expect(cleanGitlabLog("plain line\nanother")).toBe("plain line\nanother");
  });
});

describe("cleanGithubLog", () => {
  it("drops the byte-order mark and every timestamp, and splits by step", () => {
    const raw =
      BOM +
      [
        "2026-09-28T18:50:59.2902508Z Current runner version: '2.337.0'",
        "2026-09-28T18:51:04.7989766Z Complete job name: activation",
        "2026-09-28T18:51:05.0064519Z ##[group]Run actions/checkout@v4",
        "2026-09-28T18:51:05.1000000Z Syncing repository",
        "2026-09-28T18:51:05.1500000Z ##[endgroup]",
        "2026-09-28T18:51:05.2000000Z ##[group]Run npm test",
        "2026-09-28T18:51:09.0000000Z ##[error]Process completed with exit code 1.",
        "",
      ].join("\n");
    const clean = cleanGithubLog(raw, [
      { number: 1, name: "Set up job", startedAt: "2026-09-28T18:50:59Z", finishedAt: "2026-09-28T18:51:05Z" },
      { number: 2, name: "Check out", startedAt: "2026-09-28T18:51:05Z", finishedAt: "2026-09-28T18:51:05Z" },
      { number: 3, name: "Lint", startedAt: "2026-09-28T18:51:05Z", finishedAt: "2026-09-28T18:51:05Z", skipped: true },
      { number: 4, name: "Test", startedAt: "2026-09-28T18:51:05Z", finishedAt: "2026-09-28T18:51:09Z" },
    ]);
    expect(clean.text.startsWith("Current runner version")).toBe(true);
    // Steps 2 and 4 start in the same second: the `Run` lines tell them apart; a skipped step wrote nothing.
    expect(clean.steps.map((step) => [step.number, step.text.split("\n")[0]])).toEqual([
      [1, "Current runner version: '2.337.0'"],
      [2, "##[group]Run actions/checkout@v4"],
      [4, "##[group]Run npm test"],
    ]);
    expect(clean.steps[2]!.text).toContain("##[error]Process completed with exit code 1.");
    // GitHub's page does not number an `##[endgroup]`, so a step's line L is `#step:<n>:<L>` only without them.
    expect(clean.steps[1]!.text).toBe("##[group]Run actions/checkout@v4\nSyncing repository");
  });

  it("is one text and no steps when it is given none", () => {
    expect(cleanGithubLog("2026-09-28T18:50:59.2902508Z hello\n")).toEqual({ text: "hello", steps: [] });
  });
});

describe("machineFromLog", () => {
  it("reads GitHub's VM Image group", () => {
    const log = ["Current runner version: '2.337.0'", "##[group]VM Image", "- OS: Linux (x64)", "- Source: Docker", "- Name: ubuntu:24.04", "- Version: 20260922.6.5", "##[endgroup]"].join("\n");
    expect(machineFromLog(log)).toEqual({ runnerVersion: "2.337.0", os: "Linux (x64)", image: "ubuntu:24.04", imageVersion: "20260922.6.5" });
  });

  it("reads an older runner's Operating System and Runner Image groups", () => {
    const log = ["##[group]Operating System", "Ubuntu", "22.04.4", "LTS", "##[endgroup]", "##[group]Runner Image", "Image: ubuntu-22.04", "Version: 20240422.1.0", "##[endgroup]"].join("\n");
    expect(machineFromLog(log)).toEqual({ os: "Ubuntu 22.04.4 LTS", image: "ubuntu-22.04", imageVersion: "20240422.1.0" });
  });

  it("reads GitLab's runner and executor lines", () => {
    const log = ["Running with gitlab-runner 19.5.0 (a8432a3e)", 'Preparing the "docker+machine" executor', "Using Docker executor with image ghcr.io/canonical/snapcraft:8_core24 ..."].join("\n");
    expect(machineFromLog(log)).toEqual({ runnerVersion: "19.5.0", executor: "docker+machine", image: "ghcr.io/canonical/snapcraft:8_core24" });
  });
});

describe("readZip", () => {
  const recorded = (): Uint8Array => {
    const fixture = JSON.parse(readFileSync(new URL("./fixtures/forge/github.ci.json", import.meta.url), "utf8")) as { fixtures: Array<{ match: { path: string }; response: { bodyBase64?: string } }> };
    const zip = fixture.fixtures.find((f) => f.match.path.endsWith("/artifacts/10991111218/zip"))!;
    return new Uint8Array(Buffer.from(zip.response.bodyBase64!, "base64"));
  };

  it("unpacks the zip GitHub served", () => {
    const bytes = recorded();
    expect(isZip(bytes)).toBe(true);
    const entries = readZip(bytes);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) expect(safeEntryName(entry.name)).toBe(entry.name);
  });

  it("refuses what is not a zip, and one that unpacks past its limit", () => {
    expect(() => readZip(new TextEncoder().encode("not a zip at all, not even close to one"))).toThrow(ZipError);
    expect(() => readZip(recorded(), { maxBytes: 1 })).toThrow(/unpacks to more than/);
  });

  it("will not write outside the folder: no climbing, no absolute paths, no drive letters", () => {
    expect(safeEntryName("logs/job.log")).toBe("logs/job.log");
    expect(safeEntryName("./a/./b")).toBe("a/b");
    expect(safeEntryName("../escape")).toBeUndefined();
    expect(safeEntryName("a/../../escape")).toBeUndefined();
    expect(safeEntryName("/etc/passwd")).toBeUndefined();
    expect(safeEntryName("C:/Windows/x")).toBeUndefined();
    expect(safeEntryName("\\\\server\\share")).toBeUndefined();
  });
});
