/**
 * `scopes` on an executor node, as CONFIG.
 *
 * This block validates strictly, and the reason is that its mistakes fail open in the reader's
 * imagination rather than loudly on the screen: a typo'd key is a sandbox somebody believes they
 * have. `{"paths": …}` would parse as a scope naming no place, match nothing, and — since unmatched
 * denies — refuse everything under it, which reads as "the tool is broken" rather than "my table is
 * wrong". Every assertion here is about naming the mistake instead of absorbing it.
 */
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config";

const withScopes = (scopes: unknown): unknown => ({
  executors: { main: { kind: "operation", scopes } },
});

const scopesOf = (scopes: unknown) => parseConfig(withScopes(scopes) as never).executors["main"]!.scopes;

describe("an executor's scope table", () => {
  it("is carried through parsing — the whole point", () => {
    // It used to be REFUSED: `allowedFields` did not know the key, so authoring a floor was a hard
    // config error rather than a sandbox.
    expect(scopesOf([{ path: "/work/**", tools: { read_file: "allow" }, default: "deny" }])).toEqual([
      { path: "/work/**", tools: { read_file: "allow" }, default: "deny" },
    ]);
  });

  it("takes a url glob for the tools that reach the network", () => {
    expect(scopesOf([{ url: "https://docs.example/**", tools: { web_fetch: "allow" } }])).toEqual([
      { url: "https://docs.example/**", tools: { web_fetch: "allow" } },
    ]);
  });

  it("is optional, and absent means no floor at all", () => {
    expect(parseConfig({ executors: { main: { kind: "operation" } } } as never).executors["main"]!.scopes).toBeUndefined();
  });

  it("refuses a key it does not know, by name", () => {
    // The one that matters. Silently keeping `paths` would build a scope about nowhere.
    expect(() => scopesOf([{ paths: "/work/**", default: "allow" }])).toThrow(/paths/);
  });

  it("refuses a scope naming both a path and a url", () => {
    // One entry claiming both would have to be resolved twice with no rule for combining the answers.
    expect(() => scopesOf([{ path: "/a", url: "https://b", default: "allow" }])).toThrow(/one place/);
  });

  it("refuses a scope naming no place", () => {
    expect(() => scopesOf([{ default: "allow" }])).toThrow(/names no place/);
  });

  it("refuses a scope that says nothing about anything", () => {
    // Inert is indistinguishable from a rule somebody meant to finish writing.
    expect(() => scopesOf([{ path: "/work/**" }])).toThrow(/says nothing/);
  });

  it("refuses a mode that is not one of the four", () => {
    expect(() => scopesOf([{ path: "/a", default: "maybe" }])).toThrow(/allow/);
    expect(() => scopesOf([{ path: "/a", tools: { read_file: "sometimes" } }])).toThrow(/read_file/);
  });

  it("refuses an empty glob, which would match nothing and read as a sandbox", () => {
    expect(() => scopesOf([{ path: "  ", default: "allow" }])).toThrow(/non-empty/);
  });

  it("refuses a table that is not an array", () => {
    expect(() => scopesOf({ path: "/a", default: "allow" })).toThrow(/must be an array/);
  });

  it("names WHICH entry is wrong, so a long table is fixable", () => {
    expect(() => scopesOf([{ path: "/a", default: "allow" }, { path: "/b" }])).toThrow(/\[1\]/);
  });
});
