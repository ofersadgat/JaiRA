/**
 * The way from a project to its settings (the person, 2026-09-25): a ⚙ at the right end of the
 * project's row in the sidebar, and a layer switch whose project segment wears the project's NAME
 * rather than "This project".
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Sidebar, type SidebarProject, type SidebarView } from "../src/renderer/sidebar";
import { LayerPicker } from "../src/renderer/panes";

const project = (dir: string, label: string, kind: SidebarProject["kind"] = "user"): SidebarProject => ({ project: dir, label, kind, hue: "var(--p1)", counts: {} as SidebarProject["counts"] });
const settings: SidebarView = { id: "settings", glyph: "⚙", label: "Settings" };

const sidebar = (at: string | null): string =>
  renderToStaticMarkup(
    createElement(Sidebar, {
      views: [{ id: "files", glyph: "❏", label: "Files" }],
      roots: [],
      footer: [],
      settings,
      onLeaveSettings: () => undefined,
      view: "files",
      onView: () => undefined,
      collapsed: false,
      onCollapsed: () => undefined,
      projects: [project("C:/work/app", "app"), project("C:/work/api", "api")],
      at,
      onProject: () => undefined,
      busy: false,
      theme: "light",
      onTheme: () => undefined,
      onChooseProject: () => undefined,
      onProjectSettings: () => undefined,
    }),
  );

describe("a project's row", () => {
  it("carries a settings button for that project, open or not", () => {
    const html = sidebar("C:/work/app");
    expect(html).toContain('aria-label="Settings for app"');
    expect(html).toContain('aria-label="Settings for api"');
    expect(html.match(/side-project-settings/g)).toHaveLength(2);
  });
});

describe("the settings layer switch", () => {
  it("names the project on its project segment", () => {
    const html = renderToStaticMarkup(createElement(LayerPicker, { value: "project", layers: ["you", "project", "base"], projectName: "app", onChange: () => undefined }));
    expect(html).toContain(">app</button>");
    expect(html).not.toContain("This project");
    expect(html).toContain('class="layer-on"');
  });

  it("says This project when it is not told which", () => {
    const html = renderToStaticMarkup(createElement(LayerPicker, { value: "base", layers: ["you", "project", "base"], onChange: () => undefined }));
    expect(html).toContain(">This project</button>");
  });
});
