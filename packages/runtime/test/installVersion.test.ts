/**
 * Versions (`install/version.ts`): the number a program says, whether it meets what a project wrote
 * — npm's range rules, with the spellings other ecosystems add — and what an installer is asked for.
 */
import { describe, expect, it } from "vitest";
import { isAnyVersion, runVersion, versionLineOf, versionNumberOf, versionSatisfies, versionWant } from "../src/install";
import { machineExec } from "./installRig";

describe("the version a program says", () => {
  it.each([
    ["v22.11.0\n", "22.11.0"],
    ["Python 3.12.1\n", "3.12.1"],
    ["go version go1.23.2 darwin/arm64\n", "1.23.2"],
    ["Docker version 27.3.1, build ce12230\n", "27.3.1"],
    ["rustc 1.85.0-nightly (4d215e2 2025-01-01)\n", "1.85.0-nightly"],
    ["jq-1.7.1\n", "1.7.1"],
    ["Terraform v1.9.8\non darwin_arm64\n\nYour version of Terraform is out of date! The latest version\nis 1.10.0.\n", "1.9.8"],
    ["Client Version: v1.31.0\nKustomize Version: v5.4.2\n", "1.31.0"],
    ["v3.16.2+g13654a5\n", "3.16.2"],
    ["psql (PostgreSQL) 16.4 (Homebrew)\n", "16.4"],
    ["Poetry (version 1.8.4)\n", "1.8.4"],
    ["2024.11.8 macos-arm64 (2024-11-25)\n", "2024.11.8"],
    ["openjdk 21 2023-09-19\nOpenJDK Runtime Environment\n", "21"],
  ])("reads %j as %s", (output, version) => {
    expect(versionNumberOf(output)).toBe(version);
  });

  it("reads Java's own way of saying it, Java 8 as 8", () => {
    const pattern = /version "(?:1\.(?=\d+\.))?(\d+(?:\.\d+)*)/;
    expect(versionNumberOf('openjdk version "21.0.2" 2024-01-16\n', pattern)).toBe("21.0.2");
    expect(versionNumberOf('java version "1.8.0_392"\n', pattern)).toBe("8.0");
    expect(versionNumberOf('openjdk version "17.0.9" 2023-10-17\n', pattern)).toBe("17.0.9");
  });

  it("keeps a version line without the program's name, for a row to show", () => {
    expect(versionLineOf("git", "git version 2.39.5 (Apple Git-154)\n")).toBe("2.39.5 (Apple Git-154)");
    expect(versionLineOf("glab", "glab 1.48.0 (b9d6e9a5)\n")).toBe("1.48.0 (b9d6e9a5)");
    expect(versionLineOf("node", "\n")).toBeUndefined();
  });

  it("asks the program — stderr too, where Java says it — and answers nothing for one that is not there", async () => {
    const exec = machineExec((file) => (file === "java" ? { code: 0, stderr: 'openjdk version "21.0.2" 2024-01-16\n' } : undefined));
    expect(await runVersion("java", { args: ["-version"] }, { exec })).toBe("21.0.2");
    expect(exec.calls[0]).toMatchObject({ file: "java", args: ["-version"], stdin: "" });
    expect(await runVersion("node", undefined, { exec })).toBeUndefined();
  });
});

describe("versionSatisfies", () => {
  const meets = (found: string, wanted: string): boolean => versionSatisfies(found, wanted);

  it("takes a bare version as every version it starts, and three parts as that one", () => {
    expect(meets("22.11.0", "22")).toBe(true);
    expect(meets("22.0.0", "22")).toBe(true);
    expect(meets("23.0.0", "22")).toBe(false);
    expect(meets("21.9.9", "22")).toBe(false);
    expect(meets("22.11.0", "22.11")).toBe(true);
    expect(meets("22.12.0", "22.11")).toBe(false);
    expect(meets("22.11.0", "22.11.0")).toBe(true);
    expect(meets("22.11.1", "22.11.0")).toBe(false);
    expect(meets("v22.1.0", "v22")).toBe(true);
    expect(meets("22.1.0", "=22")).toBe(true);
    // A version the program says in two parts is its .0.
    expect(meets("16.4", "16.4.0")).toBe(true);
  });

  it("reads x-ranges and Python's wildcard", () => {
    expect(meets("22.3.1", "22.x")).toBe(true);
    expect(meets("23.0.0", "22.x")).toBe(false);
    expect(meets("3.12.7", "3.12.*")).toBe(true);
    expect(meets("3.12.7", "==3.12.*")).toBe(true);
    expect(meets("3.13.0", "3.12.x")).toBe(false);
  });

  it("compares with >=, >, <, <= — a partial version meaning all of it, as npm does", () => {
    expect(meets("22.0.0", ">=22")).toBe(true);
    expect(meets("24.1.0", ">=22")).toBe(true);
    expect(meets("21.9.9", ">=22")).toBe(false);
    expect(meets("22.0.0", ">= 22")).toBe(true);
    // `>9.1` is past every 9.1.x.
    expect(meets("9.1.5", ">9.1 <10")).toBe(false);
    expect(meets("9.2.0", ">9.1 <10")).toBe(true);
    expect(meets("9.12.3", ">9.1 <10")).toBe(true);
    expect(meets("10.0.0", ">9.1 <10")).toBe(false);
    expect(meets("9.1.4", "<=9.1")).toBe(true);
    expect(meets("9.2.0", "<=9.1")).toBe(false);
    expect(meets("1.2.3", ">1.2.2")).toBe(true);
    expect(meets("1.2.2", ">1.2.2")).toBe(false);
  });

  it("keeps the first part that is not 0 with ^", () => {
    expect(meets("9.0.0", "^9")).toBe(true);
    expect(meets("9.12.1", "^9")).toBe(true);
    expect(meets("10.0.0", "^9")).toBe(false);
    expect(meets("8.9.0", "^9")).toBe(false);
    expect(meets("9.1.0", "^9.1.2")).toBe(false);
    expect(meets("0.2.5", "^0.2.3")).toBe(true);
    expect(meets("0.3.0", "^0.2.3")).toBe(false);
    expect(meets("0.0.4", "^0.0.3")).toBe(false);
  });

  it("keeps the minor with ~, and Ruby's ~> the part before its last", () => {
    expect(meets("3.12.4", "~3.12")).toBe(true);
    expect(meets("3.13.0", "~3.12")).toBe(false);
    expect(meets("3.9.0", "~3")).toBe(true);
    expect(meets("4.0.0", "~3")).toBe(false);
    expect(meets("1.2.9", "~1.2.3")).toBe(true);
    expect(meets("1.2.2", "~1.2.3")).toBe(false);
    expect(meets("3.9.0", "~> 3.2")).toBe(true);
    expect(meets("4.0.0", "~> 3.2")).toBe(false);
    expect(meets("3.2.5", "~> 3.2.1")).toBe(true);
    expect(meets("3.3.0", "~> 3.2.1")).toBe(false);
  });

  it("joins comparators by space or comma, alternatives by ||, and reads a hyphen range", () => {
    expect(meets("3.12.1", ">=3.9,<3.13")).toBe(true);
    expect(meets("3.13.0", ">=3.9, <3.13")).toBe(false);
    expect(meets("19.9.0", "<20 || >=22")).toBe(true);
    expect(meets("21.0.0", "<20 || >=22")).toBe(false);
    expect(meets("22.1.0", "^18 || ^20 || ^22")).toBe(true);
    expect(meets("1.2.0", "1.2 - 2.3")).toBe(true);
    expect(meets("2.3.9", "1.2 - 2.3")).toBe(true);
    expect(meets("2.4.0", "1.2 - 2.3")).toBe(false);
    expect(meets("3.12.1", "!=3.12.1")).toBe(false);
    expect(meets("3.12.2", "!=3.12.1")).toBe(true);
    expect(meets("3.12.2", "!=3.12")).toBe(false);
  });

  it("takes a line's name as any version, and Node's LTS codenames as their major", () => {
    for (const any of ["lts", "latest", "stable", "*", "", "x", "lts/*", "LTS"]) expect(meets("0.0.1", any)).toBe(true);
    expect(isAnyVersion(undefined)).toBe(true);
    expect(isAnyVersion("lts")).toBe(true);
    expect(isAnyVersion("22")).toBe(false);
    expect(meets("22.11.0", "lts/jod")).toBe(true);
    expect(meets("20.18.1", "lts/jod")).toBe(false);
    expect(meets("20.18.1", "lts/iron")).toBe(true);
    // Node 26's line, LTS since 2026-10.
    expect(meets("26.13.1", "lts/lithium")).toBe(true);
  });

  it("meets a toolchain channel by a version that says it", () => {
    expect(meets("1.85.0-nightly", "nightly")).toBe(true);
    expect(meets("1.85.0", "nightly")).toBe(false);
  });

  it("is met by nothing it cannot read — a guess would be worse", () => {
    expect(meets("22.11.0", "banana")).toBe(false);
    expect(meets("", "22")).toBe(false);
    expect(meets("unknown", "22")).toBe(false);
    expect(meets("1.2.3", "lts/nonsense")).toBe(false);
  });
});

describe("what an installer is asked for", () => {
  it.each([
    ["22", "22"],
    ["v22", "22"],
    ["22.x", "22"],
    ["22.11", "22.11"],
    ["22.11.0", "22.11.0"],
    ["^9", "9"],
    ["^9.1.2", "9"],
    ["~3.12", "3.12"],
    ["~3.12.1", "3.12"],
    [">9.1 <10", "9"],
    [">=3.9,<3.13", "3.12"],
    ["<20", "19"],
    ["^18 || ^20 || ^22", "22"],
    ["lts/jod", "22"],
    ["==3.12.*", "3.12"],
    ["1.2 - 2.3", "2.3"],
  ])("pins %j to %s", (wanted, pin) => {
    expect(versionWant(wanted).pin).toBe(pin);
  });

  it("pins nothing where the latest does — a lower bound alone, or an alternative with none above", () => {
    expect(versionWant(">=22")).toEqual({ any: false });
    expect(versionWant("<20 || >=22")).toEqual({ any: false });
    expect(versionWant(undefined)).toEqual({ any: true });
  });

  it("names a line for the version managers that install one by name", () => {
    expect(versionWant("lts")).toEqual({ any: true, channel: "lts" });
    expect(versionWant("latest")).toEqual({ any: true, channel: "latest" });
    expect(versionWant("stable")).toEqual({ any: true, channel: "stable" });
    expect(versionWant("nightly")).toEqual({ any: false, channel: "nightly" });
    expect(versionWant("*")).toEqual({ any: true });
  });
});
