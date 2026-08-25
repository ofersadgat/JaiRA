/**
 * The value a binding actually produced, shown in the row that declares it.
 *
 * The form has always answered "where does this come from" and never "what came". Those are the two
 * halves of reading a run: the binding is the rule, and this is the one time it was applied. A state
 * that terminated with an empty document is a state whose `plan_doc` input was `""`, and until this
 * the only place that fact existed was the journal.
 *
 * ## The form's own furniture, not a control of its own
 *
 * It is a labelled field beside `default` and `description`, in the same block, drawn the same way —
 * because it is the same KIND of thing: something this slot is, written under the row that names it.
 * It had a fold and a `=` marker of its own for a while, which made the one fact somebody opened the
 * panel to read the one fact they had to click for.
 *
 * Absent — not empty, not a dash — when there is no value: a form over a state FILE has no run
 * behind it, and a derived output's value is an expression over children this cannot evaluate (see
 * `slotValueOf`). Both are "nothing to say here", and a blank box would say the opposite.
 */
import type { JSX } from "react";
import type { JsonValue } from "@declarative-ai/json";

/**
 * A value as the box under a slot shows it.
 *
 * A string is itself — prose in quotes is prose nobody can read — and everything else is JSON, which
 * is what it is.
 */
function textOf(value: JsonValue): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

export function ReadValue({ value }: { value: JsonValue | undefined }): JSX.Element | null {
  if (value === undefined) return null;
  return (
    <div className="field run-value">
      <span>value</span>
      {/*
        A block of text, not a `textarea`.
        It was one, on the reasoning that the form's other boxes are — and it brought all of a
        textarea's furniture with it: a row count that clipped a paragraph to two lines, a scrollbar
        over the clipping, and a resize grabber in the corner of something nobody can resize into
        more content. None of that is what a value is. This grows to what it holds, wraps where the
        column ends, and scrolls only when the thing itself is genuinely long.
      */}
      <div className="value-box mono">{textOf(value)}</div>
    </div>
  );
}
