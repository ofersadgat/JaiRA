/**
 * A base root of a test's own.
 *
 * The shared root is where JaiRA keeps everything a person did not write per project — workflows,
 * settings, approvals, the database, task rows. Anything that opens a project reads it, and anything
 * that runs a task WRITES to it, so a suite pointed at the real `~/.jaira` both reads whatever the
 * developer happens to keep there and leaves its own droppings behind. Both have happened.
 *
 * `test/setup.ts` is the floor under that: it redirects `JAIRA_HOME` once per worker, so a test that
 * says nothing still cannot reach a real home. This is the ceiling — a home per test, passed
 * explicitly, so the isolation is a visible argument at the call site rather than a property of the
 * environment the runner happened to set up:
 *
 * ```ts
 * service = new AppService({ watchWorkflows: false, baseDir: testHome() });
 * ```
 *
 * Explicit beats ambient here for a reason beyond tidiness. The worker-wide root is SHARED by every
 * test in the file, so a count asserted against it is a count of everything the file has done so far
 * — which is how "lists the syncs this task made" quietly became "lists every sync in the suite".
 * A home per test is empty at the start of each one, which is the state assertions are written for.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished } from "vitest";

/**
 * This test's base root — the same directory every time it is asked for, gone when the test ends.
 *
 * Callable from a test or from `beforeEach`: `onTestFinished` registers against whichever test is
 * running, so the directory outlives the hook that made it and dies with the test that used it. That
 * is what lets this be a one-line argument rather than a `let` and two hooks at the top of every file
 * that needs one.
 *
 * ## The same directory, not a fresh one, within a test
 *
 * A test that builds a second service is almost always simulating a RESTART — `crashRecovery` reopens
 * a project after a run died — and the whole question it asks is what survived. Handing the second
 * one an empty home would answer that question by construction, so the answer would mean nothing.
 * Per test rather than per call is therefore the only memo that reads correctly at the call site:
 * `baseDir: testHome()` says "this test's home" wherever it appears.
 *
 * Sequential tests are what makes one variable enough to hold it. The suite runs no concurrent tests
 * (`it.concurrent` appears nowhere), and separate files run in separate workers with their own copy
 * of this module — so the only thing that could share this slot is two tests running at once in one
 * worker, which nothing here does.
 *
 * The directory is EMPTY, not a base layout: `initBase` is what writes the layout, and a test that
 * wants a base layer of its own writes into the path this returns. An empty base is the state every
 * test that says nothing about workflows is written against.
 */
let current: string | undefined;

export function testHome(): string {
  if (current !== undefined) return current;
  const dir = mkdtempSync(join(tmpdir(), "jaira-home-"));
  current = dir;
  onTestFinished(() => {
    current = undefined;
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}
