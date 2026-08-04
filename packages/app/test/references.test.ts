/**
 * The two spellings of a document reference (WORKFLOWS.md §2.2).
 *
 * The asymmetry is the whole subject: a string position takes `{"$ref": …}`, an object position
 * takes the bare string, and getting it backwards produces a document that loads without complaint
 * and means something else. `"prompt": "$/prompts/x.md"` is a prompt whose TEXT is that path.
 */
import { describe, expect, it } from "vitest";
import { readRef, refForPath, writeRef } from "@jaira/shared/browser";
import { isKnownRef } from "../src/renderer/completions";

describe("reading a reference", () => {
  it("reads {$ref} in a string position", () => {
    expect(readRef({ $ref: "$/prompts/x.md" }, "string")).toBe("$/prompts/x.md");
  });

  it("does not read a bare string in a string position — that is a literal", () => {
    expect(readRef("$/prompts/x.md", "string")).toBeUndefined();
  });

  it("reads a bare string in an object position", () => {
    expect(readRef("$/lib/review.operation", "object")).toBe("$/lib/review.operation");
  });

  it("reads {$ref} in an object position too", () => {
    expect(readRef({ $ref: "$/types/markdown" }, "object")).toBe("$/types/markdown");
  });

  it("refuses a reference carrying sibling overrides", () => {
    // Legal, and a merge — but not something a one-box control can show without deleting the rest.
    expect(readRef({ $ref: "$/lib/review.operation", model: "opus" }, "object")).toBeUndefined();
  });

  it("reads a bare string inside a schema", () => {
    expect(readRef("$/types/markdown", "schema")).toBe("$/types/markdown");
  });

  it("never claims $ref inside a schema — that key is JSON Schema's", () => {
    // The two vocabularies cannot collide precisely because ours is the bare-string form and JSON
    // Schema has no use for one there. Reading this as a document link would rewrite a
    // `#/$defs/plan` pointer as a bare string and change what the slot is typed as.
    expect(readRef({ $ref: "#/$defs/plan" }, "schema")).toBeUndefined();
    expect(readRef({ $ref: "$/types/markdown" }, "schema")).toBeUndefined();
  });

  it("refuses anything that is not a reference", () => {
    expect(readRef({ kind: "prompt" }, "string")).toBeUndefined();
    expect(readRef(42, "object")).toBeUndefined();
    expect(readRef(null, "object")).toBeUndefined();
    expect(readRef(["$/a"], "object")).toBeUndefined();
    expect(readRef({ $ref: 7 }, "string")).toBeUndefined();
  });
});

describe("writing a reference", () => {
  it("wraps for a string position and does not for an object one", () => {
    expect(writeRef("$/prompts/x.md", "string")).toEqual({ $ref: "$/prompts/x.md" });
    expect(writeRef("$/types/markdown", "object")).toBe("$/types/markdown");
  });

  it("writes the bare string inside a schema", () => {
    expect(writeRef("$/types/markdown", "schema")).toBe("$/types/markdown");
  });

  it("round-trips every position", () => {
    for (const position of ["string", "object", "schema"] as const) {
      expect(readRef(writeRef("$/a/b", position), position)).toBe("$/a/b");
    }
  });
});

describe("spelling a path as a reference", () => {
  it("drops a data extension, because a reference probes for one", () => {
    expect(refForPath("types/markdown.json")).toBe("$/types/markdown");
    expect(refForPath("lib/guards.yaml")).toBe("$/lib/guards");
    expect(refForPath("lib/guards.yml")).toBe("$/lib/guards");
  });

  it("KEEPS any other extension", () => {
    // The mistake this exists to prevent: `$/prompts/feature_goals` finds `feature_goals.json` and
    // does not find `feature_goals.md`, so offering the bare form would suggest a dead reference.
    expect(refForPath("prompts/feature_goals.md")).toBe("$/prompts/feature_goals.md");
    expect(refForPath("skills/review.txt")).toBe("$/skills/review.txt");
  });

  it("leaves an extensionless file alone", () => {
    expect(refForPath("lib/guards")).toBe("$/lib/guards");
  });
});

describe("the unresolved hint", () => {
  const TARGETS = ["$/prompts/goals.md", "$/lib/review", "$/types/markdown"];

  it("accepts a target that is in the tree", () => {
    expect(isKnownRef("$/prompts/goals.md", TARGETS)).toBe(true);
  });

  it("accepts a property path into one", () => {
    // Everything after the file name is a property path, so `review.operation` is `review` plus a
    // property — the single most idiomatic fragment reference there is.
    expect(isKnownRef("$/lib/review.operation", TARGETS)).toBe(true);
  });

  it("flags a path with nothing behind it", () => {
    expect(isKnownRef("$/prompts/goals", TARGETS)).toBe(false);
    expect(isKnownRef("$/prompts/nope.md", TARGETS)).toBe(false);
  });

  it("says nothing about a reference anchored somewhere it cannot see", () => {
    // `./` and bare references resolve against roots this list does not model. A warning there
    // would simply be wrong, which is worse than no warning at all.
    expect(isKnownRef("./sibling", TARGETS)).toBe(true);
    expect(isKnownRef("lib/review.operation", TARGETS)).toBe(true);
    expect(isKnownRef("$JAIRA/prompts/x.md", TARGETS)).toBe(true);
  });
});
