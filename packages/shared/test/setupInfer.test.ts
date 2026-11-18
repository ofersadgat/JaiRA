/** The setup found in a checkout with no setup file: only what its own files state. */
import { describe, expect, it } from "vitest";
import { bringPatterns, inferSetup, readSetupValue, type CheckoutFiles } from "../src/index";

function files(entries: Record<string, string | true>): CheckoutFiles {
  return new Map(Object.entries(entries));
}

describe("the setup found in a checkout", () => {
  it("reads a pnpm project with an .nvmrc and .env files in its .gitignore", () => {
    const found = inferSetup(
      files({
        "package.json": JSON.stringify({ packageManager: "pnpm@9.12.0" }),
        "pnpm-lock.yaml": true,
        ".nvmrc": true,
        ".gitignore": "node_modules/\n.env*.local\n.env.example\n/dist\n",
      }),
    );
    expect(found?.targets["default"]?.steps).toEqual([
      { install: "node", version: ".nvmrc" },
      { install: "pnpm", version: "package.json" },
      { run: "pnpm install", again: ["pnpm-lock.yaml"] },
      { bring: [".env*.local"] },
    ]);
  });

  it("lets a Dev Container stand for everything but the files to bring", () => {
    const found = inferSetup(files({ ".devcontainer/devcontainer.json": true, "package.json": "{}", ".gitignore": ".env\n" }));
    expect(found?.targets["default"]?.steps).toEqual([{ use: "devcontainer", fields: {} }, { bring: [".env"] }]);
  });

  it("reads Python, Ruby, Rust and Go, and lets mise hold the versions", () => {
    const found = inferSetup(
      files({ "mise.toml": true, "pyproject.toml": true, "uv.lock": true, "Cargo.toml": true, "go.mod": "module x\ngo 1.22\n", ".python-version": true }),
    );
    expect(found?.targets["default"]?.steps).toEqual([
      { use: "mise", fields: {} },
      { use: "uv", fields: {}, again: ["uv.lock"] },
      { run: "cargo fetch", again: ["Cargo.lock"] },
      { run: "go mod download", again: ["go.sum"] },
    ]);
  });

  it("uses npm ci where only a package-lock is there, and finds nothing in an empty checkout", () => {
    expect(inferSetup(files({ "package.json": "{}", "package-lock.json": true }))?.targets["default"]?.steps).toEqual([
      { install: "node" },
      { run: "npm ci", again: ["package-lock.json"] },
    ]);
    expect(inferSetup(files({ "README.md": true }))).toBeUndefined();
  });

  it("is a file the setup reader accepts once written out", () => {
    const found = inferSetup(files({ "package.json": "{}", "yarn.lock": true, Gemfile: true, ".ruby-version": true }))!;
    const written = { version: found.version, default: found.targets["default"]!.steps.map((s) => ("use" in s ? { ...s.fields, ...s, fields: undefined } : s)) };
    const back = readSetupValue(JSON.parse(JSON.stringify(written)));
    expect(back.ok).toBe(true);
  });

  it("brings only the .env files a .gitignore names", () => {
    expect(bringPatterns("/.env\n.env.local\n.env.sample\n# .env.secret\n!.env.keep\n.envrc\n.env.*.local\n")).toEqual([".env", ".env.local", ".env.*.local"]);
    expect(bringPatterns(undefined)).toEqual([]);
  });
});
