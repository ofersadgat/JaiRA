/**
 * Skills and instructions (decision 0029 §9–§10): the two cheapest levers a lesson can pull.
 *
 * - **Instructions** are `instructions.md` at a layer root — `~/.jaira/` then the project's `.jaira/` —
 *   read once when a run (or a conversation's turn) starts and put into the system text of every model
 *   call it makes, so one file reaches every runtime: a model's `system`, and an agent's prompt, which
 *   the agent executors build from the same `system`. A call opts out with `instructions: false` in its
 *   config (the conversation title does), and the key never reaches a provider.
 * - **Skills** are `skills/<name>/SKILL.md` in any layer, nearest first, in Anthropic's format: YAML
 *   frontmatter with `name` and `description`, then the body. The catalog — each name and what it is
 *   for — rides with the instructions; the body is read only when the model asks for it with
 *   `load_skill`, a JaiRA tool like any other: gated by permission sets, and recorded, so an improver can
 *   tell whether a skill was loaded when a correction happened.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExecServices, InlineFamily, Operation, Tool } from "@declarative-ai/exec";
import type { JsonValue } from "@declarative-ai/json";
import type { StackedExecutor } from "./executorStack";

export const LIST_SKILLS = "list_skills";
export const LOAD_SKILL = "load_skill";
export const SKILL_TOOL_NAMES = [LIST_SKILLS, LOAD_SKILL] as const;

/** One skill, as the catalog shows it. */
export interface SkillInfo {
  name: string;
  description: string;
  /** The layer root it came from. */
  root: string;
  file: string;
}

/** A skill's name: lowercase letters, digits and hyphens, at most 64, never naming the vendor. */
export function skillNameProblem(name: string): string | undefined {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) return `'${name}' is not a skill name — lowercase letters, digits and hyphens, at most 64`;
  if (/anthropic|claude/.test(name)) return `'${name}' may not contain "anthropic" or "claude"`;
  return undefined;
}

/** A SKILL.md's frontmatter and body. */
export function parseSkill(text: string): { name?: string; description?: string; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (m === null) return { body: text };
  const field = (key: string): string | undefined => {
    const line = new RegExp(`^${key}:\\s*(.*)$`, "m").exec(m[1]!)?.[1]?.trim();
    if (line === undefined || line.length === 0) return undefined;
    return line.replace(/^(["'])([\s\S]*)\1$/, "$2");
  };
  const name = field("name");
  const description = field("description");
  return { ...(name !== undefined ? { name } : {}), ...(description !== undefined ? { description } : {}), body: m[2]!.trim() };
}

/** Every skill along the layer roots, nearest first — a nearer layer's skill hides a farther one's. */
export function readSkills(roots: readonly string[]): SkillInfo[] {
  const out = new Map<string, SkillInfo>();
  for (const root of roots) {
    const dir = join(root, "skills");
    if (!existsSync(dir)) continue;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || out.has(entry.name)) continue;
      const file = join(dir, entry.name, "SKILL.md");
      if (!existsSync(file)) continue;
      const parsed = parseSkill(readFileSync(file, "utf8"));
      const name = parsed.name ?? entry.name;
      if (skillNameProblem(name) !== undefined || parsed.description === undefined) continue;
      out.set(entry.name, { name, description: parsed.description.slice(0, 1024), root, file });
    }
  }
  return [...out.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** A skill's body and the other files beside it, or why not. */
export function loadSkill(roots: readonly string[], name: string): { name: string; body: string; files: string[] } | { error: string } {
  const problem = skillNameProblem(name);
  if (problem !== undefined) return { error: problem };
  const skill = readSkills(roots).find((s) => s.name === name);
  if (skill === undefined) return { error: `no skill '${name}' — list_skills says which there are` };
  const { body } = parseSkill(readFileSync(skill.file, "utf8"));
  const dir = join(skill.root, "skills", name);
  const files = readdirSync(dir).filter((f) => f !== "SKILL.md").sort();
  return { name, body, files };
}

/** `instructions.md` of each layer, farthest first, so the project's come last and read as the final word. */
export function readInstructions(roots: readonly string[]): string | undefined {
  const parts: string[] = [];
  for (const root of [...roots].reverse()) {
    const file = join(root, "instructions.md");
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8").trim();
    if (text.length > 0) parts.push(text);
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

/**
 * What every call is told beyond its own system prompt: the instructions, and the skills it may load.
 * `undefined` when there is neither.
 */
export function standingContextOf(roots: readonly string[]): string | undefined {
  const instructions = readInstructions(roots);
  const skills = readSkills(roots);
  const parts: string[] = [];
  if (instructions !== undefined) parts.push(`<instructions>\n${instructions}\n</instructions>`);
  if (skills.length > 0) {
    const listed = skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
    parts.push(`<skills>\nWhen the work in front of you matches one of these, load it with \`load_skill\` before you start, and follow it.\n${listed}\n</skills>`);
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

/**
 * Put the standing context into every prompt call's system text — unless the call says
 * `instructions: false` in its config, a key that is taken off either way so no provider sees it.
 */
export function withInstructions(context: string | undefined, inner: StackedExecutor): StackedExecutor {
  const filled = (op: Operation<InlineFamily>): Operation<InlineFamily> => {
    if (op.kind !== "prompt") return op;
    const config = op.config !== null && typeof op.config === "object" && !Array.isArray(op.config) ? (op.config as Record<string, JsonValue>) : undefined;
    const optedOut = config?.["instructions"] === false;
    const stripped = config !== undefined && "instructions" in config ? (({ instructions: _i, ...rest }) => rest)(config) : config;
    const withConfig = stripped !== config ? { ...op, config: stripped as JsonValue } : op;
    if (context === undefined || optedOut) return withConfig as Operation<InlineFamily>;
    const system = (op as { system?: unknown }).system;
    return { ...withConfig, system: typeof system === "string" && system.length > 0 ? `${system}\n\n${context}` : context } as Operation<InlineFamily>;
  };
  return {
    capabilities: inner.capabilities,
    metrics: inner.metrics,
    ...(inner.capabilitiesFor !== undefined ? { capabilitiesFor: (op: Operation<InlineFamily>) => inner.capabilitiesFor!(filled(op)) } : {}),
    start: (op: Operation<InlineFamily>, ctx: ExecServices) => inner.start(filled(op), ctx),
  };
}

/** The two skill tools, over the layer roots a run reads. */
export function createSkillTools(roots: readonly string[]): Record<string, Tool> {
  return {
    [LIST_SKILLS]: {
      description: "List the skills this project has: each one's name and what it is for. Load one with `load_skill` when the work matches its description.",
      inputSchema: { type: "object", properties: {} } as unknown as Tool["inputSchema"],
      readOnly: true,
      run: async () => readSkills(roots).map((s) => ({ name: s.name, description: s.description })) as unknown as JsonValue,
    },
    [LOAD_SKILL]: {
      description: "Load a skill by name: its instructions, to follow for the work it describes, and the names of the other files it keeps beside them.",
      inputSchema: { type: "object", properties: { name: { type: "string", description: "The skill's name, as `list_skills` gives it." } }, required: ["name"] } as unknown as Tool["inputSchema"],
      readOnly: true,
      run: async (input) => {
        const name = (input as { name?: unknown } | null)?.name;
        if (typeof name !== "string") return { error: "name the skill to load: `name`" };
        return loadSkill(roots, name) as unknown as JsonValue;
      },
    },
  };
}

/** Register the skill tools on a registry. */
export function registerSkillTools(registry: { tools: Map<string, Tool> }, roots: readonly string[]): void {
  for (const [name, tool] of Object.entries(createSkillTools(roots))) registry.tools.set(name, tool);
}
