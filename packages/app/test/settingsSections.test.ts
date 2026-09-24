/**
 * The Settings sidebar and its layer switch after round 5 (2026-09-23): ONE flat list of pages in
 * the order a person sets things up, every page layered with the same switch, and Shared the layer
 * a window opens on.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG_LAYER, SECTIONS, settingsLayersFor } from "../src/renderer/settingsSections";

describe("the Settings pages", () => {
  it("are one list, in the order a person sets things up", () => {
    expect(SECTIONS.map((page) => page.id)).toEqual(["appearance", "connections", "models", "tools", "runs", "data"]);
    expect(SECTIONS.map((page) => page.label)).toEqual(["Appearance", "Connections", "Models", "Tools", "Runs", "Data & history"]);
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

describe("the layer switch", () => {
  it("opens on Shared", () => {
    expect(DEFAULT_CONFIG_LAYER).toBe("base");
  });

  it("offers Just you, This project and Shared, strongest first — and no project layer without one", () => {
    expect(settingsLayersFor(true)).toEqual(["you", "project", "base"]);
    expect(settingsLayersFor(false)).toEqual(["you", "base"]);
  });
});
