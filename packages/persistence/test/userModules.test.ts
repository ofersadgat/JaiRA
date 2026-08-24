/**
 * The approval store and the freeze (SPEC §7.5.5), which are JaiRA's half of calling a `.ts`
 * function. hw owns hashing, the index and the transpile; what is tested here is the POLICY those
 * seams were left open for.
 *
 * The property that matters most is the strong form of the rule — an unknown file is an unapproved
 * file — because the weak one looks identical until the day somebody drops a new module earlier on
 * the search path.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { moduleHash, type WorkflowBundle } from "@declarative-ai/hw";
import { approvalsFor, canonicalModulePath, moduleEntriesOf } from "../src/userModules";

const dirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "jaira-modules-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the approval store", () => {
  it("answers `undefined` for a file it has never seen — unknown IS unapproved", () => {
    const approvals = approvalsFor(join(scratch(), "approvals.local.json"));
    expect(approvals.approved("/anywhere/never-seen.ts")).toBeUndefined();
  });

  it("round-trips an approval through the file, so a second process sees it", () => {
    const file = join(scratch(), "approvals.local.json");
    const target = "/p/functions/confidence.ts";
    approvalsFor(file).approve(target, moduleHash("export const x = 1;"));
    // A FRESH store over the same path: this is the read a later `jaira` invocation does.
    expect(approvalsFor(file).approved(target)).toBe(moduleHash("export const x = 1;"));
  });

  it("keys on the canonical path, so two spellings of one file are one approval", () => {
    const file = join(scratch(), "approvals.local.json");
    const approvals = approvalsFor(file);
    approvals.approve("C:\\p\\functions\\x.ts", "h");
    expect(approvals.approved("C:/p/functions/x.ts")).toBe("h");
  });

  it("forgets a revoked file entirely rather than recording a refusal", () => {
    const file = join(scratch(), "approvals.local.json");
    const approvals = approvalsFor(file);
    approvals.approve("/p/x.ts", "h");
    approvals.revoke("/p/x.ts");
    // Absent, not `false` — there is one representation of "may not run", and it is absence.
    expect(approvals.approved("/p/x.ts")).toBeUndefined();
    expect([...approvals.all().keys()]).toEqual([]);
  });

  it("treats a CORRUPT store as an empty one, never as a permissive one", () => {
    const dir = scratch();
    const file = join(dir, "approvals.local.json");
    writeFileSync(file, "{ this is not json", "utf8");
    // The failure mode of guessing here is running unapproved code, so "cannot tell" must read as
    // "nothing is approved".
    expect(approvalsFor(file).approved("/p/x.ts")).toBeUndefined();
  });

  it("creates its directory on first write", () => {
    const file = join(scratch(), "nested", "deeper", "approvals.local.json");
    expect(() => approvalsFor(file).approve("/p/x.ts", "h")).not.toThrow();
    expect(approvalsFor(file).approved("/p/x.ts")).toBe("h");
  });
});

describe("which modules a bundle reaches", () => {
  const bundleWith = (refs: readonly string[]): WorkflowBundle =>
    ({
      rootId: "root",
      states: {
        root: {
          id: "root",
          outputs: Object.fromEntries(refs.map((ref, i) => [`o${i}`, { binding: { op: { functionRef: ref } } }])),
        },
      },
    }) as unknown as WorkflowBundle;

  it("finds the file behind each `user:` ref and ignores everything else", () => {
    const bundle = bundleWith(["op.and", "user:/p/functions/lib.ts#confidence.score", "run_command"]);
    expect(moduleEntriesOf(bundle)).toEqual(["/p/functions/lib.ts"]);
  });

  it("reports one entry per FILE, however many symbols are called in it", () => {
    const bundle = bundleWith([
      "user:/p/functions/lib.ts#confidence.score",
      "user:/p/functions/lib.ts#confidence.reasons",
      "user:/p/functions/other.ts#thing",
    ]);
    expect(moduleEntriesOf(bundle)).toEqual(["/p/functions/lib.ts", "/p/functions/other.ts"]);
  });

  it("excludes an EMBEDDED body, which has no file to hash and needs none", () => {
    // Its pseudo-path names nothing on disk. The body is part of the document, so it is already
    // inside the snapshot hash — freezing it would be hashing the same bytes twice.
    expect(moduleEntriesOf(bundleWith(["user:<body>/score.abc123.ts#default"]))).toEqual([]);
  });

  it("says nothing about a workflow that calls no module", () => {
    expect(moduleEntriesOf(bundleWith(["op.and", "op.member"]))).toEqual([]);
  });
});

describe("canonicalModulePath", () => {
  it("is absolute and forward-slashed, which is what the hash and the require path agree on", () => {
    const dir = scratch();
    mkdirSync(join(dir, "functions"), { recursive: true });
    const canonical = canonicalModulePath(join(dir, "functions", "x.ts"));
    expect(canonical).not.toContain("\\");
    expect(canonical.endsWith("/functions/x.ts")).toBe(true);
  });
});
