/**
 * The third-party notices JaiRA ships, as the Licenses page reads them.
 *
 * The build writes one manifest (`packages/app/licenses/thirdPartyLicenses.ts`, after t3code's
 * `scripts/lib/third-party-licenses.ts`): every package some part of the app bundles or loads, with
 * its declared license and the text of its own LICENSE/NOTICE files, plus the hand-written entries
 * for what is not an npm package (Electron, the fonts, an embedded theme). This file is the half both
 * sides share — the entry's shape, the decoder the page runs over what main hands it, and the search.
 *
 * Browser-safe on purpose: no `node:` import, because the renderer decodes the manifest itself.
 */

export interface ThirdPartyLicenseEntry {
  /** Which parts of the app carry it — see {@link formatLicenseBundles}. Never empty. */
  readonly bundles: ReadonlyArray<string>;
  /** `package` for an npm package, `custom` for an entry written in the licenses config. */
  readonly kind: "custom" | "package";
  /** The declared license, an SPDX expression where the package wrote one. */
  readonly license: string;
  readonly name: string;
  /** The notice itself: the package's own LICENSE/NOTICE files, or the config's generated text. */
  readonly noticeText: string;
  readonly sourceUrl: string | null;
  readonly version: string | null;
}

export interface ThirdPartyLicenseManifest {
  readonly schemaVersion: 1;
  readonly entries: ReadonlyArray<ThirdPartyLicenseEntry>;
}

/** The manifest's file name, beside the renderer's `index.html` in `dist/renderer/`. */
export const THIRD_PARTY_LICENSES_FILE_NAME = "third-party-licenses.json";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is ReadonlyArray<string> {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function decodeEntry(value: unknown, index: number): ThirdPartyLicenseEntry {
  if (!isRecord(value)) {
    throw new Error(`License entry ${String(index + 1)} is not an object.`);
  }
  if (
    !isStringArray(value.bundles) ||
    value.bundles.length === 0 ||
    (value.kind !== "custom" && value.kind !== "package") ||
    typeof value.license !== "string" ||
    typeof value.name !== "string" ||
    typeof value.noticeText !== "string" ||
    (value.sourceUrl !== null && !isHttpUrl(value.sourceUrl)) ||
    (value.version !== null && typeof value.version !== "string")
  ) {
    throw new Error(`License entry ${String(index + 1)} has an invalid shape.`);
  }
  return {
    bundles: value.bundles,
    kind: value.kind,
    license: value.license,
    name: value.name,
    noticeText: value.noticeText,
    sourceUrl: value.sourceUrl,
    version: value.version,
  };
}

/** The manifest, checked entry by entry — anything else is refused whole rather than drawn in part. */
export function decodeThirdPartyLicenseManifest(value: unknown): ThirdPartyLicenseManifest {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.entries)) {
    throw new Error("The open-source license manifest has an unsupported format.");
  }
  const entries = value.entries.map(decodeEntry);
  const entryKeys = new Set<string>();
  for (const entry of entries) {
    const key = thirdPartyLicenseEntryKey(entry);
    if (entryKeys.has(key)) {
      throw new Error(`The open-source license manifest contains a duplicate entry: ${key}`);
    }
    entryKeys.add(key);
  }
  return { schemaVersion: 1, entries };
}

/** Every whitespace-separated term must appear in the entry's name, version, license or bundles. */
export function filterThirdPartyLicenseEntries(
  entries: ReadonlyArray<ThirdPartyLicenseEntry>,
  query: string,
): ReadonlyArray<ThirdPartyLicenseEntry> {
  const terms = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 0);
  if (terms.length === 0) return entries;
  return entries.filter((entry) => {
    const searchable = [entry.name, entry.version, entry.license, ...entry.bundles.flatMap((b) => [b, bundleLabel(b)])]
      .filter((value): value is string => value !== null)
      .join(" ")
      .toLowerCase();
    return terms.every((term) => searchable.includes(term));
  });
}

/**
 * What each bundle tag means to a reader.
 *
 * `main` and `window` are the two bundles the build actually produces (the esbuild main process with
 * its preload and workers, and the Vite renderer), so a package tagged with one is code that is IN
 * that file. `installed` is a package reached only by walking the app's production dependencies —
 * loaded from `node_modules` at run time (Electron's natives, the compiler, SQLite) rather than
 * bundled. `runtime` and `assets` are the config's own entries: the Electron shell, and the files
 * shipped beside the code.
 */
const BUNDLE_LABELS: Readonly<Record<string, string>> = {
  assets: "Assets",
  installed: "Installed",
  main: "Main process",
  runtime: "Runtime",
  window: "Window",
};

function bundleLabel(bundle: string): string {
  return Object.prototype.hasOwnProperty.call(BUNDLE_LABELS, bundle) ? BUNDLE_LABELS[bundle]! : bundle;
}

export function formatLicenseBundles(bundles: ReadonlyArray<string>): string {
  return bundles.map(bundleLabel).join(", ");
}

/** An entry's identity: kind, name and version — what the generator refuses to see twice. */
export function thirdPartyLicenseEntryKey(entry: ThirdPartyLicenseEntry): string {
  return encodeURIComponent(JSON.stringify([entry.kind, entry.name, entry.version]));
}

export function findThirdPartyLicenseEntry(
  entries: ReadonlyArray<ThirdPartyLicenseEntry>,
  key: string,
): ThirdPartyLicenseEntry | undefined {
  return entries.find((entry) => thirdPartyLicenseEntryKey(entry) === key);
}
