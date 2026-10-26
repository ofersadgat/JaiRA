/**
 * The rules over the switch (decision 0021): which state turns a state off, and the text edits that
 * write and remove `"disabled"` without disturbing the rest of a state file.
 */
import { describe, expect, it } from "vitest";
import { disabledBy, disabledWords, followFileText, followsOnly, withDisabledText } from "../src/disabled";

describe("disabledBy", () => {
  it("answers the state itself first, then the nearest state above it", () => {
    expect(disabledBy(["feature", "feature/review"], "feature/review/notes")).toBe("feature/review");
    expect(disabledBy(["feature"], "feature/review")).toBe("feature");
    expect(disabledBy(["feature"], "feature")).toBe("feature");
  });

  it("reads a variant as the state it varies, and never matches a mere prefix of a segment", () => {
    expect(disabledBy(["feature/plan"], "feature/plan#2")).toBe("feature/plan");
    expect(disabledBy(["feat"], "feature")).toBeUndefined();
    expect(disabledBy(undefined, "feature")).toBeUndefined();
    expect(disabledBy([], "feature")).toBeUndefined();
  });

  it("names the state above in its words", () => {
    expect(disabledWords("feature", "feature")).toBe("'feature' is disabled");
    expect(disabledWords("feature/review", "feature")).toBe("'feature/review' is under 'feature', which is disabled");
  });
});

describe("withDisabledText", () => {
  const FILE = `{\n  "label": "Release notes",\n  "description": "Writes them.",\n  "operation": { "kind": "prompt" }\n}\n`;

  it("writes the field after the description, leaving every other line as it was", () => {
    expect(withDisabledText(FILE, true)).toBe(
      `{\n  "label": "Release notes",\n  "description": "Writes them.",\n  "disabled": true,\n  "operation": { "kind": "prompt" }\n}\n`,
    );
  });

  it("changes a value where it stands, and takes the field out again", () => {
    const on = withDisabledText(FILE, true);
    expect(withDisabledText(on, false)).toBe(on.replace('"disabled": true', '"disabled": false'));
    expect(withDisabledText(on, undefined)).toBe(FILE);
  });

  it("keeps a file's own indentation and line endings", () => {
    const tabbed = `{\r\n\t"label": "Notes"\r\n}\r\n`;
    expect(withDisabledText(tabbed, true)).toBe(`{\r\n\t"label": "Notes",\r\n\t"disabled": true\r\n}\r\n`);
  });
});

describe("a file that follows another", () => {
  it("is written with its root spelled out, and reads as follow-only once the switch is gone", () => {
    const text = followFileText("$SYSTEM/workflows/chat/session", true);
    expect(JSON.parse(text)).toEqual({ $ref: "$SYSTEM/workflows/chat/session", disabled: true });
    expect(followsOnly(text)).toBe(false);
    expect(followsOnly(withDisabledText(text, undefined))).toBe(true);
    expect(followsOnly(`{ "$ref": "$BASE/workflows/feature", "label": "Mine" }`)).toBe(false);
  });
});
