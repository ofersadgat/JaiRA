/**
 * The File types screen's arithmetic — the part of it that is not layout.
 *
 * Four properties carry this feature, and none of them is visible from reading the types:
 *
 *  - **An All row must never state something untrue about a family.** It shows a value only where
 *    every type already agrees, or where every type that CAN take the set renderer has it — and
 *    nothing at all otherwise. A row that picked a winner would be a screen quietly reporting one
 *    type's setting as seven types' setting.
 *  - **Setting a family has to make it agree.** That means writing the family's line AND deleting
 *    the per-type lines that disagreed with it. A version that only wrote the family line looked
 *    right and did nothing, because a per-type line is read first.
 *  - **A control that cannot reach everybody must still be reachable.** The menu is the union, not
 *    the intersection: hiding `Live preview` because only Markdown has it made that setting
 *    unreachable from the one screen that exists to reach it.
 *  - **The two views are two answers.** Choosing the editor must not change the reading, and only a
 *    renderer that writes may answer the editor at all.
 *
 * The registry itself is the real one — `fileSurfaces` is imported for its registrations — because a
 * stub table would let every one of these pass while the screen showed something else.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_EDITOR_THEME,
  WORKFLOW_JSON,
  defaultRendererChoice,
  type RendererChoices,
  type RendererEdit,
} from "@jaira/shared/browser";
import "../src/renderer/fileSurfaces";
import { familyKey, rendererKey, viewRenderer } from "../src/renderer/fileTypes";
import {
  capableOf,
  contributors,
  editsForOff,
  editsForPick,
  membersOf,
  offStateAll,
  editsForTheme,
  reachOf,
  resolveAll,
  resolveTheme,
  unionOffered,
} from "../src/renderer/fileTypesPane";

/** The choices map a settings file would hold, written the short way. */
const lines = (entries: Record<string, Partial<ReturnType<typeof defaultRendererChoice>>>): RendererChoices =>
  Object.fromEntries(Object.entries(entries).map(([key, line]) => [key, { ...defaultRendererChoice(), ...line }]));

/**
 * Apply what a gesture would write, the way the store does — so a test exercises the real edits.
 *
 * Including the rule that makes "unset stays unwritten" true: a line that ends up saying nothing is
 * DELETED rather than left behind as an object of nulls. A helper that skipped that would let a test
 * pass while the settings file filled up with keys nobody meant to write.
 */
const apply = (was: RendererChoices, edits: readonly RendererEdit[]): RendererChoices => {
  const out: RendererChoices = { ...was };
  for (const { key, edit } of edits) {
    if (edit === null) {
      delete out[key];
      continue;
    }
    const before = out[key] ?? defaultRendererChoice();
    const next = {
      read: edit.read === undefined ? before.read : edit.read,
      write: edit.write === undefined ? before.write : edit.write,
      off: edit.off === undefined ? before.off : [...edit.off],
      theme: {
        read: edit.theme?.read === undefined ? before.theme.read : edit.theme.read,
        write: edit.theme?.write === undefined ? before.theme.write : edit.theme.write,
      },
    };
    const says =
      next.read !== null || next.write !== null || next.off.length > 0 || next.theme.read !== null || next.theme.write !== null;
    if (says) out[key] = next;
    else delete out[key];
  }
  return out;
};

describe("the families a person sets together", () => {
  it("folds the icon families that are too fine to set together", () => {
    // `plain` and `table` are useful marks in a tree and useless groups here: text with nothing
    // claimed about it is prose, and a CSV denotes a value like any other data file.
    expect(membersOf("prose")).toContain("text/plain");
    expect(membersOf("data")).toContain("text/csv");
    expect(membersOf("code")).toContain("text/x-typescript");
  });

  it("asks only the types that have a rendering of the kind", () => {
    // A TypeScript file denotes no value and is not DISAGREEING about how one should be drawn.
    // Counting it would make Code look permanently unsettled about a question it never had.
    expect(contributors("code", "data")).toEqual([]);
    // …and every code type DOES have a text rendering, because each of them is text and the chain
    // ends at `text/plain`. That is the property the pane leans on to keep the Code family settable
    // in one gesture, and it breaks the moment a type is listed under a MIME the app never produces.
    expect(contributors("code", "text").length).toBe(membersOf("code").length);
  });
});

describe("what an All row offers", () => {
  it("is the union, so a renderer only some types have is still reachable", () => {
    // The intersection was tried first and it hid exactly the settings this screen exists to reach.
    const ids = unionOffered("prose", "text").map((r) => r.id);
    expect(ids).toContain("live");
    expect(ids).toContain("monaco");
    expect(capableOf("prose", "text", "live")).toEqual(["text/markdown"]);
  });

  it("says how far a control that cannot reach everybody reaches", () => {
    expect(reachOf("prose", "text", "live")).toBe("only Markdown");
    // …and says nothing at all about one that reaches the whole family, which is most of them.
    expect(reachOf("prose", "text", "monaco")).toBeNull();
    expect(reachOf("data", "text", "schema")).toBe("only JSON and Workflow (JSON)");
  });
});

describe("what an All row says", () => {
  it("states the answer where every type already agrees", () => {
    const got = resolveAll("code", "text", "read", {});
    expect(got?.renderer?.id).toBe("monaco");
    expect(got?.partial).toBe(false);
  });

  it("says NOTHING where they disagree, rather than picking a winner", () => {
    // Prose out of the box: markdown reads in the live preview, plain text in Monaco. Two answers,
    // so the control is empty — and this is the state the screen opens Prose in.
    expect(resolveAll("prose", "text", "read", {})).toBeNull();
  });

  it("states a PARTIAL answer where every type that can take the set renderer has it", () => {
    // What the union buys. Markdown takes the live preview and plain text cannot, so the family does
    // not agree — but nothing else was possible, and reporting "they disagree" would be reporting a
    // failure of a gesture that did everything it could.
    const after = apply({}, editsForPick({ family: "prose", mime: null }, "text", "read", "live"));
    const got = resolveAll("prose", "text", "read", after);
    expect(got?.renderer?.id).toBe("live");
    expect(got?.partial).toBe(true);
    expect(got?.reaches).toBe(1);
    expect(got?.of).toBe(2);
    // The type it could not reach keeps what it had rather than being dragged somewhere arbitrary.
    expect(viewRenderer("text/plain", "text", "read", after)?.id).toBe("monaco");
  });
});

describe("setting a whole family", () => {
  it("writes one line and deletes the per-type lines that disagreed with it", () => {
    const was = lines({ [rendererKey("text/css", "text")]: { read: "monaco" } });
    const after = apply(was, editsForPick({ family: "code", mime: null }, "text", "read", "codeview"));
    expect(after[familyKey("code", "text")]?.read).toBe("codeview");
    // Deleted OUTRIGHT rather than overwritten with the same value: seven copies of one answer is
    // not what "they agree" should cost, and a line left behind saying nothing is a line that has to
    // be read and skipped forever after.
    expect(after[rendererKey("text/css", "text")]).toBeUndefined();
    expect(resolveAll("code", "text", "read", after)?.renderer?.id).toBe("codeview");
  });

  it("leaves a type the renderer cannot reach exactly as it was", () => {
    const was = lines({ [rendererKey("text/plain", "text")]: { read: "codeview" } });
    const after = apply(was, editsForPick({ family: "prose", mime: null }, "text", "read", "live"));
    expect(after[rendererKey("text/plain", "text")]?.read).toBe("codeview");
  });

  it("reads a type's own line before its family's", () => {
    const both = {
      ...lines({ [familyKey("code", "text")]: { read: "codeview" } }),
      ...lines({ [rendererKey("text/css", "text")]: { read: "monaco" } }),
    };
    expect(viewRenderer("text/css", "text", "read", both)?.id).toBe("monaco");
    expect(viewRenderer("text/x-python", "text", "read", both)?.id).toBe("codeview");
  });
});

describe("the two views", () => {
  it("are two answers: setting one leaves the other alone", () => {
    const after = apply({}, editsForPick({ family: "prose", mime: "text/markdown" }, "text", "write", "monaco"));
    expect(viewRenderer("text/markdown", "text", "write", after)?.id).toBe("monaco");
    expect(viewRenderer("text/markdown", "text", "read", after)?.id).toBe("live");
  });

  it("let only a renderer that writes answer the editor", () => {
    // The code view is a reading and can never be an editor, which is the registry's own `writes`
    // flag rather than a second thing anybody configures.
    const after = apply({}, editsForPick({ family: "code", mime: "text/x-typescript" }, "text", "write", "codeview"));
    expect(viewRenderer("text/x-typescript", "text", "write", after)?.id).toBe("monaco");
  });

  it("offer NOTHING to both, because refusing a rendering is a thing a person may say", () => {
    const after = apply({}, editsForPick({ family: "data", mime: WORKFLOW_JSON }, "data", "write", "none"));
    expect(viewRenderer(WORKFLOW_JSON, "data", "write", after)?.id).toBe("none");
  });
});

describe("taking a renderer off a menu", () => {
  it("removes it from what resolves, for one type", () => {
    const after = apply({}, editsForOff({ family: "prose", mime: "text/markdown" }, "text", "live", {}));
    expect(viewRenderer("text/markdown", "text", "read", after)?.id).toBe("monaco");
  });

  it("turns the kind OFF when nothing is left, rather than falling back to what was refused", () => {
    let choices: RendererChoices = {};
    for (const id of ["rendered", "none"]) {
      choices = apply(choices, editsForOff({ family: "prose", mime: "text/markdown" }, "preview", id, choices));
    }
    expect(viewRenderer("text/markdown", "preview", "read", choices)).toBeNull();
  });

  it("reports a family where only some types offer it as MIXED", () => {
    const after = apply({}, editsForOff({ family: "prose", mime: "text/markdown" }, "text", "codeview", {}));
    expect(offStateAll("prose", "text", "codeview", after)).toBe("mixed");
    // …and setting it on the family resolves the disagreement in one gesture.
    const family = apply(after, editsForOff({ family: "prose", mime: null }, "text", "codeview", after));
    expect(offStateAll("prose", "text", "codeview", family)).toBe("on");
  });
});

describe("the palette a view is drawn in", () => {
  it("is absent where the renderer has none, so no control appears over one that would ignore it", () => {
    // The data tree, a form, a table and a board are drawn in the app's own tokens. A colour-scheme
    // menu over them would be the one failure a settings screen cannot recover from: invisible.
    expect(resolveTheme({ family: "data", mime: "application/json" }, "data", "read", {}, DEFAULT_EDITOR_THEME)).toBeNull();
    expect(resolveTheme({ family: "data", mime: "application/json" }, "text", "read", {}, DEFAULT_EDITOR_THEME)).not.toBeNull();
  });

  it("is per type AND per view, because the renderer was chosen per type and per view", () => {
    const after = apply({}, editsForTheme({ family: "code", mime: "text/x-typescript" }, "text", "read", "one-dark"));
    expect(resolveTheme({ family: "code", mime: "text/x-typescript" }, "text", "read", after, DEFAULT_EDITOR_THEME)).toEqual({
      theme: "one-dark",
    });
    // The editor of the same file is a separate pick and keeps its own answer — which, with nothing
    // said, is the Editors section's one value rather than the word "app". Answering `app` there was
    // a screen stating a palette the app is not using: the section below reads Monokai Light and the
    // editors are painted in it.
    expect(resolveTheme({ family: "code", mime: "text/x-typescript" }, "text", "write", after, DEFAULT_EDITOR_THEME)).toEqual({
      theme: DEFAULT_EDITOR_THEME,
    });
    // …and so does every other type.
    expect(resolveTheme({ family: "code", mime: "text/css" }, "text", "read", after, DEFAULT_EDITOR_THEME)).toEqual({
      theme: DEFAULT_EDITOR_THEME,
    });
  });

  it("writes NOTHING for “follows the app”, so that preference keeps following it", () => {
    const after = apply({}, editsForTheme({ family: "code", mime: "text/css" }, "text", "read", "app"));
    expect(after[rendererKey("text/css", "text")]).toBeUndefined();
  });

  it("agrees across a family, and says so when it does not", () => {
    const one = apply({}, editsForTheme({ family: "code", mime: "text/css" }, "text", "read", "monokai"));
    expect(resolveTheme({ family: "code", mime: null }, "text", "read", one, DEFAULT_EDITOR_THEME)).toBe("mixed");
    const all = apply(one, editsForTheme({ family: "code", mime: null }, "text", "read", "monokai"));
    expect(resolveTheme({ family: "code", mime: null }, "text", "read", all, DEFAULT_EDITOR_THEME)).toEqual({ theme: "monokai" });
  });
});
