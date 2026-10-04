/**
 * Build JaiRA's phone app for iOS and, for a release, sign it and upload it to App Store Connect, where
 * it reaches TestFlight (decision 0017). Both CI systems run it on a Mac: GitLab's own `mac` runner and
 * a GitHub-hosted macOS machine.
 *
 *   node scripts/release/ios.mjs check     an unsigned Release archive: does it build? (no credentials)
 *   node scripts/release/ios.mjs release   the same archive, then signed and uploaded
 *   node scripts/release/ios.mjs simulator the Release app launched on a fresh simulator, and photographed
 *
 * Signing is Apple's cloud signing: the archive is built unsigned, and `xcodebuild -exportArchive`,
 * authenticated with an App Store Connect API key, has Apple sign it with a distribution certificate
 * Apple keeps, and uploads it. Nothing is installed in a keychain, so a fresh machine needs nothing but
 * the key; the key must have the Admin role, which cloud signing requires.
 *
 * A release is idempotent like every other build (0017 §8): it stops before building when the GitHub
 * release already records `ios` or App Store Connect already has this version and build, and after
 * uploading it records `build-ios.json` in the release (making the release as a draft if no desktop
 * build has yet).
 *
 * Run from the repository root after `npm install`, with declarative-ai built beside the checkout and
 * the Xcode to build with selected. Environment: JAIRA_IOS_VERSION (`X.Y.Z`) and JAIRA_IOS_BUILD
 * (`YYYYMMDD.N`), the plan's `ios_version` and `ios_build` (`app.config.cjs` reads them); for
 * `release`, ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_P8_BASE64 (the key's `.p8` file, base64) and
 * APPLE_TEAM_ID, and for the release's record PLAN_TAG, PLAN_VERSION, PLAN_COMMIT, PLAN_PRERELEASE,
 * NOTES_FILE, RELEASES_REPO and GH_TOKEN. Node 22, no dependencies.
 */
import { execFileSync } from "node:child_process";
import { createPrivateKey, sign } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { ensureRelease, hasRecord, record, recordName, retrying, upload } from "./github.mjs";

const env = process.env;
const mode = process.argv[2];
const CLIENT = resolve("packages/client");
const IOS = join(CLIENT, "ios");
/** Inside `ios/`, which is generated and ignored, so a build leaves nothing in the checkout. */
const OUT = join(IOS, "build");
const KEY_VARIABLES = ["ASC_KEY_ID", "ASC_ISSUER_ID", "ASC_KEY_P8_BASE64", "APPLE_TEAM_ID"];
const RECORD_VARIABLES = ["PLAN_TAG", "PLAN_VERSION", "PLAN_PRERELEASE", "NOTES_FILE", "GH_TOKEN", "JAIRA_IOS_VERSION", "JAIRA_IOS_BUILD"];
const BUNDLE_ID = JSON.parse(readFileSync(join(CLIENT, "app.json"), "utf8")).expo.ios.bundleIdentifier;

/** A token for the App Store Connect API: a JWT signed with the key (ES256), good for 20 minutes. */
function ascToken() {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${part({ alg: "ES256", kid: env.ASC_KEY_ID, typ: "JWT" })}.${part({ iss: env.ASC_ISSUER_ID, iat: now, exp: now + 1200, aud: "appstoreconnect-v1" })}`;
  const key = createPrivateKey(Buffer.from(env.ASC_KEY_P8_BASE64, "base64"));
  return `${unsigned}.${sign("sha256", Buffer.from(unsigned), { key, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}

async function asc(path) {
  const response = await retrying(`https://api.appstoreconnect.apple.com${path}`, { headers: { authorization: `Bearer ${ascToken()}` } });
  if (!response.ok) throw new Error(`App Store Connect ${path}: ${response.status} ${await response.text()}`);
  return response.json();
}

/** Whether App Store Connect already has this version and build of the app (uploaded by either system). */
async function uploaded() {
  const apps = await asc(`/v1/apps?filter[bundleId]=${encodeURIComponent(BUNDLE_ID)}`);
  const app = apps.data.find((a) => a.attributes.bundleId === BUNDLE_ID);
  if (app === undefined) throw new Error(`App Store Connect has no app ${BUNDLE_ID}: create it there first (Apps → +)`);
  const builds = await asc(
    `/v1/builds?filter[app]=${app.id}&filter[version]=${encodeURIComponent(env.JAIRA_IOS_BUILD)}&filter[preReleaseVersion.version]=${encodeURIComponent(env.JAIRA_IOS_VERSION)}&limit=1`,
  );
  return builds.data.length > 0;
}

/** Record `ios` in the GitHub release: the version, the build, and that it went to TestFlight. */
async function markReleased() {
  const release = await ensureRelease({
    tag: env.PLAN_TAG,
    version: env.PLAN_VERSION,
    notes: readFileSync(env.NOTES_FILE, "utf8"),
    prerelease: env.PLAN_PRERELEASE === "true",
  });
  const body = record("ios", { iosVersion: env.JAIRA_IOS_VERSION, iosBuild: env.JAIRA_IOS_BUILD, bundleId: BUNDLE_ID, destination: "TestFlight" });
  await upload(release, recordName("ios"), Buffer.from(`${JSON.stringify(body, null, 2)}\n`));
}

function run(command, args, options = {}) {
  console.log(`\n$ ${command} ${args.join(" ")}`);
  execFileSync(command, args, { stdio: "inherit", ...options });
}

/** The export options for an App Store Connect upload signed in the cloud. */
function exportOptions(team) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>upload</string>
  <key>signingStyle</key><string>automatic</string>
  <key>teamID</key><string>${team}</string>
  <key>uploadSymbols</key><true/>
  <key>manageAppVersionAndBuildNumber</key><false/>
</dict>
</plist>
`;
}

/** The newest iOS runtime installed and an iPhone it can run: what the simulator smoke test boots. */
function simulatorTarget() {
  const json = (args) => JSON.parse(execFileSync("xcrun", ["simctl", "list", ...args, "-j"], { encoding: "utf8" }));
  const runtime = json(["runtimes"])
    .runtimes.filter((r) => r.isAvailable && r.platform === "iOS")
    .sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))[0];
  if (runtime === undefined) throw new Error("no iOS simulator runtime is installed: xcodebuild -downloadPlatform iOS");
  const device = runtime.supportedDeviceTypes.filter((d) => d.productFamily === "iPhone").at(-1);
  if (device === undefined) throw new Error(`${runtime.name} supports no iPhone`);
  return { runtime, device };
}

/**
 * The Release app on a fresh simulator: installed, launched, alive 25 seconds later, and photographed
 * (`build/simulator.png`). What it said and, if it died, its crash report are printed. The phone app had
 * never run on iOS before this; a launch crash should end here, not on someone's phone.
 */
function simulate(workspace, scheme) {
  const derived = join(OUT, "simulator");
  run("xcodebuild", [
    "build",
    "-quiet",
    "-workspace", join(IOS, workspace),
    "-scheme", scheme,
    "-configuration", "Release",
    "-sdk", "iphonesimulator",
    "-destination", "generic/platform=iOS Simulator",
    "-derivedDataPath", derived,
    "CODE_SIGNING_ALLOWED=NO",
  ]);
  const app = join(derived, "Build", "Products", "Release-iphonesimulator", `${scheme}.app`);
  const { runtime, device } = simulatorTarget();
  console.log(`\nsimulator: ${device.name}, ${runtime.name}`);
  const udid = execFileSync("xcrun", ["simctl", "create", `jaira-smoke-${process.pid}`, device.identifier, runtime.identifier], { encoding: "utf8" }).trim();
  const shot = join(OUT, "simulator.png");
  try {
    run("xcrun", ["simctl", "bootstatus", udid, "-b"]);
    run("xcrun", ["simctl", "install", udid, app]);
    const launched = execFileSync("xcrun", ["simctl", "launch", udid, BUNDLE_ID], { encoding: "utf8" }).trim();
    const pid = Number(launched.split(":").pop());
    console.log(`launched ${BUNDLE_ID} (pid ${pid}); waiting 25 seconds`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25_000);
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    run("xcrun", ["simctl", "io", udid, "screenshot", shot]);
    // What the app said: React Native logs through os_log, a JavaScript error included.
    const said = execFileSync("xcrun", ["simctl", "spawn", udid, "log", "show", "--last", "2m", "--style", "compact", "--predicate", `process == "${scheme}"`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    console.log(said.split("\n").filter((line) => /error|exception|fatal|warn|\[javascript\]|ReactNative/i.test(line)).slice(-60).join("\n") || "(the app logged no error or warning)");
    if (!alive) {
      const reports = join(process.env.HOME ?? "", "Library", "Logs", "DiagnosticReports");
      let crash;
      try {
        crash = readdirSync(reports).filter((name) => name.startsWith(scheme)).sort().at(-1);
      } catch {
        // No reports folder: nothing crashed in a way the system wrote down.
      }
      if (crash !== undefined) console.log(`--- ${crash}\n${readFileSync(join(reports, crash), "utf8").slice(0, 8000)}`);
      throw new Error(`${scheme} was not running 25 seconds after launch (screenshot: ${shot})`);
    }
    console.log(`\n${scheme} is running on ${device.name} (${runtime.name}); screenshot: ${shot}`);
  } finally {
    execFileSync("xcrun", ["simctl", "delete", udid]);
  }
}

async function build() {
  if (mode !== "check" && mode !== "release" && mode !== "simulator") throw new Error("usage: node scripts/release/ios.mjs check|release|simulator");
  if (process.platform !== "darwin") throw new Error("iOS builds need a Mac");
  if (mode === "release") {
    const missing = [...KEY_VARIABLES, ...RECORD_VARIABLES].filter((name) => !env[name]);
    // Before the half-hour build, not after it.
    if (missing.length > 0) throw new Error(`a release needs ${missing.join(", ")} (an App Store Connect API key with the Admin role, the team, and the plan)`);
    if (await hasRecord(env.PLAN_TAG, "ios")) return console.log(`${env.PLAN_TAG} already records ios: nothing to build`);
    if (await uploaded()) {
      console.log(`App Store Connect already has ${env.JAIRA_IOS_VERSION} (${env.JAIRA_IOS_BUILD}): recording it, not building it`);
      return markReleased();
    }
  }
  console.log(`JaiRA for iOS ${env.JAIRA_IOS_VERSION ?? "(app.json's version)"} build ${env.JAIRA_IOS_BUILD ?? "1"}, ${mode}`);
  run("xcodebuild", ["-version"]);

  // The island pages go into the bundle at prebuild (`plugins/withIslands.cjs`), so they come first.
  run("npm", ["--workspace", "@jaira/client", "run", "build:island"]);
  // A prebuild replaces `ios/` whole, from app.json, app.config.cjs and the plugins.
  run("npx", ["one", "prebuild", "--platform", "ios", "--no-install"], { cwd: CLIENT });
  run("pod", ["install"], { cwd: IOS });

  const workspace = readdirSync(IOS).find((name) => name.endsWith(".xcworkspace"));
  if (workspace === undefined) throw new Error(`the prebuild wrote no .xcworkspace into ${IOS}`);
  const scheme = basename(workspace, ".xcworkspace");
  if (mode === "simulator") return simulate(workspace, scheme);
  const archive = join(OUT, `${scheme}.xcarchive`);
  // Unsigned: on a fresh machine automatic signing would make a new development certificate on every
  // run, and Apple allows a team only a few. The export below signs it.
  run("xcodebuild", [
    "archive",
    // Warnings and errors only: the full log of a React Native build is several times GitLab's 4 MB
    // job log, which cut the first one off before its error.
    "-quiet",
    "-workspace", join(IOS, workspace),
    "-scheme", scheme,
    "-configuration", "Release",
    "-destination", "generic/platform=iOS",
    "-archivePath", archive,
    "CODE_SIGNING_ALLOWED=NO",
  ]);
  if (mode === "check") return console.log(`\nbuilt ${archive} (unsigned)`);

  // Asked again after the long build: the other system, building the same release, may have uploaded
  // it meanwhile, and App Store Connect refuses a build number twice.
  if (await hasRecord(env.PLAN_TAG, "ios")) return console.log(`${env.PLAN_TAG} recorded ios while this built: not uploading`);
  if (await uploaded()) {
    console.log(`App Store Connect got ${env.JAIRA_IOS_VERSION} (${env.JAIRA_IOS_BUILD}) while this built: recording it, not uploading`);
    return markReleased();
  }

  const secrets = mkdtempSync(join(tmpdir(), "jaira-ios-"));
  try {
    const key = join(secrets, `AuthKey_${env.ASC_KEY_ID}.p8`);
    writeFileSync(key, Buffer.from(env.ASC_KEY_P8_BASE64, "base64"), { mode: 0o600 });
    const options = join(secrets, "ExportOptions.plist");
    writeFileSync(options, exportOptions(env.APPLE_TEAM_ID));
    run("xcodebuild", [
      "-exportArchive",
      "-quiet",
      "-archivePath", archive,
      "-exportPath", join(OUT, "export"),
      "-exportOptionsPlist", options,
      "-allowProvisioningUpdates",
      "-authenticationKeyPath", key,
      "-authenticationKeyID", env.ASC_KEY_ID,
      "-authenticationKeyIssuerID", env.ASC_ISSUER_ID,
    ]);
  } finally {
    rmSync(secrets, { recursive: true, force: true });
  }
  console.log(`\nuploaded ${env.JAIRA_IOS_VERSION} (${env.JAIRA_IOS_BUILD}) to App Store Connect; TestFlight lists it once Apple has processed it`);
  await markReleased();
}

await build();
