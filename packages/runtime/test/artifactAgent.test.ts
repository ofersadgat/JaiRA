/**
 * The agent's view of the artifact map (DESIGN §7.6).
 *
 * This is the invariant the whole design rests on, exercised the way it actually
 * happens: through the tool surface the engine injects into a delegated agent.
 * Upstream hands each registered tool over as `run: (input) => tool.run(input, ctx)`
 * — so driving `ctx.tools` here is the same path a real agent takes, minus the
 * model.
 */
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExecServices, Tool } from "@declarative-ai/exec";
import { MemoryArtifactStore } from "../src/artifacts";
import { parseDestination } from "../src/artifactPath";
import { registerFileTools, READ_FILE, WRITE_FILE } from "../src/fileTools";
import { newRegistry } from "../src/wiring";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jaira-agentfs-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** The tool set an agent would be handed, for a given destination. */
function agentTools(destination: string): { write: Tool; read: Tool; store: MemoryArtifactStore } {
  const store = new MemoryArtifactStore();
  const registry = newRegistry();
  registerFileTools(registry, {
    destination: parseDestination(destination),
    store,
    vars: {
      worktree: dir,
      project: dir,
      jaira: join(dir, ".jaira"),
      artifactDir: "jaira-artifacts",
      taskId: "t-1",
      instanceId: 3,
      slot: "out",
    },
  });
  return { write: registry.tools.get(WRITE_FILE)!, read: registry.tools.get(READ_FILE)!, store };
}

const ctx = (): ExecServices => ({ workspace: { root: dir } }) as ExecServices;

describe("what the agent can tell", () => {
  it("cannot tell that its file moved", async () => {
    const { write, read } = agentTools("$CENTRAL");

    const wrote = (await write.run({ path: "notes/design.md", content: "v1" } as never, ctx())) as Record<string, unknown>;
    // Nothing in the reply hints at the physical location.
    expect(wrote).toEqual({ path: "notes/design.md", bytes: 2 });

    const readBack = (await read.run({ path: "notes/design.md" } as never, ctx())) as Record<string, unknown>;
    expect(readBack).toEqual({ path: "notes/design.md", content: "v1" });

    // …while the bytes are demonstrably somewhere else.
    expect(existsSync(join(dir, "jaira-artifacts", "t-1", "notes", "design.md"))).toBe(true);
    expect(existsSync(join(dir, "notes", "design.md"))).toBe(false);
  });

  it("sees its own overwrite, not the stale copy", async () => {
    const { write, read } = agentTools("$CENTRAL");
    await write.run({ path: "a.md", content: "first" } as never, ctx());
    await write.run({ path: "a.md", content: "second" } as never, ctx());

    expect(await read.run({ path: "a.md" } as never, ctx())).toMatchObject({ content: "second" });
  });

  it("gets the same answers whatever the destination — so a workflow is portable", async () => {
    for (const destination of ["$DEFAULT", "$CENTRAL", "$CENTRAL_FLAT", "virtual:"]) {
      const { write, read } = agentTools(destination);
      await write.run({ path: "out/report.md", content: `body:${destination}` } as never, ctx());
      expect(await read.run({ path: "out/report.md" } as never, ctx()), destination).toMatchObject({
        path: "out/report.md",
        content: `body:${destination}`,
      });
    }
  });

  it("is refused, with a reason, when it reaches outside", async () => {
    const { write } = agentTools("$CENTRAL");
    const denied = (await write.run({ path: "../../escape.md", content: "x" } as never, ctx())) as Record<string, unknown>;
    expect(denied["error"]).toMatch(/outside the destination root/);
    // The refusal is data the agent can act on, not an exception that kills the run.
    expect(denied["path"]).toBeUndefined();
  });
});
