/**
 * The incident this exists for: a kill that reached the child and not the agent.
 *
 * `claude` resolved to a Chocolatey shim, so the process JaiRA spawned was a launcher and the agent
 * was its child. `child.kill()` killed the launcher; the agent kept the inherited pipe, the API
 * connection and the repository for seven minutes after its run was recorded as stopped.
 *
 * So the test is the shape of that, not the shim: a parent that spawns a grandchild, killed from the
 * top, with the grandchild's death as the assertion.
 */
import { describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detachedForTree, killTree, type TreeKillCommand } from "../src/killTree";

/** Is this pid still around? Signal 0 tests for existence without delivering anything, on both platforms. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(predicate: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return predicate();
}

/**
 * A process that spawns one long-lived child, prints its pid, and then waits around itself.
 *
 * On Windows the grandchild is `detached` and `unref`d ON PURPOSE, and the test is worthless without
 * it. Windows runs test processes inside a job object that collects ordinary descendants when the tree
 * above them dies, which masks the very bug this is about — measured here: a non-detached grandchild
 * disappears on a plain `child.kill()`, so the assertion below would pass with no fix at all. A
 * detached one survives, which is what the real agent did.
 *
 * On POSIX it must NOT be detached. There `detached` means a process group of its own, which a group
 * kill does not reach by design; an ordinary grandchild already outlives a plain `child.kill()` there
 * (it is reparented, not collected), so the bug is exposed without it.
 */
const PARENT_SCRIPT = `
  const { spawn } = require("node:child_process");
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: ${process.platform === "win32"} });
  child.unref();
  console.log(child.pid);
  setInterval(() => {}, 1000);
`;

/** Start {@link PARENT_SCRIPT} and wait for it to name its grandchild. */
async function spawnTree(): Promise<{ parent: ChildProcess; grandchild: number }> {
  const parent = spawn(process.execPath, ["-e", PARENT_SCRIPT], {
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
    ...detachedForTree,
  });

  const grandchild = await new Promise<number>((resolve, reject) => {
    let out = "";
    parent.stdout!.setEncoding("utf8");
    parent.stdout!.on("data", (chunk: string) => {
      out += chunk;
      const line = out.split("\n")[0];
      if (line !== undefined && line.trim().length > 0) resolve(Number(line.trim()));
    });
    parent.on("error", reject);
    setTimeout(() => reject(new Error("the parent never reported a grandchild pid")), 10_000);
  });

  expect(Number.isInteger(grandchild)).toBe(true);
  expect(alive(grandchild)).toBe(true);
  return { parent, grandchild };
}

/** Belt and braces: a failed assertion must not leak the very processes this is about. */
function reap(parent: ChildProcess, ...pids: number[]): void {
  for (const pid of pids) if (alive(pid)) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
  if (parent.exitCode === null && parent.signalCode === null) try { parent.kill("SIGKILL"); } catch { /* gone */ }
}

/**
 * A helper that never exits and never errors — what `taskkill` is while the machine's WMI service is
 * wedged. Given a `pidFile` it says who it is first, so a test can ask afterwards whether it was left
 * running.
 */
function neverExits(pidFile?: string): TreeKillCommand {
  const announce = pidFile !== undefined ? `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); ` : "";
  return { command: process.execPath, args: ["-e", `${announce}setInterval(() => {}, 1000)`] };
}

describe("killTree", () => {
  it("kills the grandchild, not just the child", async () => {
    const { parent, grandchild } = await spawnTree();

    try {
      killTree(parent);

      // The parent goes, as it always did.
      expect(await waitUntil(() => parent.exitCode !== null || parent.signalCode !== null, 10_000)).toBe(true);
      // And so does the grandchild, which is the whole point — this is the assertion that used to fail.
      expect(await waitUntil(() => !alive(grandchild), 10_000)).toBe(true);
    } finally {
      reap(parent, grandchild);
    }
  }, 40_000);

  // The machine state this is for cannot be arranged from a test — it is a wedged WMI service — so
  // the helper is replaced by one that behaves as `taskkill` did in it. Windows only: no helper runs
  // anywhere else.
  it.runIf(process.platform === "win32")("still kills the grandchild when taskkill never exits", async () => {
    const { parent, grandchild } = await spawnTree();
    const dir = mkdtempSync(join(tmpdir(), "jaira-killtree-"));
    const pidFile = join(dir, "taskkill.pid");
    const helperPid = (): number | undefined => (existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8")) : undefined);

    try {
      killTree(parent, "SIGTERM", { taskkill: () => neverExits(pidFile), taskkillDeadlineMs: 1_500 });

      // The REAL walk runs here, so this is also the proof that it reaches a detached grandchild
      // without `taskkill` — the same assertion as above, by the other route.
      expect(await waitUntil(() => parent.exitCode !== null || parent.signalCode !== null, 20_000)).toBe(true);
      expect(await waitUntil(() => !alive(grandchild), 10_000)).toBe(true);

      // And the stuck helper was not left behind. One per stop would otherwise pile up for as long as
      // the machine stayed wedged.
      const helper = helperPid();
      expect(helper).toBeDefined();
      expect(await waitUntil(() => !alive(helper!), 5_000)).toBe(true);
    } finally {
      const helper = helperPid();
      reap(parent, grandchild, ...(helper !== undefined ? [helper] : []));
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it.runIf(process.platform === "win32")("kills the direct child when neither helper ever exits", async () => {
    const { parent, grandchild } = await spawnTree();

    try {
      killTree(parent, "SIGTERM", {
        taskkill: () => neverExits(),
        taskkillDeadlineMs: 300,
        treeWalk: () => neverExits(),
        treeWalkDeadlineMs: 300,
      });

      // The floor: with nothing left that can walk a tree, the child JaiRA spawned still dies, which
      // is what lets a timeout or an abort resolve. The grandchild outliving it is the known cost of
      // this rung, and is not asserted either way.
      expect(await waitUntil(() => parent.exitCode !== null || parent.signalCode !== null, 10_000)).toBe(true);
    } finally {
      reap(parent, grandchild);
    }
  }, 40_000);

  it("does not throw when the child never started", () => {
    const missing = spawn("a-program-that-does-not-exist-jaira", [], { stdio: "ignore", windowsHide: true });
    missing.on("error", () => undefined);
    expect(() => killTree(missing)).not.toThrow();
  });
});
