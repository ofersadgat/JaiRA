/**
 * A proposed change read by one run as if it were written (decision 0029 §5 step 5): inside the
 * overlay a path the change names reads as the change says, a folder it adds is there, and everywhere
 * else — outside it, or in another overlay at the same moment — the disk reads as it is.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { currentDefinitionOverlay, definitionExists, listDefinitions, makeDefinitionOverlay, readDefinition, withDefinitionOverlay } from "../src/definitionOverlay";
import { loadSkill, readInstructions, readSkills } from "../src/skills";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "jaira-overlay-"));
  mkdirSync(join(root, "workflows"), { recursive: true });
  writeFileSync(join(root, "workflows", "a.json"), "{}", "utf8");
  writeFileSync(join(root, "instructions.md"), "Be brief.\n", "utf8");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("a definition overlay", () => {
  it("reads a changed file, a new one and the folders that lead to it inside, and the disk outside", () => {
    const overlay = makeDefinitionOverlay("t", {
      [join(root, "workflows", "a.json")]: '{"changed":true}',
      [join(root, "skills", "tidy", "SKILL.md")]: "---\nname: tidy\ndescription: Tidy up.\n---\nTidy.",
    });
    withDefinitionOverlay(overlay, () => {
      expect(readDefinition(join(root, "workflows", "a.json"))).toBe('{"changed":true}');
      expect(definitionExists(join(root, "skills"))).toBe(true);
      expect(listDefinitions(root).map((e) => [e.name, e.isDirectory()])).toEqual([["instructions.md", false], ["skills", true], ["workflows", true]]);
      expect(readSkills([root]).map((s) => s.name)).toEqual(["tidy"]);
      expect(loadSkill([root], "tidy")).toMatchObject({ body: "Tidy." });
    });
    expect(readDefinition(join(root, "workflows", "a.json"))).toBe("{}");
    expect(definitionExists(join(root, "skills"))).toBe(false);
    expect(readSkills([root])).toEqual([]);
    expect(currentDefinitionOverlay()).toBeUndefined();
  });

  it("replaces a layer's instructions whole, never adds to them", () => {
    const overlay = makeDefinitionOverlay("t", { [join(root, "instructions.md")]: "Answer in French.\n" });
    expect(withDefinitionOverlay(overlay, () => readInstructions([root]))).toBe("Answer in French.");
    expect(readInstructions([root])).toBe("Be brief.");
  });

  it("is the overlay of the work that entered it, across awaits, and not of other work at the same moment", async () => {
    const one = makeDefinitionOverlay("one", { [join(root, "instructions.md")]: "One.\n" });
    const two = makeDefinitionOverlay("two", { [join(root, "instructions.md")]: "Two.\n" });
    const read = async (): Promise<string | undefined> => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return readInstructions([root]);
    };
    const [a, b, c] = await Promise.all([withDefinitionOverlay(one, read), withDefinitionOverlay(two, read), read()]);
    expect([a, b, c]).toEqual(["One.", "Two.", "Be brief."]);
  });
});
