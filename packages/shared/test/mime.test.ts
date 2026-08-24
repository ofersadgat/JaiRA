/**
 * The one axis the Files view resolves surfaces on.
 *
 * The interesting cases are all about POSITION rather than extension: `workflows/plan.json` and
 * `notes.json` are the same bytes and emphatically not the same document, and a classifier that only
 * looked at the suffix would hand a stray JSON file the workflow authoring form. The other half is
 * the fallback chain, which is what guarantees no file in the tree is dead — every text type has to
 * reach `text/plain`, or clicking it shows nothing.
 */
import { describe, expect, it } from "vitest";
import {
  CONFIG_JSON,
  descriptionRootOf,
  DIRECTORY,
  extensionForMime,
  isTextMime,
  isWorkflowDescription,
  mimeFallbacks,
  mimeOfPath,
  WORKFLOW_DESCRIPTION,
  WORKFLOW_JSON,
  WORKFLOW_YAML,
} from "@jaira/shared";

describe("mimeOfPath", () => {
  it("distinguishes a state file from a JSON file that merely looks like one", () => {
    expect(mimeOfPath("workflows/plan.json")).toBe(WORKFLOW_JSON);
    expect(mimeOfPath("workflows/feature/plan.json")).toBe(WORKFLOW_JSON);
    expect(mimeOfPath("notes.json")).toBe("application/json");
    expect(mimeOfPath("prompts/schema.json")).toBe("application/json");
  });

  it("gives a YAML state its own type, because the JSON form cannot save it", () => {
    expect(mimeOfPath("workflows/plan.yaml")).toBe(WORKFLOW_YAML);
    expect(mimeOfPath("workflows/plan.yml")).toBe(WORKFLOW_YAML);
    expect(mimeOfPath("workflows/plan.yaml")).not.toBe(mimeOfPath("workflows/plan.json"));
  });

  it("names the workflow description, whatever case it was typed in", () => {
    // The sync controls hang off this type, so the answer decides whether a file that IS the
    // description gets them. `WORKFLOW.md` is what most people type.
    expect(mimeOfPath("workflows/workflow.md")).toBe(WORKFLOW_DESCRIPTION);
    expect(mimeOfPath("workflows/WORKFLOW.md")).toBe(WORKFLOW_DESCRIPTION);
    expect(isWorkflowDescription("workflows/Workflow.MD")).toBe(true);
  });

  it("names every markdown file under workflows/, because each describes one", () => {
    // A description per subdirectory used to raise "which of these am I being checked against?"
    // with no answer. Naming the file after the state beside it IS the answer.
    expect(mimeOfPath("workflows/feature.md")).toBe(WORKFLOW_DESCRIPTION);
    expect(mimeOfPath("workflows/feature/plan.md")).toBe(WORKFLOW_DESCRIPTION);
  });

  it("leaves markdown outside workflows/ alone", () => {
    expect(mimeOfPath("workflow.md")).toBe("text/markdown");
    expect(mimeOfPath("prompts/goals.md")).toBe("text/markdown");
  });

  it("reads the root a description is about out of its path", () => {
    expect(descriptionRootOf("workflows/feature.md")).toBe("feature");
    expect(descriptionRootOf("workflows/feature/plan.md")).toBe("feature/plan");
    // The layer-wide description is about every root, so it names none.
    expect(descriptionRootOf("workflows/workflow.md")).toBeNull();
    expect(descriptionRootOf("workflows/WORKFLOW.MD")).toBeNull();
    // Not a description at all.
    expect(descriptionRootOf("prompts/goals.md")).toBeNull();
  });

  it("sends the description back to markdown for anything it does not register itself", () => {
    // It registers a viewer (the sync panel) and no editor, so the chain is what gives it one — and
    // `application/markdown`, which the generic suffix rule would have produced, is a type nothing
    // has ever registered.
    expect(isTextMime(WORKFLOW_DESCRIPTION)).toBe(true);
    expect(mimeFallbacks(WORKFLOW_DESCRIPTION)).toEqual([WORKFLOW_DESCRIPTION, "text/markdown", "text/plain"]);
  });

  it("only calls the root settings.json config — a nested one is just JSON", () => {
    expect(mimeOfPath("settings.json")).toBe(CONFIG_JSON);
    expect(mimeOfPath("skills/review/settings.json")).toBe("application/json");
  });

  it("classifies the file types the tree actually holds", () => {
    expect(mimeOfPath("prompts/review.md")).toBe("text/markdown");
    expect(mimeOfPath("skills/review/SKILL.md")).toBe("text/markdown");
    expect(mimeOfPath("notes.yaml")).toBe("application/yaml");
    expect(mimeOfPath("run.log")).toBe("text/plain");
    expect(mimeOfPath("workflows", true)).toBe(DIRECTORY);
  });

  it("falls back to plain text for anything unrecognised, rather than to nothing", () => {
    expect(mimeOfPath("prompts/README")).toBe("text/plain");
    expect(mimeOfPath("weird.qqq")).toBe("text/plain");
    // A leading dot is a whole name, not an extension — `.gitignore` is text, not a `gitignore` type.
    expect(mimeOfPath(".gitignore")).toBe("text/plain");
  });

  it("names binary types instead of pretending they are text", () => {
    expect(mimeOfPath("artifacts/shot.png")).toBe("image/png");
    expect(isTextMime(mimeOfPath("artifacts/shot.png"))).toBe(false);
    expect(isTextMime(mimeOfPath("jaira.db"))).toBe(false);
    expect(isTextMime(DIRECTORY)).toBe(false);
  });

  it("treats the structured-syntax suffixes as text", () => {
    expect(isTextMime(WORKFLOW_JSON)).toBe(true);
    expect(isTextMime(WORKFLOW_YAML)).toBe(true);
    expect(isTextMime("image/svg+xml")).toBe(true);
    expect(isTextMime("text/x-typescript")).toBe(true);
  });
});

describe("mimeFallbacks", () => {
  it("sends a vendor type to the syntax it is written in, then to plain text", () => {
    expect(mimeFallbacks(WORKFLOW_JSON)).toEqual([WORKFLOW_JSON, "application/json", "text/plain"]);
    expect(mimeFallbacks(WORKFLOW_YAML)).toEqual([WORKFLOW_YAML, "application/yaml", "text/plain"]);
  });

  it("ends every text type at text/plain, and lists it only once", () => {
    expect(mimeFallbacks("text/markdown")).toEqual(["text/markdown", "text/plain"]);
    expect(mimeFallbacks("text/plain")).toEqual(["text/plain"]);
  });

  it("does not offer a text editor for something that is not text", () => {
    expect(mimeFallbacks("image/png")).toEqual(["image/png"]);
  });
});

/**
 * The inverse, which exists for exactly one reason: naming a file somebody is about to download.
 *
 * The value of an answer here is entirely in the extension being the CANONICAL one — `image.md`
 * rather than `image.markdown` — because the person is going to look at the name in a save dialog and
 * decide whether it is the file they meant.
 */
describe("extensionForMime", () => {
  it("answers with the spelling a person would have typed", () => {
    expect(extensionForMime("text/markdown")).toBe("md");
    expect(extensionForMime("application/json")).toBe("json");
    expect(extensionForMime("application/yaml")).toBe("yaml");
    expect(extensionForMime("text/plain")).toBe("txt");
  });

  it("answers for the types that are not text", () => {
    expect(extensionForMime("image/png")).toBe("png");
    expect(extensionForMime("image/svg+xml")).toBe("svg");
  });

  it("sees through a charset, which is how a type arrives off a header", () => {
    expect(extensionForMime("text/html; charset=utf-8")).toBe("html");
  });

  it("answers for the vendor types, which no extension table could find", () => {
    expect(extensionForMime(WORKFLOW_JSON)).toBe("json");
    expect(extensionForMime(CONFIG_JSON)).toBe("json");
    expect(extensionForMime(WORKFLOW_DESCRIPTION)).toBe("md");
  });

  it("answers nothing rather than guessing for a type it does not name", () => {
    expect(extensionForMime("application/x-nonsense")).toBeUndefined();
  });

  it("round-trips every extension the path classifier recognises", () => {
    for (const name of ["a.md", "a.json", "a.yaml", "a.png", "a.svg", "a.html", "a.ts", "a.py"]) {
      expect(`a.${extensionForMime(mimeOfPath(name))}`).toBe(name);
    }
  });
});
