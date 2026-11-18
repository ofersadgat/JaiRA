/**
 * The Settings sidebar after round 5 (2026-09-23): ONE flat list of pages in the order a person sets
 * things up, every page layered at the same path (`settingsScope.ts`, 2026-11-17), and Shared the
 * layer a window opens on.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG_LAYER, SECTIONS, settingsFrameOf, settingsLeadParts } from "../src/renderer/settingsSections";

describe("the Settings pages", () => {
  it("are one list, in the order a person sets things up", () => {
    expect(SECTIONS.map((page) => page.id)).toEqual(["appearance", "connections", "machines", "models", "tools", "runs", "data", "about"]);
    expect(SECTIONS.map((page) => page.label)).toEqual(["Appearance", "Connections", "Machines", "Models", "Tools", "Runs", "Data & history", "About"]);
  });

  it("are all layered but Machines and About, the last — both this machine's own", () => {
    expect(SECTIONS.filter((page) => !page.layered).map((page) => page.id)).toEqual(["machines", "about"]);
    expect(SECTIONS.at(-1)?.id).toBe("about");
  });

  it("no longer offer the raw document or a page of their own for the Files tree", () => {
    // Every key of settings.json has a row on a page, and the tree's patterns are Appearance's last section.
    const ids: readonly string[] = SECTIONS.map((page) => page.id);
    expect(ids).not.toContain("raw");
    expect(ids).not.toContain("files");
  });

  it("each say what they are for, which is the first clause of the page's lead", () => {
    for (const page of SECTIONS) expect(page.purpose.length, page.id).toBeGreaterThan(0);
  });
});

describe("the layer a page edits", () => {
  it("opens on Shared", () => {
    expect(DEFAULT_CONFIG_LAYER).toBe("base");
  });

  it("offers Which rows on both personal layers, and only there", () => {
    expect(settingsFrameOf("models", "you", "changed")).toMatchObject({ under: true, onlyStated: true });
    expect(settingsFrameOf("models", "projectYou", "every")).toMatchObject({ under: true, onlyStated: false });
    expect(settingsFrameOf("models", "machine", "changed")).toMatchObject({ under: false, onlyStated: false });
    expect(settingsFrameOf("machines", "you", "changed")).toMatchObject({ layered: false, under: false });
  });

  it("says in its lead whose settings these are and where they are kept, by the path's own names", () => {
    const words = (layer: Parameters<typeof settingsLeadParts>[1]): string => (settingsLeadParts("models", layer, { project: "atlas", machine: "build-01" }) ?? []).map((part) => part.text).join("");
    expect(words("projectMachine")).toContain("atlas on build-01");
    expect(words("projectMachine")).toContain(".jaira/settings.local.json");
    expect(words("machine")).toContain("machine-settings.json");
    expect(words("projectYou")).toContain("you in atlas");
    expect(words("base")).toContain("~/.jaira/settings.json");
  });
});
