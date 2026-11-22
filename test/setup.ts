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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach } from "vitest";
import { setBuiltInDir } from "@jaira/shared";

export const BASE_DIR = mkdtempSync(join(tmpdir(), "jaira-base-"));

process.env["JAIRA_HOME"] = BASE_DIR;

// The same for declarative-ai's endpoints (decision 0029, ruling 12): an engine a test hosts advertises
// where scripts run as programs report to it, in `$DAI_ENDPOINTS` — never in the developer's real one,
// where a script they run would find an engine a test left behind.
process.env["DAI_ENDPOINTS"] = join(BASE_DIR, "dai", "endpoints");

/**
 * The same floor under the THIRD layer (decision 0006): a test sees an empty built-in layer unless
 * it asks for the real one.
 *
 * What ships is on every project's search path, so without this every listing, board, digest and
 * lint report in the suite would also carry the chat states and the self-test — and would change
 * again with every built-in added. A test asserting "this project has one workflow" is about that
 * project, not about what the app happens to ship this month. The tests that ARE about what ships
 * say so with `shippedLayer()` from `test/testing.ts`, and the ones about the layer's mechanics
 * register a fixture of their own, as they always have.
 *
 * Registered through `setBuiltInDir` because that is the only way there is: no environment variable
 * names this directory, on purpose (see its doc), so a subprocess a test spawns still sees the real
 * layer beside the bundle it runs.
 */
export const EMPTY_BUILT_IN_DIR = join(BASE_DIR, "no-builtin");
setBuiltInDir(EMPTY_BUILT_IN_DIR);

/**
 * Git as the suite expects it, whatever this machine's own configuration says — the same floor as the
 * base root's. Git for Windows' SYSTEM file turns `core.autocrlf` on, and every file a test cloned came
 * back with CRLF endings; a machine with no identity of its own refused every commit a test made. So no
 * system or global file is read, and the one global file is this, with an identity a test commits as.
 */
const GIT_CONFIG = join(BASE_DIR, "gitconfig");
writeFileSync(GIT_CONFIG, "[core]\n\tautocrlf = false\n[user]\n\tname = JaiRA tests\n\temail = tests@jaira.invalid\n", "utf8");
process.env["GIT_CONFIG_GLOBAL"] = GIT_CONFIG;
process.env["GIT_CONFIG_NOSYSTEM"] = "1";

// A developer's shell may export real forge tokens, and the environment is the last link of the
// secret chain. With no token a connection check makes no request at all, so removing the two
// conventional names is what keeps a test from ever signing in to a real forge by accident.
delete process.env["GITLAB_TOKEN"];
delete process.env["GITHUB_TOKEN"];

/**
 * Every test gives the event loop a turn before the next one starts.
 *
 * A worker tells vitest's main process how its tests are going and waits at most 60 s for the reply,
 * which it can only read on the event loop. A file whose tests never reach the loop (each `await` in
 * them settles at once: SQLite and the file system are synchronous here) leaves that reply unread for
 * as long as the file runs. schemas.test.ts was one (2026-11-15): its 70 tests, each opening and
 * closing a project, held the loop for 21 s alone and 117 s under the full suite, and every full run
 * ended in `[vitest-worker]: Timeout calling "onTaskUpdate"`, an unhandled error that made `npm test`
 * exit 1 with every test passing. With a turn after each test, the reply waits one test at most.
 *
 * `setImmediate` as it was when this file loaded, not one a test has faked since.
 */
const realSetImmediate = globalThis.setImmediate;
afterEach(() => new Promise<void>((resolve) => realSetImmediate(() => resolve())));

afterAll(() => {
  rmSync(BASE_DIR, { recursive: true, force: true });
});
