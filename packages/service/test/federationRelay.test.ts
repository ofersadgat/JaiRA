/**
 * A machine's news passed on to the windows of the machines paired with it, once: what one machine
 * relays of another's is not relayed back. Two engines stand in for each other — what one publishes
 * reaches the other as that machine's push.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PushMessage } from "@jaira/shared";
import { Federation } from "../src/federation";
import type { Fleet } from "../src/fleet";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A machine: its federation, what it published, and the listener its peer's pushes reach. */
function machine(): { federation: Federation; published: PushMessage[]; push: (from: string, message: PushMessage) => void; onPublish: (f: (m: PushMessage) => void) => void } {
  let listener: ((machineId: string, message: unknown) => void) | undefined;
  let forward: ((m: PushMessage) => void) | undefined;
  const fleet = {
    onPeerPush: (l: (machineId: string, message: unknown) => void) => {
      listener = l;
      return () => undefined;
    },
    onPeerState: () => () => undefined,
    client: () => undefined,
  } as unknown as Fleet;
  const published: PushMessage[] = [];
  const baseDir = mkdtempSync(join(tmpdir(), "jaira-fed-"));
  dirs.push(baseDir);
  const federation = new Federation(fleet, {
    baseDir,
    publish: (m) => {
      published.push(m);
      forward?.(m);
    },
  });
  return { federation, published, push: (from, m) => listener?.(from, m), onPublish: (f) => (forward = f) };
}

describe("news relayed between two paired machines", () => {
  it("reaches the other machine once, and is not sent back — news about no project too", async () => {
    const a = machine();
    const b = machine();
    // Whatever either publishes reaches the other, as its peer's push.
    a.onPublish((m) => queueMicrotask(() => b.push("m-a", m)));
    b.onPublish((m) => queueMicrotask(() => a.push("m-b", m)));
    const own: PushMessage = { type: "store:invalidate", scope: "workflows" } as PushMessage;
    // A's own news: published on A, and so offered to B.
    a.published.push(own);
    b.push("m-a", own);
    await new Promise((r) => setTimeout(r, 100));
    expect(b.published).toHaveLength(1);
    expect(b.published[0]).toMatchObject({ type: "store:invalidate", scope: "workflows", relayedFrom: "m-a" });
    // B's relay reached A, which dropped it: A published nothing more than its own.
    expect(a.published).toHaveLength(1);
  });

  it("keys a project's news to the machine it came from, marked as relayed", () => {
    const b = machine();
    b.push("m-a", { type: "store:invalidate", scope: "tasks", project: "/w/atlas" } as PushMessage);
    expect(b.published[0]).toMatchObject({ relayedFrom: "m-a" });
    expect((b.published[0] as { project?: string }).project).not.toBe("/w/atlas");
  });
});
