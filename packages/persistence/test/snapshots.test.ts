import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadBundle, snapshotHash } from "@ai-exec/hw";
import { ensureSnapshot, loadSnapshot, readWorkflowFiles } from "../src/snapshots";

const STATES: Record<string, unknown> = {
  wf: {
    label: "Root",
    inputs: { x: { type: "string" } },
    outputs: { y: { type: "string", from: "children.step.outputs.y" } },
    children: { step: { state: "wf/step", inputs: { x: "inputs.x" } } },
    sequence: ["step"],
  },
  "wf/step": {
    label: "Step",
    inputs: { x: { type: "string" } },
    outputs: { y: { type: "string" } },
    agent: { provider: "p", prompt: { template: "do {{inputs.x}}" } },
  },
};

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jaira-snap-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("snapshots", () => {
  it("writes a content-addressed snapshot and loads it back to the same hash", () => {
    const bundle = loadBundle(STATES, "wf");
    const snap = ensureSnapshot(dir, bundle);
    expect(snap.created).toBe(true);
    expect(snap.hash).toBe(snapshotHash(bundle));
    expect(existsSync(join(dir, snap.hash, "wf.json"))).toBe(true);
    expect(existsSync(join(dir, snap.hash, "wf", "step.json"))).toBe(true);

    const reloaded = loadSnapshot(dir, snap.hash);
    expect(snapshotHash(reloaded)).toBe(snap.hash);
    expect(reloaded.rootId).toBe("wf");
    expect(Object.keys(reloaded.states).sort()).toEqual(["wf", "wf/step"]);
  });

  it("deduplicates identical workflow versions across tasks", () => {
    const bundle = loadBundle(STATES, "wf");
    expect(ensureSnapshot(dir, bundle).created).toBe(true);
    expect(ensureSnapshot(dir, bundle).created).toBe(false);
  });

  it("an authored matching id does not change the hash and is stripped on write", () => {
    const withId = { ...STATES, wf: { ...(STATES["wf"] as object), id: "wf" } };
    const bundle = loadBundle(withId, "wf");
    const snap = ensureSnapshot(dir, bundle);
    expect(snap.hash).toBe(snapshotHash(loadBundle(STATES, "wf")));
    const written = JSON.parse(readFileSync(join(dir, snap.hash, "wf.json"), "utf8")) as Record<string, unknown>;
    expect(written["id"]).toBeUndefined();
  });

  it("detects a corrupted snapshot on load", () => {
    const bundle = loadBundle(STATES, "wf");
    const snap = ensureSnapshot(dir, bundle);
    const stepFile = join(dir, snap.hash, "wf", "step.json");
    const step = JSON.parse(readFileSync(stepFile, "utf8")) as Record<string, unknown>;
    step["label"] = "Tampered";
    writeFileSync(stepFile, JSON.stringify(step));
    expect(() => loadSnapshot(dir, snap.hash)).toThrow(/corrupt/);
    expect(() => loadSnapshot(dir, "nope")).toThrow(/not found/);
  });

  it("readWorkflowFiles walks nested state files and skips dotfiles", () => {
    const bundle = loadBundle(STATES, "wf");
    const snap = ensureSnapshot(dir, bundle); // snapshot layout = workflows layout + .meta.json
    const files = readWorkflowFiles(snap.dir);
    const ids = Object.keys(files).map((f) => f.replace(/\\/g, "/"));
    expect(ids.sort()).toEqual(["wf.json", "wf/step.json"]);
    expect(readWorkflowFiles(join(dir, "does-not-exist"))).toEqual({});
  });
});
