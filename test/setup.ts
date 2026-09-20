/**
 * The BACKSTOP: no test may resolve the developer's real `~/.jaira`, even one that forgot to say so.
 *
 * Every project resolves workflows against `~/.jaira` by default (DESIGN §3), and opening one creates
 * that layout. A suite left to that default reads whatever the developer happens to keep there — so
 * a test passes on one machine and fails on another for reasons nothing in the test says — and
 * writes into their home directory as a side effect of running. Both have happened here.
 *
 * This is no longer the mechanism, though, only the floor under it. Tests name their own base root
 * (`testHome()` in `test/testing.ts`, and `--home` for anything that goes through the CLI), and the
 * suite passes with this file removed entirely — which is the property worth keeping, because it is
 * what makes each test's isolation a fact about the test rather than about the runner's config.
 * `defaultBaseDir` throws rather than answering `~/.jaira` under a test run, so a NEW test that
 * forgets both this and an explicit root fails loudly instead of quietly reaching into a home.
 *
 * Left in place for the case that argument does not cover: a test file, or a subprocess it spawns,
 * that reaches the default path before anything has had a chance to name a root. An empty scratch
 * directory is the right answer there, and it costs one `mkdtemp` per worker.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

export const BASE_DIR = mkdtempSync(join(tmpdir(), "jaira-base-"));

process.env["JAIRA_HOME"] = BASE_DIR;

// A developer's shell may export real forge tokens, and the environment is the last link of the
// secret chain. With no token a connection check makes no request at all, so removing the two
// conventional names is what keeps a test from ever signing in to a real forge by accident.
delete process.env["GITLAB_TOKEN"];
delete process.env["GITHUB_TOKEN"];

afterAll(() => {
  rmSync(BASE_DIR, { recursive: true, force: true });
});
