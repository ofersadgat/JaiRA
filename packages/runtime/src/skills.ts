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
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
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

/** Every file under a directory, relative to it, sorted. */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const full = join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(relative(dir, full).split("\\").join("/"));
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * The layers' skills as a Claude Code PLUGIN folder (decision 0029 §10), so the agent's own Skill tool
 * finds them as it finds its own: `.claude-plugin/plugin.json` and `skills/<name>/…`, copied from the
 * nearest layer that has each. Named by its content under `base` — the OS temp directory by default,
 * since it is a copy, never something to commit — so the same skills are one folder however many runs
 * use it, and a changed skill is a new one. `undefined` when there are no skills.
 */
export function skillsPluginDir(roots: readonly string[], base: string = join(tmpdir(), "jaira-skills")): string | undefined {
  const skills = readSkills(roots);
  if (skills.length === 0) return undefined;
  const files: Array<{ rel: string; text: Buffer }> = [];
  for (const skill of skills) {
    const dir = dirname(skill.file);
    for (const rel of filesUnder(dir)) files.push({ rel: `skills/${basename(dir)}/${rel}`, text: readFileSync(join(dir, rel)) });
  }
  const hash = createHash("sha256");
  for (const f of files) hash.update(f.rel).update("\0").update(f.text).update("\0");
  const out = join(base, hash.digest("hex").slice(0, 16));
  if (existsSync(join(out, ".claude-plugin", "plugin.json"))) return out;
  // Written beside, then moved into place: a run that finds the folder finds it whole.
  const staging = `${out}.${process.pid}.${Date.now()}`;
  for (const f of files) {
    mkdirSync(dirname(join(staging, f.rel)), { recursive: true });
    writeFileSync(join(staging, f.rel), f.text);
  }
  mkdirSync(join(staging, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(staging, ".claude-plugin", "plugin.json"),
    `${JSON.stringify({ name: "jaira-skills", version: "1.0.0", description: "The skills of this project's JaiRA layers (skills/<name>/SKILL.md)." }, null, 2)}\n`,
  );
  try {
    renameSync(staging, out);
  } catch {
    // Another run put the same folder there first: it is the same content.
    rmSync(staging, { recursive: true, force: true });
  }
  return out;
}

/**
 * Put the standing context into every prompt call's system text, and the skills plugin into what a
 * Claude Code call loads (`providerOptions.claudeCode.pluginDirs`) — unless the call says
 * `instructions: false` in its config, a key that is taken off either way so no provider sees it.
 */
export function withInstructions(context: string | undefined, inner: StackedExecutor, pluginDirs: readonly string[] = []): StackedExecutor {
  const filled = (op: Operation<InlineFamily>): Operation<InlineFamily> => {
    if (op.kind !== "prompt") return op;
    const config = op.config !== null && typeof op.config === "object" && !Array.isArray(op.config) ? (op.config as Record<string, JsonValue>) : undefined;
    const optedOut = config?.["instructions"] === false;
    const stripped = config !== undefined && "instructions" in config ? (({ instructions: _i, ...rest }) => rest)(config) : config;
    if (optedOut) return (stripped !== config ? { ...op, config: stripped as JsonValue } : op) as Operation<InlineFamily>;
    let nextConfig = stripped;
    if (pluginDirs.length > 0) {
      const po = (nextConfig?.["providerOptions"] ?? {}) as Record<string, JsonValue>;
      const cc = (po["claudeCode"] ?? {}) as Record<string, JsonValue>;
      const had = Array.isArray(cc["pluginDirs"]) ? (cc["pluginDirs"] as JsonValue[]) : [];
      nextConfig = { ...(nextConfig ?? {}), providerOptions: { ...po, claudeCode: { ...cc, pluginDirs: [...had, ...pluginDirs] } } };
    }
    const withConfig = nextConfig !== config ? { ...op, config: nextConfig as JsonValue } : op;
    if (context === undefined) return withConfig as Operation<InlineFamily>;
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
