/**
 * The `functions` block (decision 0007, amended 2026-09-23): each shipped function's defaults in one
 * place — `smart`'s judge, `review_artifacts` on a forge, and `bash`'s built-in refusals — layered like
 * every other block, strict about what it accepts, and the only home of what the dissolved `policy`
 * block and the top-level `smart` block used to hold.
 */
import { describe, expect, it } from "vitest";
import { CONFIG_SECTIONS, DEFAULT_SMART_PROMPT, defaultConfig, defaultFunctions, mergeConfigDocuments, parseConfig } from "../src/index";

describe("functions", () => {
  it("carries every default when nothing is said", () => {
    const expected = { smart: {}, review_artifacts: { publish: "ask", settleAfter: "10m" }, bash: { builtins: true } };
    expect(defaultFunctions()).toEqual(expected);
    expect(defaultConfig().functions).toEqual(expected);
    expect(parseConfig({}).functions).toEqual(expected);
    expect(parseConfig({ functions: {} }).functions).toEqual(expected);
  });

  it("reads what a layer states and keeps the defaults for the rest", () => {
    const parsed = parseConfig({
      functions: { smart: { model: "claude-haiku-4" }, review_artifacts: { publish: "allow" }, bash: { builtins: false } },
    }).functions;
    expect(parsed).toEqual({ smart: { model: "claude-haiku-4" }, review_artifacts: { publish: "allow", settleAfter: "10m" }, bash: { builtins: false } });
    // An empty model or prompt is "use the default", as it always was.
    expect(parseConfig({ functions: { smart: { model: "", prompt: "" } } }).functions.smart).toEqual({});
  });

  it("takes a project's value over the shared root's, key by key", () => {
    const merged = mergeConfigDocuments(
      { functions: { smart: { model: "claude-haiku-4", prompt: "be careful" }, review_artifacts: { settleAfter: "30m" } } },
      { functions: { smart: { model: "claude-cli/haiku" }, bash: { builtins: false } } },
    );
    expect(parseConfig(merged).functions).toEqual({
      smart: { model: "claude-cli/haiku", prompt: "be careful" },
      review_artifacts: { publish: "ask", settleAfter: "30m" },
      bash: { builtins: false },
    });
  });

  it("refuses what is not a setting, or not the right kind of value, by name", () => {
    expect(() => parseConfig({ functions: { smrt: {} } })).toThrow(/config\.functions\.smrt is not a setting/);
    expect(() => parseConfig({ functions: { smart: { model: 4 } } })).toThrow("config.functions.smart.model must be a string");
    expect(() => parseConfig({ functions: { smart: { temperature: 0 } } })).toThrow(/config\.functions\.smart\.temperature is not a setting/);
    expect(() => parseConfig({ functions: { review_artifacts: { publish: "yes please" } } })).toThrow("config.functions.review_artifacts.publish must be one of ask, allow, deny");
    expect(() => parseConfig({ functions: { review_artifacts: { settleAfter: "a while" } } })).toThrow(/settleAfter must be a duration/);
    expect(() => parseConfig({ functions: { bash: { builtins: "false" } } })).toThrow("config.functions.bash.builtins must be true or false");
    expect(() => parseConfig({ functions: { bash: { rules: [] } } })).toThrow(/config\.functions\.bash\.rules is not a setting/);
    expect(() => parseConfig({ functions: [] })).toThrow("config.functions must be an object");
  });

  it("refuses the blocks it replaced, naming where each thing went", () => {
    expect(() => parseConfig({ policy: {} })).toThrow(/config\.policy is dissolved: a command rule is a line under the bash tool of each permission set/);
    expect(() => parseConfig({ policy: { builtins: false } })).toThrow(/functions\.bash\.builtins/);
    expect(() => parseConfig({ smart: { model: "x" } })).toThrow("config.smart has moved to functions.smart");
    expect(() => parseConfig({ integrations: { review: { settleAfter: "30m" } } })).toThrow(/functions\.review_artifacts\.settleAfter/);
  });

  it("is offered in Settings as one declared section, a sub-form per function, each field with the default it falls to", () => {
    expect(CONFIG_SECTIONS.find((s) => s.key === "smart")).toBeUndefined();
    const section = CONFIG_SECTIONS.find((s) => s.key === "functions");
    expect(section).toMatchObject({
      key: "functions",
      schema: {
        type: "object",
        properties: {
          smart: { type: "object", properties: { model: { type: "string" }, prompt: { type: "string", default: DEFAULT_SMART_PROMPT } } },
          review_artifacts: { type: "object", properties: { publish: { enum: ["ask", "allow", "deny"], default: "ask" }, settleAfter: { type: "string", default: "10m" } } },
          bash: { type: "object", properties: { builtins: { type: "boolean", default: true } } },
        },
      },
    });
    // Every property says what it is for: the form draws the title and the description, nothing else.
    const walk = (node: Record<string, unknown>, at: string): void => {
      for (const [name, child] of Object.entries((node["properties"] ?? {}) as Record<string, Record<string, unknown>>)) {
        expect(typeof child["title"], `${at}.${name}.title`).toBe("string");
        expect(String(child["description"] ?? "").length, `${at}.${name}.description`).toBeGreaterThan(20);
        walk(child, `${at}.${name}`);
      }
    };
    walk(section!.schema as Record<string, unknown>, "functions");
  });
});
