/**
 * What Settings → Tools → Functions works out, as pure functions: the permission sets as columns, the
 * command and runner rows, who uses a function, and what its defaults come to. `FunctionsSections`
 * (`packages/universal/src/components/settings/FunctionsSections.tsx`) draws the table from it.
 */
import {
  BUILTIN_FUNCTIONS,
  COMMAND_RUNNERS,
  CONFIG_SECTIONS,
  DEFAULT_SMART_PROMPT,
  RUNNER_GROUP_SUBJECT,
  SMART_FUNCTION,
  entryOfDecl,
  isFunctionMode,
  permissionSetsAt,
  runnerSubject,
  subjectKindOf,
  type PermissionSetMode,
  type PermissionSetsView,
  type WorkflowLayer,
} from "@jaira/shared/browser";
import type { Writer } from "./configWriter";
import { modeMeta } from "./permissionSetWords";
import type { Schema } from "./schemaForm/types";

/** One column of the table: a permission set as this layer sees it. */
export interface SetColumn {
  id: string;
  bucket: string;
  name: string;
  /** This layer states it — its cells are outlined. */
  here: boolean;
  decl: Record<string, unknown>;
}

/** Where each function's defaults live in `settings.json` — one layered block, `functions.<name>`. */
export const DEFAULTS_BLOCK = "functions";

/** What a function a workflow calls does, in the words of the menu that offers it. */
export const WORKFLOW_FUNCTION_WHAT: Record<string, string> = {
  [SMART_FUNCTION]: "judges a call for a permission set: allow, deny, or unsure (then you are asked)",
  approve_tool_call: "the approval prompt — puts one tool call to you",
  review_artifacts: "a review of N files, each decided — optionally opened on the forge too",
  ...Object.fromEntries(BUILTIN_FUNCTIONS.map((f) => [f.name, f.what])),
};

/** The permission sets this layer can see, in rail order. */
export function columnsOf(data: PermissionSetsView | null, layer: WorkflowLayer): SetColumn[] {
  if (data === null) return [];
  return (
    permissionSetsAt(data.records, layer)
      .map((at) => ({ id: at.id, bucket: at.bucket, name: at.name, here: at.here, decl: (at.source.decl ?? {}) as Record<string, unknown> }))
      // Grouped by bucket in the order the rail lists them, each bucket's sets in their own order.
      .sort((a, b) => (a.bucket === b.bucket ? 0 : a.bucket.localeCompare(b.bucket)))
  );
}

/** Every command a set names (`git status`), for rows under `bash`. */
export function commandSubjectsOf(columns: SetColumn[]): string[] {
  const seen = new Set<string>();
  for (const column of columns) for (const subject of Object.keys(column.decl)) if (subjectKindOf(subject) === "command") seen.add(subject);
  return [...seen].sort();
}

/** Every runner line a set writes — the group's first, then each runner's in the order they are listed. */
export function runnerSubjectsOf(columns: SetColumn[]): string[] {
  const seen = new Set<string>();
  for (const column of columns) for (const subject of Object.keys(column.decl)) if (subjectKindOf(subject) === "runner") seen.add(subject);
  const order = [RUNNER_GROUP_SUBJECT, ...COMMAND_RUNNERS.map((runner) => runnerSubject(runner.program))];
  return order.filter((subject) => seen.has(subject));
}

/** A row is a command's or a runner's, drawn indented under its tool. */
export function isSubRow(name: string): boolean {
  return subjectKindOf(name) === "command" || (subjectKindOf(name) === "runner" && name !== RUNNER_GROUP_SUBJECT);
}

/** Who uses a function: the sets with a line for it — or, for a judge, the lines that hand calls to it. */
export function usersOf(name: string, columns: SetColumn[]): Array<{ id: string; says: string }> {
  const out: Array<{ id: string; says: string }> = [];
  for (const column of columns) {
    if (name === SMART_FUNCTION || !(name in column.decl)) {
      if (name !== SMART_FUNCTION) continue;
      const lines = Object.entries(column.decl).filter(([, entry]) => {
        const mode = entryOfDecl(entry as never).mode;
        return isFunctionMode(mode) && mode.function === name;
      });
      if (lines.length > 0) out.push({ id: column.id, says: lines.length === Object.keys(column.decl).length ? `every line (${lines.length})` : `${lines.length} line${lines.length === 1 ? "" : "s"}` });
      continue;
    }
    const mode = entryOfDecl(column.decl[name] as never).mode;
    out.push({ id: column.id, says: modeMeta(mode).label });
  }
  return out;
}

/** The part of the `functions` block's schema that is this function's defaults, when it has any. */
export function defaultsSchemaOf(name: string): Schema | undefined {
  const block = CONFIG_SECTIONS.find((s) => s.key === DEFAULTS_BLOCK)?.schema as Schema | undefined;
  const properties = (block as { properties?: Record<string, Schema> } | undefined)?.properties;
  return properties?.[name];
}

/** `smart`'s schema with the presets offered as its model's suggestions — `examples`, so any model id is still taken. */
export function withPresetSuggestions(schema: Schema, presets: readonly string[]): Schema {
  const properties = (schema["properties"] ?? {}) as Record<string, Schema>;
  const model = properties["model"];
  if (model === undefined || presets.length === 0) return schema;
  return { ...schema, properties: { ...properties, model: { ...model, examples: [...presets] } } };
}

/** The value at a dotted path of a document, or undefined. */
export function valueAt(doc: Record<string, unknown>, path: string): unknown {
  let cursor: unknown = doc;
  for (const part of path.split(".")) {
    if (cursor === null || typeof cursor !== "object" || Array.isArray(cursor)) return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

/** One line for the Defaults column: what the function's defaults come to, or a dash. */
export function defaultsSummary(name: string, writer: Writer | null): string {
  if (defaultsSchemaOf(name) === undefined || writer === null) return "—";
  const block = valueAt(writer.effective, `${DEFAULTS_BLOCK}.${name}`);
  if (name === "bash") {
    const builtins = (block as { builtins?: unknown } | undefined)?.builtins;
    return builtins === false ? "built-in refusals off" : "built-in refusals on";
  }
  if (name === SMART_FUNCTION) {
    const smart = (block ?? {}) as { model?: unknown; prompt?: unknown };
    return `model: ${typeof smart.model === "string" && smart.model.length > 0 ? smart.model : "machine default"} · prompt: ${typeof smart.prompt === "string" && smart.prompt.length > 0 && smart.prompt !== DEFAULT_SMART_PROMPT ? "its own" : "default"}`;
  }
  if (block === undefined || block === null || typeof block !== "object") return "defaults";
  const parts = Object.entries(block as Record<string, unknown>).filter(([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean");
  return parts.length === 0 ? "defaults" : parts.map(([k, v]) => `${k}: ${String(v)}`).join(" · ");
}

/** A cell's look: its mode's word, `fn` for a function, `none` for a set that does not offer it. */
export function modeClass(mode: PermissionSetMode | undefined): string {
  if (mode === undefined) return "none";
  if (isFunctionMode(mode)) return "fn";
  return mode;
}

/** A cell: the mode a set gives a function, its words and its tooltip. */
export function cellOf(column: SetColumn, name: string): { mode: PermissionSetMode | undefined; text: string; title: string } {
  const entry = column.decl[name];
  const mode = entry === undefined ? undefined : entryOfDecl(entry as never).mode;
  return {
    mode,
    text: mode === undefined ? "—" : isFunctionMode(mode) ? `☆ ${mode.function}` : mode,
    title: mode === undefined ? `${column.id} does not offer ${name}` : `${column.id}: ${modeMeta(mode).hint} — open it`,
  };
}

/** What the rules' disclosure says of them. */
export function rulesWords(rules: readonly string[] | undefined): string {
  return rules === undefined || rules.length === 0 ? "everything the workflow registers" : `${rules.length} rule${rules.length === 1 ? "" : "s"}`;
}

/** Whether `smart`'s shipped prompt is the one in use — the detail then shows it in full. */
export function showsDefaultPrompt(writer: Writer): boolean {
  const prompt = valueAt(writer.effective, `${DEFAULTS_BLOCK}.${SMART_FUNCTION}.prompt`);
  return (typeof prompt !== "string" || prompt.length === 0 || prompt === DEFAULT_SMART_PROMPT) && !writer.stated(`${DEFAULTS_BLOCK}.${SMART_FUNCTION}.prompt`);
}
