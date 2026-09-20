/**
 * `schema:check` — the verdict a form's values get, which has to be the RUN's verdict.
 *
 * The form is only as trustworthy as that agreement. A check stricter than the run refuses a value
 * that would have worked; a looser one lets a value through to a run that fails on its first state.
 * So the property held down here is not "these errors come back" but "ok exactly when the run's own
 * validator says ok", asked of the same values and schemas.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SchemaValidator } from "@declarative-ai/validate";
import type { JsonValue } from "@declarative-ai/json";
import { initProject } from "@jaira/persistence";
import { testHome } from "@jaira/testing";
import { AppService } from "../src/main/service";

let dir: string;
let service: AppService;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "jaira-check-"));
  initProject(dir, testHome());
  service = new AppService({ baseDir: testHome(), watchWorkflows: false });
  await service.open(dir);
});

afterEach(async () => {
  await service.close();
  rmSync(dir, { recursive: true, force: true });
});

const one = (schema: JsonValue, value: JsonValue) => service.checkValues({ checks: [{ key: "k", schema, value }] }).results[0]!;

describe("checking a form's values", () => {
  /** Schemas and values an input form actually meets, good and bad. */
  const CASES: Array<[JsonValue, JsonValue]> = [
    [{ type: "string", enum: ["blocker", "significant", "minor", "note"] }, "significant"],
    [{ type: "string", enum: ["blocker", "significant", "minor", "note"] }, "signficant"],
    [{ type: "number", minimum: 0, maximum: 1 }, 0.8],
    [{ type: "number", minimum: 0, maximum: 1 }, 1.5],
    [{ type: "number", minimum: 0, maximum: 1 }, "0.8"],
    [{ type: "integer" }, 2.5],
    [{ type: "string", contentMediaType: "text/markdown", minLength: 1 }, ""],
    [{ type: "string", contentMediaType: "text/markdown", minLength: 1 }, "A paused run comes back paused."],
    [{ type: ["string", "null"] }, null],
    [{ anyOf: [{ type: "string" }, { type: "object", required: ["path", "line"], properties: { path: { type: "string" }, line: { type: "integer", minimum: 1 } } }] }, { path: "a.ts", line: 0 }],
    [{ type: "array", minItems: 1, items: { type: "object", required: ["id"], properties: { id: { type: "string", pattern: "^AC-\\d+$" } } } }, [{ id: "AC2" }]],
    [{ type: "object", additionalProperties: { type: "string" } }, { NODE_OPTIONS: "--max-old-space-size=4096", DEPTH: 3 }],
  ];

  it("says ok exactly when the run's own validator does", () => {
    const run = new SchemaValidator();
    for (const [schema, value] of CASES) {
      expect(one(schema, value).ok, JSON.stringify([schema, value])).toBe(run.validateValue(schema as never, value).ok);
    }
  });

  it("hands back every complaint whole, with the path it is about", () => {
    const result = one({ type: "array", items: { type: "object", required: ["id", "statement"], properties: { id: { type: "string" }, statement: { type: "string", minLength: 1 } } } }, [
      { id: "AC-1", statement: "ok" },
      { id: "AC-2", statement: "" },
      { statement: "no id" },
    ]);
    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => [e.instancePath, e.keyword])).toEqual([
      ["/1/statement", "minLength"],
      ["/2", "required"],
    ]);
    expect(result.errors[0]!.params).toEqual({ limit: 1 });
  });

  it("passes a schema that constrains nothing without compiling it, as the run does", () => {
    expect(one({}, { anything: [1, 2] })).toEqual({ key: "k", ok: true, errors: [] });
    expect(one(true, "x").ok).toBe(true);
  });

  it("reports a schema that cannot be compiled rather than throwing, and checks the rest", () => {
    const { results } = service.checkValues({
      checks: [
        { key: "broken", schema: { $ref: "https://example.com/nowhere.json" }, value: 1 },
        { key: "fine", schema: { type: "number" }, value: 1 },
      ],
    });
    expect(results[0]).toMatchObject({ key: "broken", ok: false });
    expect(results[0]!.compileError).toBeDefined();
    expect(results[1]).toEqual({ key: "fine", ok: true, errors: [] });
  });
});
