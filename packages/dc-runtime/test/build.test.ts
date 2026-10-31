import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
// @ts-expect-error -- build.mjs is plain JavaScript with no declarations; its one export is used as it is.
import { buildSupport } from "../build.mjs";

const outdir = await mkdtemp(join(tmpdir(), "dc-runtime-"));
afterAll(() => rm(outdir, { recursive: true, force: true }));

describe("support.js", () => {
  it("builds into one browser file with React inside, and lists what it bundled", async () => {
    const { outfile, modulesFile } = (await buildSupport(outdir)) as { outfile: string; modulesFile: string };
    const bundle = await readFile(outfile, "utf8");
    // An IIFE: no module syntax, nothing left to resolve.
    expect(bundle.startsWith('"use strict";(()=>{')).toBe(true);
    expect(bundle).toContain("@license React");
    expect(bundle).not.toMatch(/\brequire\(["']react/);
    expect(bundle).toContain("x-dc{display:none!important}");
    expect(bundle).toContain("dc:ready");
    const modules = JSON.parse(await readFile(modulesFile, "utf8")) as string[];
    for (const pkg of ["react", "react-dom", "scheduler"]) {
      expect(modules.some((file) => file.split(/[\\/]/).includes(pkg))).toBe(true);
    }
  });
});
