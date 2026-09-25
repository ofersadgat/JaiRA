/**
 * The third-party notice manifest the build writes for Settings → Licenses (`licenses/thirdPartyLicenses.ts`),
 * after t3code's `third-party-licenses.test.ts`: t3code's cases, plus what this app's two builds add
 * — the main build's module list, the `installed` fallback tag, and walking through first-party packages
 * — and a check that the committed config builds offline.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  generateThirdPartyLicenseManifest,
  moduleFilePath,
  THIRD_PARTY_LICENSES_FILE_NAME,
  thirdPartyLicensesPlugin,
} from "../licenses/thirdPartyLicenses";
import { commercialUseProblem } from "../licenses/commercialUse";

const tempDirectories: string[] = [];
const LICENSES_DIRECTORY = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "../licenses");

async function writeJson(path: string, value: unknown): Promise<void> {
  await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
  await NodeFSP.writeFile(path, `${JSON.stringify(value)}\n`, "utf8");
}

async function createFixture(): Promise<{ readonly appManifest: string; readonly configFile: string; readonly dependencyRoot: string; readonly root: string }> {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "jaira-licenses-"));
  tempDirectories.push(root);
  const appManifest = NodePath.join(root, "package.json");
  const dependencyRoot = NodePath.join(root, "node_modules", "demo-dependency");
  const configFile = NodePath.join(root, "config.json");

  await writeJson(appManifest, { name: "fixture-app", dependencies: { "demo-dependency": "1.2.3" } });
  await writeJson(NodePath.join(dependencyRoot, "package.json"), {
    name: "demo-dependency",
    version: "1.2.3",
    license: "MIT",
    main: "index.js",
    repository: "example/demo-dependency",
  });
  await NodeFSP.writeFile(NodePath.join(dependencyRoot, "index.js"), "export {};\n", "utf8");
  await NodeFSP.writeFile(NodePath.join(dependencyRoot, "LICENSE"), "Demo MIT license text\n", "utf8");
  await NodeFSP.writeFile(NodePath.join(root, "asset-notice.txt"), "Asset notice text\n", "utf8");
  await writeJson(configFile, {
    customNotices: [{ name: "demo-asset", license: "CC-BY-4.0", noticeFile: "asset-notice.txt", bundles: ["assets", "window"] }],
    packageOverrides: [],
  });
  return { appManifest, configFile, dependencyRoot, root };
}

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => NodeFSP.rm(directory, { force: true, recursive: true })));
});

describe("third-party license generation", () => {
  it("collects production packages and custom asset notices", async () => {
    const fixture = await createFixture();
    const manifest = await generateThirdPartyLicenseManifest({
      configFile: fixture.configFile,
      packageManifests: [{ bundle: "window", path: fixture.appManifest }],
    });

    expect(manifest).toEqual({
      schemaVersion: 1,
      entries: [
        { bundles: ["assets", "window"], kind: "custom", license: "CC-BY-4.0", name: "demo-asset", noticeText: "Asset notice text", sourceUrl: null, version: null },
        {
          bundles: ["window"],
          kind: "package",
          license: "MIT",
          name: "demo-dependency",
          noticeText: "Demo MIT license text",
          sourceUrl: "https://github.com/example/demo-dependency",
          version: "1.2.3",
        },
      ],
    });
  });

  it("renders generated notices from the committed SPDX templates", async () => {
    const fixture = await createFixture();
    await writeJson(NodePath.join(fixture.root, "spdx/v3.28.0/MIT.json"), {
      licenseId: "MIT",
      licenseText: "MIT License\n\nCopyright (c) <year> <copyright holders>\n\nPermission text",
    });
    await writeJson(fixture.configFile, {
      customNotices: [
        {
          name: "generated-asset",
          license: "MIT",
          generatedNotices: [{ licenseId: "MIT", copyrights: ["Copyright (c) 2026 Example Author"], preamble: ["Adapted for JaiRA."] }],
          bundles: ["assets", "window"],
        },
      ],
      packageOverrides: [],
    });

    const manifest = await generateThirdPartyLicenseManifest({ configFile: fixture.configFile, packageManifests: [{ bundle: "window", path: fixture.appManifest }] });

    expect(manifest.entries.find((entry) => entry.name === "generated-asset")?.noticeText).toBe(
      "Adapted for JaiRA.\n\nMIT License\n\nCopyright (c) 2026 Example Author\n\nPermission text",
    );
  });

  it("omits generated rows with no template when missing ones are allowed", async () => {
    const fixture = await createFixture();
    await writeJson(fixture.configFile, {
      customNotices: [{ name: "generated-asset", license: "MIT", generatedNotices: [{ licenseId: "MIT" }], bundles: ["assets", "window"] }],
      packageOverrides: [],
    });

    const manifest = await generateThirdPartyLicenseManifest({
      configFile: fixture.configFile,
      packageManifests: [{ bundle: "window", path: fixture.appManifest }],
      allowMissingGeneratedNotices: true,
    });

    expect(manifest.entries.some((entry) => entry.name === "generated-asset")).toBe(false);
  });

  it("finds packages whose exports hide both their manifest and entry point", async () => {
    const fixture = await createFixture();
    await writeJson(NodePath.join(fixture.dependencyRoot, "package.json"), {
      name: "demo-dependency",
      version: "1.2.3",
      license: "MIT",
      exports: {},
      repository: "example/demo-dependency",
    });

    const manifest = await generateThirdPartyLicenseManifest({ configFile: fixture.configFile, packageManifests: [{ bundle: "window", path: fixture.appManifest }] });

    expect(manifest.entries.some((entry) => entry.name === "demo-dependency")).toBe(true);
  });

  it("fails when a production package has no distributable notice text", async () => {
    const fixture = await createFixture();
    await NodeFSP.rm(NodePath.join(fixture.dependencyRoot, "LICENSE"));

    await expect(
      generateThirdPartyLicenseManifest({ configFile: fixture.configFile, packageManifests: [{ bundle: "window", path: fixture.appManifest }] }),
    ).rejects.toThrow("does not include a license or notice file");
  });

  it("fails when a production package declares no license, or an undistributable one", async () => {
    const fixture = await createFixture();
    await writeJson(NodePath.join(fixture.dependencyRoot, "package.json"), { name: "demo-dependency", version: "1.2.3", license: "UNLICENSED", main: "index.js" });

    await expect(
      generateThirdPartyLicenseManifest({ configFile: fixture.configFile, packageManifests: [{ bundle: "window", path: fixture.appManifest }] }),
    ).rejects.toThrow("does not declare a distributable license");
  });

  it("collects nested notices even when a package also has a root license", async () => {
    const fixture = await createFixture();
    await NodeFSP.mkdir(NodePath.join(fixture.dependencyRoot, "dist", "third-party"), { recursive: true });
    await NodeFSP.mkdir(NodePath.join(fixture.dependencyRoot, "lib"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(fixture.dependencyRoot, "dist", "third-party", "NOTICE.txt"), "Nested notice\n", "utf8");
    await NodeFSP.writeFile(NodePath.join(fixture.dependencyRoot, "lib", "license_header.js"), "require('not-a-license');\n", "utf8");

    const manifest = await generateThirdPartyLicenseManifest({ configFile: fixture.configFile, packageManifests: [{ bundle: "window", path: fixture.appManifest }] });

    // Forward slashes on every machine, Windows included.
    expect(manifest.entries.find((entry) => entry.name === "demo-dependency")?.noticeText).toBe(
      "dist/third-party/NOTICE.txt\n\nNested notice\n\n---\n\nLICENSE\n\nDemo MIT license text",
    );
  });

  it("uses package overrides for notices published outside the npm archive", async () => {
    const fixture = await createFixture();
    await NodeFSP.rm(NodePath.join(fixture.dependencyRoot, "LICENSE"));
    await NodeFSP.writeFile(NodePath.join(fixture.root, "override.txt"), "Override text\n", "utf8");
    await writeJson(fixture.configFile, { customNotices: [], packageOverrides: [{ name: "demo-dependency", noticeFile: "override.txt" }] });

    const manifest = await generateThirdPartyLicenseManifest({ configFile: fixture.configFile, packageManifests: [{ bundle: "window", path: fixture.appManifest }] });

    expect(manifest.entries[0]?.noticeText).toBe("Override text");
  });

  it("keeps all licenses and attributions in a package with multiple generated notices", async () => {
    const fixture = await createFixture();
    await NodeFSP.rm(NodePath.join(fixture.dependencyRoot, "LICENSE"));
    for (const licenseId of ["Apache-2.0", "BSD-3-Clause"]) {
      await writeJson(NodePath.join(fixture.root, `spdx/v3.28.0/${licenseId}.json`), { licenseId, licenseText: `${licenseId} terms` });
    }
    await writeJson(fixture.configFile, {
      packageOverrides: [
        {
          name: "demo-dependency",
          license: "(Apache-2.0 AND BSD-3-Clause)",
          generatedNotices: [
            { licenseId: "Apache-2.0", copyrights: ["Copyright primary author"] },
            { licenseId: "BSD-3-Clause", copyrights: ["Copyright vendored author"] },
          ],
        },
      ],
    });
    const manifest = await generateThirdPartyLicenseManifest({ configFile: fixture.configFile, packageManifests: [{ bundle: "window", path: fixture.appManifest }] });
    expect(manifest.entries[0]?.license).toBe("(Apache-2.0 AND BSD-3-Clause)");
    expect(manifest.entries[0]?.noticeText).toBe("Copyright primary author\n\nApache-2.0 terms\n\n---\n\nCopyright vendored author\n\nBSD-3-Clause terms");
  });

  it("rejects conflicting package notice sources", async () => {
    const fixture = await createFixture();
    await writeJson(fixture.configFile, {
      packageOverrides: [{ name: "demo-dependency", generatedNotice: { licenseId: "MIT" }, generatedNotices: [{ licenseId: "BSD-3-Clause" }] }],
    });
    await expect(
      generateThirdPartyLicenseManifest({ configFile: fixture.configFile, packageManifests: [{ bundle: "window", path: fixture.appManifest }] }),
    ).rejects.toThrow("can define only one");
  });

  it("applies repository overrides across monorepo packages", async () => {
    const fixture = await createFixture();
    await NodeFSP.rm(NodePath.join(fixture.dependencyRoot, "LICENSE"));
    await NodeFSP.writeFile(NodePath.join(fixture.root, "override.txt"), "Repository text\n", "utf8");
    await writeJson(fixture.configFile, {
      customNotices: [],
      packageOverrides: [{ repositoryUrl: "https://github.com/example/demo-dependency", noticeFile: "override.txt" }],
    });

    const manifest = await generateThirdPartyLicenseManifest({ configFile: fixture.configFile, packageManifests: [{ bundle: "window", path: fixture.appManifest }] });

    expect(manifest.entries[0]?.noticeText).toBe("Repository text");
  });

  it("reuses a repository license for packages from the same monorepo", async () => {
    const fixture = await createFixture();
    const siblingRoot = NodePath.join(fixture.root, "node_modules", "demo-sibling");
    await writeJson(fixture.appManifest, { name: "fixture-app", dependencies: { "demo-dependency": "1.2.3", "demo-sibling": "2.0.0" } });
    await writeJson(NodePath.join(siblingRoot, "package.json"), {
      name: "demo-sibling",
      version: "2.0.0",
      license: "MIT",
      main: "index.js",
      repository: "https://github.com/example/demo-dependency.git#main",
    });
    await NodeFSP.writeFile(NodePath.join(siblingRoot, "index.js"), "export {};\n", "utf8");

    const manifest = await generateThirdPartyLicenseManifest({ configFile: fixture.configFile, packageManifests: [{ bundle: "window", path: fixture.appManifest }] });

    expect(manifest.entries.find((entry) => entry.name === "demo-sibling")?.noticeText).toBe("Demo MIT license text");
  });

  it("prefers version-specific repository overrides", async () => {
    const fixture = await createFixture();
    await NodeFSP.writeFile(NodePath.join(fixture.root, "generic.txt"), "Generic text\n", "utf8");
    await NodeFSP.writeFile(NodePath.join(fixture.root, "exact.txt"), "Exact text\n", "utf8");
    await writeJson(fixture.configFile, {
      customNotices: [],
      packageOverrides: [
        { repositoryUrl: "https://github.com/example/demo-dependency", noticeFile: "generic.txt" },
        { repositoryUrl: "https://github.com/example/demo-dependency", version: "1.2.3", noticeFile: "exact.txt" },
      ],
    });

    const manifest = await generateThirdPartyLicenseManifest({ configFile: fixture.configFile, packageManifests: [{ bundle: "window", path: fixture.appManifest }] });

    expect(manifest.entries[0]?.noticeText).toBe("Exact text");
  });

  it("omits custom notices for other bundles", async () => {
    const fixture = await createFixture();
    const manifest = await generateThirdPartyLicenseManifest({ configFile: fixture.configFile, packageManifests: [{ bundle: "main", path: fixture.appManifest }] });
    expect(manifest.entries.some((entry) => entry.name === "demo-asset")).toBe(false);
  });

  it("shows a multi-file notice under a label that differs from the bundles that include it", async () => {
    const fixture = await createFixture();
    await NodeFSP.writeFile(NodePath.join(fixture.root, "shell-license.txt"), "Shell license\n", "utf8");
    await NodeFSP.writeFile(NodePath.join(fixture.root, "engine-notice.txt"), "Engine notice\n", "utf8");
    await writeJson(fixture.configFile, {
      customNotices: [
        {
          name: "runtime-shell",
          license: "MIT",
          noticeFiles: ["shell-license.txt", "engine-notice.txt"],
          bundles: ["runtime"],
          includeInBundles: ["main"],
        },
      ],
      packageOverrides: [],
    });

    const manifest = await generateThirdPartyLicenseManifest({ configFile: fixture.configFile, packageManifests: [{ bundle: "main", path: fixture.appManifest }] });

    expect(manifest.entries.find((entry) => entry.name === "runtime-shell")).toMatchObject({ bundles: ["runtime"], noticeText: "Shell license\n\n---\n\nEngine notice" });
  });

  it("fails when a custom notice file is empty", async () => {
    const fixture = await createFixture();
    await NodeFSP.writeFile(NodePath.join(fixture.root, "asset-notice.txt"), "\n", "utf8");

    await expect(
      generateThirdPartyLicenseManifest({ configFile: fixture.configFile, packageManifests: [{ bundle: "window", path: fixture.appManifest }] }),
    ).rejects.toThrow('Custom third-party notice "demo-asset" is empty');
  });

  it("fails generation when custom notices produce duplicate entries", async () => {
    const fixture = await createFixture();
    await writeJson(fixture.configFile, {
      customNotices: [
        { name: "duplicate-asset", license: "MIT", noticeFile: "asset-notice.txt", bundles: ["assets", "window"] },
        { name: "duplicate-asset", license: "CC0-1.0", noticeFile: "asset-notice.txt", bundles: ["assets", "window"] },
      ],
      packageOverrides: [],
    });

    await expect(
      generateThirdPartyLicenseManifest({ configFile: fixture.configFile, packageManifests: [{ bundle: "window", path: fixture.appManifest }] }),
    ).rejects.toThrow("duplicate custom notice for duplicate-asset");
  });
});

describe("JaiRA's two builds", () => {
  it("walks through first-party packages to their dependencies without listing them", async () => {
    const fixture = await createFixture();
    const firstParty = NodePath.join(fixture.root, "node_modules", "@declarative-ai", "llm");
    await writeJson(fixture.appManifest, { name: "fixture-app", dependencies: { "@declarative-ai/llm": "*", "@jaira/shared": "*" } });
    await writeJson(NodePath.join(firstParty, "package.json"), { name: "@declarative-ai/llm", version: "0.0.0", dependencies: { "demo-dependency": "1.2.3" } });
    await writeJson(NodePath.join(fixture.root, "node_modules", "@jaira", "shared", "package.json"), { name: "@jaira/shared", version: "0.0.0" });

    const manifest = await generateThirdPartyLicenseManifest({ configFile: fixture.configFile, packageManifests: [{ bundle: "window", path: fixture.appManifest }] });

    expect(manifest.entries.filter((entry) => entry.kind === "package").map((entry) => entry.name)).toEqual(["demo-dependency"]);
  });

  it("tags a bundled package with its bundles and drops the fallback tag; an unbundled one keeps it", async () => {
    const fixture = await createFixture();
    const otherRoot = NodePath.join(fixture.root, "node_modules", "demo-native");
    await writeJson(fixture.appManifest, { name: "fixture-app", dependencies: { "demo-dependency": "1.2.3", "demo-native": "1.0.0" } });
    await writeJson(NodePath.join(otherRoot, "package.json"), { name: "demo-native", version: "1.0.0", license: "ISC" });
    await NodeFSP.writeFile(NodePath.join(otherRoot, "LICENSE"), "Native text\n", "utf8");
    const bundledFile = NodePath.join(fixture.dependencyRoot, "index.js");

    const manifest = await generateThirdPartyLicenseManifest({
      configFile: fixture.configFile,
      packageManifests: [{ bundle: "installed", path: fixture.appManifest, fallback: true }],
      bundledModules: [
        { bundle: "window", moduleIds: [bundledFile.replaceAll("\\", "/"), "\0vite/preload-helper", "virtual:x"] },
        { bundle: "main", moduleIds: [bundledFile] },
      ],
    });

    const bundles = Object.fromEntries(manifest.entries.map((entry) => [entry.name, entry.bundles]));
    expect(bundles["demo-dependency"]).toEqual(["main", "window"]);
    expect(bundles["demo-native"]).toEqual(["installed"]);
  });

  it("reads a Rollup or esbuild id as a file only when it is under node_modules", () => {
    expect(moduleFilePath("\0commonjsHelpers.js")).toBeNull();
    expect(moduleFilePath("/src/renderer/App.tsx")).toBeNull();
    expect(moduleFilePath("C:/repo/node_modules/react/index.js?commonjs-es-import")).toBe("C:/repo/node_modules/react/index.js");
    expect(moduleFilePath("C:\\repo\\node_modules\\react\\index.js")).toBe("C:\\repo\\node_modules\\react\\index.js");
  });

  it("writes the manifest beside the renderer from its chunks and the main build's module list", async () => {
    const fixture = await createFixture();
    const moduleList = NodePath.join(fixture.root, "main-modules.json");
    await writeJson(moduleList, [NodePath.join(fixture.dependencyRoot, "index.js")]);
    const plugin = thirdPartyLicensesPlugin({
      bundleName: "window",
      configFile: fixture.configFile,
      packageManifests: [{ bundle: "installed", path: fixture.appManifest, fallback: true }],
      moduleLists: [{ bundle: "main", file: moduleList }],
    });
    const emitted: { fileName: string; source: string }[] = [];
    await plugin.generateBundle.call({ emitFile: (file) => (emitted.push(file), "id") }, {}, { "index.js": { type: "chunk", modules: {} } });

    expect(emitted.map((file) => file.fileName)).toEqual([THIRD_PARTY_LICENSES_FILE_NAME]);
    const manifest = JSON.parse(emitted[0]!.source) as { entries: { name: string; bundles: string[] }[] };
    expect(manifest.entries.find((entry) => entry.name === "demo-dependency")?.bundles).toEqual(["main"]);
    // The custom notice is gated on `window`, which is this build's own tag.
    expect(manifest.entries.some((entry) => entry.name === "demo-asset")).toBe(true);
  });

  it("refuses to build without the main build's module list, and says how to get it", async () => {
    const fixture = await createFixture();
    const plugin = thirdPartyLicensesPlugin({
      bundleName: "window",
      configFile: fixture.configFile,
      packageManifests: [{ bundle: "installed", path: fixture.appManifest, fallback: true }],
      moduleLists: [{ bundle: "main", file: NodePath.join(fixture.root, "absent.json") }],
    });
    await expect(plugin.generateBundle.call({ emitFile: () => "id" }, {}, {})).rejects.toThrow("build:main");
  });
});

describe("commercial use", () => {
  it("reads SPDX expressions: OR takes any branch, AND needs every part, WITH is judged by its license", () => {
    expect(commercialUseProblem("MIT")).toBeNull();
    expect(commercialUseProblem("(MPL-2.0 OR Apache-2.0)")).toBeNull();
    expect(commercialUseProblem("(MIT OR GPL-3.0-only)")).toBeNull();
    expect(commercialUseProblem("MIT AND BSD-3-Clause")).toBeNull();
    expect(commercialUseProblem("(MIT AND (Apache-2.0 OR GPL-2.0-only))")).toBeNull();
    expect(commercialUseProblem("Apache-2.0 WITH LLVM-exception")).toBeNull();
    expect(commercialUseProblem("GPL-3.0-or-later WITH GCC-exception-3.1")).toBeNull();
    expect(commercialUseProblem("MIT AND GPL-3.0-only")).toContain("not on the commercial-use list");
  });

  it("refuses copyleft that reaches the whole work, non-commercial terms and source-available licenses", () => {
    for (const license of ["GPL-2.0-only", "GPL-3.0-or-later", "AGPL-3.0-only", "LGPL-2.1-only", "CC-BY-NC-4.0", "CC-BY-NC-SA-4.0", "SSPL-1.0", "BUSL-1.1", "Elastic-2.0"]) {
      expect(commercialUseProblem(license), license).not.toBeNull();
    }
  });

  it("refuses a license it cannot read, rather than guessing", () => {
    expect(commercialUseProblem("SEE LICENSE IN LICENSE.md")).not.toBeNull();
    expect(commercialUseProblem("(MIT OR")).not.toBeNull();
  });

  it("allows every license the app ships — each package it bundles or installs, and each hand-written notice", async () => {
    // The dependency walk reaches every package the two bundles hold (checked against a built manifest
    // on 2026-09-24: the only entries it lacked were the config's, which are gated on `main`/`window`);
    // the empty module lists open that gate, so the check needs no build first.
    const manifest = await generateThirdPartyLicenseManifest({
      configFile: NodePath.join(LICENSES_DIRECTORY, "config.json"),
      packageManifests: [{ bundle: "installed", path: NodePath.join(LICENSES_DIRECTORY, "..", "package.json"), fallback: true }],
      bundledModules: [
        { bundle: "main", moduleIds: [] },
        { bundle: "window", moduleIds: [] },
      ],
    });
    expect(manifest.entries.length).toBeGreaterThan(300);
    const problems = manifest.entries.flatMap((entry) => {
      const problem = commercialUseProblem(entry.license);
      return problem === null ? [] : [`${entry.name}${entry.version !== null ? `@${entry.version}` : ""}: ${problem}`];
    });
    expect(problems).toEqual([]);
  }, 60_000);
});

describe("the committed licenses config", () => {
  it("builds offline: every SPDX template it names is committed, and every notice file exists", async () => {
    const config = JSON.parse(await NodeFSP.readFile(NodePath.join(LICENSES_DIRECTORY, "config.json"), "utf8")) as {
      customNotices: { name: string; noticeFile?: string; noticeFiles?: string[]; generatedNotices?: { licenseId: string }[] }[];
      packageOverrides: { noticeFile?: string; generatedNotice?: { licenseId: string }; generatedNotices?: { licenseId: string }[] }[];
    };
    const licenseIds = [
      ...config.customNotices.flatMap((notice) => notice.generatedNotices ?? []),
      ...config.packageOverrides.flatMap((override) => [...(override.generatedNotice ? [override.generatedNotice] : []), ...(override.generatedNotices ?? [])]),
    ].map((notice) => notice.licenseId);
    for (const licenseId of new Set(licenseIds)) {
      await expect(NodeFSP.access(NodePath.join(LICENSES_DIRECTORY, "spdx", "v3.28.0", `${licenseId}.json`)), licenseId).resolves.toBeUndefined();
    }
    const files = [
      ...config.customNotices.flatMap((notice) => [...(notice.noticeFile ? [notice.noticeFile] : []), ...(notice.noticeFiles ?? [])]),
      ...config.packageOverrides.flatMap((override) => (override.noticeFile ? [override.noticeFile] : [])),
    ];
    for (const file of files) {
      await expect(NodeFSP.access(NodePath.resolve(LICENSES_DIRECTORY, file)), file).resolves.toBeUndefined();
    }
  });
});
