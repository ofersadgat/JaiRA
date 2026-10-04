/**
 * Build JaiRA's phone app for iOS and, for a release, sign it and upload it to App Store Connect, where
 * it reaches TestFlight (decision 0017). Both CI systems run it on a Mac: GitLab's own `mac` runner and
 * a GitHub-hosted macOS machine.
 *
 *   node scripts/release/ios.mjs check     an unsigned Release archive: does it build? (no credentials)
 *   node scripts/release/ios.mjs release   the same archive, then signed and uploaded
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
import { ensureRelease, hasRecord, record, recordName, upload } from "./github.mjs";

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
  const response = await fetch(`https://api.appstoreconnect.apple.com${path}`, { headers: { authorization: `Bearer ${ascToken()}` } });
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

async function build() {
  if (mode !== "check" && mode !== "release") throw new Error("usage: node scripts/release/ios.mjs check|release");
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
  const archive = join(OUT, `${scheme}.xcarchive`);
  // Unsigned: on a fresh machine automatic signing would make a new development certificate on every
  // run, and Apple allows a team only a few. The export below signs it.
  run("xcodebuild", [
    "archive",
    "-workspace", join(IOS, workspace),
    "-scheme", scheme,
    "-configuration", "Release",
    "-destination", "generic/platform=iOS",
    "-archivePath", archive,
    "CODE_SIGNING_ALLOWED=NO",
  ]);
  if (mode === "check") return console.log(`\nbuilt ${archive} (unsigned)`);

  const secrets = mkdtempSync(join(tmpdir(), "jaira-ios-"));
  try {
    const key = join(secrets, `AuthKey_${env.ASC_KEY_ID}.p8`);
    writeFileSync(key, Buffer.from(env.ASC_KEY_P8_BASE64, "base64"), { mode: 0o600 });
    const options = join(secrets, "ExportOptions.plist");
    writeFileSync(options, exportOptions(env.APPLE_TEAM_ID));
    run("xcodebuild", [
      "-exportArchive",
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
