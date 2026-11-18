/**
 * Paths judged from where the task's shell stands (decision 0030, ruling 7): a line with no `cwd` starts
 * in the shell's directory, and its `~` and `$VARS` expand as that shell would expand them — so
 * `rm -rf $HOME/x` is judged at the home directory, not at `<workspace>/$HOME/x`.
 */
import { describe, expect, it } from "vitest";
import { decideCommand, projectPolicy } from "../src/policy";
import { expandShellWord } from "../src/shellSessions";
const policy = projectPolicy({ functions: { shell: { builtins: true } } });
/** A floor that refuses writing anywhere outside `/w`. */
const insideOnly = (_tool: string, place: { path?: string }): "allow" | "deny" | undefined => (place.path === undefined ? undefined : place.path.startsWith("/w") ? "allow" : "deny");
const env: Record<string, string> = { HOME: "/home/u", BUILD: "/w/out" };
const expand = (word: string): string => expandShellWord(word, (name) => env[name]);

describe("a line's paths, as its shell would expand them", () => {
  it("judges a variable's path where it points", () => {
    expect(decideCommand(policy, "rm -rf $HOME/x", "posix", { root: "/w", scopeOf: insideOnly }).action).toBe("allow");
    expect(decideCommand(policy, "rm -rf $HOME/x", "posix", { root: "/w", scopeOf: insideOnly, expand }).action).toBe("deny");
    expect(decideCommand(policy, "rm -rf ~/x", "posix", { root: "/w", scopeOf: insideOnly, expand }).action).toBe("deny");
    expect(decideCommand(policy, "rm -rf $BUILD/x", "posix", { root: "/w", scopeOf: insideOnly, expand }).action).toBe("allow");
  });

  it("follows a cd to a variable", () => {
    expect(decideCommand(policy, "cd $HOME && rm -rf x", "posix", { root: "/w", scopeOf: insideOnly, expand }).action).toBe("deny");
  });

  it("starts a line in the shell's directory", () => {
    expect(decideCommand(policy, "rm -rf x", "posix", { root: "/w", cwd: "/elsewhere", scopeOf: insideOnly }).action).toBe("deny");
    expect(decideCommand(policy, "rm -rf x", "posix", { root: "/w", cwd: "/w/pkg", scopeOf: insideOnly }).action).toBe("allow");
  });
});
