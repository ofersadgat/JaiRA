/**
 * The Licenses page's half of the manifest contract (after t3code's `thirdPartyLicenses.test.ts`):
 * what the decoder accepts and refuses, the search, and how bundle tags read.
 */
import { describe, expect, it } from "vitest";
import {
  decodeThirdPartyLicenseManifest,
  filterThirdPartyLicenseEntries,
  findThirdPartyLicenseEntry,
  formatLicenseBundles,
  thirdPartyLicenseEntryKey,
  type ThirdPartyLicenseEntry,
} from "../src/thirdPartyLicenses";

const ENTRIES: ReadonlyArray<ThirdPartyLicenseEntry> = [
  {
    bundles: ["window"],
    kind: "package",
    license: "MIT",
    name: "react",
    noticeText: "React license",
    sourceUrl: "https://react.dev",
    version: "19.2.6",
  },
  {
    bundles: ["assets"],
    kind: "custom",
    license: "OFL-1.1",
    name: "DM Sans",
    noticeText: "Font notice",
    sourceUrl: null,
    version: null,
  },
];

describe("third-party license manifests", () => {
  it("decodes the generated manifest shape", () => {
    expect(decodeThirdPartyLicenseManifest({ schemaVersion: 1, entries: ENTRIES })).toEqual({ schemaVersion: 1, entries: ENTRIES });
  });

  it("rejects unsupported manifest versions", () => {
    expect(() => decodeThirdPartyLicenseManifest({ schemaVersion: 2, entries: [] })).toThrow("unsupported format");
  });

  it("rejects an entry with no bundle", () => {
    expect(() => decodeThirdPartyLicenseManifest({ schemaVersion: 1, entries: [{ ...ENTRIES[0]!, bundles: [] }] })).toThrow("invalid shape");
  });

  it("rejects unsafe source links", () => {
    expect(() => decodeThirdPartyLicenseManifest({ schemaVersion: 1, entries: [{ ...ENTRIES[0]!, sourceUrl: "javascript:alert(1)" }] })).toThrow("invalid shape");
  });

  it("rejects duplicate entries", () => {
    expect(() => decodeThirdPartyLicenseManifest({ schemaVersion: 1, entries: [ENTRIES[0]!, ENTRIES[0]!] })).toThrow("duplicate entry");
  });

  it("filters by package, license, version and bundle — tag or label", () => {
    expect(filterThirdPartyLicenseEntries(ENTRIES, "react 19.2")).toEqual([ENTRIES[0]]);
    expect(filterThirdPartyLicenseEntries(ENTRIES, "ofl assets")).toEqual([ENTRIES[1]]);
    expect(filterThirdPartyLicenseEntries(ENTRIES, "window")).toEqual([ENTRIES[0]]);
    expect(filterThirdPartyLicenseEntries(ENTRIES, "apache")).toEqual([]);
    expect(filterThirdPartyLicenseEntries(ENTRIES, "   ")).toBe(ENTRIES);
  });

  it("reads each bundle tag the build writes, and leaves an unknown one as written", () => {
    expect(formatLicenseBundles(["main", "window", "installed", "runtime", "assets", "constructor"])).toBe(
      "Main process, Window, Installed, Runtime, Assets, constructor",
    );
  });

  it("finds an entry by its key", () => {
    const entry = ENTRIES[0]!;
    expect(findThirdPartyLicenseEntry(ENTRIES, thirdPartyLicenseEntryKey(entry))).toBe(entry);
  });

  it("keys a scoped package without a slash", () => {
    expect(thirdPartyLicenseEntryKey({ ...ENTRIES[0]!, name: "@scope/package" })).not.toContain("/");
  });

  it("keys names and versions that contain delimiters apart", () => {
    const first = thirdPartyLicenseEntryKey({ ...ENTRIES[0]!, name: "a:1", version: null });
    const second = thirdPartyLicenseEntryKey({ ...ENTRIES[0]!, name: "a", version: "1:custom" });
    expect(first).not.toBe(second);
  });
});
