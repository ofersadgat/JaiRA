/**
 * The suite's own base root, `testHome()`.
 *
 * Test infrastructure gets a test because its contract is load-bearing and silent: it is what stops
 * the suite reading and writing the developer's real `~/.jaira`, and the two halves of the contract
 * fail in opposite, invisible ways. If it were fresh per CALL, a test that builds a second service
 * to simulate a restart would hand it an empty home and prove recovery by construction. If it were
 * shared across TESTS, a count asserted against it would be a count of everything the file had done
 * so far — which is how "the syncs this task made" quietly became "every sync in the suite".
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { testHome } from "@jaira/testing";

/** What the previous test was given, so the next one can prove it did not inherit it. */
let previous: string | undefined;
let fromHook: string;

beforeEach(() => {
  fromHook = testHome();
});

describe("testHome", () => {
  it("is one directory per test, and it exists", () => {
    expect(testHome()).toBe(fromHook);
    expect(existsSync(fromHook)).toBe(true);
    previous = fromHook;
  });

  it("is the SAME directory however often one test asks — a restart keeps its home", () => {
    // The property `crashRecovery` depends on: a second service built inside one test is a restart,
    // and it must reopen the base the first one wrote, not an empty one.
    mkdirSync(join(testHome(), "workflows"), { recursive: true });
    expect(existsSync(join(testHome(), "workflows"))).toBe(true);
  });

  it("is a DIFFERENT directory from the last test's, and the last one is gone", () => {
    expect(previous).toBeDefined();
    expect(fromHook).not.toBe(previous);
    // Removed when the test that asked for it finished, so nothing accumulates across a file.
    expect(existsSync(previous!)).toBe(false);
  });
});
