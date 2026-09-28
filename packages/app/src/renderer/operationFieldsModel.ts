/**
 * What `operationFields.tsx` computes for one `operation` or `environment` block — which fields a
 * block shows, which lint path each answers for, whether the model knobs were tuned, the reasoning
 * value SchemaForm edits — moved here unchanged so the universal copy
 * (`components/workflow/OperationFields.tsx`) draws the same block (decision 0015).
 */
import {
  JSON_FIELDS,
  SIMPLE_FIELDS,
  type OperationFieldsForm,
  type ReasoningForm,
  type SimpleField,
} from "./operationForm";

export const REF_HINT = "a referenced value — edit it on the JSON tab";

/**
 * Every lint path a control inside an `operation` block marks for itself.
 *
 * Exported because the KIND picker sits outside the block and takes what is left: a diagnostic
 * against `operation` that none of these claims — the block failing to resolve at all, or a lowered
 * spelling this form does not render, like `operation.config.model` — is about what kind of
 * operation this is, and the picker is the box that says so.
 */
export function operationFieldPaths(path: string): string[] {
  return [...SIMPLE_FIELDS.map((spec) => `${path}.${spec.key}`), `${path}.session`, `${path}.input`, `${path}.output`];
}

/** Whether anything under "Model settings" was actually tuned — see the fold's own note. */
export function modelKnobsSet(form: OperationFieldsForm): boolean {
  const tuned = SIMPLE_FIELDS.some(
    (spec) =>
      spec.group === "model" &&
      spec.prominent !== true &&
      ((form.fields[spec.name] ?? "").trim().length > 0 || form.refs[spec.name] !== undefined),
  );
  const json = JSON_FIELDS.some((spec) => (form.json[spec.name] ?? "").trim().length > 0);
  return tuned || json || form.reasoning.effort.length > 0 || form.reasoning.budgetTokens.trim().length > 0;
}

/** The form's reasoning text as the value SchemaForm edits: a level, and a budget when it reads as a number. */
export function reasoningValueOf(form: ReasoningForm): Record<string, unknown> {
  const budget = form.budgetTokens.trim();
  return {
    ...(form.effort !== "" ? { effort: form.effort } : {}),
    ...(budget !== "" ? { budgetTokens: Number.isFinite(Number(budget)) ? Number(budget) : budget } : {}),
  };
}

/** SchemaForm's value back as the form's text — what the form serialises from. */
export function reasoningFormOf(value: unknown): ReasoningForm {
  const bag = value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const effort = bag["effort"];
  const budget = bag["budgetTokens"];
  return {
    effort: typeof effort === "string" ? effort : "",
    budgetTokens: typeof budget === "number" || typeof budget === "string" ? String(budget) : "",
  };
}

/** Which of the block's simple fields it shows: prompt and function by kind, and its tools ONCE. */
export function visibleField(spec: SimpleField, show: { prompt: boolean; function: boolean }, form: OperationFieldsForm): boolean {
  return (
    (spec.name !== "prompt" || show.prompt) &&
    (spec.name !== "functionRef" || show.function) &&
    // A block says its tools ONCE, in the field below — see `ToolsFieldControl`.
    (spec.name !== "tools" || form.toolsField === undefined)
  );
}

/** A form shows every field it COULD hold; a reading only what the state says. */
export function simpleFieldShown(readOnly: boolean, form: OperationFieldsForm, spec: SimpleField): boolean {
  const structured = form.structured[spec.name] === true;
  const linked = form.refs[spec.name] !== undefined;
  const value = form.fields[spec.name] ?? "";
  return !(readOnly && !linked && !structured && value.trim().length === 0);
}

/** The block's edits: one field's text, one JSON field, and a field's reference set or cleared. */
export function withField(form: OperationFieldsForm, name: string, value: string): OperationFieldsForm {
  return { ...form, fields: { ...form.fields, [name]: value } };
}
export function withJson(form: OperationFieldsForm, name: string, value: string): OperationFieldsForm {
  return { ...form, json: { ...form.json, [name]: value } };
}
export function withRef(form: OperationFieldsForm, name: string, ref: string | null): OperationFieldsForm {
  const refs = { ...form.refs };
  // Deleting the key is what "not linked" IS — an empty string there means a link whose target has
  // not been typed yet, and the two must stay distinguishable or unlinking would write a literal
  // empty prompt.
  if (ref === null) delete refs[name];
  else refs[name] = ref;
  return { ...form, refs };
}

/** The session picker's choices, in the order it offers them. */
export const SESSION_CHOICES = [
  { value: "absent", label: "not declared — its own stream" },
  { value: "named", label: "named — shared by every state using the name" },
  { value: "fresh", label: "fresh — override the chain and start new" },
] as const;
export const STRUCTURED_SESSION = { value: "structured", label: "a computed position" } as const;
export const SESSION_TITLE = "which conversation stream this call joins";
export const SESSION_NAME_TITLE = "also the resource-bundle key — workspace and permissions";
export const CONVERSATION_TITLE = "the transcript preamble injected into THIS call (SPEC §4.7)";
export const FORK_TITLE = "always branch, rather than appending when the position is still the head";
export const LINKED_NOTE = "spliced in where it is referenced — a copy, not a live link";
