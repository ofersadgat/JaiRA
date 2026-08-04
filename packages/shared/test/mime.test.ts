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
  DIRECTORY,
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

  it("leaves every other markdown file alone", () => {
    // One description per project, directly under `workflows/`. A per-directory one would raise
    // "which of these am I being checked against?" with no answer.
    expect(mimeOfPath("workflows/feature/workflow.md")).toBe("text/markdown");
    expect(mimeOfPath("workflow.md")).toBe("text/markdown");
    expect(mimeOfPath("workflows/notes.md")).toBe("text/markdown");
  });

  it("sends the description back to markdown for anything it does not register itself", () => {
    // It registers a viewer (the sync panel) and no editor, so the chain is what gives it one — and
    // `application/markdown`, which the generic suffix rule would have produced, is a type nothing
    // has ever registered.
    expect(isTextMime(WORKFLOW_DESCRIPTION)).toBe(true);
    expect(mimeFallbacks(WORKFLOW_DESCRIPTION)).toEqual([WORKFLOW_DESCRIPTION, "text/markdown", "text/plain"]);
  });

  it("only calls the root config.json config — a nested one is just JSON", () => {
    expect(mimeOfPath("config.json")).toBe(CONFIG_JSON);
    expect(mimeOfPath("skills/review/config.json")).toBe("application/json");
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
