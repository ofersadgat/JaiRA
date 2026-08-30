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
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { testHome } from "@jaira/testing";

/**
 * Every home this file was given, recorded as each test ends.
 *
 * In an `afterEach` rather than inside one test, and asserted in `afterAll` rather than by a later
 * sibling. The two properties are about a SEQUENCE of tests — each gets its own directory, and each
 * is gone once its test is over — so a test that checks them by reading what "the last test" left
 * behind is really asserting the runner's declaration order. That passes here (nothing shuffles) and
 * fails the moment anyone runs `--sequence.shuffle` to debug something else, reporting `expected
 * undefined to be defined` about a property that is perfectly fine.
 *
 * Collected and checked at the end, the same two properties hold whatever order the tests ran in —
 * and they are checked across ALL of them rather than one adjacent pair.
 */
const given: string[] = [];
let fromHook: string;

beforeEach(() => {
  fromHook = testHome();
});

afterEach(() => {
  given.push(fromHook);
});

afterAll(() => {
  // One directory per test…
  expect(new Set(given).size).toBe(given.length);
  // …and none of them outlives the test that asked for it, so nothing accumulates across a file.
  for (const home of given) expect(existsSync(home)).toBe(false);
});

describe("testHome", () => {
  it("is one directory per test, and it exists", () => {
    expect(testHome()).toBe(fromHook);
    expect(existsSync(fromHook)).toBe(true);
  });

  it("is the SAME directory however often one test asks — a restart keeps its home", () => {
    // The property `crashRecovery` depends on: a second service built inside one test is a restart,
    // and it must reopen the base the first one wrote, not an empty one.
    mkdirSync(join(testHome(), "workflows"), { recursive: true });
    expect(existsSync(join(testHome(), "workflows"))).toBe(true);
  });

  it("hands the next test a different one, whichever test that is", () => {
    // The pair-wise half of what `afterAll` checks across the whole file — kept as a test of its own
    // because it is the property a reader comes here looking for.
    expect(given).not.toContain(fromHook);
  });
});
