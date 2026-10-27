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
 *   node packages/app/buildTailnet.mjs        # dist/tailnet/jaira-tailnet[.exe]
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, "..", "tailnet");
export const TAILNET_OUT = join(here, "dist", "tailnet");
const exe = process.platform === "win32" ? "jaira-tailnet.exe" : "jaira-tailnet";

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
async function downloadModules(go, env) {
  for (let attempt = 1; ; attempt++) {
    if (spawnSync(go, ["mod", "download"], { cwd: source, stdio: "inherit", env }).status === 0) return;
    if (attempt === DOWNLOAD_TRIES) throw new Error(`go mod download failed ${DOWNLOAD_TRIES} times`);
    const wait = DOWNLOAD_WAIT_MS * attempt;
    console.log(`buildTailnet: go mod download failed (try ${attempt} of ${DOWNLOAD_TRIES}); again in ${wait / 1000} s`);
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

export async function buildTailnet() {
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
  await downloadModules(go, env);
  execFileSync(go, ["build", "-trimpath", "-ldflags=-s -w", "-o", join(TAILNET_OUT, exe), "."], { cwd: source, stdio: "inherit", env });
  return join(TAILNET_OUT, exe);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log(await buildTailnet());
}
