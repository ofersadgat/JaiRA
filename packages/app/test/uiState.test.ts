/**
 * The rules behind a remembered layout (`renderer/uiState.ts`).
 *
 * Everything here is a pure value in and a new value out, which is the point of the module existing
 * at all: what a pane opens at, what a fold does when nothing has been stored, and whether a tree
 * that gains a branch shows it open are decisions that would otherwise be spread across six
 * components and only observable by running the app.
 */
import { describe, expect, it } from "vitest";
import { parseSettings } from "@jaira/shared";
import {
  FOLD,
  FOLD_DEFAULTS,
  PANE,
  PANE_DEFAULTS,
  SHUT,
  emptyUiState,
  openOf,
  paneOf,
  shutOf,
  toggleShut,
  withOpen,
  withPane,
} from "../src/renderer/uiState";

describe("remembered pane sizes", () => {
  it("falls back to the pane's own default until something has been dragged", () => {
    expect(paneOf(emptyUiState(), PANE.shellSidebar)).toBe(PANE_DEFAULTS[PANE.shellSidebar]);
  });

  it("returns what was stored, and leaves the other panes alone", () => {
    const ui = withPane(withPane(emptyUiState(), PANE.shellSidebar, 310), PANE.tasksPanel, 420);
    expect(paneOf(ui, PANE.shellSidebar)).toBe(310);
    expect(paneOf(ui, PANE.tasksPanel)).toBe(420);
    // Dragging the sidebar has nothing to say about the width of the inspector.
    expect(paneOf(ui, PANE.filesInspector)).toBe(PANE_DEFAULTS[PANE.filesInspector]);
  });

  it("answers for a pane it has never heard of rather than throwing", () => {
    // A surface can name its own pane — see `UiSurface` — so an unknown id is ordinary, not a fault.
    expect(paneOf(emptyUiState(), "some.new.pane")).toBe(0);
  });

  it("does not mutate the layout it was given", () => {
    const before = emptyUiState();
    withPane(before, PANE.shellSidebar, 310);
    expect(before.panes).toEqual({});
  });
});

describe("remembered folds", () => {
  it("uses the fold's own default, which is not always shut", () => {
    // The Files editor half defaults OPEN: folding it away is the exception, and an app that started
    // with the editor hidden would look like it had failed to load the file.
    expect(openOf(emptyUiState(), FOLD.filesEditor)).toBe(true);
    expect(openOf(emptyUiState(), FOLD.settingsEffective)).toBe(false);
    expect(FOLD_DEFAULTS[FOLD.filesEditor]).toBe(true);
  });

  it("opens the sidebar for a settings file written before the sidebar existed", () => {
    // Stored POSITIVELY — open means showing — so the absent key reads as "showing". The negative
    // spelling would have collapsed the app's whole navigation on first launch after the upgrade,
    // leaving one button on screen that still did anything.
    expect(openOf(parseSettings({ theme: "light" }).ui, FOLD.shellSidebar)).toBe(true);
    expect(openOf(emptyUiState(), FOLD.shellFiles)).toBe(true);
  });

  it("remembers being closed, which is the whole point of storing a boolean", () => {
    // `false` has to survive the round trip. Any implementation that reaches for `||` loses exactly
    // this case and nothing else, so it is the one worth stating.
    expect(openOf(withOpen(emptyUiState(), FOLD.filesEditor, false), FOLD.filesEditor)).toBe(false);
  });
});

describe("collapsed branches", () => {
  it("lists what is SHUT, so a branch nobody has folded is open", () => {
    const ui = toggleShut(emptyUiState(), SHUT.folders, "project:workflows/review");
    expect(shutOf(ui, SHUT.folders).has("project:workflows/review")).toBe(true);
    // The branch created after the file was written — it must not arrive collapsed.
    expect(shutOf(ui, SHUT.folders).has("project:workflows/new")).toBe(false);
  });

  it("folds and unfolds the same row", () => {
    const shut = toggleShut(emptyUiState(), SHUT.folders, "base:prompts");
    const open = toggleShut(shut, SHUT.folders, "base:prompts");
    expect(shutOf(open, SHUT.folders).size).toBe(0);
  });

  it("keeps the trees apart", () => {
    // Two ids, one of which nothing renders — the store is keyed by id, and a second tree must not
    // read the first one's rows however it is spelled.
    const ui = toggleShut(emptyUiState(), "some.other.tree", "/repo");
    expect(shutOf(ui, "some.other.tree").has("/repo")).toBe(true);
    expect(shutOf(ui, SHUT.folders).size).toBe(0);
  });

  it("stores a row once however many times it is toggled", () => {
    let ui = emptyUiState();
    for (let i = 0; i < 5; i += 1) ui = toggleShut(ui, SHUT.folders, "project:workflows");
    // Odd number of clicks ⇒ folded, and stored once. A list that grew a duplicate would make the
    // next click appear to do nothing.
    expect(ui.shut[SHUT.folders]).toEqual(["project:workflows"]);
  });
});

describe("what survives a trip through the settings file", () => {
  it("round-trips a layout the app actually produced", () => {
    const ui = toggleShut(
      withOpen(withPane(emptyUiState(), PANE.filesViewer, 260), FOLD.filesEditor, false),
      SHUT.folders,
      "project:workflows",
    );
    const back = parseSettings(JSON.parse(JSON.stringify({ theme: "dark", ui })) as unknown).ui;

    expect(paneOf(back, PANE.filesViewer)).toBe(260);
    expect(openOf(back, FOLD.filesEditor)).toBe(false);
    expect(shutOf(back, SHUT.folders).has("project:workflows")).toBe(true);
  });

  it("opens at the defaults when the file has never heard of a layout", () => {
    const back = parseSettings({ theme: "light" }).ui;
    expect(paneOf(back, PANE.shellSidebar)).toBe(PANE_DEFAULTS[PANE.shellSidebar]);
    expect(openOf(back, FOLD.filesEditor)).toBe(true);
    expect(shutOf(back, SHUT.folders).size).toBe(0);
  });
});
