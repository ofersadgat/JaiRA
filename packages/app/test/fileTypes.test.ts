/**
 * The surface registry: what renders a file, and what happens when nothing does.
 *
 * The mechanism is small enough that the risky part is the fallback chain rather than the table.
 * Two properties matter and both are load-bearing for the UI: a text type that nobody registered
 * still resolves to an editor (otherwise clicking a `.ts` file in the tree shows a dead panel), and
 * the viewer is allowed to resolve to nothing (that null is what makes the editor fill the column,
 * so a bug here silently halves the space every plain file gets).
 *
 * ## The axis this file is really about
 *
 * A renderer declares what KIND of rendering it is — text, data or preview — and whether it writes.
 * Which half of the panel it lands in follows from those two facts (`viewerFor`, `editorFor`) rather
 * than from a registration. The registry used to be keyed by the halves themselves, and that made it
 * impossible to say the true thing about a `.json` file: it has a text rendering AND a data
 * rendering, at the same time, and neither is an alternative to the other.
 *
 * Stub surfaces rather than the real components: this is a test about lookup, and importing the
 * built-in table would drag React, a markdown parser and a DOM sanitizer into a node test to prove
 * something none of them are involved in.
 */
import { describe, expect, it } from "vitest";
import { CONFIG_JSON, WORKFLOW_JSON, WORKFLOW_YAML, defaultRendererChoice, parseSettings } from "@jaira/shared/browser";
import type { RendererChoices } from "@jaira/shared/browser";
import {
  chosenRenderer,
  editorFor,
  editorPick,
  isReading,
  pickPalette,
  fileRenderers,
  registerFileSurface,
  registeredMimes,
  rendererChoices,
  rendererKey,
  viewerFor,
  viewerPick,
  type FileSurface,
  type RenderKind,
} from "../src/renderer/fileTypes";
import { editorPaint } from "../src/renderer/editorThemes";
import { textRendererFor } from "../src/renderer/renderChoice";

/** A surface identified by name — enough to assert WHICH one resolution picked. */
const stub = (name: string): FileSurface => Object.assign(() => null as never, { surfaceName: name });
const nameOf = (surface: FileSurface | null): string | null =>
  surface === null ? null : ((surface as unknown as { surfaceName: string }).surfaceName ?? "?");

const TEXT_EDIT = stub("TextEdit");
const CODE_VIEW = stub("CodeSourceView");
const MARKDOWN_VIEW = stub("MarkdownView");
const JSON_VIEW = stub("JsonView");
const JSON_EDIT = stub("JsonEdit");
const WORKFLOW_VIEW = stub("WorkflowRunView");
const WORKFLOW_EDIT = stub("WorkflowEdit");
const CONFIG_EDIT = stub("ConfigEdit");

/** A registration, with the id, label and writing flag every one of them now carries. */
const at = (mime: string, kind: RenderKind, id: string, surface: FileSurface | null, writes?: boolean): void =>
  registerFileSurface(mime, kind, { id, label: id, surface, ...(writes === true ? { writes: true } : {}) });

// The floor of the chain: two ways of drawing text, one of which does not write.
at("text/plain", "text", "monaco", TEXT_EDIT, true);
at("text/plain", "text", "codeview", CODE_VIEW);

at("text/markdown", "text", "live", stub("MarkdownFileEdit"), true);
at("text/markdown", "text", "monaco", TEXT_EDIT, true);
at("text/markdown", "preview", "rendered", MARKDOWN_VIEW);
at("text/markdown", "preview", "none", null);

at("application/json", "text", "schema", JSON_EDIT, true);
at("application/json", "text", "monaco", TEXT_EDIT, true);
at("application/json", "data", "tree", JSON_VIEW);
at("application/json", "data", "none", null);

at("application/yaml", "text", "monaco", TEXT_EDIT, true);

// A state: a board to read, a form to write, and the JSON editor underneath both through the chain.
at(WORKFLOW_JSON, "preview", "board", WORKFLOW_VIEW);
at(WORKFLOW_JSON, "preview", "none", null);
at(WORKFLOW_JSON, "data", "form", WORKFLOW_EDIT, true);
at(WORKFLOW_JSON, "data", "none", null);
at(WORKFLOW_YAML, "preview", "board", WORKFLOW_VIEW);

at(CONFIG_JSON, "text", "validated", CONFIG_EDIT, true);

/**
 * One stored line: the renderer this person wants for the READING of a type.
 *
 * The reading rather than the editor, because that is what the old single-valued setting meant and
 * what these tests were written against — a file's editor is now a second, separate statement.
 */
const chose = (mime: string, kind: RenderKind, id: string): RendererChoices => ({
  [rendererKey(mime, kind)]: { ...defaultRendererChoice(), read: id },
});

/** The other half of the same statement: what this person wants to TYPE INTO. */
const choseEditor = (mime: string, kind: RenderKind, id: string): RendererChoices => ({
  [rendererKey(mime, kind)]: { ...defaultRendererChoice(), write: id },
});

describe("resolving the panel's two halves", () => {
  it("puts a rendering above and the thing that writes below", () => {
    // The whole model in one assertion: the upper half is what the document IS, the lower half is
    // where it is changed, and neither was declared — both follow from the renderers' own kinds.
    expect(nameOf(viewerFor("text/markdown"))).toBe("MarkdownView");
    expect(nameOf(editorFor("text/markdown")?.surface ?? null)).toBe("MarkdownFileEdit");
  });

  it("gives a JSON file a data rendering AND a text one, which are not alternatives", () => {
    // The case the old `view`/`edit` keying could not express. Both are true at once, and a person
    // choosing how their JSON is edited is not thereby choosing how its value is shown.
    expect(nameOf(viewerFor("application/json"))).toBe("JsonView");
    expect(nameOf(editorFor("application/json")?.surface ?? null)).toBe("JsonEdit");
  });

  it("lets a WRITING data renderer take the lower half, ahead of the text one", () => {
    // A state's authoring form. It is a data renderer — fields for the value the document denotes —
    // and it writes, which is what puts it below the divider rather than above it.
    expect(nameOf(viewerFor(WORKFLOW_JSON))).toBe("WorkflowRunView");
    expect(nameOf(editorFor(WORKFLOW_JSON)?.surface ?? null)).toBe("WorkflowEdit");
    // …and declining it falls through to the text renderer, which for a JSON state is the
    // schema-aware editor inherited from `application/json`. Declined as an EDITOR, which is the
    // statement being made: the form may well still be how this person reads the file.
    const source = choseEditor(WORKFLOW_JSON, "data", "none");
    expect(nameOf(editorFor(WORKFLOW_JSON, source)?.surface ?? null)).toBe("JsonEdit");
  });

  it("sends a vendor type with no renderers of its own to the syntax it is written in", () => {
    // The case that made the chain worth having: a YAML state keeps the board on top, and its text
    // renderer is YAML's — the authoring form serialises JSON and would rewrite the file.
    expect(nameOf(viewerFor(WORKFLOW_YAML))).toBe("WorkflowRunView");
    expect(nameOf(editorFor(WORKFLOW_YAML)?.surface ?? null)).toBe("TextEdit");
  });

  it("gives every unregistered text type the plain editor", () => {
    for (const mime of ["text/x-typescript", "text/plain", "application/toml"]) {
      expect(nameOf(editorFor(mime)?.surface ?? null), mime).toBe("TextEdit");
    }
  });

  it("resolves no viewer for a type that has nothing to show beyond its own text", () => {
    // Not a gap: this null is what tells the panel to give the editor the whole column.
    expect(viewerFor("text/plain")).toBeNull();
    expect(viewerFor("text/x-typescript")).toBeNull();
  });

  it("resolves nothing at all for a type that is not text", () => {
    expect(editorFor("image/png")).toBeNull();
    expect(viewerFor("image/png")).toBeNull();
  });

  it("lets a registration replace the one with its own id, and only that one", () => {
    // Replacement is by ID rather than by arrival — which is what makes a stored preference mean
    // anything, since "the last one loaded" is not something a settings file can name. The
    // alternative registered beside it must survive, or overriding a default would silently delete
    // every other rendering of the type.
    at("text/markdown", "preview", "rendered", stub("BetterMarkdown"));
    expect(nameOf(viewerFor("text/markdown"))).toBe("BetterMarkdown");
    expect(fileRenderers("text/markdown", "preview").map((r) => r.id)).toEqual(["rendered", "none"]);
    at("text/markdown", "preview", "rendered", MARKDOWN_VIEW);
  });

  it("keeps the kinds independent — registering one does not imply another", () => {
    expect(fileRenderers("application/yaml", "data")).toHaveLength(0);
    expect(nameOf(editorFor("application/yaml")?.surface ?? null)).toBe("TextEdit");
    // Config registers only a text renderer here, so it has no data rendering of its own and does
    // NOT inherit JSON's: a more specific list replaces rather than extends, which is what stops it
    // from inheriting the plain JSON editor that would write it unvalidated.
    expect(nameOf(editorFor(CONFIG_JSON)?.surface ?? null)).toBe("ConfigEdit");
    expect(fileRenderers(CONFIG_JSON, "text").map((r) => r.id)).toEqual(["validated"]);
  });

  it("lists what it holds", () => {
    expect(registeredMimes()).toContain(WORKFLOW_JSON);
    expect(registeredMimes()).toContain("text/plain");
  });
});

describe("a person's choice of renderer", () => {
  it("draws a type with the renderer that was chosen for it", () => {
    expect(nameOf(editorFor("text/markdown", choseEditor("text/markdown", "text", "monaco"))?.surface ?? null)).toBe("TextEdit");
    // The reading is a SEPARATE statement, and saying one leaves the other alone: the live-preview
    // editor is still what this person reads markdown in.
    expect(nameOf(chosenRenderer("text/markdown", "text", choseEditor("text/markdown", "text", "monaco"))?.surface ?? null)).toBe(
      "MarkdownFileEdit",
    );
    // …and with the table's own default when nothing was chosen, which is the case for everybody.
    expect(nameOf(editorFor("text/markdown")?.surface ?? null)).toBe("MarkdownFileEdit");
  });

  it("treats a chosen NOTHING as an answer rather than as a miss", () => {
    // The trap this stops: `null` is what "no viewer" already looks like, and a resolution that
    // simply skipped it would fall through to the data renderer — or to a vaguer type — and draw the
    // very rendering that was just declined.
    expect(viewerFor("text/markdown", chose("text/markdown", "preview", "none"))).toBeNull();
    expect(viewerFor("application/json", chose("application/json", "data", "none"))).toBeNull();
  });

  it("carries a choice about a text renderer that cannot write", () => {
    // Choosing the code view IS choosing not to type. The panel takes it rather than overruling it —
    // and it has to know, which is why `editorFor` answers with the renderer rather than a component.
    const plain = editorFor("text/x-typescript", chose("text/plain", "text", "codeview"));
    expect(nameOf(plain?.surface ?? null)).toBe("CodeSourceView");
    expect(plain?.writes).not.toBe(true);
  });

  it("reaches a vendor type through the chain, unless that type has a choice of its own", () => {
    // A workflow description IS markdown, so a preference about markdown applies to it — the same
    // property that lets it inherit the markdown editor without registering one.
    const monaco = choseEditor("text/markdown", "text", "monaco");
    expect(nameOf(editorFor("text/vnd.jaira.workflow-description+markdown", monaco)?.surface ?? null)).toBe("TextEdit");
  });

  it("ignores a choice that names a renderer this build does not have", () => {
    // A settings file outlives a release. The person is left looking at the default, which is a
    // state they can see and correct, rather than at an empty panel with nothing to explain it.
    expect(nameOf(viewerFor("text/markdown", chose("text/markdown", "preview", "gone")))).toBe("MarkdownView");
    expect(chosenRenderer("text/markdown", "preview", chose("text/markdown", "preview", "gone"))?.id).toBe("rendered");
  });

  it("offers only the type-and-kind pairs there is actually something to choose between", () => {
    const offered = rendererChoices();
    expect(offered.some((row) => row.mime === "text/markdown" && row.kind === "preview")).toBe(true);
    expect(offered.some((row) => row.mime === "text/markdown" && row.kind === "text")).toBe(true);
    // One renderer, so no row: a menu of one is a statement dressed as a question.
    expect(offered.some((row) => row.mime === CONFIG_JSON && row.kind === "text")).toBe(false);
    for (const row of offered) expect(row.renderers.length).toBeGreaterThan(1);
  });
});

/**
 * The same choice, asked by a surface that has fewer renderers to offer.
 *
 * A value view draws source two ways — an editor, or coloured text — so the several editors the
 * Files panel distinguishes between all mean "an editor" here. That collapse is why there is one
 * preference rather than two: "draw my source as coloured text" is one statement about a type.
 */
describe("the text renderer a value view can honour", () => {
  /** One line, saying only what a reading should be drawn by. */
  const reads = (entries: Record<string, string>): RendererChoices =>
    Object.fromEntries(Object.entries(entries).map(([key, id]) => [key, { ...defaultRendererChoice(), read: id }]));

  it("answers with the choice made for the type", () => {
    expect(textRendererFor("text/x-typescript", reads({ "text/plain:text": "codeview" }))).toBe("codeview");
    expect(textRendererFor("text/x-typescript", {})).toBeUndefined();
  });

  it("reads every editor as an editor", () => {
    // `live` and `schema` are editors this reader cannot mount inside a fenced block, so they mean
    // the one it can. Answering `undefined` would be worse: it would let a vaguer type's choice of
    // the code view overrule a specific choice of an editor.
    expect(textRendererFor("text/markdown", reads({ "text/markdown:text": "live" }))).toBe("monaco");
    expect(textRendererFor(WORKFLOW_JSON, reads({ "application/json:text": "schema" }))).toBe("monaco");
  });

  it("reaches a vendor type through the chain, and lets a specific one win", () => {
    const json = reads({ "application/json:text": "codeview" });
    expect(textRendererFor(WORKFLOW_JSON, json)).toBe("codeview");
    expect(textRendererFor(WORKFLOW_JSON, { ...json, ...reads({ [`${WORKFLOW_JSON}:text`]: "monaco" }) })).toBe("monaco");
  });

  it("is addressed with the same spelling the panel's choices are", () => {
    // One `rendererKey`, or the pane would write a preference the reader could not find.
    expect(rendererKey("text/x-typescript", "text")).toBe("text/x-typescript:text");
    expect(parseSettings({ renderers: { "text/x-typescript:text": { read: "codeview" } } }).renderers).toEqual({
      "text/x-typescript:text": { ...defaultRendererChoice(), read: "codeview" },
    });
  });
});

/**
 * The stored side of the same choice.
 *
 * Deliberately forgiving, and deliberately incurious: `shared` has no registry, so it cannot know
 * whether a key names a type this app opens or a value names a renderer that exists. Both questions
 * are answered harmlessly at the point of use — see the resolution tests above — and what is checked
 * here is only that a hand-edited file cannot put something through that is not a renderer id.
 */
describe("reading the renderer choices back", () => {
  it("keeps a choice, and drops what is not one", () => {
    const renderers = parseSettings({
      renderers: {
        "text/markdown:preview": { read: "none" },
        "text/markdown:text": { id: "monaco" },
        "not a key": { read: "monaco" },
      },
    }).renderers;
    expect(renderers).toEqual({ "text/markdown:preview": { ...defaultRendererChoice(), read: "none" } });
  });

  it("reads the single value the older file held as the READING", () => {
    // What that value always meant. It was resolved for the half of the panel that shows the
    // document, and the editor was picked by a rule nobody could see or change — so a person who
    // said "draw my markdown as source" keeps having said exactly that.
    expect(parseSettings({ renderers: { "text/markdown:text": "monaco" } }).renderers).toEqual({
      "text/markdown:text": { ...defaultRendererChoice(), read: "monaco" },
    });
  });

  it("keeps the four statements apart, including the palette each view is painted in", () => {
    expect(
      parseSettings({
        renderers: {
          "application/json:data": { read: "tree", write: "form", off: ["none", "none"], theme: { write: "one-dark" } },
        },
      }).renderers,
    ).toEqual({
      "application/json:data": { read: "tree", write: "form", off: ["none"], theme: { read: null, write: "one-dark" } },
    });
  });

  it("drops a line that says nothing at all", () => {
    // What keeps "unset stays unwritten" true across a round trip: an empty object and an absent key
    // mean the same thing, so only one of them may survive being read back.
    expect(parseSettings({ renderers: { "text/markdown:text": {}, "text/css:text": { off: [] } } }).renderers).toEqual({});
  });

  it("keeps a key for a renderer this build no longer has", () => {
    // Dropped at the point of USE rather than here — a settings file outlives a release, and a
    // renderer that comes back (a rename reverted, a plugin reinstalled) should find its preference
    // where it left it rather than having been quietly tidied away.
    expect(parseSettings({ renderers: { "text/markdown:preview": { read: "gone" } } }).renderers["text/markdown:preview"]?.read).toBe("gone");
  });

  it("reads a settings file written before any of this existed", () => {
    expect(parseSettings({ theme: "dark" }).renderers).toEqual({});
  });
});

/**
 * A choice made against a type that owns no renderers of its own.
 *
 * The case that broke the settings table before it was noticed: almost every type is in it. A `.ts`
 * file's text renderers are `text/plain`'s, so a preference stored against TypeScript is written at
 * one link of the chain and the list is found at another — and a resolution that read only the key
 * belonging to the link it found the list at would ignore every such choice silently.
 */
describe("a choice against a type that inherits its renderers", () => {
  it("is honoured, though the list came from further down the chain", () => {
    expect(fileRenderers("text/x-typescript", "text").map((r) => r.id)).toEqual(["monaco", "codeview"]);
    const chosen = chose("text/x-typescript", "text", "codeview");
    expect(nameOf(editorFor("text/x-typescript", chosen)?.surface ?? null)).toBe("CodeSourceView");
    // …and it is about THAT type. Another language inheriting the same list is untouched, which is
    // the whole point of storing the choice where the person made it.
    expect(nameOf(editorFor("text/x-python", chosen)?.surface ?? null)).toBe("TextEdit");
  });

  it("lets the more specific choice win, and steps over a stale one", () => {
    const both = { ...chose("text/plain", "text", "codeview"), ...chose("text/x-typescript", "text", "monaco") };
    expect(nameOf(editorFor("text/x-typescript", both)?.surface ?? null)).toBe("TextEdit");
    expect(nameOf(editorFor("text/x-python", both)?.surface ?? null)).toBe("CodeSourceView");
    // A specific choice naming a renderer that no longer exists does not swallow the vaguer one.
    const stale = { ...chose("text/plain", "text", "codeview"), ...chose("text/x-typescript", "text", "gone") };
    expect(nameOf(editorFor("text/x-typescript", stale)?.surface ?? null)).toBe("CodeSourceView");
  });
});

/**
 * The palette a half of the panel is painted in — the question a mounted surface cannot answer.
 *
 * A theme is stored per type, per kind and per view, and the panel resolves its two halves through
 * pairs it never states: the upper half is a `preview` for markdown and a `data` reading for JSON,
 * and the lower half is a `text` write for most types but a `data` write for a state file and a
 * `text` READ for anyone who chose the code view. A palette looked up against a guessed pair is a
 * preference read from the wrong key — which is a control that stores what you chose and changes
 * nothing you can see, and is exactly the bug this pair of functions exists to prevent.
 */
describe("the palette a half carries", () => {
  // Themed and unthemed, registered as such: the flag is what decides whether the control appears
  // beside a renderer at all, and painting a surface that ignores colours would be a preference
  // reaching something it was never about.
  registerFileSurface("text/x-paint", "text", { id: "cm", label: "cm", writes: true, themed: true, surface: TEXT_EDIT });
  registerFileSurface("text/x-paint", "preview", { id: "flat", label: "flat", surface: MARKDOWN_VIEW });

  const themed = (view: "read" | "write", id: string | null): RendererChoices => ({
    [rendererKey("text/x-paint", "text")]: { ...defaultRendererChoice(), theme: { read: null, write: null, [view]: id } },
  });

  it("asks against the pair the half actually resolved through", () => {
    const mime = "text/x-paint";
    // The editor is the `text` WRITE of this type, so that is the palette it takes…
    expect(pickPalette(editorPick(mime, themed("write", "one-dark")), mime, themed("write", "one-dark"))).toBe("one-dark");
    // …and the other view is a separate statement, which this half must not pick up.
    expect(pickPalette(editorPick(mime, themed("read", "one-dark")), mime, themed("read", "one-dark"))).toBeNull();
  });

  it("says nothing for a renderer with no palette of its own", () => {
    // The upper half here is a rendering drawn in the app's own tokens. Painting a container round
    // it would be the preference reaching a surface that cannot express it.
    const chosen = themed("read", "one-dark");
    expect(pickPalette(viewerPick("text/x-paint", chosen), "text/x-paint", chosen)).toBeNull();
  });

  it("says nothing where nothing was chosen, so the window's default stands", () => {
    expect(pickPalette(editorPick("text/x-paint"), "text/x-paint")).toBeNull();
    expect(editorPaint(null)).toBeNull();
  });

  it("paints a named theme, and REFUSES the window's for one that follows the app", () => {
    const painted = editorPaint("one-dark");
    expect(painted?.className).toBe("ed-themed");
    expect(painted?.style?.["--ed-bg"]).toBeTruthy();
    // "Follows the app" is an answer rather than an absence: the app's own default is a theme, so
    // the container has to be able to switch the root's mapping off. It carries no colours because
    // there are none to carry — the editor inherits the app's tokens like anything else.
    expect(editorPaint("app")).toEqual({ className: "ed-app" });
  });
});

/**
 * A reading stays a reading, whatever the renderer it landed on can do.
 *
 * The flag is one line, and what hangs off it is the whole rule: a renderer that writes is a
 * legitimate answer to a type's READ view — Monaco is a fine way to look at a `.ts` file — and a
 * mount that came in through that view must not accept a keystroke or offer a Save. The surfaces
 * ask this rather than being handed a missing `onSave`, because absence of somewhere-to-save is a
 * different statement and each of them answers it by drawing a different renderer entirely.
 */
describe("a mount that is a reading", () => {
  it("is the read view, and nothing else is", () => {
    expect(isReading({ view: "read" })).toBe(true);
    expect(isReading({ view: "write" })).toBe(false);
    // Absent is the editor, which is what almost every mount is and what everything was before a
    // surface could be asked which half it is.
    expect(isReading({})).toBe(false);
  });
});

/**
 * "Follows the app" is STORED, and that is what makes it choosable.
 *
 * `null` in this field means "nothing said", and what nothing falls back to is the default palette
 * rather than the window — so writing null for this choice made it a no-op that the control then
 * re-read as Monokai Light.
 */
describe("the palette that follows the window", () => {
  it("survives a settings file", () => {
    const back = parseSettings({ renderers: { "text/markdown:text": { theme: { write: "app" } } } });
    expect(back.renderers["text/markdown:text"]?.theme.write).toBe("app");
  });
});
