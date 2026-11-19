/**
 * Instructions and skills (decision 0029 §9–§10): one file per layer every call is told, and skills a
 * call loads by name — read along the layers, nearest first.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExecServices, InlineFamily, Operation } from "@declarative-ai/exec";
import { createSkillTools, loadSkill, parseSkill, readInstructions, readSkills, skillNameProblem, standingContextOf, withInstructions } from "../src/skills";

function layer(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "jaira-layer-"));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), text, "utf8");
  }
  return root;
}

const skill = (name: string, description: string, body = "Do it this way.") => `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;

describe("skills", () => {
  it("reads every layer's skills, the nearer one hiding a farther one of the same name", () => {
    const project = layer({ "skills/migrations/SKILL.md": skill("migrations", "Writing a database migration") });
    const shared = layer({
      "skills/migrations/SKILL.md": skill("migrations", "the shared one"),
      "skills/logging/SKILL.md": skill("logging", "Adding logging to a package"),
      "skills/bad/SKILL.md": "no frontmatter",
    });
    expect(readSkills([project, shared]).map((s) => `${s.name}: ${s.description}`)).toEqual(["logging: Adding logging to a package", "migrations: Writing a database migration"]);
  });

  it("loads a skill's body and names the files beside it — and says plainly when there is no such skill", () => {
    const root = layer({ "skills/logging/SKILL.md": skill("logging", "Adding logging", "Use the logger."), "skills/logging/example.ts": "x" });
    expect(loadSkill([root], "logging")).toEqual({ name: "logging", body: "Use the logger.", files: ["example.ts"] });
    expect(loadSkill([root], "nope")).toMatchObject({ error: expect.stringMatching(/no skill 'nope'/) });
    expect(loadSkill([root], "../x")).toMatchObject({ error: expect.stringMatching(/not a skill name/) });
  });

  it("holds a name to Anthropic's rules", () => {
    expect(skillNameProblem("good-name-2")).toBeUndefined();
    expect(skillNameProblem("Bad Name")).toBeDefined();
    expect(skillNameProblem("claude-helper")).toBeDefined();
    expect(parseSkill(skill("x", '"quoted, with a comma"'))).toMatchObject({ name: "x", description: "quoted, with a comma" });
  });

  it("serves the two tools over the layers", async () => {
    const root = layer({ "skills/logging/SKILL.md": skill("logging", "Adding logging", "Use the logger.") });
    const tools = createSkillTools([root]);
    expect(await tools.list_skills!.run({}, {} as never)).toEqual([{ name: "logging", description: "Adding logging" }]);
    expect(await tools.load_skill!.run({ name: "logging" }, {} as never)).toMatchObject({ body: "Use the logger." });
  });
});

describe("instructions", () => {
  it("joins the layers' files farthest first, so the project's read last", () => {
    const project = layer({ "instructions.md": "Use pnpm here." });
    const shared = layer({ "instructions.md": "Be brief." });
    expect(readInstructions([project, shared])).toBe("Be brief.\n\nUse pnpm here.");
    expect(readInstructions([layer({})])).toBeUndefined();
  });

  it("puts the instructions and the skill catalog into every prompt call's system text, unless the call opts out", () => {
    const root = layer({ "instructions.md": "Be brief.", "skills/logging/SKILL.md": skill("logging", "Adding logging") });
    const context = standingContextOf([root])!;
    expect(context).toContain("<instructions>\nBe brief.\n</instructions>");
    expect(context).toContain("- logging: Adding logging");
    const seen: Array<Operation<InlineFamily>> = [];
    const inner = { capabilities: {} as never, metrics: {} as never, start: (op: Operation<InlineFamily>) => (seen.push(op), {} as never) };
    const wrapped = withInstructions(context, inner as never);
    wrapped.start({ kind: "prompt", system: "You are a reviewer.", user: "hi", config: { model: "m" } } as never, {} as ExecServices);
    wrapped.start({ kind: "prompt", user: "title this", config: { model: "m", instructions: false } } as never, {} as ExecServices);
    expect((seen[0] as { system?: string }).system).toBe(`You are a reviewer.\n\n${context}`);
    expect((seen[1] as { system?: string }).system).toBeUndefined();
    // The opt-out key never reaches a provider.
    expect((seen[1] as { config?: Record<string, unknown> }).config).toEqual({ model: "m" });
  });
});
