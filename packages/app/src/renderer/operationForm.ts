/**
 * The fields an `operation` block carries — and, unchanged, the fields an `environment` block does.
 *
 * One model for both, because they are one shape: hw's `EnvironmentDecl` IS `OperationFields`, all
 * optional (WORKFLOWS.md §5). A state's effective operation is every ancestor's `environment`,
 * outermost first, then its own `environment`, then its own `operation` — nearest wins. So the only
 * difference between the two blocks is what they MEAN, not what they may say, and giving each its
 * own editor would have been two places to add a field and one of them to forget.
 *
 * `kind` is deliberately NOT here. It is the operation's discriminator and the form's Operation
 * control owns it (see `stateForm`'s `OperationKind`); an environment's `kind` is just another
 * default, edited as one.
 *
 * ## The rule every field obeys
 *
 * Written when the form is the authority on it, left alone otherwise. "Left alone" covers two cases
 * and they are easy to conflate: a value the document holds as a REFERENCE (`{"$ref": …}`), which
 * the form renders read-only and must never overwrite; and a key this model does not model at all,
 * which is merged through untouched. Neither is evidence that the author wanted it gone.
 *
 * The second case is smaller than it was but has not gone away, and must not: hw passes any field it
 * does not own straight into the call config — "the operation IS the call" — so a knob invented
 * after this file was written still reaches the model, and dropping it would silently change what
 * the model is asked to do.
 */
import { jsonTextOf, jsonValueOf, listOf, listTextOf } from "./jsonText";
import { applySlotRow, applySlots, slotRowOf, slotsOf, type SlotRow } from "./slotForm";

/** Authored keys the document holds as something other than the value this form edits. */
export type StructuredFields = Record<string, true>;

/**
 * Fields the document holds as a document REFERENCE, keyed by field name (WORKFLOWS.md §2.2).
 *
 * Presence of the key is the link — the value is the reference text, and it may be empty while
 * someone is typing one. Which is why this is a separate map rather than a sentinel inside
 * `fields`: linking and unlinking must not destroy what the other spelling held, so a field can
 * carry a literal in `fields` and a reference here at the same time and the form picks between them.
 * Toggling the link off and on again gets the same reference back, and vice versa.
 *
 * These used to land in {@link StructuredFields} — read-only, "edit it on the JSON tab". They still
 * do when they are anything more than a bare `{"$ref": …}`: a reference with sibling overrides is a
 * merge this form cannot show, and showing only its `$ref` would delete the overrides.
 */
export type RefFields = Record<string, string>;

/**
 * The field vocabulary now lives in `@jaira/shared`, and is re-exported here.
 *
 * It moved because the JSON editor's schema is built from the same table and is compiled in the main
 * process, which cannot import a renderer module. Re-exported rather than repointed at every call
 * site: this module is still where the form's authors expect to find the fields, and a table that
 * has one home but two names is cheaper than forty edited imports.
 */
import {
  CONVERSATION_MODES,
  JSON_FIELDS,
  PERMISSION_MODES,
  PERMISSION_PROFILES,
  SIMPLE_FIELDS,
  readRef,
  writeRef,
  type JsonField,
  type SimpleField,
} from "@jaira/shared/browser";

export {
  CONVERSATION_MODES,
  JSON_FIELDS,
  PERMISSION_MODES,
  PERMISSION_PROFILES,
  SIMPLE_FIELDS,
  type JsonField,
  type SimpleField,
};

/**
 * The session an operation runs under, as the form offers it (DESIGN §1.6).
 *
 * Four states, and the distinction that matters is `absent` vs `fresh`. Absent is no declaration —
 * the operation gets its own stream. `null` is an explicit "start fresh", which OVERRIDES whatever
 * the environment chain supplied. Collapsing them would silently discard an override.
 */
export type SessionMode = "absent" | "named" | "fresh" | "structured";

export interface SessionForm {
  mode: SessionMode;
  /** `named` only. `""` is an error in the engine, never "fresh" — a template that interpolated a
   *  bad reference must not quietly produce an isolated conversation that looks like it worked. */
  name: string;
  /** `structured` only: `{ id }` or `{ expr }`, as text, for the read-only display. */
  text: string;
}

export interface ConversationForm {
  mode: "" | (typeof CONVERSATION_MODES)[number];
  /** `selected_artifacts` only: which artifacts to inject. */
  artifacts: string;
}

export interface PermissionToolRow {
  tool: string;
  mode: string;
}

export interface PermissionsForm {
  profile: string;
  /** The default mode for tools the map does not name. */
  default: string;
  tools: PermissionToolRow[];
}

export interface ReasoningForm {
  effort: string;
  budgetTokens: string;
}

export interface OperationFieldsForm {
  /** Every {@link SimpleField}, keyed by its `name`, as text. */
  fields: Record<string, string>;
  /** Every {@link JsonField}, keyed by its `name`, as JSON text. */
  json: Record<string, string>;
  fork: boolean;
  /**
   * `operation.input` — a PARAMETER map, not a binding map (WORKFLOWS.md §4.3).
   *
   * The same rows as a state's `inputs`, deliberately: the difference between the two blocks is the
   * single most common silent failure in the format, and it exists because both are written as a map
   * keyed by slot name while only one takes a bare binding as the value. A row with its own binding
   * column cannot produce the broken spelling.
   */
  input: SlotRow[];
  /**
   * `operation.output` — one slot, or `null` for "let the loader build it".
   *
   * Absent means the loader assembles an object slot from the state's PRODUCED outputs, and the
   * operation must return a record of them. Declaring it matters most for the blob rule (§4.4): a
   * delegated agent returns one string, so its output must be blob-kind or the string is read as a
   * record of named outputs, finds nothing, and the state fails.
   */
  output: SlotRow | null;
  session: SessionForm;
  conversation: ConversationForm;
  permissions: PermissionsForm;
  reasoning: ReasoningForm;
  structured: StructuredFields;
  /** See {@link RefFields}. Only {@link SimpleField.linkable} fields ever appear here. */
  refs: RefFields;
}

export const EMPTY_OPERATION_FIELDS: OperationFieldsForm = {
  fields: {},
  json: {},
  refs: {},
  fork: false,
  input: [],
  output: null,
  session: { mode: "absent", name: "", text: "" },
  conversation: { mode: "", artifacts: "" },
  permissions: { profile: "", default: "", tools: [] },
  reasoning: { effort: "", budgetTokens: "" },
  structured: {},
};

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

// --- reading -----------------------------------------------------------------

/**
 * The name an authored `output` gives itself.
 *
 * Optional: omitted, the slot is called `output`. Shown as the blank it is rather than pre-filled
 * with the default, so saving an untouched form does not add a `"name": "output"` nobody wrote.
 */
function readOutputName(raw: unknown): string {
  const name = asRecord(raw)["name"];
  return typeof name === "string" ? name : "";
}

function readSession(raw: unknown): SessionForm {
  if (raw === undefined) return { mode: "absent", name: "", text: "" };
  if (raw === null) return { mode: "fresh", name: "", text: "" };
  if (typeof raw === "string") return { mode: "named", name: raw, text: "" };
  return { mode: "structured", name: "", text: JSON.stringify(raw) };
}

function readConversation(raw: unknown): ConversationForm {
  const decl = asRecord(raw);
  const mode = decl["mode"];
  return {
    mode: (CONVERSATION_MODES as readonly string[]).includes(mode as string)
      ? (mode as ConversationForm["mode"])
      : "",
    artifacts: listTextOf(decl["artifacts"]),
  };
}

function readPermissions(raw: unknown): PermissionsForm {
  const decl = asRecord(raw);
  const tools = asRecord(decl["tools"]);
  return {
    profile: typeof decl["profile"] === "string" ? decl["profile"] : "",
    default: typeof decl["default"] === "string" ? decl["default"] : "",
    tools: Object.entries(tools).map(([tool, mode]) => ({ tool, mode: typeof mode === "string" ? mode : "" })),
  };
}

/** Read one `operation`/`environment` block into the form's model. */
export function operationFieldsOf(raw: unknown): OperationFieldsForm {
  const op = asRecord(raw);
  const fields: Record<string, string> = {};
  const structured: StructuredFields = {};
  const refs: RefFields = {};

  for (const spec of SIMPLE_FIELDS) {
    const value = op[spec.key] ?? (spec.alias !== undefined ? op[spec.alias] : undefined);
    if (value === undefined) {
      fields[spec.name] = "";
      continue;
    }
    const ours =
      spec.type === "list" ? Array.isArray(value) : spec.type === "number" ? typeof value === "number" : typeof value === "string";
    if (!ours) {
      // A plain `{"$ref": …}` on a linkable field is a LINK, and the form owns it: the link control
      // shows the target and can retarget or unlink it. This is the case that used to fall through to
      // read-only and send the author to the JSON tab to author what the hint had just recommended.
      const ref = spec.linkable === true ? readRef(value, "string") : undefined;
      if (ref !== undefined) {
        refs[spec.name] = ref;
        fields[spec.name] = "";
        continue;
      }
      // Anything else — a reference with sibling overrides, a transcluded block. Shown read-only
      // rather than as an empty box, because an empty box invites the one edit that replaces it
      // with a literal.
      structured[spec.name] = true;
      fields[spec.name] = "";
      continue;
    }
    fields[spec.name] = spec.type === "list" ? listTextOf(value) : String(value);
  }

  const json: Record<string, string> = {};
  for (const spec of JSON_FIELDS) {
    json[spec.name] = op[spec.key] === undefined ? "" : JSON.stringify(op[spec.key], null, 2);
  }

  const reasoning = asRecord(op["reasoning"]);
  return {
    fields,
    json,
    fork: op["fork"] === true,
    input: slotsOf(op["input"]),
    // An authored `output` may name itself; the row's name column is that `name`.
    output: op["output"] === undefined ? null : slotRowOf(readOutputName(op["output"]), op["output"]),
    session: readSession(op["session"]),
    conversation: readConversation(op["conversation"]),
    permissions: readPermissions(op["permissions"]),
    reasoning: {
      effort: typeof reasoning["effort"] === "string" ? reasoning["effort"] : "",
      budgetTokens: typeof reasoning["budgetTokens"] === "number" ? String(reasoning["budgetTokens"]) : "",
    },
    structured,
    refs,
  };
}

// --- writing -----------------------------------------------------------------

/**
 * Delete a key and its alias, but only when the value there is one this form could have written.
 *
 * A plain `{"$ref": …}` on a linkable field counts as one: the link control put it there and the
 * link control is what removes it. Anything richer is left alone, exactly as before — this is the
 * check that stops an emptied box from deleting a transclusion the form only ever showed read-only.
 */
function clear(op: Record<string, unknown>, spec: SimpleField): void {
  for (const key of spec.alias === undefined ? [spec.key] : [spec.key, spec.alias]) {
    const value = op[key];
    if (value === undefined) continue;
    const ours =
      spec.type === "list" ? Array.isArray(value) : typeof value === (spec.type === "number" ? "number" : "string");
    if (ours || (spec.linkable === true && readRef(value, "string") !== undefined)) delete op[key];
  }
}

function applySimple(op: Record<string, unknown>, form: OperationFieldsForm): void {
  for (const spec of SIMPLE_FIELDS) {
    if (form.structured[spec.name] === true) continue;
    // Linked wins over whatever the literal box holds. The two are kept side by side so that
    // toggling the link is not destructive (see {@link RefFields}), which means exactly one of them
    // has to be the one written, and the toggle is what says which.
    if (Object.prototype.hasOwnProperty.call(form.refs, spec.name)) {
      const ref = (form.refs[spec.name] ?? "").trim();
      // An empty link box is "not authored yet", not an authored empty reference — the same reading
      // an empty text box gets. A reference that resolves to nothing is a different thing, and it is
      // written, so the linter can say so.
      if (ref.length === 0) clear(op, spec);
      else op[spec.key] = writeRef(ref, "string");
      continue;
    }
    const text = form.fields[spec.name] ?? "";
    if (text.trim().length === 0) {
      clear(op, spec);
      continue;
    }
    if (spec.type === "list") {
      const list = listOf(text);
      if (list === undefined) clear(op, spec);
      else op[spec.key] = list;
    } else if (spec.type === "number") {
      const value = Number(text.trim());
      // A box mid-edit ("-", "1e") is not a number yet. Leaving what was there beats writing NaN,
      // which would serialize as `null` and reach the provider as an explicit null.
      if (Number.isFinite(value)) op[spec.key] = value;
    } else {
      op[spec.key] = text;
    }
    if (spec.alias !== undefined && typeof op[spec.alias] === "string") delete op[spec.alias];
  }
}

function applySession(op: Record<string, unknown>, session: SessionForm): void {
  switch (session.mode) {
    case "structured":
      return; // shown read-only — an exact position, normally computed rather than typed
    case "absent":
      // Reaching here with a `{ expr }` in place means the author moved the control OFF structured,
      // which is a deliberate "stop inheriting a position" and not an accident of rendering.
      delete op["session"];
      return;
    case "fresh":
      op["session"] = null;
      return;
    case "named":
      // `""` is an error in the engine, not a synonym for fresh — so an empty box is "not declared".
      if (session.name.trim().length > 0) op["session"] = session.name.trim();
      else delete op["session"];
  }
}

function applyConversation(op: Record<string, unknown>, conversation: ConversationForm): void {
  if (conversation.mode === "") {
    delete op["conversation"];
    return;
  }
  const decl: Record<string, unknown> = { ...asRecord(op["conversation"]), mode: conversation.mode };
  const artifacts = listOf(conversation.artifacts);
  // Only `selected_artifacts` reads the list; carrying it under another mode would be dead config
  // that reads as intent.
  if (conversation.mode === "selected_artifacts" && artifacts !== undefined) decl["artifacts"] = artifacts;
  else delete decl["artifacts"];
  op["conversation"] = decl;
}

function applyPermissions(op: Record<string, unknown>, permissions: PermissionsForm): void {
  const decl: Record<string, unknown> = { ...asRecord(op["permissions"]) };
  if (permissions.profile.trim().length > 0) decl["profile"] = permissions.profile.trim();
  else delete decl["profile"];
  if (permissions.default.trim().length > 0) decl["default"] = permissions.default.trim();
  else delete decl["default"];

  const tools: Record<string, unknown> = {};
  for (const row of permissions.tools) {
    if (row.tool.trim().length === 0 || row.mode.length === 0) continue;
    tools[row.tool.trim()] = row.mode;
  }
  if (Object.keys(tools).length > 0) decl["tools"] = tools;
  else delete decl["tools"];

  if (Object.keys(decl).length > 0) op["permissions"] = decl;
  else delete op["permissions"];
}

function applyReasoning(op: Record<string, unknown>, reasoning: ReasoningForm): void {
  const decl: Record<string, unknown> = { ...asRecord(op["reasoning"]) };
  if (reasoning.effort.length > 0) decl["effort"] = reasoning.effort;
  else delete decl["effort"];
  const budget = Number(reasoning.budgetTokens.trim());
  if (reasoning.budgetTokens.trim().length > 0 && Number.isFinite(budget)) decl["budgetTokens"] = budget;
  else if (reasoning.budgetTokens.trim().length === 0) delete decl["budgetTokens"];

  if (Object.keys(decl).length > 0) op["reasoning"] = decl;
  else delete op["reasoning"];
}

/**
 * Fold the form's fields back into one `operation`/`environment` block.
 *
 * `previous` is merged through, so `input`, `output`, `path` and any provider knob this model has
 * never heard of survive. hw passes an unrecognized field straight to the call config — "the
 * operation IS the call" — so dropping one would silently change what the model is asked to do.
 */
export function applyOperationFields(previous: unknown, form: OperationFieldsForm): Record<string, unknown> {
  const op: Record<string, unknown> = { ...asRecord(previous) };
  applySimple(op, form);

  if (form.fork) op["fork"] = true;
  else delete op["fork"];

  for (const spec of JSON_FIELDS) {
    const value = jsonValueOf(form.json[spec.name] ?? "");
    if (value === undefined) delete op[spec.key];
    else op[spec.key] = value;
  }

  // §4.3: a PARAMETER map. `includeOptional` is on because an operation's own input may be optional
  // exactly as a state's may.
  const input = applySlots(op["input"], form.input, true);
  if (input) op["input"] = input;
  else delete op["input"];

  if (form.output === null) delete op["output"];
  else {
    const output = applySlotRow(op["output"], form.output, false);
    // The name is a FIELD here rather than a map key, and it is optional — omitted, the slot is
    // called `output`.
    if (form.output.name.trim().length > 0) output["name"] = form.output.name.trim();
    else delete output["name"];
    op["output"] = output;
  }

  applySession(op, form.session);
  applyConversation(op, form.conversation);
  applyPermissions(op, form.permissions);
  applyReasoning(op, form.reasoning);
  return op;
}

/** True when a block says nothing at all — used to drop an `environment` emptied of its last field. */
export function isEmptyBlock(op: Record<string, unknown>): boolean {
  return Object.keys(op).length === 0;
}

export { jsonTextOf, jsonValueOf };
