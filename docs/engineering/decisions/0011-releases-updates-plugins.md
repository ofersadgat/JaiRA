---
id: engineering/decisions/0011-releases-updates-plugins
type: decision
status: accepted
updated: 2026-09-26
decides_for: [engineering/units/app-shell, engineering/units/agent-executors, engineering/units/model-routing, engineering/units/cli]
---

# 0011. Release builds, updates, channels, and downloadable plugins

The person's words are quoted where they settle something. Signing is deliberately left for later
("worry about paid accounts later"), and declarative-ai stays unpinned ("leave declarative ai unpinned
for now").

## Context

JaiRA builds and tests, and that is all. There is no installer, no signing, no release workflow, no
auto-update and no version beyond `0.1.0` in every package. `.github/workflows/ci.yml` and
`.gitlab-ci.yml` typecheck, test and run `app:build`, which is the esbuild bundle only.
`packages/app/build.mjs` already inlines declarative-ai and the workspace packages. It leaves three
modules external: `electron`, `better-sqlite3` and `typescript`. `paths.ts` already looks for
`<process.resourcesPath>/builtin`.

pingdotgg/t3code (MIT, © 2026 T3 Tools Inc.) was read on 2026-09-26 at `c9a0e8a1` as the reference:

- electron-builder runs in a staged directory and never publishes.
- The workflow uploads to GitHub Releases.
- The desktop updates through stock `electron-updater` from GitHub.
- There are two channels, `latest` and `nightly`. A nightly is a GitHub prerelease with its own
  `nightly*.yml` feed files, and its version says so: `X.Y.Z-nightly.YYYYMMDD.N`.
- A Settings option, "Update track", picks the channel.
- Stable promotes the latest nightly's commit.
- Signing happens only when every signing secret is present.

Any file copied from t3code keeps its MIT notice.

What would make an installer big, measured in `node_modules` on win32-x64 on 2026-09-26:

| Package | On disk |
|---|---|
| `@anthropic-ai/claude-agent-sdk` (JS) | 5 MB |
| `@anthropic-ai/claude-agent-sdk-win32-x64` (the `claude` binary) | 231 MB |
| `node-llama-cpp` (34 MB of it is llama.cpp source) | 40 MB |
| `@node-llama-cpp/win-x64` (CPU) | 47 MB |
| `@node-llama-cpp/win-x64-vulkan` | 99 MB |
| `@node-llama-cpp/win-x64-cuda` | 168 MB |
| `@node-llama-cpp/win-x64-cuda-ext` | 351 MB |

Both packages are already optional:

- The SDK is resolved by name in `runtime/executors.ts` (`AGENT_SDK_MODULE`) and `runtime/limitsRefresh.ts`
  (`sdkClaudeBinary`), and upstream in `agents-api/sdkQuery.ts` (`SDK_SPECIFIER`).
- node-llama-cpp is resolved by name in `runtime/modelRoutes.ts` (`EMBEDDED_MODULE`), and upstream in
  `llm/embedded.ts` (`loadLlamaModule`).

A machine without one of them already gets "not installed" on the Connections page.

The releases repo exists: `git@github.com:ofersadgat/releases.git`, readable anonymously, which
`electron-updater`'s GitHub provider needs. JaiRA itself is proprietary.

## Options

**Where plugins download from:**

| Option | For | Against |
|---|---|---|
| A. Zips built by CI, attached to each release in `ofersadgat/releases` | One file per plugin. Exactly what CI tested. | Redistributes Anthropic's binary. A package two plugins share is stored twice, and every app release re-uploads hundreds of MB. |
| B. CI writes a manifest of exact package tarballs with their integrity hashes; the app downloads each one from `registry.npmjs.org` over HTTPS | No npm needed on the machine. We never redistribute. A shared package is downloaded once. The manifest ships inside the app, so nothing extra is hosted. | Depends on the npm registry being up. The app assembles a `node_modules` tree itself. |
| C. Bundle everything | Nothing to download | An installer over 1 GB on Windows |

**The SQLite binary:** not a blocker, per the person ("we just need to be careful about it"). The
Electron upgrade then removed it outright (§1).

## Decision

**B for plugins.** The person: "the plugins are so big that we want to be careful with duplication…
the different variants should be separate plugins so that the client only downloads what it needs."
They also noted "the problem with npm is that the user might not have it installed". Downloading
tarballs from the registry needs no npm, which answers that. The person then chose the manifest.

### 1. Electron first

Electron 33 is out of support and must be upgraded before updates ship: "we can upgrade electron". t3code
is on 44. The upgrade lands on its own, before any packaging, so what it breaks is not mixed up with
what packaging breaks.

**Done 2026-09-26: Electron 44.4.5.**

- better-sqlite3 12 publishes no prebuild for Electron 44 (ABI 149), so it moved to **13.0.3**.
- 13 is a Node-API addon, and its npm package ships one prebuilt binary per platform under
  `prebuilds/`. Node and Electron load the same file.
- The per-ABI cache was deleted: `scripts/nativeAbi.mjs`, `persistence/src/nativeBinding.ts`, the
  `postinstall` hook and the `abi*` scripts. **The SQLite binary problem is gone**, not merely
  handled.
- Since Electron 42, the `electron` package no longer downloads its binary on install. It downloads
  the first time the `electron` command runs or `require("electron")` is asked for its path. The
  screenshot driver now asks that, instead of hard-coding `dist/electron.exe`.
- `console-message` moved to the event-object form, where `level` is a string (deprecated in 35).
- Nothing else in 34–44's breaking changes touches JaiRA:
  - The clipboard was removed from the renderer in 44, but the renderer already uses
    `navigator.clipboard`.
  - Dialogs default to Downloads since 43.
  - macOS 12, Windows ia32 and Linux armv7l are dropped.

### 2. Packaging

electron-builder runs over a **staged directory**. The stage holds the bundle and a generated
`package.json` whose dependencies are only the runtime externals: `better-sqlite3` and `typescript`.
electron-builder runs with `--publish never`.

- **Stage contents:**
  - `builtin/` ships as an `extraResources` entry, which `paths.ts` already expects.
  - `typescript` is unpacked from the asar, because it reads its own `lib.*.d.ts` from disk, worker
    threads included.
  - `**/*.node` is unpacked.
- **better-sqlite3:**
  - The stage keeps only this platform's file from the package's `prebuilds/` (§1). The package
    ships all eight.
  - CI still launches the packaged app headless and opens a database, so a missing binary fails the
    build instead of the person's first launch.
- **Targets, each architecture built on its own runner:**
  - Windows: `nsis` for x64 and arm64, with `differentialPackage: true`.
  - macOS: `dmg` + `zip` for arm64 and x64. The zip is what Squirrel.Mac updates from.
  - Linux: `AppImage` + `deb`. The deb gets electron-updater's `package-type` marker.
- **Unsigned for now.**
  - The workflow is written with t3code's "sign only when every secret is present" steps, so adding the
    accounts later changes no structure.
  - Windows and Linux update fine unsigned; Windows shows a SmartScreen warning.
  - **macOS cannot auto-update an unsigned app.** Squirrel.Mac requires a signature, so mac updates
    wait for signing. Until then a mac build is a manual download.

### 3. Releases

- **Publishing:**
  - A release publishes to `ofersadgat/releases` with `softprops/action-gh-release`, using its
    `repository:` input.
  - The token is a fine-grained `RELEASES_TOKEN` secret in JaiRA's GitHub repo, with `contents: write`
    on that one repo.
  - GitLab CI keeps only its checks.
- **Triggers:**
  - **A `vX.Y.Z` tag on JaiRA** releases stable. Stable builds the commit of the latest published
    nightly, as t3code does, so what ships as stable is what ran as nightly.
  - **A schedule** checks whether a nightly is due. One is due when at least six hours have passed since
    the last nightly and there are new commits.
  - **A manual run** can release any channel.
- **Versions:**
  - Stable is `X.Y.Z`.
  - Nightly is `X.Y.Z-nightly.YYYYMMDD.N`, where `X.Y.Z` is the next patch.
  - The version is stamped into every workspace `package.json` during the build and never committed
    for a nightly.
- **declarative-ai stays unpinned:** CI builds against its `main`. Each release's notes **record** the
  declarative-ai commit it was built from, which costs nothing and pins nothing.
- **Nightlies** are GitHub prereleases, and only stable is marked latest.

### 4. Updates

- **Library:** stock `electron-updater`, with provider `{github, owner: "ofersadgat", repo: "releases"}`
  written into `app-update.yml` at build time.
- **Disabled** in an unpackaged build and when `JAIRA_DISABLE_AUTO_UPDATE` is set.
- **Checking:** once after start, then hourly. This is not t3code's four minutes: the person has asked
  before for care with polling.
- **Download and install are the person's clicks**, never automatic.
- **Installing is a quit**, so it takes the app's existing quit path. Runs pause and chat turns are
  waited for, exactly as they are on a quit.
- **Before an update installs, the plugins it needs are downloaded** (§6). An update never leaves a
  route that worked broken.
- **Differential download** is turned off when an x64 mac build runs on Apple Silicon, so the next
  download is the arm64 build (t3code's rule).
- **Screens:**
  - an update control in the sidebar;
  - the version and **Update track** under Settings;
  - release notes for a nightly.
  - These are drawn as mockups before they are built.

### 5. Channels

- **Two channels:** `stable` (electron-updater's `latest`) and `nightly`.
- **One install:** there is one app id, so switching channel replaces the installed app.
- **The setting:** `updates.channel` in the personal ("Just you") layer, because a channel belongs to
  the machine, not to a project. Its default is the channel of the installed build.
- **Switching:** a switch allows one downgrade on the next check, so nightly can go back to stable.
- **Filtering:** an `update-available` whose version belongs to the other channel is ignored.

### 6. Plugins

**A plugin is what the person installs. A package is what is stored.** A plugin names a set of exact
packages. Each package is stored once and shared by every plugin and plugin version that names it.

**The plugins:**

| Plugin | Packages | Offered when |
|---|---|---|
| `claude-agent-sdk` | the SDK and this platform's `claude-agent-sdk-<platform>-<arch>` | always |
| `llama` | `node-llama-cpp` and its 28 dependencies | always |
| `llama-cpu` | `@node-llama-cpp/<platform>-<arch>` | always |
| `llama-vulkan` | `…-vulkan` | a Vulkan loader is present (`vulkan-1.dll`, `libvulkan.so.1`) |
| `llama-cuda`, `llama-cuda-ext` | `…-cuda`, `…-cuda-ext` | an NVIDIA driver is present (`nvcuda.dll`, `libcuda.so.1`) and new enough |
| `llama-metal` | `@node-llama-cpp/mac-arm64-metal` | macOS on arm64 |

The person picks one `llama-*` variant, and the Connections page offers the best one it detects. The
list is built from the lockfile's `os` and `cpu` fields, so a platform with no package gets no row.

**Versions:**

- A plugin's version is its library's version: `claude-agent-sdk@0.3.282`, `llama@3.21.1`.
- A suffix `+rN` is added only when the manifest changes for the same library version. The person:
  "tied to the package library version with perhaps a library suffix if the abi changes".
- Such changes should be rare:
  - The Claude plugin is a standalone executable with no Node ABI.
  - node-llama-cpp's binaries use Node-API, which stays compatible across Electron versions.
- So upgrading Electron does not force a download.

**The manifest:**

- CI derives it from `package-lock.json`. The lock already holds each package's `resolved` URL,
  `integrity`, `os`, `cpu` and dependencies.
- It ships inside the app as `resources/plugins.json`, and the npm CLI carries it in its `dist`.
- Each build names the plugin versions it wants.
- Nothing is hosted beyond the registry itself.

**Download and storage:**

- Each tarball is fetched from its `resolved` URL and checked against `integrity` (sha512) before it is
  unpacked.
- Packages are unpacked into `~/.jaira/plugins/store/<name>@<version>/`.
- A plugin version gets `~/.jaira/plugins/<plugin>@<version>/node_modules`, a pnpm-style tree of links
  into the store. On Windows these are directory junctions, which need no admin rights.
- **Removing is never a recursive delete through a link.** Once, MSYS `rm -rf` followed a junction and
  wiped a sibling repo. Links are unlinked, and store entries no plugin version names are deleted.
- The store is shared by stable, nightly and the npm CLI.

**Loading:** JaiRA resolves the entry point inside the plugin's tree and loads it with
`import(pathToFileURL(entry))`. `require` is not an option, because node-llama-cpp is ESM-only with
top-level `await`.

**declarative-ai learns nothing about plugins.** The person: "declarative ai shouldnt know anything about
application concerns; its a library. perhaps it should be passed the root reference?"

- Each of its three runtime imports takes an injected loader, `load?: () => Promise<Module>`, defaulting
  to today's import by name:
  - the SDK, `sdkQuery.ts:531`;
  - the MCP SDK, `sdkQuery.ts:402-403`;
  - node-llama-cpp, `embedded.ts:130`.
- JaiRA passes loaders that read from its plugin store.
- A folder path is deliberately not passed, because a path would still teach the library where things
  live.

**The SDK's peer dependencies:** `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk` and `zod`. `sdk.mjs`
imports none of them at run time, so they appear to be for types only. The first build verifies this;
any that is needed joins the plugin.

**The Connections page:**

- A route that needs a plugin shows it and its size, with a **Download** button, progress, the
  installed version and **Remove**. It is drawn as a mockup first.
- The `claude-agent-sdk` plugin also improves the **claude-cli** route's usage readings.
  `sdkClaudeBinary` prefers the SDK's newer `claude`, because an older installed `claude` refuses
  `get_usage`. The page says so.

**Updating plugins:**

- An app update that names a newer plugin version downloads it before installing (§4).
- The old version stays until nothing names it.
- The CLI gets `jaira plugin list|install|remove`.

**Licences:**

- Plugin packages leave the installer's notices.
- Settings → Licenses lists the notices of the installed plugins, read from their unpacked packages.
- Before the `claude-agent-sdk` download, the page links Anthropic's terms, because the person downloads
  it from npm under those terms and we do not redistribute it.

### 7. The `jaira` command from the installer

The person chose the installer: "4 installer", and "keep it as the cli should also be capable of
starting the server", which keeps the npm package too.

- **How it runs:** the installer ships a `jaira` wrapper in `resources/bin` that runs the CLI bundle on
  the app's own Electron with `ELECTRON_RUN_AS_NODE=1`. The command and the app then share one
  better-sqlite3 build and one plugin store, and no Node install is needed.
- **Putting it on PATH:**
  - Windows: NSIS adds it.
  - Linux `.deb`: a link in `/usr/bin`.
  - macOS and AppImage: a one-time **Install the jaira command** action, like VS Code's `code`. On macOS
    it asks for admin rights.
- **The npm package `@jaira/cli`** is still published. It runs on Node, with Node's better-sqlite3 build.

## Build order

1. The Electron upgrade.
2. Packaging, run as unsigned local builds on all three platforms, including the headless open-a-database
   smoke test.
3. The release workflow to `ofersadgat/releases`, nightly and stable.
4. The updater and channels in main, then the screens after their mockups.
5. The loader injection in declarative-ai.
6. The plugin manifest generator, the store and the loader, followed by the CLI's `plugin` command.
7. The Connections page's plugin rows, after their mockups. Then remove both packages from the app's
   dependencies.
8. The installer's `jaira` command.

## Consequences

**Easier:**

- A base installer without either plugin, and a download of only the variant a machine can use.
- A package downloaded once however many plugins name it.
- Updates that never break a working route.

**Harder:**

- JaiRA now assembles a `node_modules` tree itself and must get junction removal right.
- The registry must be up for a first download.

**Foreclosed for now:** macOS auto-update, until the app is signed.

## Revisit when

- The registry is unreachable often enough to matter. Mirror the manifest's tarballs to the releases
  repo; the manifest shape already allows a second URL.
- A plugin needs a native module built against Electron's ABI. Then `+rN` versions per Electron ABI
  become routine, not rare.
- Signing accounts exist. Enable the signing steps and macOS updates.
