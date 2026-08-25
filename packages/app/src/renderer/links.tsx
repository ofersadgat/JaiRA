/**
 * The control that turns an authored value into a document reference, and back.
 *
 * Three places in a state file hold a link and each spells it differently — a prompt takes
 * `{"$ref": …}`, an `operation` and a `schema` take the bare string (WORKFLOWS.md §2.2). That
 * asymmetry is `references.ts`'s problem, not this file's: by the time a control is rendered the
 * form already holds a link as "the target, or nothing", so all three look the same on screen.
 *
 * And they should. The previous state of affairs was a form that RECOMMENDED a link in its own hint
 * text — "a reusable prompt is a $ref to a .md file" — while rendering every reference disabled with
 * "edit it on the JSON tab". The advice and the affordance disagreed, and the JSON tab won.
 *
 * ## Toggling is not destructive
 *
 * A linked field keeps whatever its literal control held, and vice versa (see `RefFields`). So the
 * toggle is safe to press to find out what it does — which matters more than usual here, because
 * what it does is replace a six-line prompt with a one-line path.
 */
import type { JSX } from "react";
import { useReadOnly } from "./reading";
import { isKnownRef } from "./completions";

/**
 * The datalist every link control completes against.
 *
 * One list for the whole editor rather than one per control: a state form renders a link control per
 * linkable field, per slot row and once for the operation, and a datalist id has to be unique.
 */
export const LINK_TARGETS_ID = "link-targets";

export function LinkTargets({ targets }: { targets: string[] }): JSX.Element {
  return (
    <datalist id={LINK_TARGETS_ID}>
      {targets.map((ref) => (
        <option key={ref} value={ref} />
      ))}
    </datalist>
  );
}

/**
 * The link/unlink toggle.
 *
 * Deliberately a chain glyph and the word, not an icon alone: "link" here means a specific thing
 * from the format — templating, a splice, not a live pointer — and a bare icon in a form full of
 * other icons would be read as "attach a file".
 */
export function LinkToggle({
  linked,
  disabled,
  onToggle,
}: {
  linked: boolean;
  /** True when the value is a shape the form shows read-only — there is nothing to toggle. */
  disabled?: boolean;
  onToggle: (linked: boolean) => void;
}): JSX.Element | null {
  // Linking MOVES a value into a file — an edit, and one of the larger ones the form makes. There is
  // nothing for it to do in a reading, where the value is already wherever it is.
  if (useReadOnly()) return null;
  return (
    <button
      type="button"
      className={`ghost sm link-toggle${linked ? " on" : ""}`}
      disabled={disabled === true}
      title={
        linked
          ? "hold this value inline instead of in a file — what you had before linking comes back"
          : "hold this value in a file and reference it (WORKFLOWS.md §2.2)"
      }
      onClick={() => onToggle(!linked)}
    >
      🔗 {linked ? "Linked" : "Link"}
    </button>
  );
}

/**
 * The box a linked value shows instead of its own control.
 *
 * The unresolved note is advisory and says so. A reference is written whatever this thinks of it —
 * that is the point, since the alternative is a picker that cannot name a file you are about to
 * create — and the linter, which can actually probe the search path, has the final word.
 */
export function LinkInput({
  value,
  targets,
  placeholder,
  mark = "",
  onChange,
}: {
  value: string;
  /** Every reference the tree can offer, for the unresolved check. See {@link isKnownRef}. */
  targets: readonly string[];
  placeholder?: string;
  /** The lint class for the field this link holds — see `fieldClass`. */
  mark?: string;
  onChange: (value: string) => void;
}): JSX.Element {
  const unresolved = value.trim().length > 0 && !isKnownRef(value, targets);
  return (
    <>
      <input
        className={`link-input${unresolved ? " unresolved" : ""}${mark}`}
        list={LINK_TARGETS_ID}
        value={value}
        spellCheck={false}
        placeholder={placeholder ?? "$/prompts/feature_goals.md"}
        onChange={(e) => onChange(e.target.value)}
      />
      {unresolved ? (
        <span className="sub warn">no file here yet — the linter will call this unresolved</span>
      ) : null}
    </>
  );
}
