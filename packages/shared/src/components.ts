/**
 * The built-in UI components (SPEC §8.1, DESIGN §7.1).
 *
 * A UI state is a `FunctionOp` whose function names one of these components; the
 * state's authored surface arrives as the op's `config` input. This module is the
 * contract both sides agree on:
 *
 *  - {@link parseComponentConfig} reads what the *author* wrote, so a malformed
 *    state file fails with a clear message instead of rendering an empty dialog.
 *  - {@link validateComponentResult} checks what the *user* submitted before it
 *    can enter the engine. That check is the reason this lives in `shared` rather
 *    than in the renderer: the renderer is the untrusted half of the boundary, so
 *    the main process re-validates every answer (DESIGN §7.1). The engine then
 *    separately validates against the state's declared output schema.
 *
 * Result shapes are chosen to land directly on a state's declared outputs — e.g.
 * `choose_option` returns `{ decision, comments? }`, which is exactly what SPEC
 * §8.2's human-review state declares.
 */
import type { JsonValue } from "@declarative-ai/json";

export const COMPONENT_NAMES = [
  "choose_option",
  "review_artifact",
  "edit_markdown",
  "fill_form",
  "confirm_action",
] as const;

export type ComponentName = (typeof COMPONENT_NAMES)[number];

export function isComponentName(name: string): name is ComponentName {
  return (COMPONENT_NAMES as readonly string[]).includes(name);
}

/** One selectable choice. Authors may write a bare string or a labelled option. */
export interface ComponentOption {
  value: string;
  label?: string;
  /** Rendered as a destructive/secondary action (e.g. `block`). */
  tone?: "default" | "danger";
}

/** A field of a `fill_form` schema — the JSON-Schema subset DESIGN §7.1 allows. */
export interface FormField {
  name: string;
  type: "string" | "number" | "boolean" | "enum";
  label?: string;
  description?: string;
  enum?: string[];
  optional?: boolean;
  default?: JsonValue;
  /** `string` fields only: render a textarea. */
  multiline?: boolean;
}

export interface ChooseOptionConfig {
  component: "choose_option";
  prompt: string;
  options: ComponentOption[];
  /** Offer a free-text comment alongside the choice. */
  comments?: boolean;
}

export interface ReviewArtifactConfig {
  component: "review_artifact";
  prompt: string;
  /** Which of the state's inputs holds the artifact to show. */
  artifact: string;
  /** Decision buttons, supplied by the state config (DESIGN §7.1). */
  options: ComponentOption[];
  comments?: boolean;
}

export interface EditMarkdownConfig {
  component: "edit_markdown";
  prompt: string;
  /** Input name whose content seeds the editor. */
  source?: string;
}

export interface FillFormConfig {
  component: "fill_form";
  prompt: string;
  fields: FormField[];
}

export interface ConfirmActionConfig {
  component: "confirm_action";
  prompt: string;
  confirmLabel: string;
  cancelLabel: string;
}

export type ComponentConfig =
  | ChooseOptionConfig
  | ReviewArtifactConfig
  | EditMarkdownConfig
  | FillFormConfig
  | ConfirmActionConfig;

// --- parsing the authored config ---------------------------------------------

class ConfigError extends Error {}

function asRecord(raw: unknown, where: string): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError(`${where} must be an object`);
  }
  return raw as Record<string, unknown>;
}

function str(raw: unknown, where: string, fallback?: string): string {
  if (raw === undefined) {
    if (fallback !== undefined) return fallback;
    throw new ConfigError(`${where} is required`);
  }
  if (typeof raw !== "string" || raw.length === 0) throw new ConfigError(`${where} must be a non-empty string`);
  return raw;
}

function options(raw: unknown, where: string): ComponentOption[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ConfigError(`${where} must be a non-empty array of options`);
  }
  return raw.map((entry, i) => {
    if (typeof entry === "string") {
      if (entry.length === 0) throw new ConfigError(`${where}[${i}] must be a non-empty string`);
      return { value: entry };
    }
    const record = asRecord(entry, `${where}[${i}]`);
    const option: ComponentOption = { value: str(record["value"], `${where}[${i}].value`) };
    if (record["label"] !== undefined) option.label = str(record["label"], `${where}[${i}].label`);
    if (record["tone"] !== undefined) {
      const tone = record["tone"];
      if (tone !== "default" && tone !== "danger") {
        throw new ConfigError(`${where}[${i}].tone must be "default" or "danger"`);
      }
      option.tone = tone;
    }
    return option;
  });
}

const FIELD_TYPES = new Set(["string", "number", "boolean", "enum"]);

function fields(raw: unknown, where: string): FormField[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ConfigError(`${where} must be a non-empty array of fields`);
  }
  return raw.map((entry, i) => {
    const record = asRecord(entry, `${where}[${i}]`);
    const name = str(record["name"], `${where}[${i}].name`);
    const type = record["type"] ?? "string";
    if (typeof type !== "string" || !FIELD_TYPES.has(type)) {
      throw new ConfigError(`${where}[${i}].type must be one of string, number, boolean, enum`);
    }
    const field: FormField = { name, type: type as FormField["type"] };
    if (record["label"] !== undefined) field.label = str(record["label"], `${where}[${i}].label`);
    if (record["description"] !== undefined) {
      field.description = str(record["description"], `${where}[${i}].description`);
    }
    if (field.type === "enum") {
      const values = record["enum"];
      if (!Array.isArray(values) || values.length === 0 || values.some((v) => typeof v !== "string")) {
        throw new ConfigError(`${where}[${i}].enum must be a non-empty array of strings`);
      }
      field.enum = values as string[];
    }
    if (record["optional"] === true) field.optional = true;
    if (record["default"] !== undefined) field.default = record["default"] as JsonValue;
    if (record["multiline"] === true) field.multiline = true;
    return field;
  });
}

/**
 * Normalize a component's authored config. `raw` is the op's `config` input.
 * Throws with a path-shaped message on anything malformed.
 */
export function parseComponentConfig(component: ComponentName, raw: unknown): ComponentConfig {
  const config = raw === undefined ? {} : asRecord(raw, `${component} config`);
  const prompt = str(config["prompt"], `${component}.prompt`, defaultPrompt(component));
  switch (component) {
    case "choose_option": {
      const parsed: ChooseOptionConfig = {
        component,
        prompt,
        options: options(config["options"], "choose_option.options"),
      };
      if (config["comments"] === true) parsed.comments = true;
      return parsed;
    }
    case "review_artifact": {
      const parsed: ReviewArtifactConfig = {
        component,
        prompt,
        artifact: str(config["artifact"], "review_artifact.artifact", "artifact"),
        // Decisions are the state's to name; `decisions` is accepted as an alias
        // because it reads better in a review state.
        options: options(config["options"] ?? config["decisions"], "review_artifact.options"),
      };
      if (config["comments"] === true) parsed.comments = true;
      return parsed;
    }
    case "edit_markdown": {
      const parsed: EditMarkdownConfig = { component, prompt };
      if (config["source"] !== undefined) parsed.source = str(config["source"], "edit_markdown.source");
      return parsed;
    }
    case "fill_form":
      return { component, prompt, fields: fields(config["fields"], "fill_form.fields") };
    case "confirm_action":
      return {
        component,
        prompt,
        confirmLabel: str(config["confirmLabel"], "confirm_action.confirmLabel", "Confirm"),
        cancelLabel: str(config["cancelLabel"], "confirm_action.cancelLabel", "Cancel"),
      };
  }
}

function defaultPrompt(component: ComponentName): string {
  switch (component) {
    case "choose_option":
      return "Choose an option";
    case "review_artifact":
      return "Review";
    case "edit_markdown":
      return "Edit";
    case "fill_form":
      return "Fill in the form";
    case "confirm_action":
      return "Confirm this action";
  }
}

// --- validating a submitted result -------------------------------------------

export type ResultCheck = { ok: true } | { ok: false; errors: string };

const bad = (errors: string): ResultCheck => ({ ok: false, errors });

/**
 * Check a submitted answer against its component contract. Called in the main
 * process, so a renderer bug — or anything else reaching the IPC channel — cannot
 * push an out-of-contract value (an undeclared decision, a missing field) into a
 * workflow's outputs.
 */
export function validateComponentResult(config: ComponentConfig, value: unknown): ResultCheck {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return bad(`${config.component} result must be an object`);
  }
  const result = value as Record<string, unknown>;
  switch (config.component) {
    case "choose_option":
    case "review_artifact": {
      const decision = result["decision"];
      if (typeof decision !== "string") return bad("result.decision must be a string");
      if (!config.options.some((o) => o.value === decision)) {
        return bad(`result.decision '${decision}' is not one of: ${config.options.map((o) => o.value).join(", ")}`);
      }
      if (result["comments"] !== undefined && typeof result["comments"] !== "string") {
        return bad("result.comments must be a string when present");
      }
      return { ok: true };
    }
    case "edit_markdown":
      return typeof result["content"] === "string" ? { ok: true } : bad("result.content must be a string");
    case "confirm_action":
      return typeof result["confirmed"] === "boolean" ? { ok: true } : bad("result.confirmed must be a boolean");
    case "fill_form": {
      const problems: string[] = [];
      for (const field of config.fields) {
        const present = Object.prototype.hasOwnProperty.call(result, field.name);
        const raw = result[field.name];
        if (!present || raw === undefined || raw === null || raw === "") {
          if (!field.optional) problems.push(`result.${field.name} is required`);
          continue;
        }
        switch (field.type) {
          case "string":
            if (typeof raw !== "string") problems.push(`result.${field.name} must be a string`);
            break;
          case "number":
            if (typeof raw !== "number" || Number.isNaN(raw)) problems.push(`result.${field.name} must be a number`);
            break;
          case "boolean":
            if (typeof raw !== "boolean") problems.push(`result.${field.name} must be a boolean`);
            break;
          case "enum":
            if (typeof raw !== "string" || !(field.enum ?? []).includes(raw)) {
              problems.push(`result.${field.name} must be one of: ${(field.enum ?? []).join(", ")}`);
            }
            break;
        }
      }
      return problems.length === 0 ? { ok: true } : bad(problems.join("; "));
    }
  }
}

// --- artifact display --------------------------------------------------------

/**
 * Text to display for an input value. An artifact-typed input arrives as an
 * `{ artifact: true, content }` record for llm-backed states, but may also be a
 * plain string (or a path, once process units exist) — so a component renders
 * whatever it can rather than assuming one shape.
 */
export function displayText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record["content"] === "string") return record["content"];
    if (typeof record["path"] === "string") return String(record["path"]);
  }
  return JSON.stringify(value, null, 2);
}
