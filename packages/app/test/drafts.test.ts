/**
 * What happens to unsaved typing.
 *
 * The rules are small and the consequence of getting one wrong is someone's work, so they are
 * pinned here rather than left to be discovered in the app. The component half needs a DOM and is
 * not tested; everything that DECIDES anything is pure and is.
 */
import { describe, expect, it } from "vitest";
import {
  docKey,
  draftBox,
  movedDraft,
  movedDraftsUnder,
  settled,
  withDraft,
  withoutDraftsUnder,
  type Drafts,
} from "../src/renderer/drafts";

/** A `set`/`revert` recorder standing in for the store. */
function box(drafts: Drafts, key: string, onDisk: string) {
  const writes: Array<string | null> = [];
  const view = draftBox(drafts, (_k, text) => writes.push(text), key, onDisk);
  return { view, writes };
}

describe("a draft is a difference from the file", () => {
  it("shows the file when there is no draft", () => {
    const { view } = box({}, "project:prompts/goal.md", "on disk");
    expect(view.text).toBe("on disk");
    expect(view.dirty).toBe(false);
  });

  it("shows the draft when there is one", () => {
    const { view } = box({ "project:prompts/goal.md": "typed" }, "project:prompts/goal.md", "on disk");
    expect(view.text).toBe("typed");
    expect(view.dirty).toBe(true);
  });

  it("keeps two files apart", () => {
    const drafts = { "project:a.md": "A", "base:a.md": "B" };
    expect(box(drafts, "project:a.md", "").view.text).toBe("A");
    // Same relative path, other root: a different file, and it must not borrow the first one's text.
    expect(box(drafts, "base:a.md", "").view.text).toBe("B");
    expect(box(drafts, "project:b.md", "on disk").view.text).toBe("on disk");
  });

  it("clears rather than storing a copy of the file", () => {
    const { view, writes } = box({ "project:a.md": "typed" }, "project:a.md", "on disk");
    view.set("on disk");
    expect(writes).toEqual([null]);
  });

  it("revert forgets the draft rather than undoing a save", () => {
    const { view, writes } = box({ "project:a.md": "typed" }, "project:a.md", "on disk");
    view.revert();
    expect(writes).toEqual([null]);
  });

  /**
   * The case the whole module is for: an edit outlives the editor. The map is the only thing that
   * persists across an unmount, so a box built again for the same key sees the same text.
   */
  it("survives being rebuilt for the same file", () => {
    let drafts: Drafts = {};
    const first = draftBox(drafts, (k, t) => (drafts = withDraft(drafts, k, t)), "project:a.md", "on disk");
    first.set("half a sentence");
    // …clicked another file, went to the board, came back.
    const again = draftBox(drafts, () => undefined, "project:a.md", "on disk");
    expect(again.text).toBe("half a sentence");
    expect(again.dirty).toBe(true);
  });
});

describe("withDraft", () => {
  it("records, replaces and deletes", () => {
    let drafts: Drafts = {};
    drafts = withDraft(drafts, "k", "one");
    expect(drafts).toEqual({ k: "one" });
    drafts = withDraft(drafts, "k", "two");
    expect(drafts).toEqual({ k: "two" });
    drafts = withDraft(drafts, "k", null);
    expect(drafts).toEqual({});
  });

  it("returns the same map when nothing changes, so React can bail out", () => {
    const drafts = { k: "one" };
    expect(withDraft(drafts, "k", "one")).toBe(drafts);
    expect(withDraft(drafts, "other", null)).toBe(drafts);
  });
});

describe("settled", () => {
  it("drops a draft the file has caught up with", () => {
    expect(settled({ k: "saved" }, "k", "saved")).toEqual({});
  });

  it("leaves a draft that still differs — a re-read must not land on unsaved typing", () => {
    const drafts = { k: "typed" };
    expect(settled(drafts, "k", "on disk")).toBe(drafts);
  });
});

describe("withoutDraftsUnder", () => {
  const drafts = {
    [docKey("project", "workflows/review.json")]: "a",
    [docKey("project", "workflows/review/critique.json")]: "b",
    [docKey("project", "workflows/reviewer.json")]: "c",
    [docKey("base", "workflows/review.json")]: "d",
  };

  it("drops the file itself", () => {
    expect(Object.keys(withoutDraftsUnder(drafts, "base", "workflows/review.json"))).toEqual([
      docKey("project", "workflows/review.json"),
      docKey("project", "workflows/review/critique.json"),
      docKey("project", "workflows/reviewer.json"),
    ]);
  });

  /**
   * A directory takes everything inside it — and nothing beside it. `workflows/reviewer.json` shares
   * a prefix with `workflows/review` as a STRING and is not under it, which is the bug a bare
   * `startsWith` would have.
   */
  it("drops a directory's contents and not its neighbours", () => {
    const left = withoutDraftsUnder(drafts, "project", "workflows/review");
    expect(Object.keys(left)).toEqual([
      docKey("project", "workflows/review.json"),
      docKey("project", "workflows/reviewer.json"),
      docKey("base", "workflows/review.json"),
    ]);
  });

  it("returns the same map when it covers nothing", () => {
    expect(withoutDraftsUnder(drafts, "project", "prompts")).toBe(drafts);
  });
});

describe("a rename carries the draft with it", () => {
  it("moves one file's draft to where the file went", () => {
    expect(movedDraft({ "project:a.json": "typed" }, "project:a.json", "project:b.json")).toEqual({
      "project:b.json": "typed",
    });
  });

  it("forgets it when the new path could not be resolved", () => {
    expect(movedDraft({ "project:a.json": "typed" }, "project:a.json", null)).toEqual({});
  });

  it("re-roots a whole directory, file by file", () => {
    const drafts = {
      [docKey("project", "workflows/review")]: "the directory itself, somehow",
      [docKey("project", "workflows/review/critique.json")]: "a",
      [docKey("project", "workflows/reviewer.json")]: "untouched",
    };
    expect(movedDraftsUnder(drafts, "project", "workflows/review", "workflows/audit")).toEqual({
      [docKey("project", "workflows/audit")]: "the directory itself, somehow",
      [docKey("project", "workflows/audit/critique.json")]: "a",
      [docKey("project", "workflows/reviewer.json")]: "untouched",
    });
  });

  it("returns the same map when nothing under it is being edited", () => {
    const drafts = { [docKey("project", "prompts/goal.md")]: "typed" };
    expect(movedDraftsUnder(drafts, "project", "workflows", "flows")).toBe(drafts);
  });
});
