/** The setup file's schema, as the editor holds `.jaira/setup.json` to it: what it accepts and refuses. */
import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import { schemaForFile, setupSchema } from "@jaira/shared";

const validate = new Ajv({ allErrors: true, strict: false }).compile(setupSchema());

describe("the setup file's schema", () => {
  it("accepts a file of targets, use steps with their own fields among them", () => {
    const ok = validate({
      version: 1,
      default: [
        { target: "node" },
        { install: "vips" },
        { run: "brew bundle", on: ["mac"] },
        { bring: ".env*.local" },
        { run: "pnpm install", again: ["pnpm-lock.yaml"] },
        { use: "github", file: ".github/workflows/ci.yml", job: "build", through: "Build deps" },
      ],
      node: [{ install: "node", version: ".nvmrc" }],
      gpu: { on: ["cuda"], steps: [{ install: "cuda", version: 12.4 }] },
      environment: [{ first: [{ use: "compose", file: "compose.dev.yml", when: "open" }, { install: "postgres", version: "16" }] }],
    });
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  it("refuses a field a use kind does not take, a step of two kinds, and a missing version", () => {
    expect(validate({ version: 1, default: [{ use: "nvm", job: "x" }] })).toBe(false);
    expect(validate({ version: 1, default: [{ run: "x", install: "y" }] })).toBe(false);
    expect(validate({ default: [] })).toBe(false);
  });

  it("is the schema the editor picks for the setup files by name", () => {
    expect(schemaForFile(".jaira/setup.json")?.id).toBe("setup");
    expect(schemaForFile("/repo/.jaira/setup.local.yaml")?.id).toBe("setup");
  });
});
