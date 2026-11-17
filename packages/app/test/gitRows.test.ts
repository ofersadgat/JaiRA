/**
 * Connections → Git (`connectionsModel.ts`): git is a row whether or not it is here, since JaiRA cannot
 * do without it; the forges' own CLIs are rows once they are here and tiles on a shelf while they are
 * not, as an agent is. A closed row's one button is the install that would make it work.
 */
import { describe, expect, it } from "vitest";
import type { ProbeResult } from "@jaira/shared";
import { agentLineOf, gitCliActionOf, gitCliPanelOf, gitCliPlaceOf, providerState, shelfTileOf } from "../src/renderer/connectionsModel";

const CLT = { method: "command-line-tools", via: "Apple's Command Line Tools", display: "xcode-select --install" } as const;
const BREW = { method: "homebrew", via: "Homebrew", display: "brew install gh" } as const;
const WINGET = { method: "winget", via: "WinGet", display: "winget install --id GitHub.cli --exact" } as const;
const CHOCO = { method: "chocolatey", via: "Chocolatey", display: "choco install gh -y (as administrator)" } as const;

const probe = (name: string, over: Partial<ProbeResult>): ProbeResult => ({ name, status: "ok", detail: "", ...over });

describe("where a git program is drawn", () => {
  it("keeps git a row even when it is nowhere — its absence is said where it is looked for", () => {
    expect(gitCliPlaceOf("git", probe("git", { status: "failed", install: { install: [CLT] } }))).toBe("row");
    expect(gitCliPlaceOf("git", undefined)).toBe("row");
  });

  it("puts gh and glab on the shelf while they are not here, and makes them rows once they are", () => {
    expect(gitCliPlaceOf("gh", probe("gh", { status: "failed", install: { install: [BREW] } }))).toBe("shelf");
    expect(gitCliPlaceOf("glab", probe("glab", { status: "failed", install: {} }))).toBe("shelf");
    expect(gitCliPlaceOf("gh", probe("gh", { version: "2.83.0", install: { path: "/opt/homebrew/bin/gh", onPath: true, method: "homebrew" } }))).toBe("row");
  });
});

describe("a git program's row", () => {
  it("says a ready one's version and how it was installed", () => {
    const ready = probe("git", { version: "2.39.5 (Apple Git-154)", install: { path: "/usr/bin/git", onPath: true, method: "command-line-tools" } });
    expect(agentLineOf(ready, providerState(true, ready), ready.install)).toEqual({ word: "ready", rest: "2.39.5 (Apple Git-154) · Command Line Tools" });
  });

  it("offers the first way to install a missing one, and nothing for one that works", () => {
    const missing = probe("git", { status: "failed", detail: "macOS has only a placeholder for git until Apple's Command Line Tools are installed", install: { install: [CLT] } });
    expect(gitCliActionOf(missing)).toEqual({ kind: "install", label: "Install", title: "runs xcode-select --install", method: "command-line-tools" });
    expect(gitCliActionOf(probe("git", { install: { path: "/usr/bin/git", onPath: true } }))).toBeUndefined();
  });

  it("has no path to use: one off the PATH is reached by the check, so one still reported so is left to its sentence", () => {
    expect(gitCliPanelOf({ path: "/home/me/.linuxbrew/bin/gh", onPath: false })).toBeUndefined();
    expect(gitCliActionOf(probe("gh", { status: "failed", install: { path: "/home/me/.linuxbrew/bin/gh", onPath: false } }))).toBeUndefined();
  });

  it("lists every Windows way on a tile, the first recommended", () => {
    const { sub, ways } = shelfTileOf({ install: [WINGET, CHOCO] });
    expect(sub).toBe("installs with WinGet");
    expect(ways.map((way) => [way.name, way.at])).toEqual([
      ["WinGet", "winget install --id GitHub.cli --exact"],
      ["Chocolatey", "choco install gh -y (as administrator)"],
    ]);
  });
});
