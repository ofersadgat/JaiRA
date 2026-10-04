/**
 * Tailscale built into the phone app (decision 0013, amended 2026-10-04): binds packages/tailnet/mobile
 * with gomobile, for the platform asked, into where this module's native build looks for it.
 *
 *   node packages/client/modules/jaira-net/build.mjs ios       → ios/Tailnet.xcframework (a Mac, Xcode)
 *   node packages/client/modules/jaira-net/build.mjs android   → android/libs/maven (the Android NDK): a
 *     Maven repository of one artifact, com.mistlabs.jaira:tailnet:0.1.0, which the module's Gradle uses
 *
 * Needs Go (the version packages/tailnet/go.mod says); gomobile and gobind are installed into Go's own
 * bin directory when missing. A build whose Go source has not changed since the last one is kept (a
 * stamp of the sources' hash beside the output). Both outputs are build products, not in git.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const TAILNET = resolve(here, "../../../tailnet");
const platform = process.argv[2];
if (platform !== "ios" && platform !== "android") {
  console.error("usage: node packages/client/modules/jaira-net/build.mjs ios|android");
  process.exit(2);
}

function go(args, options = {}) {
  return execFileSync("go", args, { cwd: TAILNET, encoding: "utf8", ...options }).trim();
}

try {
  go(["version"]);
} catch {
  console.error("Go is not installed: the phone app's Tailscale is built from packages/tailnet with it. Install the version packages/tailnet/go.mod says (https://go.dev/dl), then run this again.");
  process.exit(1);
}

// gomobile and gobind, the versions go.mod pins, where Go installs commands.
const gobin = go(["env", "GOBIN"]) || join(go(["env", "GOPATH"]).split(delimiter)[0], "bin");
const exe = process.platform === "win32" ? ".exe" : "";
// gomobile runs `javac` for Android: the JDK in JAVA_HOME, as Gradle has it, need not be on PATH.
const javaBin = process.env.JAVA_HOME ? `${join(process.env.JAVA_HOME, "bin")}${delimiter}` : "";
const env = { ...process.env, PATH: `${gobin}${delimiter}${javaBin}${process.env.PATH}` };
if (!existsSync(join(gobin, `gomobile${exe}`)) || !existsSync(join(gobin, `gobind${exe}`))) {
  console.log("installing gomobile and gobind…");
  go(["install", "golang.org/x/mobile/cmd/gomobile", "golang.org/x/mobile/cmd/gobind"], { env, stdio: "inherit" });
}

/** What the output is made from: every Go file and the module's requirements. */
function sourceHash() {
  const hash = createHash("sha256");
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith(".go") || name === "go.mod" || name === "go.sum") hash.update(name).update(readFileSync(path));
    }
  };
  walk(TAILNET);
  return hash.update(platform).digest("hex");
}

const MAVEN = join(here, "android", "libs", "maven", "com", "mistlabs", "jaira", "tailnet", "0.1.0");
const out = platform === "ios" ? join(here, "ios", "Tailnet.xcframework") : join(MAVEN, "tailnet-0.1.0.aar");
const stamp = `${out}.stamp`;
const wanted = sourceHash();
if (existsSync(out) && existsSync(stamp) && readFileSync(stamp, "utf8").trim() === wanted) {
  console.log(`${out} is up to date`);
  process.exit(0);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(dirname(out), { recursive: true });
const common = ["-trimpath", "-ldflags=-s -w"];
const args =
  platform === "ios"
    ? ["bind", "-target=ios,iossimulator", "-iosversion=16.4", ...common, "-o", out, "./mobile"]
    : ["bind", "-target=android/arm64,android/amd64", "-androidapi=24", "-javapkg=com.mistlabs.jaira", ...common, "-o", out, "./mobile"];
console.log(`gomobile ${args.join(" ")}`);
execFileSync(`gomobile${exe}`, args, { cwd: TAILNET, env, stdio: "inherit" });
rmSync(out.replace(/\.aar$/, "-sources.jar"), { force: true });
if (platform === "android") {
  const pom = ["<?xml version=\"1.0\" encoding=\"UTF-8\"?>", '<project xmlns="http://maven.apache.org/POM/4.0.0">', "  <modelVersion>4.0.0</modelVersion>", "  <groupId>com.mistlabs.jaira</groupId>", "  <artifactId>tailnet</artifactId>", "  <version>0.1.0</version>", "  <packaging>aar</packaging>", "</project>", ""];
  writeFileSync(join(MAVEN, "tailnet-0.1.0.pom"), pom.join("\n"));
}
writeFileSync(stamp, `${wanted}\n`);
console.log(`built ${out}`);
