/**
 * Build JaiRA's Tailscale helper (`packages/tailnet`, decision 0013 §2) for THIS machine, into
 * `dist/tailnet/`, which the installer ships as `resources/tailnet` beside the built-in layer.
 *
 * Bundled rather than a plugin (the person, 2026-09-27: "bundle it in the installer and drop the
 * plugin"): it is 8.6 MB compressed against a 129 MB installer, where the plugins are split out because
 * each is as big as the app.
 *
 * Every installer is built on a machine of its own platform and architecture (package.mjs), so this
 * builds for the machine it runs on. It uses the `go` on the PATH when there is one; otherwise it
 * downloads the current Go release for this machine into the OS's temporary directory and builds with
 * that — so a packaging machine needs nothing installed for it, the CI ones included.
 *
 * The app's own build (`build:main`) runs it with `--if-stale`, so a development build has the helper
 * too: it builds when `dist/tailnet` has none, or one older than its sources (`staleBecause`). The
 * person, 2026-11-15, of a development build saying "this build of JaiRA carries no Tailscale helper":
 * only the installers built it. There a failure is said and the build goes on without it (the app says
 * so, as before), and a CI build leaves it to the packaging, which always builds it (package.mjs).
 *
 *   node packages/app/buildTailnet.mjs              # dist/tailnet/jaira-tailnet[.exe]
 *   node packages/app/buildTailnet.mjs --if-stale   # only when missing or older than its sources
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, "..", "tailnet");
export const TAILNET_OUT = join(here, "dist", "tailnet");
const exe = process.platform === "win32" ? "jaira-tailnet.exe" : "jaira-tailnet";

const say = (line) => console.log(`buildTailnet: ${line}`);

/**
 * What `go build .` in `dir` reads: go.mod, go.sum and every Go file but the tests', leaving out
 * `mobile/`, the phone's package (built by jaira-net, never imported by the helper).
 */
export function helperSources(dir = source) {
  const found = [];
  const walk = (at) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) {
        if (!(at === dir && entry.name === "mobile")) walk(path);
      } else if (at === dir && (entry.name === "go.mod" || entry.name === "go.sum")) found.push(path);
      else if (entry.name.endsWith(".go") && !entry.name.endsWith("_test.go")) found.push(path);
    }
  };
  walk(dir);
  return found;
}

/** Why the helper at `binary` must be built again from `dir`, or undefined when it is newer than all of it. */
export function staleBecause(binary = join(TAILNET_OUT, exe), dir = source) {
  if (!existsSync(binary)) return "not built";
  const built = statSync(binary).mtimeMs;
  const changed = helperSources(dir).filter((file) => statSync(file).mtimeMs > built);
  return changed.length === 0 ? undefined : `${changed.map((file) => relative(dir, file).split("\\").join("/")).join(", ")} changed since it was built`;
}

/**
 * The helper for a development build: built when stale, and a failure said rather than thrown, since the
 * app runs without it (and says why). Under CI nothing: a CI build that ships it packages, and
 * package.mjs builds it there whatever is on disk.
 */
export async function ensureTailnet() {
  if (process.env.CI) {
    say("not built under CI (the installer's packaging builds it)");
    return;
  }
  const why = staleBecause();
  if (why === undefined) {
    say("built since its sources last changed");
    return;
  }
  say(`${why}; building`);
  try {
    say(`built ${await buildTailnet({ tries: 1 })}`);
  } catch (e) {
    say(`not built (${e instanceof Error ? e.message : String(e)}); this build runs without it`);
  }
}

const GOOS = { win32: "windows", darwin: "darwin", linux: "linux" }[process.platform];
const GOARCH = { x64: "amd64", arm64: "arm64" }[process.arch];

/** A `go` that answers, on the PATH. */
function pathGo() {
  const found = spawnSync(process.platform === "win32" ? "go.exe" : "go", ["version"], { encoding: "utf8" });
  return found.status === 0 ? (process.platform === "win32" ? "go.exe" : "go") : undefined;
}

/** The current Go release for this machine, downloaded once into the temporary directory. */
async function downloadedGo() {
  const releases = await (await fetch("https://go.dev/dl/?mode=json")).json();
  const release = releases.find((r) => r.stable);
  const file = release.files.find((f) => f.os === GOOS && f.arch === GOARCH && f.kind === "archive");
  if (file === undefined) throw new Error(`no Go release for ${GOOS}/${GOARCH}`);
  const root = join(tmpdir(), "jaira-go", release.version);
  const go = join(root, "go", "bin", process.platform === "win32" ? "go.exe" : "go");
  if (existsSync(go)) return go;
  mkdirSync(root, { recursive: true });
  const archive = join(root, file.filename);
  console.log(`buildTailnet: downloading ${file.filename}`);
  writeFileSync(archive, Buffer.from(await (await fetch(`https://go.dev/dl/${file.filename}`)).arrayBuffer()));
  // Windows' own tar (bsdtar) reads the zip — by its full path, since a Git Bash GNU tar earlier on the
  // PATH takes `C:` for a remote host. Everywhere else it is a .tar.gz.
  const tar = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
  execFileSync(tar, ["-xf", archive, "-C", root], { stdio: "inherit" });
  rmSync(archive, { force: true });
  return go;
}

/** Tries at fetching the modules, and the wait before the next (it grows: 10 s, 20 s, 30 s). */
const DOWNLOAD_TRIES = 4;
const DOWNLOAD_WAIT_MS = 10_000;

/**
 * The modules go.mod needs (and the toolchain it asks for), fetched before the build and fetched again
 * when that fails: the module proxy fails now and then, and a build fetching as it went failed with it
 * (the linux-arm64 nightly, 2026-10-26: "stream error: stream ID 1; INTERNAL_ERROR" reading
 * github.com/klauspost/compress). The build then finds every module in the cache.
 */
async function downloadModules(go, env, tries) {
  for (let attempt = 1; ; attempt++) {
    if (spawnSync(go, ["mod", "download"], { cwd: source, stdio: "inherit", env }).status === 0) return;
    if (attempt === tries) throw new Error(tries === 1 ? "go mod download failed" : `go mod download failed ${tries} times`);
    const wait = DOWNLOAD_WAIT_MS * attempt;
    say(`go mod download failed (try ${attempt} of ${tries}); again in ${wait / 1000} s`);
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

/**
 * `tries`: at fetching the modules. A development build tries once (`ensureTailnet`): offline, it should
 * not wait a minute for a helper it can run without.
 */
export async function buildTailnet({ tries = DOWNLOAD_TRIES } = {}) {
  if (GOOS === undefined || GOARCH === undefined) throw new Error(`no helper for ${process.platform}/${process.arch}`);
  const go = pathGo() ?? (await downloadedGo());
  mkdirSync(TAILNET_OUT, { recursive: true });
  const cache = join(tmpdir(), "jaira-go-cache");
  const env = {
    ...process.env,
    CGO_ENABLED: "0",
    GOOS,
    GOARCH,
    // The toolchain go.mod asks for, fetched when this one is older.
    GOTOOLCHAIN: process.env.GOTOOLCHAIN ?? "auto",
    GOMODCACHE: process.env.GOMODCACHE ?? join(cache, "mod"),
    GOCACHE: process.env.GOCACHE ?? join(cache, "build"),
  };
  await downloadModules(go, env, tries);
  // Built beside it and renamed over it: a development app may be running the old one, and a running
  // binary written over in place can be killed (macOS checks its pages against its signature).
  const out = join(TAILNET_OUT, exe);
  const next = `${out}.next`;
  execFileSync(go, ["build", "-trimpath", "-ldflags=-s -w", "-o", next, "."], { cwd: source, stdio: "inherit", env });
  renameSync(next, out);
  return out;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes("--if-stale")) await ensureTailnet();
  else console.log(await buildTailnet());
}
