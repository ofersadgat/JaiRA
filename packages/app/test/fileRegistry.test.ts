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
  hasGrammar,
  mimeOfPath,
} from "@jaira/shared/browser";
import "../src/renderer/fileSurfaces";
import { resolveFileSurface } from "../src/renderer/fileTypes";

const surface = (mime: string, action: "view" | "edit"): string =>
  resolveFileSurface(mime, action)?.name ?? "none";

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
      expect(resolveFileSurface(mimeOfPath(path), "view"), path).toBeNull();
      expect(surface(mimeOfPath(path), "edit"), path).toBe("TextEdit");
    }
  });

  it("gives a file that is not text neither half", () => {
    expect(resolveFileSurface(mimeOfPath("a.png"), "view")).toBeNull();
    expect(resolveFileSurface(mimeOfPath("a.png"), "edit")).toBeNull();
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
