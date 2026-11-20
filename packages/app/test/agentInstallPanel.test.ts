/**
 * Connections → Agents, for an agent JaiRA can install (claude, codex): what the panel under its row
 * offers when the binary will not run here — the ways to install it, the reinstall of what is left of
 * one, the path it was found at — and what its version line says when it runs (`connectionsModel.ts`).
 */
import { describe, expect, it } from "vitest";
import type { AgentInstall, InstallChoice } from "@jaira/shared";
import { installMenuOf, installPanelOf, shelfTileOf, updateOf } from "../src/renderer/connectionsModel";

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

/** Gemini on a Mac with no Node.js and no Homebrew, as the check builds its menu (`chain.ts`). */
const NPM_STEP = { title: "Gemini (cli)", via: "npm", display: "npm install -g @google/gemini-cli" };
const THEN_NPM: InstallChoice = { key: "npm", name: "npm", steps: [NPM_STEP] };
const GEMINI_MENU: InstallChoice[] = [
  {
    key: "npm",
    name: "Node.js",
    steps: [],
    next: [
      { key: "fnm", name: "fnm", steps: [{ title: "fnm", via: "the native installer", display: "curl -fsSL https://fnm.vercel.app/install | bash -s -- --force-install" }, { title: "Node.js", via: "fnm", display: "fnm install --lts && fnm default lts-latest" }], next: [THEN_NPM] },
      { key: "nvm", name: "nvm", steps: [{ title: "nvm", via: "the native installer", display: "curl -o- …/install.sh | bash" }, { title: "Node.js", via: "nvm", display: "nvm install --lts" }], next: [THEN_NPM] },
      { key: "homebrew", name: "Homebrew", steps: [{ title: "Homebrew", via: "the native installer", display: "installer -pkg Homebrew.pkg -target / (as administrator)", elevated: true }, { title: "Node.js", via: "Homebrew", display: "brew install node" }], next: [THEN_NPM] },
    ],
  },
];

describe("the install menu, a step a row", () => {
  it("draws a row for what the agent needs first, its ways behind the arrow, each saying what comes after", () => {
    const [node] = installMenuOf(GEMINI_MENU);
    expect(node).toMatchObject({ name: "Node.js", path: ["npm"], way: ["npm"], at: "by fnm", then: "then npm install -g @google/gemini-cli", elevated: false });
    expect(node!.title).toBe("runs curl -fsSL https://fnm.vercel.app/install | bash -s -- --force-install, then fnm install --lts && fnm default lts-latest, then npm install -g @google/gemini-cli");
    expect(node!.sub?.map((row) => [row.name, row.at, row.path, row.elevated])).toEqual([
      ["fnm", "installs fnm, then Node.js", ["npm", "fnm"], false],
      ["nvm", "installs nvm, then Node.js", ["npm", "nvm"], false],
      ["Homebrew", "installs Homebrew, then Node.js", ["npm", "homebrew"], true],
    ]);
    // One way after each: said as "then …", with no arrow of its own.
    expect(node!.sub?.[0]).toMatchObject({ then: "then npm install -g @google/gemini-cli" });
    expect(node!.sub?.[0]?.sub).toBeUndefined();
  });

  it("puts the menu in the panel — and keeps a way that is all there is to it as the way it always was", () => {
    const panel = installPanelOf({ choices: GEMINI_MENU });
    expect(panel?.rows.map((row) => [row.name, row.choice, row.method, row.menu !== undefined])).toEqual([["Node.js", ["npm"], undefined, true]]);
    const plain = installPanelOf({ install: [NATIVE, NPM], choices: [{ key: "native", name: "the native installer", steps: [{ title: "Claude", ...NATIVE }] }, { key: "npm", name: "npm", steps: [{ title: "Claude", ...NPM }] }] });
    expect(plain?.rows.map((row) => [row.name, row.method, row.choice])).toEqual([
      ["Native installer", "native", undefined],
      ["npm", "npm", undefined],
    ]);
  });

  it("says on a shelf tile what the recommended way installs first", () => {
    expect(shelfTileOf({ choices: GEMINI_MENU }).sub).toBe("installs fnm and Node.js first");
    expect(shelfTileOf({ choices: [{ key: "npm", name: "npm", steps: [NPM_STEP] }] }).sub).toBe("installs with npm");
  });
});

