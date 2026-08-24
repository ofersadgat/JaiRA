/**
 * The credential lookup chain (DESIGN §8.1).
 *
 * The ORDER is the whole contract, and it is narrowest-to-widest for a reason a test should pin
 * down rather than leave to the comments: a key set for one project has to beat the machine-wide
 * default, or per-project credentials cannot be expressed at all.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseEnvFile, SecretResolver } from "../src/secrets";

let projectDir: string;
let baseDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "jaira-secret-project-"));
  baseDir = mkdtempSync(join(tmpdir(), "jaira-secret-base-"));
  mkdirSync(baseDir, { recursive: true });
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(baseDir, { recursive: true, force: true });
});

const write = (dir: string, name: string, body: string): void => writeFileSync(join(dir, name), body, "utf8");

/** A resolver over the two scratch directories, with an explicit environment. */
const resolverOf = (options: { keychain?: (n: string) => string | undefined; env?: NodeJS.ProcessEnv } = {}) =>
  new SecretResolver({ projectDir, baseDir, env: options.env ?? {}, ...(options.keychain ? { keychain: options.keychain } : {}) });

describe("parseEnvFile", () => {
  it("reads the conventions these files already use", () => {
    const parsed = parseEnvFile(
      [
        "# a comment",
        "",
        "PLAIN=value",
        "export EXPORTED=exported-value",
        'DOUBLE="with spaces"',
        "SINGLE='literal $VALUE'",
        "SPACED = padded",
        "INLINE=value # trailing note",
      ].join("\n"),
    );

    expect(parsed).toEqual({
      PLAIN: "value",
      EXPORTED: "exported-value",
      DOUBLE: "with spaces",
      // Single quotes are literal, as in a POSIX shell — no expansion, no escapes.
      SINGLE: "literal $VALUE",
      SPACED: "padded",
      INLINE: "value",
    });
  });

  it("decodes escapes in double quotes only", () => {
    expect(parseEnvFile('A="one\\ntwo"')["A"]).toBe("one\ntwo");
    expect(parseEnvFile("B='one\\ntwo'")["B"]).toBe("one\\ntwo");
  });

  it("skips a line it cannot understand instead of throwing", () => {
    // A malformed credentials file must not stop a run from starting; the credential is simply not
    // found, and THAT is the error the caller reports.
    expect(parseEnvFile("this is not an assignment\nGOOD=yes")).toEqual({ GOOD: "yes" });
  });
});

describe("the lookup chain", () => {
  it("prefers the keychain over every file and the environment", () => {
    write(projectDir, ".env.local", "KEY=from-project-local");
    write(baseDir, ".env", "KEY=from-base");
    const hit = resolverOf({ keychain: () => "from-keychain", env: { KEY: "from-env" } }).lookup("KEY");

    expect(hit).toEqual({ value: "from-keychain", source: "keychain" });
  });

  it("prefers the project's .env.local over its .env", () => {
    write(projectDir, ".env.local", "KEY=local");
    write(projectDir, ".env", "KEY=committed");

    expect(resolverOf().lookup("KEY")).toMatchObject({ value: "local", source: "project-env-local" });
  });

  it("prefers the project's .jaira/ pair over the pair at its root", () => {
    // A checkout has two places, and `.jaira/` is the narrower: a key put there was put there FOR
    // JaiRA, where one at the repository root may be shared with everything else the project runs.
    mkdirSync(join(projectDir, ".jaira"), { recursive: true });
    write(join(projectDir, ".jaira"), ".env", "KEY=for-jaira");
    write(projectDir, ".env.local", "KEY=for-the-repo");

    expect(resolverOf().lookup("KEY")).toMatchObject({ value: "for-jaira", source: "project-jaira-env" });
  });

  it("prefers .jaira/.env.local over .jaira/.env, exactly as the root pair does", () => {
    mkdirSync(join(projectDir, ".jaira"), { recursive: true });
    write(join(projectDir, ".jaira"), ".env.local", "KEY=local");
    write(join(projectDir, ".jaira"), ".env", "KEY=committed");

    expect(resolverOf().lookup("KEY")).toMatchObject({ value: "local", source: "project-jaira-env-local" });
  });

  it("prefers the project over the shared root — the reason the order is narrowest first", () => {
    write(projectDir, ".env", "KEY=this-project");
    write(baseDir, ".env.local", "KEY=every-project");

    expect(resolverOf().lookup("KEY")).toMatchObject({ value: "this-project", source: "project-env" });
  });

  it("prefers the shared root's .env.local over its .env", () => {
    write(baseDir, ".env.local", "KEY=machine-local");
    write(baseDir, ".env", "KEY=machine");

    expect(resolverOf().lookup("KEY")).toMatchObject({ value: "machine-local", source: "base-env-local" });
  });

  it("falls back to the environment last", () => {
    expect(resolverOf({ env: { KEY: "from-env" } }).lookup("KEY")).toEqual({ value: "from-env", source: "environment" });
  });

  it("reports nothing when no link supplies it", () => {
    expect(resolverOf().lookup("ABSENT")).toBeUndefined();
  });

  it("treats an empty value as absent, so a blank line does not shadow a real key", () => {
    write(projectDir, ".env.local", "KEY=");
    write(baseDir, ".env", "KEY=real");

    expect(resolverOf().lookup("KEY")).toMatchObject({ value: "real", source: "base-env" });
  });

  it("skips the keychain entirely when none is injected — the CLI's situation", () => {
    write(baseDir, ".env", "KEY=from-file");

    expect(resolverOf().lookup("KEY")).toMatchObject({ source: "base-env" });
  });
});

describe("describe()", () => {
  it("reports the origin and the file, and never the value", () => {
    write(baseDir, ".env.local", "KEY=secret-value");
    const origin = resolverOf().describe("KEY");

    expect(origin).toEqual({ source: "base-env-local", file: join(baseDir, ".env.local") });
    // The point of the whole method: this is what crosses IPC into the renderer.
    expect(JSON.stringify(origin)).not.toContain("secret-value");
  });

  it("is undefined for a secret nothing supplies", () => {
    expect(resolverOf().describe("ABSENT")).toBeUndefined();
  });
});
