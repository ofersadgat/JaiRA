/**
 * Persisting engine-registered artifacts (DESIGN §7.6).
 *
 * The case the file tools do not cover: a state that *returns* blob content rather
 * than writing it. Without this a workflow with no agent in it produces no files at
 * all, which is most of what "artifacts are durable work products" is supposed to
 * mean.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryArtifactStore } from "../src/artifacts";
import { parseDestination } from "../src/artifactPath";
import {
  collectEngineArtifacts,
  isEngineArtifact,
  logicalPathFor,
  parseArtifactName,
  persistEngineArtifacts,
} from "../src/artifactSink";

let dir: string;
let store: MemoryArtifactStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jaira-sink-"));
  store = new MemoryArtifactStore();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const artifact = (name: string, content: string, format = "text/markdown") => ({
  artifact: true as const,
  name,
  format,
  content,
});

function persist(outputs: unknown, destination = "$CENTRAL") {
  return persistEngineArtifacts(outputs as never, {
    destination: parseDestination(destination),
    store,
    vars: {
      worktree: dir,
      project: dir,
      jaira: join(dir, ".jaira"),
      artifactDir: "jaira-artifacts",
      taskId: "t-1",
    },
    runId: 2,
    now: () => 5_000,
  });
}

describe("finding artifacts in a result", () => {
  it("recognizes the engine's ref shape", () => {
    expect(isEngineArtifact({ artifact: true, name: "a#1.b" })).toBe(true);
    expect(isEngineArtifact({ name: "a#1.b" })).toBe(false);
    expect(isEngineArtifact("a string")).toBe(false);
  });

  it("finds them however deeply they are nested", () => {
    const outputs = {
      plan: artifact("wf#1.plan", "P"),
      nested: { list: [artifact("wf#2.note", "N"), "not an artifact"] },
    };
    expect(collectEngineArtifacts(outputs as never).map((a) => a.name)).toEqual(["wf#1.plan", "wf#2.note"]);
  });

  it("splits the engine's name into state, instance and slot", () => {
    expect(parseArtifactName("feature.plan.context#3.plan_doc")).toEqual({
      stateId: "feature.plan.context",
      instanceId: 3,
      slot: "plan_doc",
    });
    // A name that does not match is not forced into a shape.
    expect(parseArtifactName("just-a-name")).toEqual({});
  });

  it("derives a logical filename from the slot and the media type", () => {
    expect(logicalPathFor(artifact("s#1.plan_doc", "x", "text/markdown"), "plan_doc")).toBe("plan_doc.md");
    expect(logicalPathFor(artifact("s#1.data", "x", "application/json"), "data")).toBe("data.json");
    // An unknown media type contributes no extension rather than a guessed one.
    expect(logicalPathFor(artifact("s#1.thing", "x", "application/vnd.weird+xyz"), "thing")).toBe("thing");
  });
});

describe("placement", () => {
  it("writes each artifact to the configured destination and records it", () => {
    const written = persist({ plan: artifact("feature.plan#1.plan_doc", "# hello") });

    expect(written).toHaveLength(1);
    const path = join(dir, "jaira-artifacts", "t-1", "plan_doc.md");
    expect(readFileSync(path, "utf8")).toBe("# hello");
    expect(store.get("t-1", "plan_doc.md")).toMatchObject({
      physicalPath: path,
      slot: "plan_doc",
      instanceId: 1,
      runId: 2,
      format: "text/markdown",
      bytes: 7,
    });
  });

  it("uses the instance and slot the name carries, so $CENTRAL_FLAT works", () => {
    persist({ plan: artifact("feature.plan#9.plan_doc", "x") }, "$CENTRAL_FLAT");
    expect(existsSync(join(dir, "jaira-artifacts", "t-1", "9-plan_doc.md"))).toBe(true);
  });

  it("writes nothing under virtual: but still records the content", () => {
    persist({ plan: artifact("wf#1.plan", "x") }, "virtual:");
    const record = store.get("t-1", "plan.md")!;
    expect(record.physicalPath).toBeUndefined();
    expect(record.content).toBe("x");
  });

  it("skips a ref with no inline content — there is nothing to write", () => {
    expect(persist({ plan: { artifact: true, name: "wf#1.plan" } })).toEqual([]);
  });
});

describe("failure handling", () => {
  it("reports an unwritable artifact instead of throwing", () => {
    // The run has already finished by the time this executes; a bad path must not
    // turn a completed run into a failed one.
    const errors: string[] = [];
    const written = persistEngineArtifacts({ plan: artifact("wf#1.plan", "x") } as never, {
      destination: parseDestination("$CENTRAL"),
      store,
      vars: {
        worktree: dir,
        project: dir,
        jaira: join(dir, ".jaira"),
        artifactDir: "../../escape",
        taskId: "t-1",
      },
      onError: (name, error) => errors.push(`${name}: ${error.message}`),
    });

    expect(written).toEqual([]);
    // A config value that climbs out of the worktree is caught before any write.
    expect(errors[0]).toMatch(/resolves its root to .*outside/);
  });
});
