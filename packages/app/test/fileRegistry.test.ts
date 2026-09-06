/**
 * What this app can actually open — the REAL table, not a stub of one.
 *
 * `fileTypes.test.ts` tests the lookup mechanism with stub components, which is right for testing
 * resolution and wrong for testing the answer: it registers its own table, so it would pass with the
 * built-in one empty. Nothing checked the built-in one at all, which is how `text/markdown` came to
 * have an editor and no viewer for as long as it did.
 *
 * The two properties worth pinning are the ones a reader of the Files panel depends on: a type with
 * a rendering distinct from its text gets a viewer above the editor, and a type whose source IS its
 * presentation gets no viewer, because half a panel of nothing is worse than the space (see
 * `FilePanel`).
 */
import { describe, expect, it } from "vitest";
import {
  CONFIG_JSON,
  WORKFLOW_DESCRIPTION,
  WORKFLOW_JSON,
  WORKFLOW_YAML,
  defaultRendererChoice,
  hasGrammar,
  mimeOfPath,
} from "@jaira/shared/browser";
import "../src/renderer/fileSurfaces";
import { editorFor, fileRenderers, viewerFor } from "../src/renderer/fileTypes";

/** What actually draws each half of the panel for a type, with nothing chosen. */
const surface = (mime: string, action: "view" | "edit"): string =>
  (action === "view" ? viewerFor(mime) : (editorFor(mime)?.surface ?? null))?.name ?? "none";

describe("the built-in surfaces", () => {
  it("reads a markdown document above the editor that changes it", () => {
    // The registration this file was written for. A ```yaml block in the VIEWER is the value viewer,
    // with its Code / Data / Source toggle; the editor below cannot host one, because CodeMirror's
    // document is text with decorations rather than a place to mount a component.
    expect(surface("text/markdown", "view")).toBe("MarkdownView");
    expect(surface("text/markdown", "edit")).toBe("MarkdownFileEdit");
  });

  it("still gives a workflow description its sync panel, which is more specific", () => {
    // The whole point of resolving along the fallback chain: a more specific type keeps its own
    // viewer and inherits the editor it has no opinion about.
    expect(surface(WORKFLOW_DESCRIPTION, "view")).toBe("WorkflowSyncPanel");
    expect(surface(WORKFLOW_DESCRIPTION, "edit")).toBe("MarkdownFileEdit");
    expect(surface(mimeOfPath("workflows/feature.md"), "view")).toBe("WorkflowSyncPanel");
  });

  it("gives every type with a reading a viewer", () => {
    expect(surface("application/json", "view")).toBe("JsonView");
    expect(surface("application/yaml", "view")).toBe("YamlView");
    expect(surface("text/csv", "view")).toBe("DelimitedView");
    expect(surface("text/x-diff", "view")).toBe("PatchFileSurface");
    expect(surface("text/html", "view")).toBe("RenderedFileView");
    expect(surface(WORKFLOW_JSON, "view")).toBe("WorkflowRunView");
    expect(surface(WORKFLOW_YAML, "view")).toBe("WorkflowRunView");
    expect(surface(CONFIG_JSON, "view")).toBe("ConfigEffectiveView");
  });

  it("gives source code no viewer, so the editor takes the whole column", () => {
    // Not a gap — see `FilePanel`. A `.ts` file has no rendering distinct from its own text, and a
    // viewer above it would be a second copy of what is already on screen.
    for (const path of ["a.ts", "a.py", "a.rs", "a.txt", "a.toml"]) {
      expect(viewerFor(mimeOfPath(path)), path).toBeNull();
      expect(surface(mimeOfPath(path), "edit"), path).toBe("TextEdit");
    }
  });

  it("gives a file that is not text neither half", () => {
    expect(viewerFor(mimeOfPath("a.png"))).toBeNull();
    expect(editorFor(mimeOfPath("a.png"))).toBeNull();
  });

  it("offers every text type the two text renderers, and only one of them writes", () => {
    // The pair the value viewer has always had on its `▾` — an editor, and coloured source that
    // cannot be typed into — reaching the Files panel through the floor of the chain, so a `.ts`, a
    // `.py` and a `.toml` all have them with nothing registered per type.
    for (const path of ["a.ts", "a.py", "a.toml", "a.md"]) {
      const ids = fileRenderers(mimeOfPath(path), "text").map((renderer) => renderer.id);
      expect(ids, path).toContain("monaco");
      expect(ids, path).toContain("codeview");
    }
    const [monaco, codeview] = fileRenderers("text/plain", "text");
    expect(monaco?.writes).toBe(true);
    expect(codeview?.writes).not.toBe(true);
  });

  it("gives a JSON file all three kinds of rendering at once", () => {
    // The reason the registry is keyed by kind. Text and data are not alternatives: Monaco draws the
    // characters, the tree draws the value they denote, and a person wants both — which is exactly
    // what the panel shows them, one above the other.
    expect(fileRenderers("application/json", "text").map((r) => r.id)).toEqual(["schema", "monaco", "codeview"]);
    expect(fileRenderers("application/json", "data").map((r) => r.id)).toEqual(["tree", "form", "none"]);
    expect(fileRenderers("application/json", "preview")).toHaveLength(0);
  });
});

describe("editing a file", () => {
  it("colours source code, rather than handing it a bare box", () => {
    // The floor of the registry is `TextEdit`, and it was a `<textarea>` for every type that reached
    // it — so a `.ts` file was edited with no highlighting in an app that colours TypeScript in the
    // transcript, in a fenced block and in a diff. It asks `hasGrammar` now, so naming a grammar in
    // `shared/grammars.ts` is the whole of adding one.
    for (const path of ["a.ts", "a.py", "a.rs", "a.yaml", "a.sh"]) {
      expect(hasGrammar(mimeOfPath(path)), path).toBe(true);
      expect(surface(mimeOfPath(path), "edit"), path).toBe("TextEdit");
    }
  });

  it("keeps the plain box for text with no structure to show", () => {
    // Not a gap: `plaintext` is the correct answer for a type nothing can colour, and a Monaco
    // instance that highlights nothing is an editor instance spent on nothing.
    for (const path of ["a.txt", "a.log", "a.toml"]) {
      expect(hasGrammar(mimeOfPath(path)), path).toBe(false);
    }
  });
});

describe("reading a JSON document as its schema's fields", () => {
  it("offers the form beside the tree, and leaves the tree leading", () => {
    // Three readings of one file, and they are not ranked by how clever they are: the tree always
    // draws something, and the form draws nothing at all for a document answering to no schema this
    // app knows — which is most `.json` files on disk. So the tree leads and the form is a choice.
    expect(fileRenderers("application/json", "data").map((r) => r.id)).toEqual(["tree", "form", "none"]);
    expect(surface("application/json", "view")).toBe("JsonView");
  });

  it("puts the form ABOVE the editor rather than in place of it", () => {
    // The form reads and the editor writes, which is what keeps them in different halves. A form
    // that wrote would have to serialise the document back through `JSON.stringify` — reordering
    // keys and discarding every choice of formatting in the file — and the editor below it already
    // validates against the very same schema.
    const asForm = { "application/json:data": { ...defaultRendererChoice(), read: "form" } };
    expect(viewerFor("application/json", asForm)?.name).toBe("JsonFormView");
    expect(editorFor("application/json", asForm)?.surface?.name).toBe("JsonEdit");
    expect(fileRenderers("application/json", "data").find((r) => r.id === "form")?.writes).not.toBe(true);
  });

  it("reaches a workflow state's own form rather than this one", () => {
    // A state file registers a data renderer of its own and a more specific list REPLACES rather
    // than extends, so the authoring form is what it gets — and that one writes, which is why it is
    // the lower half. Two forms, two jobs, and the chain keeps them apart.
    expect(editorFor(WORKFLOW_JSON)?.surface?.name).toBe("WorkflowEdit");
    expect(fileRenderers(WORKFLOW_JSON, "data").map((r) => r.id)).toEqual(["form", "none"]);
  });
});
