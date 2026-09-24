/**
 * Settings → Tools → Functions: every function a run can call, keyed by the function — the reverse
 * of the permission sets above it (the person's ask, 2026-09-23: "keyed by the function/tool and show
 * you which permission set has that tool and what it is set to").
 *
 * Two lists, because a function is reached two ways:
 *
 *  - **An agent calls it.** Those are what a permission set holds a line for, so they are drawn as a
 *    TABLE: one row per function, one column per permission set this layer can see, and in each cell
 *    the mode that set gives it — "what does bash get across my sets?" in one look instead of eight
 *    opened sets. A cell opens that set, above.
 *  - **A workflow state calls it.** Gates, the permission judge, an agent reached as a function. No
 *    permission set names these, so the column that matters is whether the default executor may
 *    REACH them — its function rules, which live here now rather than inside the executor tree.
 *
 * Either kind has DEFAULTS, and a row opens them: what `smart` judges with, and what it is told (the
 * shipped prompt shown in full until a layer writes its own); whether `review_artifacts` may publish,
 * and how long it waits after a comment; whether `bash` keeps JaiRA's built-in refusals. They are one
 * layered block, `functions.<name>`, written through the same schema form as every other setting.
 */
import { useMemo, useState, type JSX } from "react";
import {
  CONFIG_SECTIONS,
  COMPONENT_NAMES,
  BUILTIN_FUNCTIONS,
  DEFAULT_SMART_PROMPT,
  SMART_FUNCTION,
  TOOL_CATEGORIES,
  entryOfDecl,
  functionAllowed,
  isFunctionMode,
  subjectKindOf,
  toolsInCategory,
  permissionSetsAt,
  type ConfigLayer,
  type ConfigView,
  type PermissionSetMode,
  type PermissionSetsView,
  type WorkflowLayer,
} from "@jaira/shared/browser";
import { configWriter } from "./configPane";
import { Disclosure } from "./controls";
import { Icon } from "./icons";
import { RuleList } from "./executorTreePane";
import { SchemaForm } from "./schemaForm/SchemaForm";
import type { Schema } from "./schemaForm/types";
import { SettingsSection } from "./settingsLayout";
import { modeMeta } from "./permissionSetRows";

export interface FunctionsProps {
  /** What the permission sets hold — the same read the pane above draws. Absent while it loads. */
  data: PermissionSetsView | null;
  /** The layer the Tools page is showing: a project, the shared root, or what ships. */
  layer: WorkflowLayer;
  config: ConfigView | null;
  busy: boolean;
  /** Write a settings layer — what a function's defaults save through. */
  onSave: (layer: ConfigLayer, doc: unknown) => void;
  /** Agent runtimes this project configures — reachable as functions under their registry names. */
  agents: string[];
  /** The default executor's function rules, in effect. Absent ⇒ none: everything is reachable. */
  rules: string[] | undefined;
  /** Pin the rules into the layer's executor overlay; `undefined` unpins them. */
  onRules: (next: string[] | undefined) => void;
  /** Open one permission set in the pane above. */
  onOpenSet: (id: string) => void;
}

/** One column of the table: a permission set as this layer sees it. */
interface SetColumn {
  id: string;
  bucket: string;
  name: string;
  /** This layer states it — its cells are outlined. */
  here: boolean;
  decl: Record<string, unknown>;
}

/** Where each function's defaults live in `settings.json` — one layered block, `functions.<name>`. */
const DEFAULTS_BLOCK = "functions";

/** What a function a workflow calls does, in the words of the menu that offers it. */
const WORKFLOW_FUNCTION_WHAT: Record<string, string> = {
  [SMART_FUNCTION]: "judges a call for a permission set: allow, deny, or unsure (then you are asked)",
  approve_tool_call: "the approval prompt — puts one tool call to you",
  review_artifacts: "a review of N files, each decided — optionally opened on the forge too",
  ...Object.fromEntries(BUILTIN_FUNCTIONS.map((f) => [f.name, f.what])),
};

export function FunctionsSections(props: FunctionsProps): JSX.Element {
  const [open, setOpen] = useState<string | null>(null);
  const columns = useMemo(() => columnsOf(props.data, props.layer), [props.data, props.layer]);
  const commands = useMemo(() => commandSubjectsOf(columns), [columns]);
  const toggle = (name: string): void => setOpen((current) => (current === name ? null : name));

  const writableLayer: ConfigLayer | null = props.layer === "system" ? null : props.layer;
  const writer =
    props.config !== null ? configWriter(props.config, writableLayer ?? "base", props.busy || writableLayer === null, props.onSave) : null;
  const detail = (name: string): JSX.Element => (
    <FunctionDetail name={name} columns={columns} writer={writer} readOnly={writableLayer === null} onOpenSet={props.onOpenSet} />
  );

  const workflowFunctions = [SMART_FUNCTION, ...COMPONENT_NAMES, ...props.agents];

  return (
    <>
      <SettingsSection
        id="functions"
        title="Functions an agent calls"
        info="Each row is a tool an agent may call, and each column a permission set this layer can see; the cell is the mode that set gives it. A dash is a set that does not offer the tool — a call to it falls to that set's other line. An outlined cell is in a set this layer states. A row opens the function; a cell opens that set above."
        wide
      >
        {props.data === null ? (
          <p className="cfg-hint">Reading the permission sets…</p>
        ) : (
          <div className="fx-wrap">
            <table className="fx-table">
              <thead>
                <tr>
                  <th className="fx-fn">Function</th>
                  <th className="fx-defaults">Defaults</th>
                  {columns.map((column, i) => (
                    <th key={column.id} className={i === 0 || columns[i - 1]!.bucket !== column.bucket ? "fx-set fx-bucket-start" : "fx-set"}>
                      {i === 0 || columns[i - 1]!.bucket !== column.bucket ? <span className="fx-bucket">{column.bucket}</span> : null}
                      {column.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {TOOL_CATEGORIES.map((category) => {
                  const tools = toolsInCategory(category.id).map((spec) => spec.name);
                  const extra = category.id === "execution" ? [...commands, "script"] : [];
                  const names = [...tools, ...extra];
                  if (names.length === 0) return null;
                  return [
                    <tr key={`g:${category.id}`} className="fx-group">
                      <th colSpan={2 + columns.length}>{category.label}</th>
                    </tr>,
                    ...names.map((name) => (
                      <FunctionRow
                        key={name}
                        name={name}
                        sub={subjectKindOf(name) === "command"}
                        defaults={defaultsSummary(name, writer)}
                        columns={columns}
                        open={open === name}
                        onToggle={() => toggle(name)}
                        onOpenSet={props.onOpenSet}
                        detail={detail}
                      />
                    )),
                  ];
                })}
                <tr className="fx-group">
                  <th colSpan={2 + columns.length}>Everything not listed</th>
                </tr>
                <FunctionRow
                  name="other"
                  sub={false}
                  defaults="—"
                  columns={columns}
                  open={open === "other"}
                  onToggle={() => toggle("other")}
                  onOpenSet={props.onOpenSet}
                  detail={detail}
                  what="an agent's own tools with no equal here, and MCP"
                />
              </tbody>
            </table>
          </div>
        )}
      </SettingsSection>

      <SettingsSection
        id="workflow-functions"
        title="Functions a workflow calls"
        info="Gates, the permission judge, and an agent reached as a function. A workflow state calls these, not an agent, so no permission set lists them; what decides whether a run may call one is the default executor's rules, below."
      >
        <ul className="cfg-rows fx-list">
          {workflowFunctions.map((name) => {
            const available = functionAllowed(props.rules, name);
            const isAgent = props.agents.includes(name) && !(COMPONENT_NAMES as readonly string[]).includes(name);
            return (
              <li key={name} className={`fx-list-row${open === name ? " open" : ""}`}>
                <button type="button" className="fx-list-head" aria-expanded={open === name} onClick={() => toggle(name)}>
                  <span className="mono fx-list-name">{name}</span>
                  <span className="fx-list-what">{isAgent ? "agent — delegate a state to that runtime" : (WORKFLOW_FUNCTION_WHAT[name] ?? "")}</span>
                  <span className="fx-list-defaults">{defaultsSummary(name, writer)}</span>
                  <span className={`fx-avail ${available ? "yes" : "no"}`}>{available ? "available" : "not reachable"}</span>
                  <Icon name="chevron" className={`fx-chev${open === name ? " open" : ""}`} />
                </button>
                {open === name ? <div className="fx-list-body">{detail(name)}</div> : null}
              </li>
            );
          })}
        </ul>
        <div className="fx-rules">
          <Disclosure summary="Which of them a run may reach" desc={props.rules === undefined || props.rules.length === 0 ? "everything the workflow registers" : `${props.rules.length} rule${props.rules.length === 1 ? "" : "s"}`}>
            <p className="cfg-hint">
              Walked in order, last match winning. Start with a baseline — everything or nothing — then add or subtract; the available column above
              is what they come to.
            </p>
            <RuleList
              rules={props.rules ?? []}
              known={[...BUILTIN_FUNCTIONS, ...props.agents.map((name) => ({ name, what: "agent — delegate this state to that runtime" }))]}
              disabled={props.busy || props.layer === "system"}
              onChange={(next) => props.onRules(next.length > 0 ? next : undefined)}
            />
          </Disclosure>
        </div>
      </SettingsSection>
    </>
  );
}

/** One function's row in the table, and — while it is open — its defaults and the sets that hold it. */
function FunctionRow({
  name,
  sub,
  defaults,
  columns,
  open,
  onToggle,
  onOpenSet,
  detail,
  what,
}: {
  name: string;
  sub: boolean;
  defaults: string;
  columns: SetColumn[];
  open: boolean;
  onToggle: () => void;
  onOpenSet: (id: string) => void;
  detail: (name: string) => JSX.Element;
  what?: string;
}): JSX.Element {
  return (
    <>
      <tr className={`fx-row${open ? " open" : ""}${sub ? " sub" : ""}`}>
        <th className="fx-fn">
          <button type="button" className="fx-fn-button" aria-expanded={open} onClick={onToggle}>
            <span className="mono">{name}</span>
            {what !== undefined ? <span className="fx-what">{what}</span> : null}
          </button>
        </th>
        <td className="fx-defaults">{defaults}</td>
        {columns.map((column, i) => {
          const entry = column.decl[name];
          const mode = entry === undefined ? undefined : entryOfDecl(entry as never).mode;
          return (
            <td key={column.id} className={i === 0 || columns[i - 1]!.bucket !== column.bucket ? "fx-bucket-start" : undefined}>
              <button
                type="button"
                className={`fx-cell ${modeClass(mode)}${column.here && mode !== undefined ? " here" : ""}`}
                title={mode === undefined ? `${column.id} does not offer ${name}` : `${column.id}: ${modeMeta(mode).hint} — open it`}
                onClick={() => onOpenSet(column.id)}
              >
                {mode === undefined ? "—" : isFunctionMode(mode) ? `☆ ${mode.function}` : mode}
              </button>
            </td>
          );
        })}
      </tr>
      {open ? (
        <tr className="fx-detail-row">
          <td colSpan={2 + columns.length}>{detail(name)}</td>
        </tr>
      ) : null}
    </>
  );
}

/**
 * A function, opened: its defaults as rows of the schema form (read-only while the Tools page shows
 * what ships), and every permission set that uses it.
 */
function FunctionDetail({
  name,
  columns,
  writer,
  readOnly,
  onOpenSet,
}: {
  name: string;
  columns: SetColumn[];
  writer: ReturnType<typeof configWriter> | null;
  readOnly: boolean;
  onOpenSet: (id: string) => void;
}): JSX.Element {
  const schema = defaultsSchemaOf(name);
  const users = usersOf(name, columns);
  const prompt = name === SMART_FUNCTION && writer !== null ? valueAt(writer.effective, `${DEFAULTS_BLOCK}.${SMART_FUNCTION}.prompt`) : undefined;
  return (
    <div className="fx-detail">
      {schema !== undefined && writer !== null ? (
        <div className="fx-detail-defaults">
          <div className="fx-detail-title">Defaults{readOnly ? <span className="sub"> · shown as in effect; set them in a project or the shared layer</span> : null}</div>
          <SchemaForm
            schema={schema}
            value={valueAt(writer.effective, `${DEFAULTS_BLOCK}.${name}`)}
            onChange={(next) => writer.set(`${DEFAULTS_BLOCK}.${name}`, next)}
            ctx={{ path: `${DEFAULTS_BLOCK}.${name}`, disabled: writer.locked, isSet: writer.stated, setAt: writer.set }}
          />
          {name === SMART_FUNCTION && (typeof prompt !== "string" || prompt.length === 0 || prompt === DEFAULT_SMART_PROMPT) && !writer.stated(`${DEFAULTS_BLOCK}.${SMART_FUNCTION}.prompt`) ? (
            <div className="fx-default-prompt">
              <div className="sub">The prompt it uses now — the one JaiRA ships. The call being judged is appended as JSON.</div>
              <pre>{DEFAULT_SMART_PROMPT}</pre>
            </div>
          ) : null}
        </div>
      ) : (
        <p className="cfg-hint">No defaults — {name === "other" ? "a set's other line is all there is to it" : "it takes nothing a layer could set"}.</p>
      )}
      <div className="fx-detail-title">Used by</div>
      {users.length === 0 ? (
        <p className="cfg-hint">No permission set this layer can see {name === SMART_FUNCTION ? "hands a call to it" : "offers it"}.</p>
      ) : (
        <ul className="fx-users">
          {users.map((user) => (
            <li key={user.id}>
              <button type="button" className="link mono" onClick={() => onOpenSet(user.id)}>
                {user.id}
              </button>
              <span className="sub">{user.says}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The permission sets this layer can see, in rail order. */
function columnsOf(data: PermissionSetsView | null, layer: WorkflowLayer): SetColumn[] {
  if (data === null) return [];
  return permissionSetsAt(data.records, layer)
    .map((at) => ({ id: at.id, bucket: at.bucket, name: at.name, here: at.here, decl: (at.source.decl ?? {}) as Record<string, unknown> }))
    // Grouped by bucket in the order the rail lists them, each bucket's sets in their own order.
    .sort((a, b) => (a.bucket === b.bucket ? 0 : a.bucket.localeCompare(b.bucket)));
}

/** Every command a set names (`git status`), for rows under `bash`. */
function commandSubjectsOf(columns: SetColumn[]): string[] {
  const seen = new Set<string>();
  for (const column of columns) for (const subject of Object.keys(column.decl)) if (subjectKindOf(subject) === "command") seen.add(subject);
  return [...seen].sort();
}

/** Who uses a function: the sets with a line for it — or, for a judge, the lines that hand calls to it. */
function usersOf(name: string, columns: SetColumn[]): Array<{ id: string; says: string }> {
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
function defaultsSchemaOf(name: string): Schema | undefined {
  const block = CONFIG_SECTIONS.find((s) => s.key === DEFAULTS_BLOCK)?.schema as Schema | undefined;
  const properties = (block as { properties?: Record<string, Schema> } | undefined)?.properties;
  return properties?.[name];
}

/** One line for the Defaults column: what the function's defaults come to, or a dash. */
function defaultsSummary(name: string, writer: ReturnType<typeof configWriter> | null): string {
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

function modeClass(mode: PermissionSetMode | undefined): string {
  if (mode === undefined) return "none";
  if (isFunctionMode(mode)) return "fn";
  return mode;
}

/** The value at a dotted path of a document, or undefined. */
function valueAt(doc: Record<string, unknown>, path: string): unknown {
  let cursor: unknown = doc;
  for (const part of path.split(".")) {
    if (cursor === null || typeof cursor !== "object" || Array.isArray(cursor)) return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}
