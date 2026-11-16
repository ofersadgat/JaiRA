/**
 * Connections → Agents, for an agent JaiRA can install (claude, codex): what the panel under its row
 * offers when the binary will not run here — the ways to install it, the reinstall of what is left of
 * one, the path it was found at — and what its version line says when it runs (`connectionsModel.ts`).
 */
import { describe, expect, it } from "vitest";
import type { AgentInstall } from "@jaira/shared";
import { installPanelOf, updateOf } from "../src/renderer/connectionsModel";

const NATIVE = { method: "native", via: "the native installer", display: "curl -fsSL https://claude.ai/install.sh | bash" } as const;
const NPM = { method: "npm", via: "npm", display: "npm install -g @anthropic-ai/claude-code" } as const;

describe("the install panel", () => {
  it("lists the ways to install an agent that is not here, the recommended one first", () => {
    const panel = installPanelOf({ install: [NATIVE, NPM] });
    expect(panel?.head).toBe("Not installed here. Install it with:");
    expect(panel?.right).toBe("the first is recommended");
    expect(panel?.rows.map((row) => [row.name, row.at, row.button, row.method])).toEqual([
      ["Native installer", NATIVE.display, "Install", "native"],
      ["npm", NPM.display, "Install", "npm"],
    ]);
  });

  it("says so when nothing here can install it", () => {
    expect(installPanelOf({})).toEqual({ head: "Not installed — and none of the ways it is installed is on this machine", right: "", rows: [] });
  });

  it("offers the reinstall for what is left of an install — an update with no way named", () => {
    const install: AgentInstall = { path: "/usr/local/bin/codex", onPath: true, broken: true, method: "homebrew", update: { method: "homebrew", via: "Homebrew", display: "brew reinstall --cask codex" } };
    const panel = installPanelOf(install);
    expect(panel?.rows).toEqual([{ key: "reinstall", name: "Homebrew", at: "brew reinstall --cask codex", button: "Reinstall", title: "runs brew reinstall --cask codex" }]);
    expect(updateOf(install)).toBeUndefined();
  });

  it("offers the path an agent was found at when this app's PATH does not reach it", () => {
    const panel = installPanelOf({ path: "/Users/me/.local/bin/claude", onPath: false, method: "native", update: { method: "native", via: "its own updater", display: "claude update" } });
    expect(panel?.rows).toMatchObject([{ name: "Found at", at: "/Users/me/.local/bin/claude", button: "Use it", path: "/Users/me/.local/bin/claude" }]);
  });

  it("draws nothing for an agent that runs, or one nobody looked for", () => {
    expect(installPanelOf({ path: "/opt/homebrew/bin/claude", onPath: true, method: "homebrew" })).toBeUndefined();
    expect(installPanelOf(undefined)).toBeUndefined();
  });
});

describe("the version line's Update", () => {
  it("names how it was installed, and says what Update runs", () => {
    expect(updateOf({ path: "/opt/homebrew/bin/claude", onPath: true, method: "homebrew", update: { method: "homebrew", via: "Homebrew", display: "brew upgrade --cask claude-code" } })).toEqual({
      via: "Homebrew",
      title: "update it: runs brew upgrade --cask claude-code",
    });
  });

  it("offers no Update for an install whose way is not known", () => {
    expect(updateOf({ path: "/opt/tools/claude", onPath: true })).toBeUndefined();
  });
});
