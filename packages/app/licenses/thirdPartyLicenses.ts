/**
 * The third-party notice manifest — what the Licenses page (Settings → Licenses) lists.
 *
 * A port of t3code's `scripts/lib/third-party-licenses.ts` (pingdotgg/t3code), reshaped for the two
 * builds this app has where t3code has one:
 *
 *  - **The dependency walk.** From `packages/app/package.json`, every `dependencies` and
 *    `optionalDependencies` entry, recursively, through `node_modules` — including THROUGH the
 *    first-party packages (`@jaira/*`, `@declarative-ai/*`), whose own dependencies ship too, though
 *    they themselves are not listed. The walk is what finds a package nothing bundles: Electron's
 *    natives, the TypeScript compiler, SQLite, which the main build keeps external.
 *  - **The bundles.** Every module id the Vite renderer build put in a chunk (`window`), and every
 *    input the esbuild main build (`main.cjs`, the preload, both workers) read from `node_modules`,
 *    which `build.mjs` writes to `dist/main-modules.json` because it runs first and is a different
 *    bundler (`main`). A package that is in a bundle is tagged with that bundle; the walk's own tag
 *    (`installed`) is kept only for a package no bundle contains, so the tag says where the code is.
 *
 * For each package: its declared license (`package.json#license`, or the legacy `licenses` array),
 * and the text of every LICENSE/COPYING/NOTICE file at its root and up to three directories down.
 * Packages from one repository under one license share a notice when one of them has none of its own.
 * A package that declares no distributable license, or ships no notice anywhere, FAILS the build with
 * a message naming it — the fix is an entry in `licenses/config.json`, never silence.
 *
 * `licenses/config.json` holds what is not an npm package (`customNotices`: the Electron shell, the
 * fonts, the embedded Monokai Light theme) and per-package corrections (`packageOverrides`). Either
 * may give its text as a file or as an SPDX license template rendered with a copyright line
 * (`generatedNotices`); the templates come from the SPDX license list at a pinned revision and are
 * committed under `licenses/spdx/`, so a build never needs the network — `npm run licenses:sync`
 * fetches any the config newly names.
 *
 * The output is `dist/renderer/third-party-licenses.json`, read by main on `licenses:read`.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeModule from "node:module";

import {
  THIRD_PARTY_LICENSES_FILE_NAME,
  type ThirdPartyLicenseEntry,
  type ThirdPartyLicenseManifest,
} from "../../shared/src/thirdPartyLicenses";

export { THIRD_PARTY_LICENSES_FILE_NAME };
export type { ThirdPartyLicenseEntry, ThirdPartyLicenseManifest };

const SPDX_LICENSE_LIST_VERSION = "v3.28.0";
const SPDX_LICENSE_LIST_REVISION = "c4a7237ec8f4654e867546f9f409749300f1bf4c";
/** Beside the config, and committed: see the header. */
const GENERATED_NOTICE_CACHE_DIRECTORY = "spdx";

export interface ThirdPartyLicensePackageManifest {
  readonly bundle: string;
  readonly path: string | URL;
  /**
   * The walk from this manifest tags only what no bundle contains: a package some bundle holds keeps
   * that bundle's tag alone. Without it, every package the renderer bundles would also read
   * "installed", which is true of every package and so says nothing.
   */
  readonly fallback?: boolean;
}

export interface BundledModules {
  readonly bundle: string;
  readonly moduleIds: ReadonlyArray<string>;
}

export interface ThirdPartyLicensesPluginOptions {
  readonly configFile?: string | URL;
  readonly packageManifests: ReadonlyArray<ThirdPartyLicensePackageManifest>;
  /** The tag this Vite build's own chunks give their packages. */
  readonly bundleName: string;
  /** Other bundles' module lists, as JSON arrays of paths on disk — the main build's, written first. */
  readonly moduleLists?: ReadonlyArray<{ readonly bundle: string; readonly file: string | URL }>;
}

interface GeneratedNoticeConfigEntry {
  readonly copyrights?: ReadonlyArray<string>;
  readonly licenseId: string;
  readonly preamble?: ReadonlyArray<string>;
}

interface PackageJson {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly homepage?: unknown;
  readonly license?: unknown;
  readonly licenses?: unknown;
  readonly name?: unknown;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly repository?: unknown;
  readonly version?: unknown;
}

interface CustomNoticeConfigEntry {
  readonly bundles?: ReadonlyArray<string>;
  readonly includeInBundles?: ReadonlyArray<string>;
  readonly license: string;
  readonly name: string;
  readonly generatedNotices?: ReadonlyArray<GeneratedNoticeConfigEntry>;
  readonly noticeFiles?: ReadonlyArray<string>;
  readonly sourceUrl?: string;
  readonly version?: string;
}

interface PackageNoticeOverrideConfigEntry {
  readonly generatedNotices?: ReadonlyArray<GeneratedNoticeConfigEntry>;
  readonly license?: string;
  readonly name?: string;
  readonly noticeFile?: string;
  readonly repositoryUrl?: string;
  readonly sourceUrl?: string;
  readonly version?: string;
}

interface ThirdPartyLicensesConfig {
  readonly customNotices: ReadonlyArray<CustomNoticeConfigEntry>;
  readonly packageOverrides: ReadonlyArray<PackageNoticeOverrideConfigEntry>;
}

interface SpdxLicenseDetails {
  readonly licenseId: string;
  readonly licenseText: string;
}

interface CollectedPackage {
  readonly bundles: Set<string>;
  readonly packageJson: PackageJson;
  readonly packageRoot: string;
}

interface PackageCollection {
  readonly byIdentity: Map<string, CollectedPackage>;
}

const EMPTY_CONFIG: ThirdPartyLicensesConfig = { customNotices: [], packageOverrides: [] };

const NOTICE_FILE_PATTERN = /^(?:licen[cs]e|copying|notice)(?:[._-].*)?$/i;
const NOTICE_TEXT_EXTENSIONS = new Set([
  "",
  ".0bsd",
  ".agpl",
  ".apache2",
  ".bsd",
  ".gpl",
  ".isc",
  ".lgpl",
  ".markdown",
  ".md",
  ".mit",
  ".mpl",
  ".mpl2",
  ".rst",
  ".txt",
  ".unlicense",
]);
/** JaiRA's own packages, and declarative-ai's, which it is built on: walked through, never listed. */
const FIRST_PARTY_PACKAGE_PREFIXES = ["@jaira/", "@declarative-ai/"];

function isFirstParty(name: string): boolean {
  return name === "jaira" || FIRST_PARTY_PACKAGE_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function isNoticeTextFile(fileName: string): boolean {
  return NOTICE_FILE_PATTERN.test(fileName) && NOTICE_TEXT_EXTENSIONS.has(NodePath.extname(fileName).toLowerCase());
}

function asPath(value: string | URL): string {
  return value instanceof URL ? NodeURL.fileURLToPath(value) : NodePath.resolve(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | null {
  return isRecord(error) && typeof error.code === "string" ? error.code : null;
}

function readRequiredString(value: Record<string, unknown>, key: string, context: string): string {
  const field = value[key];
  if (typeof field !== "string" || field.trim().length === 0) {
    throw new Error(`${context} must define a non-empty "${key}" string.`);
  }
  return field.trim();
}

function readOptionalString(value: Record<string, unknown>, key: string, context: string): string | undefined {
  const field = value[key];
  if (field === undefined) return undefined;
  if (typeof field !== "string" || field.trim().length === 0) {
    throw new Error(`${context} must define "${key}" as a non-empty string when present.`);
  }
  return field.trim();
}

function readOptionalStringArray(value: Record<string, unknown>, key: string, context: string): ReadonlyArray<string> | undefined {
  const field = value[key];
  if (field === undefined) return undefined;
  if (!Array.isArray(field) || field.length === 0 || field.some((entry) => typeof entry !== "string" || entry.trim().length === 0)) {
    throw new Error(`${context} must define "${key}" as a non-empty string array.`);
  }
  return field.map((entry) => (entry as string).trim());
}

function decodeGeneratedNotice(value: unknown, context: string): GeneratedNoticeConfigEntry {
  if (!isRecord(value)) throw new Error(`${context} must be an object.`);
  const copyrights = readOptionalStringArray(value, "copyrights", context);
  const preamble = readOptionalStringArray(value, "preamble", context);
  return {
    licenseId: readRequiredString(value, "licenseId", context),
    ...(copyrights !== undefined ? { copyrights } : {}),
    ...(preamble !== undefined ? { preamble } : {}),
  };
}

function decodeGeneratedNotices(value: unknown, context: string): ReadonlyArray<GeneratedNoticeConfigEntry> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${context} must define "generatedNotices" as a non-empty array.`);
  }
  return value.map((entry, index) => decodeGeneratedNotice(entry, `${context} generated notice at index ${String(index)}`));
}

function decodeCustomNotices(value: unknown): ReadonlyArray<CustomNoticeConfigEntry> {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error('Third-party license config field "customNotices" must be an array.');
  }
  return value.map((entry, index) => {
    const context = `Third-party custom notice at index ${String(index)}`;
    if (!isRecord(entry)) throw new Error(`${context} must be an object.`);
    const version = readOptionalString(entry, "version", context);
    const sourceUrl = readOptionalString(entry, "sourceUrl", context);
    const bundles = readOptionalStringArray(entry, "bundles", context);
    const includeInBundles = readOptionalStringArray(entry, "includeInBundles", context);
    const noticeFile = readOptionalString(entry, "noticeFile", context);
    const noticeFiles = readOptionalStringArray(entry, "noticeFiles", context);
    const generatedNotices = decodeGeneratedNotices(entry.generatedNotices, context);
    const noticeSourceCount = Number(noticeFile !== undefined) + Number(noticeFiles !== undefined) + Number(generatedNotices !== undefined);
    if (noticeSourceCount !== 1) {
      throw new Error(`${context} must define exactly one of "noticeFile", "noticeFiles", or "generatedNotices".`);
    }
    return {
      name: readRequiredString(entry, "name", context),
      license: readRequiredString(entry, "license", context),
      ...(noticeFile !== undefined ? { noticeFiles: [noticeFile] } : {}),
      ...(noticeFiles !== undefined ? { noticeFiles } : {}),
      ...(generatedNotices !== undefined ? { generatedNotices } : {}),
      ...(version !== undefined ? { version } : {}),
      ...(sourceUrl !== undefined ? { sourceUrl } : {}),
      ...(bundles !== undefined ? { bundles } : {}),
      ...(includeInBundles !== undefined ? { includeInBundles } : {}),
    };
  });
}

function decodePackageOverrides(value: unknown): ReadonlyArray<PackageNoticeOverrideConfigEntry> {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error('Third-party license config field "packageOverrides" must be an array.');
  }
  return value.map((entry, index) => {
    const context = `Third-party package override at index ${String(index)}`;
    if (!isRecord(entry)) throw new Error(`${context} must be an object.`);
    const name = readOptionalString(entry, "name", context);
    const repositoryUrl = readOptionalString(entry, "repositoryUrl", context);
    if ((name === undefined) === (repositoryUrl === undefined)) {
      throw new Error(`${context} must define exactly one of "name" or "repositoryUrl".`);
    }
    const version = readOptionalString(entry, "version", context);
    const license = readOptionalString(entry, "license", context);
    const noticeFile = readOptionalString(entry, "noticeFile", context);
    const generatedNotice =
      entry.generatedNotice === undefined ? undefined : decodeGeneratedNotice(entry.generatedNotice, `${context} generated notice`);
    const generatedNotices = decodeGeneratedNotices(entry.generatedNotices, context);
    if (Number(noticeFile !== undefined) + Number(generatedNotice !== undefined) + Number(generatedNotices !== undefined) > 1) {
      throw new Error(`${context} can define only one of "noticeFile", "generatedNotice", or "generatedNotices".`);
    }
    const sourceUrl = readOptionalString(entry, "sourceUrl", context);
    return {
      ...(name !== undefined ? { name } : {}),
      ...(repositoryUrl !== undefined ? { repositoryUrl } : {}),
      ...(version !== undefined ? { version } : {}),
      ...(license !== undefined ? { license } : {}),
      ...(noticeFile !== undefined ? { noticeFile } : {}),
      ...(generatedNotice !== undefined ? { generatedNotices: [generatedNotice] } : {}),
      ...(generatedNotices !== undefined ? { generatedNotices } : {}),
      ...(sourceUrl !== undefined ? { sourceUrl } : {}),
    };
  });
}

async function readConfig(configFile: string | URL | undefined): Promise<{ readonly config: ThirdPartyLicensesConfig; readonly directory: string }> {
  if (configFile === undefined) {
    return { config: EMPTY_CONFIG, directory: NodePath.resolve(".") };
  }
  const configPath = asPath(configFile);
  const decoded = JSON.parse(await NodeFSP.readFile(configPath, "utf8")) as unknown;
  if (!isRecord(decoded)) throw new Error("Third-party license config must contain an object.");
  return {
    config: {
      customNotices: decodeCustomNotices(decoded.customNotices),
      packageOverrides: decodePackageOverrides(decoded.packageOverrides),
    },
    directory: NodePath.dirname(configPath),
  };
}

function spdxLicenseCachePath(configDirectory: string, licenseId: string): string {
  return NodePath.join(configDirectory, GENERATED_NOTICE_CACHE_DIRECTORY, SPDX_LICENSE_LIST_VERSION, `${licenseId}.json`);
}

function decodeSpdxLicenseDetails(value: unknown, expectedLicenseId: string): SpdxLicenseDetails {
  if (!isRecord(value) || value.licenseId !== expectedLicenseId || typeof value.licenseText !== "string" || value.licenseText.trim().length === 0) {
    throw new Error(`SPDX returned invalid license details for ${expectedLicenseId}.`);
  }
  return { licenseId: expectedLicenseId, licenseText: value.licenseText.trim() };
}

async function readCachedSpdxLicense(configDirectory: string, licenseId: string): Promise<SpdxLicenseDetails | null> {
  try {
    const source = await NodeFSP.readFile(spdxLicenseCachePath(configDirectory, licenseId), "utf8");
    return decodeSpdxLicenseDetails(JSON.parse(source) as unknown, licenseId);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

async function downloadSpdxLicense(configDirectory: string, licenseId: string): Promise<SpdxLicenseDetails> {
  const url = `https://raw.githubusercontent.com/spdx/license-list-data/${SPDX_LICENSE_LIST_REVISION}/json/details/${encodeURIComponent(licenseId)}.json`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not download SPDX license ${licenseId}: HTTP ${String(response.status)}.`);
  }
  const details = decodeSpdxLicenseDetails((await response.json()) as unknown, licenseId);
  const cachePath = spdxLicenseCachePath(configDirectory, licenseId);
  await NodeFSP.mkdir(NodePath.dirname(cachePath), { recursive: true });
  await NodeFSP.writeFile(cachePath, `${JSON.stringify(details)}\n`, "utf8");
  return details;
}

async function resolveSpdxLicense(configDirectory: string, licenseId: string, allowMissing: boolean): Promise<SpdxLicenseDetails | null> {
  const cached = await readCachedSpdxLicense(configDirectory, licenseId);
  if (cached || allowMissing) return cached;
  return downloadSpdxLicense(configDirectory, licenseId);
}

/** The template's copyright placeholder line becomes the config's copyright lines. */
function renderGeneratedNotice(config: GeneratedNoticeConfigEntry, licenseText: string): string {
  const copyrights = config.copyrights ?? [];
  let renderedLicense = licenseText;
  if (copyrights.length > 0) {
    const placeholderPattern = /^Copyright[^\n]*(?:<year>|<copyright holders>|<owner>)[^\n]*$/m;
    if (placeholderPattern.test(renderedLicense)) {
      renderedLicense = renderedLicense.replace(placeholderPattern, copyrights.join("\n"));
    } else if (config.licenseId === "ISC") {
      renderedLicense = renderedLicense.replace(/^(?:Copyright[^\n]*\n)+/m, `${copyrights.join("\n")}\n`);
    } else {
      renderedLicense = `${copyrights.join("\n")}\n\n${renderedLicense}`;
    }
  }
  return [...(config.preamble ?? []), renderedLicense].join("\n\n").trim();
}

async function generatedNoticeText(
  configs: ReadonlyArray<GeneratedNoticeConfigEntry>,
  configDirectory: string,
  allowMissing: boolean,
): Promise<string | null> {
  const sections = await Promise.all(
    configs.map(async (config) => {
      const details = await resolveSpdxLicense(configDirectory, config.licenseId, allowMissing);
      return details ? renderGeneratedNotice(config, details.licenseText) : null;
    }),
  );
  return sections.some((section) => section === null) ? null : (sections as ReadonlyArray<string>).join("\n\n---\n\n");
}

function configuredGeneratedNotices(config: ThirdPartyLicensesConfig): ReadonlyArray<GeneratedNoticeConfigEntry> {
  return [
    ...config.customNotices.flatMap((notice) => notice.generatedNotices ?? []),
    ...config.packageOverrides.flatMap((override) => override.generatedNotices ?? []),
  ];
}

async function syncConfiguredGeneratedNotices(config: ThirdPartyLicensesConfig, directory: string): Promise<void> {
  const licenseIds = [...new Set(configuredGeneratedNotices(config).map((notice) => notice.licenseId))].sort((left, right) => left.localeCompare(right));
  await Promise.all(licenseIds.map((licenseId) => resolveSpdxLicense(directory, licenseId, false)));
}

/** Fetch every SPDX template the config names and does not have yet — `npm run licenses:sync`. */
export async function syncThirdPartyLicenseNotices(configFile: string | URL): Promise<void> {
  const { config, directory } = await readConfig(configFile);
  await syncConfiguredGeneratedNotices(config, directory);
}

async function readPackageJson(packageJsonPath: string): Promise<PackageJson> {
  const value = JSON.parse(await NodeFSP.readFile(packageJsonPath, "utf8")) as unknown;
  if (!isRecord(value)) throw new Error(`Package manifest is not an object: ${packageJsonPath}`);
  return value as PackageJson;
}

function packageIdentity(packageJson: PackageJson, packageRoot: string): string {
  const name = typeof packageJson.name === "string" ? packageJson.name : NodePath.basename(packageRoot);
  const version = typeof packageJson.version === "string" ? packageJson.version : "unknown";
  return `${name}@${version}`;
}

async function findPackageRoot(
  resolvedPath: string,
  expectedName?: string,
): Promise<{ readonly packageJson: PackageJson; readonly packageRoot: string } | null> {
  let current = NodePath.dirname(resolvedPath);
  const root = NodePath.parse(current).root;
  while (current !== root) {
    const packageJsonPath = NodePath.join(current, "package.json");
    try {
      const packageJson = await readPackageJson(packageJsonPath);
      // A nested `package.json` holding only `{"type": "module"}` is not the package: keep climbing.
      const matchesExpectedPackage =
        expectedName !== undefined ? packageJson.name === expectedName : typeof packageJson.name === "string" && typeof packageJson.version === "string";
      if (matchesExpectedPackage) {
        return { packageJson, packageRoot: await NodeFSP.realpath(current) };
      }
    } catch (error) {
      const code = errorCode(error);
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    }
    current = NodePath.dirname(current);
  }
  return null;
}

async function resolveDependencyPackage(
  dependencyName: string,
  fromPackageJsonPath: string,
): Promise<{ readonly packageJson: PackageJson; readonly packageRoot: string } | null> {
  const requireFromPackage = NodeModule.createRequire(fromPackageJsonPath);
  for (const candidate of [`${dependencyName}/package.json`, dependencyName]) {
    try {
      const found = await findPackageRoot(requireFromPackage.resolve(candidate), dependencyName);
      if (found) return found;
    } catch (error) {
      const code = errorCode(error);
      if (code !== "MODULE_NOT_FOUND" && code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error;
    }
  }

  // Neither `package.json` nor a main entry resolves (an ESM-only package whose exports name
  // neither, a types-only package): look for the directory itself, climbing like Node does.
  let current = NodePath.dirname(fromPackageJsonPath);
  const root = NodePath.parse(current).root;
  while (true) {
    const packageRoot = NodePath.join(current, "node_modules", dependencyName);
    try {
      const packageJson = await readPackageJson(NodePath.join(packageRoot, "package.json"));
      if (packageJson.name === dependencyName) {
        return { packageJson, packageRoot: await NodeFSP.realpath(packageRoot) };
      }
    } catch (error) {
      const code = errorCode(error);
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    }
    if (current === root) break;
    current = NodePath.dirname(current);
  }
  return null;
}

function dependencyNames(packageJson: PackageJson): ReadonlyArray<string> {
  return [...new Set([...Object.keys(packageJson.dependencies ?? {}), ...Object.keys(packageJson.optionalDependencies ?? {})])].sort((left, right) =>
    left.localeCompare(right),
  );
}

function addToCollection(collection: PackageCollection, packageJson: PackageJson, packageRoot: string, bundle: string): void {
  const identity = packageIdentity(packageJson, packageRoot);
  const existing = collection.byIdentity.get(identity);
  if (existing) {
    existing.bundles.add(bundle);
  } else {
    collection.byIdentity.set(identity, { bundles: new Set([bundle]), packageJson, packageRoot });
  }
}

async function collectProductionDependencyPackages(packageManifests: ReadonlyArray<ThirdPartyLicensePackageManifest>): Promise<PackageCollection> {
  const collection: PackageCollection = { byIdentity: new Map() };
  const visited = new Set<string>();

  const visitManifest = async (packageJsonPath: string, bundle: string): Promise<void> => {
    const packageJson = await readPackageJson(packageJsonPath);
    for (const dependencyName of dependencyNames(packageJson)) {
      const resolved = await resolveDependencyPackage(dependencyName, packageJsonPath);
      // An optional dependency for another platform (`@node-llama-cpp/mac-arm64-metal` on Windows)
      // is not installed, and so is not shipped.
      if (!resolved) continue;
      const visitKey = `${bundle}:${resolved.packageRoot}`;
      if (visited.has(visitKey)) continue;
      visited.add(visitKey);

      const name = typeof resolved.packageJson.name === "string" ? resolved.packageJson.name : dependencyName;
      if (!isFirstParty(name)) addToCollection(collection, resolved.packageJson, resolved.packageRoot, bundle);
      await visitManifest(NodePath.join(resolved.packageRoot, "package.json"), bundle);
    }
  };

  for (const manifest of packageManifests) {
    await visitManifest(asPath(manifest.path), manifest.bundle);
  }
  return collection;
}

/** A Rollup or esbuild module id as a path on disk, or null when it is not a file under `node_modules`. */
export function moduleFilePath(moduleId: string): string | null {
  if (moduleId.startsWith("\0") || moduleId.includes("\0")) return null;
  const withoutQuery = moduleId.split(/[?#]/, 1)[0] ?? moduleId;
  const viteFilePath = withoutQuery.startsWith("/@fs/") ? withoutQuery.slice("/@fs/".length) : withoutQuery;
  const filePath = withoutQuery.startsWith("file:")
    ? NodeURL.fileURLToPath(withoutQuery)
    : /^[A-Za-z]:[\\/]/.test(viteFilePath)
      ? viteFilePath
      : NodePath.resolve("/", viteFilePath);
  return filePath.replaceAll("\\", "/").includes("/node_modules/") ? filePath : null;
}

async function addBundledModulePackages(collection: PackageCollection, moduleIds: ReadonlyArray<string>, bundle: string): Promise<void> {
  const seen = new Set<string>();
  for (const moduleId of moduleIds) {
    const filePath = moduleFilePath(moduleId);
    if (!filePath) continue;
    let found: Awaited<ReturnType<typeof findPackageRoot>>;
    try {
      found = await findPackageRoot(await NodeFSP.realpath(filePath));
    } catch (error) {
      const code = errorCode(error);
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      throw error;
    }
    if (!found || typeof found.packageJson.name !== "string") continue;
    if (isFirstParty(found.packageJson.name)) continue;
    if (seen.has(found.packageRoot)) continue;
    seen.add(found.packageRoot);
    addToCollection(collection, found.packageJson, found.packageRoot, bundle);
  }
}

/** A fallback manifest's tag, on a package some bundle holds, is dropped — see `fallback`. */
function dropFallbackTags(collection: PackageCollection, packageManifests: ReadonlyArray<ThirdPartyLicensePackageManifest>): void {
  const fallbacks = new Set(packageManifests.filter((manifest) => manifest.fallback === true).map((manifest) => manifest.bundle));
  if (fallbacks.size === 0) return;
  for (const collected of collection.byIdentity.values()) {
    if ([...collected.bundles].some((bundle) => !fallbacks.has(bundle))) {
      for (const bundle of fallbacks) collected.bundles.delete(bundle);
    }
  }
}

function normalizeLicense(packageJson: PackageJson): string | null {
  if (typeof packageJson.license === "string" && packageJson.license.trim().length > 0) {
    return packageJson.license.trim();
  }
  if (isRecord(packageJson.license) && typeof packageJson.license.type === "string") {
    return packageJson.license.type.trim() || null;
  }
  const declaredLicenses = Array.isArray(packageJson.license) ? packageJson.license : packageJson.licenses;
  if (Array.isArray(declaredLicenses)) {
    const licenses = declaredLicenses
      .map((entry) => {
        if (typeof entry === "string") return entry.trim();
        if (isRecord(entry) && typeof entry.type === "string") return entry.type.trim();
        return "";
      })
      .filter((entry) => entry.length > 0);
    if (licenses.length > 0) return licenses.join(" OR ");
  }
  return null;
}

function normalizeRepositoryUrl(value: unknown): string | null {
  const raw = typeof value === "string" ? value : isRecord(value) && typeof value.url === "string" ? value.url : null;
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed.startsWith("github:")) return `https://github.com/${trimmed.slice(7)}`;
  const normalized = trimmed
    .replace(/^git\+ssh:\/\/git@github\.com\//, "https://github.com/")
    .replace(/^git\+/, "")
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/^ssh:\/\/(?:git@)?github\.com\//, "https://github.com/")
    .replace(/^git:\/\/github\.com\//, "https://github.com/")
    .replace(/#.*$/, "")
    .replace(/\.git$/, "");
  if (/^[\w.-]+\/[\w.-]+$/.test(normalized)) return `https://github.com/${normalized}`;
  return normalized;
}

/** Only an http(s) address: the page's decoder refuses anything else, and so must this. */
function httpUrlOrNull(value: string | null): string | null {
  if (value === null) return null;
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

function packageSourceUrl(packageJson: PackageJson): string | null {
  if (typeof packageJson.homepage === "string" && packageJson.homepage.trim().length > 0) {
    const homepage = httpUrlOrNull(packageJson.homepage.trim());
    if (homepage !== null) return homepage;
  }
  return httpUrlOrNull(normalizeRepositoryUrl(packageJson.repository));
}

async function readPackageNoticeText(packageRoot: string): Promise<string | null> {
  const noticeFiles: string[] = [];
  const rootEntries = await NodeFSP.readdir(packageRoot, { withFileTypes: true });
  noticeFiles.push(...rootEntries.filter((entry) => entry.isFile() && isNoticeTextFile(entry.name)).map((entry) => entry.name));

  const collectNestedNoticeFiles = async (directory: string, depth: number): Promise<void> => {
    const directoryEntries = await NodeFSP.readdir(NodePath.join(packageRoot, directory), { withFileTypes: true });
    await Promise.all(
      directoryEntries.map(async (entry) => {
        const relativePath = NodePath.join(directory, entry.name);
        if (entry.isFile() && isNoticeTextFile(entry.name)) {
          noticeFiles.push(relativePath);
          return;
        }
        if (depth > 0 && entry.isDirectory() && entry.name !== "node_modules" && entry.name !== ".git") {
          await collectNestedNoticeFiles(relativePath, depth - 1);
        }
      }),
    );
  };
  await Promise.all(
    rootEntries
      .filter((entry) => entry.isDirectory() && entry.name !== "node_modules" && entry.name !== ".git")
      .map((entry) => collectNestedNoticeFiles(entry.name, 2)),
  );
  noticeFiles.sort((left, right) => left.localeCompare(right));
  if (noticeFiles.length === 0) return null;

  const sections: string[] = [];
  for (const fileName of noticeFiles) {
    const contents = (await NodeFSP.readFile(NodePath.join(packageRoot, fileName), "utf8")).trim();
    if (contents.length === 0) continue;
    // Forward slashes whatever the machine, so the manifest reads the same built anywhere.
    sections.push(noticeFiles.length === 1 ? contents : `${fileName.replaceAll("\\", "/")}\n\n${contents}`);
  }
  return sections.length > 0 ? sections.join("\n\n---\n\n") : null;
}

function repositoryNoticeKey(packageJson: PackageJson, license: string): string | null {
  const repositoryUrl = normalizeRepositoryUrl(packageJson.repository);
  return repositoryUrl ? `${repositoryUrl.toLowerCase()}\n${license.toLowerCase()}` : null;
}

async function collectRepositoryNotices(collection: PackageCollection, packageNotices: Map<string, Promise<string | null>>): Promise<ReadonlyMap<string, string>> {
  const notices = new Map<string, string>();
  const candidates = await Promise.all(
    [...collection.byIdentity.values()].map(async (collected) => {
      const license = normalizeLicense(collected.packageJson);
      if (!license) return null;
      const key = repositoryNoticeKey(collected.packageJson, license);
      if (!key) return null;
      const noticeText = await packageNoticeText(collected.packageRoot, packageNotices);
      return noticeText ? { key, noticeText } : null;
    }),
  );
  for (const candidate of candidates) {
    if (candidate && !notices.has(candidate.key)) notices.set(candidate.key, candidate.noticeText);
  }
  return notices;
}

function packageNoticeText(packageRoot: string, cache: Map<string, Promise<string | null>>): Promise<string | null> {
  const existing = cache.get(packageRoot);
  if (existing) return existing;
  const notice = readPackageNoticeText(packageRoot);
  cache.set(packageRoot, notice);
  return notice;
}

function findPackageOverride(
  overrides: ReadonlyArray<PackageNoticeOverrideConfigEntry>,
  name: string,
  version: string,
  packageJson: PackageJson,
): PackageNoticeOverrideConfigEntry | undefined {
  const repositoryUrl = normalizeRepositoryUrl(packageJson.repository)?.toLowerCase();
  const matchesRepository = (override: PackageNoticeOverrideConfigEntry): boolean =>
    repositoryUrl !== undefined && override.repositoryUrl !== undefined && normalizeRepositoryUrl(override.repositoryUrl)?.toLowerCase() === repositoryUrl;
  return (
    overrides.find((override) => override.name === name && override.version === version) ??
    overrides.find((override) => override.name === name && override.version === undefined) ??
    overrides.find((override) => matchesRepository(override) && override.version === version) ??
    overrides.find((override) => matchesRepository(override) && override.version === undefined)
  );
}

async function packageEntry(
  collected: CollectedPackage,
  config: ThirdPartyLicensesConfig,
  configDirectory: string,
  packageNotices: Map<string, Promise<string | null>>,
  repositoryNotices: ReadonlyMap<string, string>,
  allowMissingGeneratedNotices: boolean,
): Promise<ThirdPartyLicenseEntry | null> {
  const name = typeof collected.packageJson.name === "string" ? collected.packageJson.name : NodePath.basename(collected.packageRoot);
  const version = typeof collected.packageJson.version === "string" ? collected.packageJson.version : "unknown";
  const override = findPackageOverride(config.packageOverrides, name, version, collected.packageJson);
  const license = override?.license ?? normalizeLicense(collected.packageJson);
  if (!license || /^(?:unlicensed|proprietary)$/i.test(license)) {
    throw new Error(
      `${name}@${version} does not declare a distributable license. Add a package override in packages/app/licenses/config.json if the package publishes its notice elsewhere.`,
    );
  }

  const repositoryKey = repositoryNoticeKey(collected.packageJson, license);
  const noticeText = override?.generatedNotices
    ? await generatedNoticeText(override.generatedNotices, configDirectory, allowMissingGeneratedNotices)
    : override?.noticeFile
      ? (await NodeFSP.readFile(NodePath.resolve(configDirectory, override.noticeFile), "utf8")).trim()
      : ((await packageNoticeText(collected.packageRoot, packageNotices)) ?? (repositoryKey ? repositoryNotices.get(repositoryKey) : undefined));
  if (!noticeText) {
    if (override?.generatedNotices && allowMissingGeneratedNotices) return null;
    throw new Error(
      `${name}@${version} does not include a license or notice file. Add a package override with "noticeFile" or "generatedNotice" in packages/app/licenses/config.json.`,
    );
  }

  return {
    bundles: [...collected.bundles].sort((left, right) => left.localeCompare(right)),
    kind: "package",
    license,
    name,
    noticeText,
    sourceUrl: override?.sourceUrl ?? packageSourceUrl(collected.packageJson),
    version,
  };
}

async function customEntries(
  config: ThirdPartyLicensesConfig,
  configDirectory: string,
  includedBundles: ReadonlySet<string>,
  allowMissingGeneratedNotices: boolean,
): Promise<ReadonlyArray<ThirdPartyLicenseEntry>> {
  const entries = await Promise.all(
    config.customNotices
      .filter((notice) => {
        const gate = notice.includeInBundles ?? notice.bundles;
        return gate === undefined || gate.some((bundle) => includedBundles.has(bundle));
      })
      .map(async (notice) => {
        const noticeText = notice.generatedNotices
          ? await generatedNoticeText(notice.generatedNotices, configDirectory, allowMissingGeneratedNotices)
          : (
              await Promise.all(
                notice.noticeFiles!.map(async (noticeFile) => {
                  const contents = (await NodeFSP.readFile(NodePath.resolve(configDirectory, noticeFile), "utf8")).trim();
                  if (contents.length === 0) {
                    throw new Error(`Custom third-party notice "${notice.name}" is empty.`);
                  }
                  return contents;
                }),
              )
            ).join("\n\n---\n\n");
        if (noticeText === null) {
          if (allowMissingGeneratedNotices) return null;
          throw new Error(`Could not generate custom third-party notice "${notice.name}".`);
        }
        if (noticeText.length === 0) {
          throw new Error(`Custom third-party notice "${notice.name}" is empty.`);
        }
        return {
          bundles: [...(notice.bundles ?? ["assets"])].sort((left, right) => left.localeCompare(right)),
          kind: "custom" as const,
          license: notice.license,
          name: notice.name,
          noticeText,
          sourceUrl: notice.sourceUrl ?? null,
          version: notice.version ?? null,
        };
      }),
  );
  return entries.flatMap((entry) => (entry ? [entry] : []));
}

function entrySort(left: ThirdPartyLicenseEntry, right: ThirdPartyLicenseEntry): number {
  return left.name.localeCompare(right.name) || (left.version ?? "").localeCompare(right.version ?? "") || left.kind.localeCompare(right.kind);
}

function assertUniqueEntries(entries: ReadonlyArray<ThirdPartyLicenseEntry>): void {
  const identities = new Set<string>();
  for (const entry of entries) {
    const identity = JSON.stringify([entry.kind, entry.name, entry.version]);
    if (identities.has(identity)) {
      throw new Error(`Third-party license generation found a duplicate ${entry.kind} notice for ${entry.name}${entry.version ? `@${entry.version}` : ""}.`);
    }
    identities.add(identity);
  }
}

export async function generateThirdPartyLicenseManifest(input: {
  readonly configFile?: string | URL;
  readonly packageManifests: ReadonlyArray<ThirdPartyLicensePackageManifest>;
  readonly bundledModules?: ReadonlyArray<BundledModules>;
  readonly allowMissingGeneratedNotices?: boolean;
}): Promise<ThirdPartyLicenseManifest> {
  const allowMissing = input.allowMissingGeneratedNotices ?? false;
  const [{ config, directory }, collection] = await Promise.all([readConfig(input.configFile), collectProductionDependencyPackages(input.packageManifests)]);
  if (!allowMissing) await syncConfiguredGeneratedNotices(config, directory);
  for (const bundled of input.bundledModules ?? []) {
    await addBundledModulePackages(collection, bundled.moduleIds, bundled.bundle);
  }
  dropFallbackTags(collection, input.packageManifests);

  const packageNotices = new Map<string, Promise<string | null>>();
  const repositoryNotices = await collectRepositoryNotices(collection, packageNotices);

  // Every failure at once: a dependency bump that adds three unlicensed packages should say three.
  const packageEntryResults = await Promise.allSettled(
    [...collection.byIdentity.values()].map((collected) => packageEntry(collected, config, directory, packageNotices, repositoryNotices, allowMissing)),
  );
  const failures = packageEntryResults.flatMap((result) =>
    result.status === "rejected" ? [result.reason instanceof Error ? result.reason.message : String(result.reason)] : [],
  );
  if (failures.length > 0) {
    throw new Error(
      `Third-party license generation found ${String(failures.length)} invalid package notice${failures.length === 1 ? "" : "s"}:\n${failures.map((failure) => `- ${failure}`).join("\n")}`,
    );
  }
  const packageEntries = packageEntryResults.flatMap((result) => (result.status === "fulfilled" && result.value ? [result.value] : []));
  const includedBundles = new Set([...input.packageManifests.map((manifest) => manifest.bundle), ...(input.bundledModules ?? []).map((bundled) => bundled.bundle)]);
  const manualEntries = await customEntries(config, directory, includedBundles, allowMissing);
  const entries = [...packageEntries, ...manualEntries].sort(entrySort);
  assertUniqueEntries(entries);
  return { schemaVersion: 1, entries };
}

/** Every module id Rollup put in a chunk. */
export function moduleIdsFromBundle(bundle: unknown): ReadonlyArray<string> {
  const ids = new Set<string>();
  if (!isRecord(bundle)) return [];
  for (const output of Object.values(bundle)) {
    if (!isRecord(output) || output.type !== "chunk" || !isRecord(output.modules)) continue;
    for (const id of Object.keys(output.modules)) ids.add(id);
  }
  return [...ids];
}

async function readModuleList(file: string | URL, bundle: string): Promise<ReadonlyArray<string>> {
  const path = asPath(file);
  let source: string;
  try {
    source = await NodeFSP.readFile(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      throw new Error(`The ${bundle} bundle's module list is missing (${path}). Build it first: npm --workspace @jaira/app run build:main.`);
    }
    throw error;
  }
  const value = JSON.parse(source) as unknown;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`The ${bundle} bundle's module list is not an array of paths: ${path}`);
  }
  return value as string[];
}

export function serializeManifest(manifest: ThirdPartyLicenseManifest): string {
  return `${JSON.stringify(manifest)}\n`;
}

/**
 * The Vite plugin: after the renderer's chunks are final, write the manifest beside them.
 *
 * Structurally typed rather than `import type { Plugin } from "vite"`: this file is type-checked with
 * the app's sources, and `vite.config.ts` is kept out of that for the two copies of Vite's types it
 * would compare (see `tsconfig.json`). Vite reads the object for its shape either way.
 */
export function thirdPartyLicensesPlugin(options: ThirdPartyLicensesPluginOptions): {
  name: string;
  apply: "build";
  generateBundle(this: { emitFile(file: { type: "asset"; fileName: string; source: string }): string }, outputOptions: unknown, bundle: unknown): Promise<void>;
} {
  return {
    name: "jaira:third-party-licenses",
    apply: "build",
    async generateBundle(_outputOptions, bundle) {
      const others = await Promise.all(
        (options.moduleLists ?? []).map(async (list) => ({ bundle: list.bundle, moduleIds: await readModuleList(list.file, list.bundle) })),
      );
      const manifest = await generateThirdPartyLicenseManifest({
        packageManifests: options.packageManifests,
        bundledModules: [{ bundle: options.bundleName, moduleIds: moduleIdsFromBundle(bundle) }, ...others],
        ...(options.configFile !== undefined ? { configFile: options.configFile } : {}),
      });
      this.emitFile({ type: "asset", fileName: THIRD_PARTY_LICENSES_FILE_NAME, source: serializeManifest(manifest) });
    },
  };
}
