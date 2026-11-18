/**
 * An agent's `shell` setting (decision 0030): the emulated shell, or the absolute path of a zsh, bash
 * or sh — on every kind of agent, refused when it is anything else.
 */
import { describe, expect, it } from "vitest";
import { agentShellProblem, parseConfig } from "../src/config";

describe("an agent's shell", () => {
  it("is taken on every kind of agent", () => {
    const config = parseConfig({
      agents: {
        claudeCode: { shell: "/bin/zsh" },
        claudeCli: { shell: "emulated" },
        codex: { shell: "/opt/homebrew/bin/bash" },
        genericCli: [{ name: "aider", command: "aider", shell: "/bin/sh" }],
      },
    });
    expect(config.agents.claudeCode?.shell).toBe("/bin/zsh");
    expect(config.agents.claudeCli?.shell).toBe("emulated");
    expect(config.agents.codex?.shell).toBe("/opt/homebrew/bin/bash");
    expect(config.agents.genericCli?.find((agent) => agent.name === "aider")?.shell).toBe("/bin/sh");
  });

  it("is refused, naming why, when it is not a zsh, bash or sh by absolute path", () => {
    expect(() => parseConfig({ agents: { claudeCli: { shell: "zsh" } } })).toThrow(/agents\.claudeCli\.shell must be an absolute path/);
    expect(() => parseConfig({ agents: { codex: { shell: "/usr/bin/fish" } } })).toThrow(/must name a zsh, bash or sh \('fish'/);
    expect(agentShellProblem(undefined)).toBeUndefined();
    expect(agentShellProblem("emulated")).toBeUndefined();
    expect(agentShellProblem(3)).toMatch(/must be "emulated"/);
  });
});
