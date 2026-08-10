/**
 * What to call ONE RUN of a state.
 *
 * A state's `label` names the state — `"Planning"` is the same on every run of it, which is exactly
 * what a board column heading wants and exactly what a CARD does not. Four `design` runs share a
 * state id, a child key and a label; the only thing that tells them apart is what each was called
 * with. So `label` is now an EXPRESSION, evaluated against that run's resolved inputs:
 *
 * ```jsonc
 * "label": "Design"                  // a literal — every run of this state is called "Design"
 * "label": ".inputs.description"     // a reference — each run is called by what it was given
 * ```
 *
 * **The leading dot is what makes a label a reference.** Everything else is a literal, which is the
 * rule that lets both spellings exist without a second field and without breaking a single workflow
 * written before this. It has to be the dot rather than "does it parse", because a bare word parses
 * perfectly well — `Planning` is a valid identifier expression — and reading it as one would turn
 * every label already written into a lookup of a variable that does not exist. A dot is also what
 * every other reference in the format starts with, so there is no second convention to learn.
 *
 * Only two forms actually resolve, and that is deliberate rather than unfinished:
 *
 *  - a **literal** (`'Design'`, or anything that does not parse), and
 *  - a **path** into this run's own scope (`.inputs.description`).
 *
 * A path is answerable from the `inputs` already on `instance.entered`. Anything richer — a
 * comparison, a call, a concatenation — is a producer tree that only the engine can evaluate, and
 * inventing a second half-evaluator here is how the two come to disagree about what an expression
 * means. Those report {@link LabelIssue} rather than rendering wrong, and the state's inputs are
 * listed instead.
 */
import { parseExpression, selfPathOf, type Expr } from "@declarative-ai/hw";
import type { JsonValue } from "@declarative-ai/json";

/** Why a label could not be resolved. Reported as lint, never rendered as the label. */
export interface LabelIssue {
  /** `unsupported` — parses, but is richer than a path. `unknown-input` — names a slot that is not declared. */
  kind: "unsupported" | "unknown-input";
  message: string;
}

export interface ResolvedLabel {
  /** What to show. Absent when the expression could not be resolved — see {@link issue}. */
  label?: string;
  issue?: LabelIssue;
}

/** An expression that is a bare string literal — `'Design'`. */
function literalOf(expr: Expr): string | undefined {
  const node = expr as { type?: string; value?: unknown };
  if (node.type !== "lit") return undefined;
  return typeof node.value === "string" ? node.value : undefined;
}

/**
 * A resolved value as a one-line label.
 *
 * Not `JSON.stringify` for a string, because a card reading `"span offsets survive a rewrite"` with
 * the quotes showing is a card that looks like it is quoting a bug report rather than naming one.
 * Everything else is stringified, since an object with no rendering is better shown than hidden.
 */
function asLabel(value: JsonValue | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/**
 * Resolve a state's `label` against one run's inputs.
 *
 * `declared` is the state's authored label; `inputs` is what `instance.entered` recorded. Returns no
 * label at all when there is nothing to say, so the caller can fall back to listing inputs rather
 * than rendering an empty string that looks like a bug.
 */
export function resolveLabel(declared: unknown, inputs: Record<string, JsonValue> = {}): ResolvedLabel {
  if (typeof declared !== "string" || declared.trim().length === 0) return {};

  const source = declared.trim();
  let expr: Expr | undefined;
  try {
    expr = parseExpression(source);
  } catch {
    // Not expression syntax at all — `Spec the feature` is three tokens, not one. It is what it
    // says.
    return { label: declared };
  }

  // A quoted string is the explicit way to write a literal, and means the same as writing it bare.
  const literal = literalOf(expr);
  if (literal !== undefined) return { label: literal };

  // No leading dot ⇒ a literal, whatever it happened to parse as. This is the backward-compatible
  // half of the rule and the reason no existing `"label": "Planning"` had to change.
  if (!source.startsWith(".")) return { label: declared };

  const path = selfPathOf(expr);
  if (path === undefined) {
    return {
      issue: {
        kind: "unsupported",
        message: `label '${declared}' is richer than a path — only a literal or a reference like '.inputs.name' can title a run`,
      },
    };
  }

  // `.inputs.<name>`, and nothing else. The other scopes a binding can reach — `.children.*`,
  // `.outputs.*` — are not resolved when the run STARTS, and a label that only appears once the run
  // is over is a label the card cannot show while it is the one you are watching.
  if (path.length !== 2 || path[0] !== "inputs") {
    return {
      issue: {
        kind: "unsupported",
        message: `label '${declared}' must reference an input — '.${path.join(".")}' is not resolved when a run starts`,
      },
    };
  }

  const name = path[1]!;
  if (!(name in inputs)) {
    return { issue: { kind: "unknown-input", message: `label references input '${name}', which is not set` } };
  }
  return { label: asLabel(inputs[name]) ?? "" };
}

/**
 * The same check with no run to resolve against — what lint asks while a file is being edited.
 *
 * `declared` names an input that the STATE declares, rather than one a run happened to be given, so
 * a typo shows up in the tree instead of as an unlabelled card three states into a run.
 */
export function checkLabel(declared: unknown, declaredInputs: readonly string[]): LabelIssue | undefined {
  const probe = Object.fromEntries(declaredInputs.map((name) => [name, null as JsonValue]));
  return resolveLabel(declared, probe).issue;
}
