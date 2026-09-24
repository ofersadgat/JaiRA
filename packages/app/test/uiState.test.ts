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
  HALVES,
  PANE,
  PANE_DEFAULTS,
  OPENED,
  SHUT,
  emptyUiState,
  forgetSeen,
  modeOf,
  openOf,
  paneOf,
  seenOf,
  shutOf,
  toggleUnfolded,
  unfoldedOf,
  toggleShut,
  withMode,
  withOpen,
  withPane,
  withSeen,
  withSeenAll,
} from "../src/renderer/uiState";

/**
 * The one control with more than two positions, and the rule that keeps it safe.
 *
 * A fold is a boolean and a mode is a word, so a word from a settings file written by another
 * version can name a position this one no longer has. The list of positions is passed in at the
 * point of reading for exactly that reason — the file cannot know them, and a control that trusted
 * it would open in a state it cannot draw.
 */
describe("remembered modes", () => {
  it("opens at the control's own default until something has been chosen", () => {
    expect(modeOf(emptyUiState(), FOLD.filesEditor, HALVES, "half")).toBe("half");
  });

  it("returns what was chosen", () => {
    const ui = withMode(emptyUiState(), FOLD.filesEditor, "full");
    expect(modeOf(ui, FOLD.filesEditor, HALVES, "half")).toBe("full");
  });

  it("falls back rather than taking a position the control does not offer", () => {
    const ui = withMode(emptyUiState(), FOLD.filesEditor, "sideways");
    expect(modeOf(ui, FOLD.filesEditor, HALVES, "half")).toBe("half");
  });

  /** A layout is a cache of gestures: a mode survives the round trip like a pane size does. */
  it("survives being written and read back", () => {
    const ui = withMode(emptyUiState(), FOLD.filesEditor, "shut");
    const written = JSON.parse(JSON.stringify({ ui })) as unknown;
    expect(parseSettings(written).ui.modes[FOLD.filesEditor]).toBe("shut");
  });
});

describe("remembered pane sizes", () => {
  it("falls back to the pane's own default until something has been dragged", () => {
    expect(paneOf(emptyUiState(), PANE.shellSidebar)).toBe(PANE_DEFAULTS[PANE.shellSidebar]);
  });

  it("returns what was stored, and leaves the other panes alone", () => {
    const ui = withPane(withPane(emptyUiState(), PANE.shellSidebar, 310), PANE.panelTask, 420);
    expect(paneOf(ui, PANE.shellSidebar)).toBe(310);
    expect(paneOf(ui, PANE.panelTask)).toBe(420);
    // Dragging the sidebar has nothing to say about the width of the inspector.
    expect(paneOf(ui, PANE.panelState)).toBe(PANE_DEFAULTS[PANE.panelState]);
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
    expect(openOf(emptyUiState(), FOLD.schemaReference)).toBe(false);
    expect(FOLD_DEFAULTS[FOLD.filesEditor]).toBe(true);
  });

  it("opens the sidebar for a settings file written before the sidebar existed", () => {
    // Stored POSITIVELY — open means showing — so the absent key reads as "showing". The negative
    // spelling would have collapsed the app's whole navigation on first launch after the upgrade,
    // leaving one button on screen that still did anything.
    expect(openOf(parseSettings({ theme: "light" }).ui, FOLD.shellSidebar)).toBe(true);
    // And an id nobody declares a default for reads as showing too — which is what the three
    // retired drawer folds (`shell.files` and friends) would do if anything still asked.
    expect(openOf(emptyUiState(), "shell.files")).toBe(true);
  });

  it("remembers being closed, which is the whole point of storing a boolean", () => {
    // `false` has to survive the round trip. Any implementation that reaches for `||` loses exactly
    // this case and nothing else, so it is the one worth stating.
    expect(openOf(withOpen(emptyUiState(), FOLD.filesEditor, false), FOLD.filesEditor)).toBe(false);
  });
});

describe("collapsed branches", () => {
  it("lists what is SHUT, so a branch nobody has folded is open", () => {
    const ui = toggleShut(emptyUiState(), SHUT.runStates, "r1:i1:0");
    expect(shutOf(ui, SHUT.runStates).has("r1:i1:0")).toBe(true);
    // The branch created after the file was written — it must not arrive collapsed.
    expect(shutOf(ui, SHUT.runStates).has("r1:i1:9")).toBe(false);
  });

  it("lists what is OPEN for the Files tree, so a folder nobody opened is shut", () => {
    // The opposite default, and the one tree that has it: rooted at a checkout, expanded-by-default
    // is a first paint of every file in the repository.
    const ui = toggleUnfolded(emptyUiState(), OPENED.folders, "project:packages");
    expect(unfoldedOf(ui, OPENED.folders).has("project:packages")).toBe(true);
    // Everything else, including a folder inside the one just opened.
    expect(unfoldedOf(ui, OPENED.folders).has("project:packages/app")).toBe(false);
    expect(unfoldedOf(emptyUiState(), OPENED.folders).has("project:packages")).toBe(false);
  });

  it("opens and closes the same row", () => {
    const open = toggleUnfolded(emptyUiState(), OPENED.folders, "base:prompts");
    expect(unfoldedOf(open, OPENED.folders).has("base:prompts")).toBe(true);
    expect(unfoldedOf(toggleUnfolded(open, OPENED.folders, "base:prompts"), OPENED.folders).has("base:prompts")).toBe(false);
  });

  it("folds and unfolds the same row", () => {
    const shut = toggleShut(emptyUiState(), SHUT.runStates, "base:prompts");
    const open = toggleShut(shut, SHUT.runStates, "base:prompts");
    expect(shutOf(open, SHUT.runStates).size).toBe(0);
  });

  it("keeps the trees apart", () => {
    // Two ids, one of which nothing renders — the store is keyed by id, and a second tree must not
    // read the first one's rows however it is spelled.
    const ui = toggleShut(emptyUiState(), "some.other.tree", "/repo");
    expect(shutOf(ui, "some.other.tree").has("/repo")).toBe(true);
    expect(shutOf(ui, SHUT.runStates).size).toBe(0);
  });

  it("stores a row once however many times it is toggled", () => {
    let ui = emptyUiState();
    for (let i = 0; i < 5; i += 1) ui = toggleUnfolded(ui, OPENED.folders, "project:packages");
    // Odd number of clicks ⇒ open, and stored once. A list that grew a duplicate would make the
    // next click appear to do nothing.
    expect(ui.unfolded[OPENED.folders]).toEqual(["project:packages"]);
  });
});

describe("what survives a trip through the settings file", () => {
  it("round-trips a layout the app actually produced", () => {
    // Both row maps, because they are opposite claims and a round trip that kept one would look
    // fine right up until the Files tree opened with every folder shut or every folder open.
    const ui = toggleUnfolded(
      toggleShut(
        withOpen(withPane(emptyUiState(), PANE.filesViewer, 260), FOLD.filesEditor, false),
        SHUT.runStates,
        "r1:i1:0",
      ),
      OPENED.folders,
      "project:.jaira/workflows",
    );
    const back = parseSettings(JSON.parse(JSON.stringify({ theme: "dark", ui })) as unknown).ui;

    expect(paneOf(back, PANE.filesViewer)).toBe(260);
    expect(openOf(back, FOLD.filesEditor)).toBe(false);
    expect(shutOf(back, SHUT.runStates).has("r1:i1:0")).toBe(true);
    expect(unfoldedOf(back, OPENED.folders).has("project:.jaira/workflows")).toBe(true);
  });

  it("opens at the defaults when the file has never heard of a layout", () => {
    const back = parseSettings({ theme: "light" }).ui;
    expect(paneOf(back, PANE.shellSidebar)).toBe(PANE_DEFAULTS[PANE.shellSidebar]);
    expect(openOf(back, FOLD.filesEditor)).toBe(true);
    expect(shutOf(back, SHUT.runStates).size).toBe(0);
    // And the Files tree opens with nothing unfolded, which is now what "every folder shut" means.
    expect(unfoldedOf(back, OPENED.folders).size).toBe(0);
  });
});

/**
 * How far a conversation has been read.
 *
 * The rules matter more here than for a pane size, because two of them are what keep this out of the
 * write path and off the screen incorrectly: the mark never moves backwards, and setting it to
 * something it already covers must return the SAME object — the marker is set from a render effect
 * several times a second while an answer streams, and a new object each time would be a settings
 * write forever and a re-render behind it.
 */
describe("which conversations have been read", () => {
  it("reads as unread until something has been seen", () => {
    expect(seenOf(emptyUiState(), "t-1")).toBe(0);
  });

  it("moves the mark forward as a conversation is read", () => {
    const ui = withSeen(emptyUiState(), "t-1", 500);
    expect(seenOf(ui, "t-1")).toBe(500);
    expect(seenOf(withSeen(ui, "t-1", 900), "t-1")).toBe(900);
  });

  it("never moves the mark backwards, and hands back the same object when it would not move", () => {
    const ui = withSeen(emptyUiState(), "t-1", 900);
    // The identity check is the assertion: `markSeen` writes only when this returns something new.
    expect(withSeen(ui, "t-1", 500)).toBe(ui);
    expect(withSeen(ui, "t-1", 900)).toBe(ui);
    expect(seenOf(withSeen(ui, "t-1", 500), "t-1")).toBe(900);
  });

  it("marks a whole row at once, each task at its own clock", () => {
    // What clicking a project's status pills does (SHELL.md §4.3). Per-task rather than one "now"
    // for the row: the marks are compared against each task's own `updatedAt`, and a single stamp
    // would swallow a turn that landed in the same millisecond as the click.
    const ui = withSeenAll(emptyUiState(), [
      { taskId: "t-1", at: 500 },
      { taskId: "t-2", at: 900 },
    ]);
    expect(seenOf(ui, "t-1")).toBe(500);
    expect(seenOf(ui, "t-2")).toBe(900);
  });

  it("is monotonic in bulk too, and hands back the same object when nothing would move", () => {
    const ui = withSeenAll(emptyUiState(), [{ taskId: "t-1", at: 900 }]);
    // The identity check again: a row already clear must not write settings or re-render the window.
    expect(withSeenAll(ui, [{ taskId: "t-1", at: 500 }])).toBe(ui);
    expect(withSeenAll(ui, [])).toBe(ui);
    // A row where SOME of it has moved still marks only what moved forwards.
    const next = withSeenAll(ui, [
      { taskId: "t-1", at: 500 },
      { taskId: "t-2", at: 100 },
    ]);
    expect(seenOf(next, "t-1")).toBe(900);
    expect(seenOf(next, "t-2")).toBe(100);
  });

  it("marks one conversation without touching another", () => {
    const ui = withSeen(withSeen(emptyUiState(), "t-1", 500), "t-2", 900);
    expect(seenOf(ui, "t-1")).toBe(500);
    expect(seenOf(ui, "t-2")).toBe(900);
  });

  it("forgets the marks of deleted conversations and leaves the rest alone", () => {
    const ui = withSeen(withSeen(emptyUiState(), "t-1", 500), "t-2", 900);
    const after = forgetSeen(ui, ["t-1"]);
    expect(seenOf(after, "t-1")).toBe(0);
    expect(seenOf(after, "t-2")).toBe(900);
    // Nothing to forget is not a change — same rule, same reason as `withSeen`.
    expect(forgetSeen(after, ["t-1", "t-nothing"])).toBe(after);
  });

  it("survives the settings file", () => {
    const ui = withSeen(emptyUiState(), "t-1", 1_700_000_000_000);
    const back = parseSettings(JSON.parse(JSON.stringify({ theme: "dark", ui })) as unknown).ui;
    expect(seenOf(back, "t-1")).toBe(1_700_000_000_000);
  });

  it("has an empty map when the file has never heard of one", () => {
    expect(seenOf(parseSettings({ theme: "light" }).ui, "t-1")).toBe(0);
  });
});
