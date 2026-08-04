/**
 * Global test setup: point the shared BASE root at a scratch directory.
 *
 * Every project resolves workflows against `~/.jaira` by default (DESIGN §3), and `openProject`
 * creates that layout. A suite left to the default would therefore read whatever the developer
 * happens to keep in their real base root — so a test could pass on one machine and fail on
 * another for reasons nothing in the test says — and would create directories in their home
 * directory as a side effect of running tests. Both are unacceptable, so `JAIRA_HOME` is
 * redirected before any test opens a project.
 *
 * A test that wants a base layer of its own writes into {@link BASE_DIR}, or passes an explicit
 * `baseDir` to `openProject`. This one is deliberately left EMPTY: an empty base is the state
 * every pre-existing test was written against.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

export const BASE_DIR = mkdtempSync(join(tmpdir(), "jaira-base-"));

process.env["JAIRA_HOME"] = BASE_DIR;

afterAll(() => {
  rmSync(BASE_DIR, { recursive: true, force: true });
});
