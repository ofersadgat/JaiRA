---
id: engineering/decisions/0017-ios-releases
type: decision
status: proposed
updated: 2026-10-03
decides_for: [engineering/units/app-shell]
---

# 0017. iOS releases

Extends decision 0011 §3 (releases) to the phone app of decision 0015. The person asked, 2026-10-02:
"build a pipeline to build release and deploy an ios version of this app", on GitLab's own Mac and on
GitHub, with "many apps go through the same pipeline". The sections below are what was settled with
them; "proposed" until a release has reached TestFlight.

## Context

- The phone app had never been built for iOS, nor as a release on any platform (0015: "A release build.
  The bundle is embedded, not served by Metro; not built yet").
- GitLab has a Mac: the mistlabs group's runner (`mac` tag), a Mac mini (arm64, 8 GB) that also builds
  mist-server, running jobs as shell commands. On 2026-10-03 it had macOS 13.5 and Xcode 15.0.1, too old
  for Expo 57; it was upgraded to macOS Tahoe 26.6 and Xcode 26.6 (mist-server's pin moved with it).
- It held no usable signing identity: the only profiles were Mist Weaver's, expired May 2025, for team
  `Q4X58YQ7SJ`. Nothing anywhere stored Apple credentials.
- Xcode 27 (September 2026) builds with the iOS 27 SDK, under which an app must use the scene life cycle;
  Expo 57 has it only as an opt-in (`expo@57.0.23`, `ios.enableSceneSupport`). App Store Connect requires
  the iOS 27 SDK from April 2027.

## Decision

1. **Build with Xcode 26** until the Expo upgrade that brings the scene life cycle; move to Xcode 27
   before April 2027. The GitLab Mac stays on Tahoe 26.x (it runs both), not macOS 27.
2. **Apple's cloud signing.** The archive is built unsigned; `xcodebuild -exportArchive` with an App
   Store Connect API key (`-allowProvisioningUpdates`, `-authenticationKey*`) has Apple sign it with a
   distribution certificate Apple keeps, and uploads it (`destination: upload`). A builder needs only the
   key: no keychain, no certificate files, nothing tied to one machine, so GitHub's machines and the Mac
   sign alike. The key has the Admin role, which cloud signing requires. The person, asked to choose
   between this and fastlane `match` (an encrypted store of exported certificates): "go with cloud
   signing first". If it misbehaves, `match` replaces only the export step.
3. **One script, both CIs.** `scripts/release/ios.mjs` (`check`: an unsigned archive, no credentials;
   `release`: archive, sign, upload) runs on GitLab (`release:build:ios`, and `ios:check` from Run
   pipeline with `IOS_CHECK = true`) and on GitHub (the `ios` job on `macos-26`). Neither holds back the
   desktop release: GitLab's job may fail, GitHub's continues on error, and publishing waits for neither.
4. **Credentials by the same names everywhere**: `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8_BASE64` (the
   `.p8` file, base64 so GitLab can mask it; protected) and `APPLE_TEAM_ID`. On GitLab they are
   mistlabs *group* variables, so every app in the group has them; an API key and a distribution
   certificate belong to the team, not to one app. GitHub's job runs only when the secrets exist.
5. **Versions.** Apple takes `X.Y.Z` as the version and a build number that is new and rising within it
   (`appleVersionOf` in `scripts/release/versions.mjs`, written out by the plan as `ios_version` and
   `ios_build`, read by `packages/client/app.config.cjs`): a nightly `X.Y.Z-nightly.YYYYMMDD.N` is
   `X.Y.Z` build `YYYYMMDD.N`; a stable `X.Y.Z` is build `YYYYMMDD.1000` of the day it is built.
6. **Every release goes to TestFlight.** Submitting one for App Store review is done by hand in App Store
   Connect. Review needs a reviewer to be able to use the app, and JaiRA does nothing until it is paired
   with a desktop over Tailscale (0013), which the reviewer has none of: a demo mode or a reachable demo
   desktop comes first.
7. **No capabilities.** The app ID has Apple's defaults: the keychain, the local network and the `jaira`
   scheme need none. Push notifications, associated domains, app groups or multicast are added when
   something uses them.

8. **Every build is idempotent, on either system** (the person, 2026-10-03: "a build should be able to be
   run via github or gitlab and should be published as a github release. therefore, if a job starts
   and sees that the release is already there, it should early exit"). Asked whether "there" means the
   release or the job's own part of it, they chose the part, since GitLab cannot build every installer:
   - a release is *filled in*: the plan gives a commit that already has a nightly (published or a draft,
     from either system) that nightly's version again, and never refuses a version that exists;
   - each build that reached the release leaves a record there, `build-<name>.json` (`linux-x64`,
     `linux-arm64`, `win-x64`, `win-arm64`, `mac-arm64`, `mac-x64`, `ios`), uploaded after its files;
   - every build job asks first (`scripts/release/builds.mjs check`) and exits if its record is there;
     the iOS job also asks App Store Connect whether the version and build are already uploaded, before
     building and again before uploading (the other system may have uploaded it meanwhile, and App
     Store Connect refuses a build number twice), and records one it finds rather than building it;
   - the plan is skipped when the release has every build the pipeline makes (`BUILDS`);
   - publishing (`publish.mjs`) finds the release or makes it as a draft (two pipelines making it at once
     keep the older one), uploads only files and builds it lacks, merges the update manifests with the
     release's own copies across architectures, then the records, then publishes a draft; it publishes
     what finished even when another build failed, and a later run adds the rest.

   The build jobs run this pipeline's release scripts, kept apart from the commit they build, which may
   be older than them (a stable release promotes an earlier nightly's commit).

## Not yet

- **A real icon.** `packages/client/assets/icon.png` is a placeholder (a "J" in the dark palette's
  accent): App Store Connect rejects an upload without one, and Expo's template has none.
- **The app reports its committed version** (`bridges/clientVersion.ts` reads `package.json`), not the
  build's.
- **Run on a phone.** The first `check` is also the first iOS build ever; what it finds (the island pages,
  the fonts, the Reanimated workaround, App Transport Security for `ws://` to a tailnet address) is
  still to come.
- **A shared pipeline for other apps**: a GitLab CI/CD component and a GitHub reusable workflow over the
  same steps, once a second app exists.
