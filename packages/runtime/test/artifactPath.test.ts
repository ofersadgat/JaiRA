/**
 * Artifact destination templates (DESIGN §7.6).
 *
 * The interesting cases are all failure cases: a typo'd variable, a template that
 * escapes its own root, and an agent-supplied `$RELPATH` carrying `../`. Each one
 * would otherwise write a file somewhere nobody named.
 */
import { describe, expect, it } from "vitest";
import {
  DestinationError,
  parseDestination,
  resolveDestination,
  withinWorkspace,
  type DestinationVars,
} from "../src/artifactPath";

const vars: DestinationVars = {
  worktree: "/work/repo",
  project: "/work/project",
  jaira: "/work/project/.jaira",
  artifactDir: "jaira-artifacts",
  taskId: "t-1",
  runId: 4,
  instanceId: 7,
  stateId: "feature/plan/context",
  slot: "plan_doc",
};

/** Resolved path with separators normalized, so assertions read the same on both hosts. */
function resolve(template: string, logical: string, over: Partial<DestinationVars> = {}): string {
  const out = resolveDestination(parseDestination(template), { ...vars, ...over }, logical);
  return (out.path ?? "").replace(/\\/g, "/");
}

describe("schemes", () => {
  it("treats a bare path as file:, and file:// the same way", () => {
    expect(resolve("$WORKTREE/$RELPATH", "docs/plan.md")).toMatch(/\/work\/repo\/docs\/plan\.md$/);
    expect(parseDestination("file://$WORKTREE/$RELPATH").scheme).toBe("file");
    expect(resolve("file://$WORKTREE/$RELPATH", "docs/plan.md")).toMatch(/\/work\/repo\/docs\/plan\.md$/);
    expect(parseDestination("$DEFAULT").scheme).toBe("file");
  });

  it("parses virtual: as the memory backend, with no path", () => {
    const parsed = parseDestination("virtual:");
    expect(parsed.scheme).toBe("virtual");
    expect(resolveDestination(parsed, vars, "docs/plan.md")).toEqual({ scheme: "virtual" });
    expect(() => parseDestination("virtual:/somewhere")).toThrow(/takes no path/);
  });

  it("rejects a scheme it does not implement", () => {
    expect(() => parseDestination("s3://bucket/$RELPATH")).toThrow(/unknown artifact destination scheme/);
  });

  it("does not mistake a Windows drive letter for a scheme", () => {
    // `C:/artifacts/…` is a path, not a `c:` scheme.
    expect(parseDestination("C:/artifacts/$RELPATH").scheme).toBe("file");
  });
});

describe("aliases", () => {
  it("expands the three one-word placements", () => {
    expect(resolve("$DEFAULT", "docs/plan.md")).toMatch(/\/work\/repo\/docs\/plan\.md$/);
    expect(resolve("$CENTRAL", "docs/plan.md")).toMatch(/repo\/jaira-artifacts\/t-1\/docs\/plan\.md$/);
    expect(resolve("$CENTRAL_FLAT", "docs/plan.md")).toMatch(/repo\/jaira-artifacts\/t-1\/7-plan_doc\.md$/);
  });

  it("lets an alias be extended rather than requiring a new mode", () => {
    expect(resolve("$WORKTREE/$ARTIFACT_DIR/$TASK_ID/run-$RUN_ID/$RELPATH", "a/b.md")).toMatch(
      /t-1\/run-4\/a\/b\.md$/,
    );
  });
});

describe("validation", () => {
  it("rejects an unknown variable instead of substituting nothing", () => {
    // The failure this prevents: `$WORKTRE/$RELPATH` silently resolving to a path
    // outside the project.
    expect(() => parseDestination("$WORKTRE/$RELPATH")).toThrow(/unknown variable '\$WORKTRE'/);
    expect(() => parseDestination("$WORKTRE/$RELPATH")).toThrow(DestinationError);
  });

  it("names the known variables in the error, including aliases", () => {
    expect(() => parseDestination("$NOPE")).toThrow(/\$DEFAULT.*\$CENTRAL.*\$WORKTREE/s);
  });

  it("rejects an empty destination", () => {
    expect(() => parseDestination("   ")).toThrow(/empty/);
  });
});

describe("containment", () => {
  it("refuses an agent-supplied path that escapes the root", () => {
    // `$RELPATH` comes from a model, so this is reachable from generated content.
    expect(() => resolve("$CENTRAL", "../../etc/passwd")).toThrow(/outside the destination root/);
    expect(() => resolve("$DEFAULT", "../outside.md")).toThrow(/outside the destination root/);
  });

  it("refuses rather than clamping, so nothing is written somewhere unnamed", () => {
    expect(() => resolve("$DEFAULT", "a/../../b.md")).toThrow(DestinationError);
    // …while an interior `..` that stays inside is fine.
    expect(resolve("$DEFAULT", "a/../b.md")).toMatch(/\/work\/repo\/b\.md$/);
  });

  it("confines to the AUTHOR-FIXED prefix, not merely to the worktree", () => {
    // Regression. Anchoring on `$WORKTREE` let `$CENTRAL` + `../../src/index.ts`
    // climb out of the artifact directory and overwrite source while still being
    // "inside the worktree" — technically true, entirely wrong.
    expect(() => resolve("$CENTRAL", "../../src/index.ts")).toThrow(/outside the destination root/);
    try {
      resolve("$CENTRAL", "../../src/index.ts");
    } catch (e) {
      // The root reported is the task's artifact directory, not the repo.
      expect((e as Error).message.replace(/\\/g, "/")).toMatch(/root '.*jaira-artifacts\/t-1'/);
    }
  });

  it("takes the root to the last directory boundary, so a derived filename still works", () => {
    // `$CENTRAL_FLAT` ends `$INSTANCE_ID-$SLOT.$EXT`; cutting the prefix at `$EXT`
    // rather than at the preceding `/` would produce the non-directory root
    // `…/7-plan_doc.` and reject every path.
    expect(resolve("$CENTRAL_FLAT", "docs/plan.md")).toMatch(/jaira-artifacts\/t-1\/7-plan_doc\.md$/);
  });

  it("refuses a CONFIG value that climbs out of the anchor", () => {
    // Regression. The fixed prefix becomes the containment root, so nothing was
    // checking it: `"dir": "../../escape"` placed the entire artifact tree outside
    // the project. Author-supplied, but a typo with filesystem-wide reach.
    expect(() => resolve("$CENTRAL", "plan.md", { artifactDir: "../../escape" })).toThrow(
      /resolves its root to .*outside/,
    );
    expect(() => resolve("$WORKTREE/../../out/$RELPATH", "plan.md")).toThrow(/resolves its root to .*outside/);
  });

  it("allows an explicitly absolute destination — that is a choice, not a typo", () => {
    // `..` climbing out of an anchor is almost always a mistake; writing an
    // absolute path is unambiguous intent, so it is not second-guessed.
    expect(resolve("/var/artifacts/$TASK_ID/$RELPATH", "plan.md")).toMatch(/var\/artifacts\/t-1\/plan\.md$/);
  });

  it("confines to the anchor the template actually names", () => {
    expect(resolve("$JAIRA/artifacts/$TASK_ID/$RELPATH", "plan.md")).toMatch(/\.jaira\/artifacts\/t-1\/plan\.md$/);
    // Escaping $JAIRA is refused even though the result would still be in the project.
    expect(() => resolve("$JAIRA/artifacts/$RELPATH", "../../../elsewhere.md")).toThrow(/outside/);
  });
});

describe("substitution", () => {
  it("keeps $RELPATH's directories but flattens ids into one segment", () => {
    // A state id contains slashes; as a path segment it must not silently create
    // directories the template never asked for.
    expect(resolve("$WORKTREE/$STATE_ID/$RELPATH", "a/b.md")).toMatch(/repo\/feature-plan-context\/a\/b\.md$/);
  });

  it("resolves in whatever path view it is handed (the WSL case)", () => {
    // Substitution happens here, not at parse time, because $WORKTREE is not one
    // string: the distro sees /mnt/c/… where the host sees C:\….
    const distro = resolve("$CENTRAL", "plan.md", { worktree: "/mnt/c/work/repo" });
    expect(distro).toMatch(/repo\/jaira-artifacts\/t-1\/plan\.md$/);
    expect(distro.startsWith("/mnt/c")).toBe(true);
  });

  it("derives $BASENAME and $EXT from the logical path", () => {
    expect(resolve("$WORKTREE/$BASENAME.$EXT", "docs/plan.md")).toMatch(/\/work\/repo\/plan\.md$/);
    // No extension: `$EXT` is empty rather than undefined.
    expect(resolve("$WORKTREE/out/$BASENAME", "README")).toMatch(/out\/README$/);
  });
});

describe("withinWorkspace", () => {
  it("maps a workspace-relative path and refuses an escape", () => {
    expect(withinWorkspace("/work/repo", "src/a.ts")?.replace(/\\/g, "/")).toMatch(/repo\/src\/a\.ts$/);
    expect(withinWorkspace("/work/repo", "../secrets")).toBeUndefined();
  });
});
