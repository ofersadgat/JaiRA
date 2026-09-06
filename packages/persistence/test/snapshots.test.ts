import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadBundle, snapshotHash } from "@declarative-ai/hw";
import { ensureSnapshot, loadSnapshot, readWorkflowFiles } from "../src/snapshots";

/** Post-ops-redesign format: slots carry JSON Schemas, wiring is binding sugar,
 *  and a state's work is one `operation`. */
const STATES: Record<string, unknown> = {
  wf: {
    label: "Root",
    inputs: { x: { schema: { type: "string" } } },
    outputs: { y: { schema: { type: "string" }, binding: ".children.step.output.y" } },
    children: { step: { state: "wf/step", inputs: { x: ".inputs.x" } } },
    sequence: ["step"],
  },
  "wf/step": {
    label: "Step",
    inputs: { x: { schema: { type: "string" } } },
    outputs: { y: { schema: { type: "string" } } },
    operation: { kind: "prompt", prompt: "do {{.inputs.x}}", model: "p" },
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
  it("writes a content-addressed snapshot and loads it back to the same hash", async () => {
    const bundle = loadBundle(STATES, "wf");
    const snap = await ensureSnapshot(dir, bundle);
    expect(snap.created).toBe(true);
    expect(snap.hash).toBe(snapshotHash(bundle));
    expect(existsSync(join(dir, snap.hash, "wf.json"))).toBe(true);
    expect(existsSync(join(dir, snap.hash, "wf", "step.json"))).toBe(true);

    const reloaded = loadSnapshot(dir, snap.hash);
    expect(snapshotHash(reloaded)).toBe(snap.hash);
    expect(reloaded.rootId).toBe("wf");
    expect(Object.keys(reloaded.states).sort()).toEqual(["wf", "wf/step"]);
  });

  it("deduplicates identical workflow versions across tasks", async () => {
    const bundle = loadBundle(STATES, "wf");
    expect((await ensureSnapshot(dir, bundle)).created).toBe(true);
    expect((await ensureSnapshot(dir, bundle)).created).toBe(false);
  });

  it("an authored matching id does not change the hash and is stripped on write", async () => {
    const withId = { ...STATES, wf: { ...(STATES["wf"] as object), id: "wf" } };
    const bundle = loadBundle(withId, "wf");
    const snap = await ensureSnapshot(dir, bundle);
    expect(snap.hash).toBe(snapshotHash(loadBundle(STATES, "wf")));
    const written = JSON.parse(readFileSync(join(dir, snap.hash, "wf.json"), "utf8")) as Record<string, unknown>;
    expect(written["id"]).toBeUndefined();
  });

  it("detects a corrupted snapshot on load", async () => {
    const bundle = loadBundle(STATES, "wf");
    const snap = await ensureSnapshot(dir, bundle);
    const stepFile = join(dir, snap.hash, "wf", "step.json");
    const step = JSON.parse(readFileSync(stepFile, "utf8")) as Record<string, unknown>;
    step["label"] = "Tampered";
    writeFileSync(stepFile, JSON.stringify(step));
    expect(() => loadSnapshot(dir, snap.hash)).toThrow(/corrupt/);
    expect(() => loadSnapshot(dir, "nope")).toThrow(/not found/);
  });

  it("readWorkflowFiles walks nested state files and skips dotfiles", async () => {
    const bundle = loadBundle(STATES, "wf");
    const snap = await ensureSnapshot(dir, bundle); // snapshot layout = workflows layout + .meta.json
    const files = readWorkflowFiles(snap.dir);
    const ids = Object.keys(files).map((f) => f.replace(/\\/g, "/"));
    expect(ids.sort()).toEqual(["wf.json", "wf/step.json"]);
    expect(readWorkflowFiles(join(dir, "does-not-exist"))).toEqual({});
  });
});

/**
 * The Windows rename retry (`commitStaging`), driven through the injected rename.
 *
 * The real failure is a handle a virus scanner holds open inside the staged directory, which no
 * portable test can arrange — so the rename itself is the seam, and these describe the three ways
 * it can end rather than the one way it can fail.
 */
describe("snapshot commit under a rename that fails", () => {
  const eperm = (): never => {
    const e = new Error("EPERM: operation not permitted, rename") as NodeJS.ErrnoException;
    e.code = "EPERM";
    throw e;
  };
  const staging = (): string[] => readdirSync(dir).filter((f) => f.startsWith(".staging-"));

  it("retries, and the snapshot lands once the handle closes", async () => {
    const bundle = loadBundle(STATES, "wf");
    let attempts = 0;
    const snap = await ensureSnapshot(dir, bundle, {
      rename: (from, to) => {
        if (++attempts < 3) eperm();
        renameSync(from, to);
      },
    });
    expect(attempts).toBe(3);
    expect(snap.created).toBe(true);
    // Not merely renamed somewhere: the pinned definition still reloads to its own hash.
    expect(snapshotHash(loadSnapshot(dir, snap.hash))).toBe(snap.hash);
    expect(staging()).toEqual([]);
  });

  it("stops as soon as a concurrent writer's identical snapshot appears", async () => {
    const bundle = loadBundle(STATES, "wf");
    const expected = snapshotHash(bundle);
    let attempts = 0;
    // The second attempt is where the other process lands: `dir` exists, our rename still fails.
    const snap = await ensureSnapshot(dir, bundle, {
      rename: (_from, to) => {
        if (++attempts === 2) mkdirSync(to, { recursive: true });
        eperm();
      },
    });
    expect(attempts).toBe(2);
    expect(snap.hash).toBe(expected);
    // Ours is discarded rather than left for the next start to trip over.
    expect(staging()).toEqual([]);
  });

  it("gives up with the rename's own error, not a cleanup failure", async () => {
    const bundle = loadBundle(STATES, "wf");
    let attempts = 0;
    await expect(
      ensureSnapshot(dir, bundle, {
        rename: () => {
          attempts++;
          eperm();
        },
      }),
    ).rejects.toThrow(/EPERM/);
    expect(attempts).toBe(5); // one try plus the four backoffs
    expect(staging()).toEqual([]);
    expect(existsSync(join(dir, snapshotHash(bundle)))).toBe(false);
  });
});
