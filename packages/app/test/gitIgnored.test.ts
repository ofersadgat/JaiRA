/**
 * What git ignores, as the file tree takes it (`gitIgnored.ts`): a folder named ONCE when all of it is
 * ignored — the property that keeps the answer small — and a single file where only it is.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitIgnoredPaths } from "@jaira/service/gitIgnored";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jaira-ignored-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("gitIgnoredPaths", () => {
  it("names a wholly ignored folder once, and an ignored file alone", () => {
    execFileSync("git", ["init", "-q", dir], { windowsHide: true });
    writeFileSync(join(dir, ".gitignore"), "build/\n*.log\n", "utf8");
    mkdirSync(join(dir, "build", "obj", "deep"), { recursive: true });
    for (let i = 0; i < 50; i++) writeFileSync(join(dir, "build", "obj", "deep", `${i}.o`), "", "utf8");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "main.ts"), "", "utf8");
    writeFileSync(join(dir, "src", "main.log"), "", "utf8");

    const ignored = gitIgnoredPaths(dir);
    expect(ignored).toBeDefined();
    expect([...ignored!.dirs]).toEqual(["build"]);
    expect([...ignored!.files]).toEqual(["src/main.log"]);
  });

  it("has no answer outside a repository", () => {
    expect(gitIgnoredPaths(dir)).toBeUndefined();
  });
});
