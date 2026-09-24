/**
 * The slot table — one editor for `inputs`, `outputs`, and an operation's `input`.
 *
 * All three are `Record<string, ParameterDecl>`, so all three get the same rows. See `slotForm` for
 * why sharing the shape also closes WORKFLOWS.md §4.3's "single most common silent failure".
 */
import type { JSX, ReactNode } from "react";
import {
  ANY_TYPE,
  DEFAULT_MEDIA_TYPE,
  OWNED_KEYWORDS,
  SLOT_TYPES,
  type SlotType,
  type SlotTypeName,
} from "@jaira/shared/browser";
import { NO_ISSUES, fieldClass, markFor, type FormIssues } from "./issues";
import { LinkInput, LinkToggle } from "./links";
import { LinkPreview } from "./linkPreview";
import { emptySlotRow, type SlotRow } from "./slotForm";
import { slotValueOf, useReadOnly, useRunReading } from "./reading";
import { ReadValue } from "./readValue";

/**
 * The type control on one slot row: the vocabulary, a `list of` toggle, and an artifact's media type.
 *
 * A schema the vocabulary does not cover is shown as a read-only summary instead. That is not a
 * fallback, it is the honest rendering — the alternative is a dropdown that can only round
 * `{"type":"object","properties":{…}}` down to "object" and delete the properties on the way.
 *
 * The `list of` toggle belongs to the row and not to the vocabulary, which is why it survives
 * LINKING. A named type is still a type: "a list of `$/types/plan`" is an ordinary thing to declare,
 * and the control that could say it about `text` refused to say it about a type from the library
 * that exists precisely so those declarations can be shared.
 */
export function SlotTypePicker({
  row,
  targets,
  mark = "",
  onChange,
  onLink,
}: {
  row: SlotRow;
  /** Link completions. Absent ⇒ this picker does not offer linking (an operation's `output`). */
  targets?: readonly string[];
  /** The lint class for this slot's TYPE — see `fieldClass`. Applied to whichever control shows it. */
  mark?: string;
  onChange: (type: SlotType) => void;
  /** Set or clear this slot's type reference. `null` unlinks. Absent ⇒ no link control. */
  onLink?: (ref: string | null) => void;
}): JSX.Element {
  const readOnly = useReadOnly();
  if (row.spread === true) {
    // A spread declares N slots, each keeping the child's own schema and optionality. There is no
    // one type here to pick.
    return (
      <span className={`slot-type-custom${mark}`} title="a spread — each slot keeps the child's own schema (§3.5)">
        per child
      </span>
    );
  }
  // A LINKED type: the named type's document decides the WHAT, so the vocabulary dropdown is
  // replaced rather than shown beside it claiming otherwise. `list` is not the vocabulary's — it is
  // the wrapper this row puts around whatever the type is — so it stays.
  //
  // Both branches, and the second one is a bug this used to have: a picker with no link control fell
  // THROUGH to the vocabulary, which showed `any` over a document that said
  // `"schema": "$/types/markdown"` and offered to overwrite it.
  if (row.typeRef !== undefined) {
    // The wrapper is the ROW's, not the referenced document's — see {@link SlotRow.typeRef}. Held
    // through the link so unlinking gives back a picker that says the same thing it did.
    const wrapped = row.type ?? ANY_TYPE;
    if (onLink === undefined) {
      return (
        <span className={`slot-type-custom${mark}`} title={`${row.typeRef} — a linked type; edit it on the JSON tab`}>
          🔗 {wrapped.list ? "list of " : ""}
          {row.typeRef}
        </span>
      );
    }
    return (
      <span className="slot-type linked">
        <LinkInput
          value={row.typeRef}
          targets={targets ?? []}
          placeholder="$/types/markdown"
          mark={mark}
          onChange={(ref) => onLink(ref)}
        />
        <label className="slot-opt" title="wrap the named type in an array — a list of these">
          <input
            type="checkbox"
            checked={wrapped.list}
            onChange={(e) => onChange({ ...wrapped, list: e.target.checked })}
          />
          list
        </label>
        <LinkToggle linked onToggle={() => onLink(null)} />
      </span>
    );
  }
  if (row.type === null) {
    return (
      <span className={`slot-type-custom${mark}`} title={`${row.schemaText} — edit it on the JSON tab`}>
        {summarizeSchema(row.schemaText)}
      </span>
    );
  }
  const type = row.type;
  // A reading says the type in words. The picker is three controls — a vocabulary, a `list of`
  // switch, a media type — which together answer one question, and at the width of a side panel they
  // answer it as `artifact ☐ list text/`. A sentence fits where a control row does not, and an
  // unticked switch is a fact the sentence simply does not mention.
  if (readOnly) {
    return (
      <span className={`slot-type-custom${mark}`} title={SLOT_TYPES.find((t) => t.name === type.name)?.hint}>
        {type.list ? "list of " : ""}
        {SLOT_TYPES.find((t) => t.name === type.name)?.label ?? type.name}
        {type.name === "artifact" && (type.mediaType ?? "").length > 0 ? ` · ${type.mediaType}` : ""}
      </span>
    );
  }
  return (
    <span className="slot-type">
      {/* The mark goes on the SELECT, which is the control that decides the schema — not on the
          span, which is three controls wide and would be the "whole thing" again. */}
      <select
        className={mark.trim()}
        value={type.name}
        title={SLOT_TYPES.find((t) => t.name === type.name)?.hint}
        onChange={(e) => {
          const name = e.target.value as SlotTypeName;
          // A media type is only meaningful on an artifact, and one has to be there or the slot is
          // not a blob at all — `contentMediaType` IS the derivation (`kindFor`).
          onChange({
            name,
            list: type.list,
            ...(name === "artifact" ? { mediaType: type.mediaType ?? DEFAULT_MEDIA_TYPE } : {}),
          });
        }}
      >
        {SLOT_TYPES.map((t) => (
          <option key={t.name} value={t.name}>
            {t.label}
          </option>
        ))}
      </select>
      <label className="slot-opt" title="wrap the type in an array — a list of these">
        <input type="checkbox" checked={type.list} onChange={(e) => onChange({ ...type, list: e.target.checked })} />
        list
      </label>
      {type.name === "artifact" ? (
        <input
          className="media-type"
          value={type.mediaType ?? ""}
          placeholder={DEFAULT_MEDIA_TYPE}
          spellCheck={false}
          title="the content's media type — what makes this slot a blob"
          onChange={(e) => onChange({ ...type, mediaType: e.target.value })}
        />
      ) : null}
      {/* A schema's reference is the BARE STRING — inside a schema, `$ref` is JSON Schema's own
          (WORKFLOWS.md §2.2). Which is why `"schema": "$/types/markdown"` read as "richer than the
          vocabulary" and could not be authored here at all before this. */}
      {onLink !== undefined ? <LinkToggle linked={false} onToggle={() => onLink("")} /> : null}
    </span>
  );
}

/** A one-glance label for a schema the picker does not model. The full document is the tooltip. */
function summarizeSchema(text: string): string {
  try {
    const schema = JSON.parse(text) as Record<string, unknown>;
    const type = typeof schema["type"] === "string" ? (schema["type"] as string) : "schema";
    const named = typeof schema["x-type"] === "string" ? ` ${schema["x-type"] as string}` : "";
    const extra = Object.keys(schema).filter((k) => !OWNED_KEYWORDS.includes(k));
    return `${type}${named}${extra.length > 0 ? ` +${extra.join(" +")}` : ""}`;
  } catch {
    return "schema";
  }
}

/**
 * One slot table — `inputs` or `outputs`.
 *
 * The first row of each slot is what changes most (name, type, binding); `default` and `description`
 * sit on a second row behind a disclosure, because a slot that needs neither should not pay two
 * empty boxes of screen for them. `default` is more than a convenience — it is the documented
 * opt-out from the §7.2 reachability rule, and so the one fix for a whole class of lint error.
 */
/**
 * What hangs under a slot row: its default, its description, and — in a reading — its value.
 *
 * A DISCLOSURE while the form is a form, because those are three things you fill in occasionally and
 * a table of open boxes is a table nobody can scan. Not a disclosure in a reading: the value is the
 * one fact somebody opened the panel for, and putting it behind a twisty makes them click for it
 * once per slot. Nothing at all when a reading has none of the three, which is most slots on most
 * states.
 */
/** A control with its name over it in a reading, and bare in a form — see the call site. */
function Boxed({ readOnly, label, children }: { readOnly: boolean; label: string; children: ReactNode }): JSX.Element {
  return readOnly ? (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  ) : (
    <>{children}</>
  );
}

function SlotMore({
  readOnly,
  hasDefault,
  hasDescription,
  value,
  children,
}: {
  readOnly: boolean;
  hasDefault: boolean;
  hasDescription: boolean;
  /** The recorded value, only to decide whether there is anything to show. */
  value: unknown;
  children: ReactNode;
}): JSX.Element | null {
  if (!readOnly) {
    return (
      <details className="slot-more" open={hasDefault || hasDescription}>
        <summary>default &amp; description</summary>
        {children}
      </details>
    );
  }
  if (!hasDefault && !hasDescription && value === undefined) return null;
  return <div className="slot-more open">{children}</div>;
}

export function SlotTable({
  title,
  rows,
  optional = false,
  bindingHint,
  targets,
  bindingListId,
  emptyBindingMeans,
  path,
  issues = NO_ISSUES,
  onChange,
}: {
  title: string;
  rows: SlotRow[];
  /** Show the `optional` checkbox. Only meaningful for inputs — an output is not "required". */
  optional?: boolean;
  bindingHint: string;
  /** Link completions for a slot's type reference. */
  targets: readonly string[];
  /** The datalist of runtime paths a binding may name — see `bindingTargets`. */
  bindingListId?: string;
  /**
   * What an EMPTY binding means in this table, when it means something.
   *
   * Outputs only, and it is not decoration (WORKFLOWS.md §3.3): an output with a binding is
   * *derived*, one without is *produced* — the operation returns it — and "there is no third case".
   * So the empty box is the answer to "bind this to the operation's result", and it read as an
   * unfilled field instead, with a placeholder suggesting a child path was wanted.
   */
  emptyBindingMeans?: string;
  /**
   * What this table is called in a lint path — `inputs`, `outputs`, `operation.input`.
   *
   * The rows below it answer for `<path>.<name>`, which is exactly how the linter names a slot, so a
   * diagnostic on `outputs.report` marks and reveals the row for `report`. Absent ⇒ the table is not
   * part of a linted document and nothing is marked.
   */
  path?: string;
  /** This state's diagnostics — see `issues`. */
  issues?: FormIssues;
  onChange: (rows: SlotRow[]) => void;
}): JSX.Element | null {
  // A reading of a run rather than an editor over a file — see `reading.ts`. Both are false and null
  // in the Files view, where this table is exactly what it always was.
  const readOnly = useReadOnly();
  const reading = useRunReading();
  const edit = (index: number, patch: Partial<SlotRow>): void =>
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  /** True when this row's empty binding is a MEANING rather than a blank — see `emptyBindingMeans`. */
  const produced = (row: SlotRow): boolean =>
    emptyBindingMeans !== undefined && row.structured !== true && row.binding.trim().length === 0;

  /** A row's lint path, or `undefined` when this table is not part of a linted document. */
  const pathOf = (row: SlotRow): string | undefined =>
    path === undefined || row.name.trim().length === 0 ? undefined : `${path}.${row.name.trim()}`;

  /** Linking is presence of `typeRef`, so unlinking has to DELETE the key, not blank it. */
  const link = (index: number, ref: string | null): void =>
    onChange(
      rows.map((row, i) => {
        if (i !== index) return row;
        if (ref === null) {
          const { typeRef: _dropped, ...rest } = row;
          return rest;
        }
        return { ...row, typeRef: ref };
      }),
    );
  // A table with nothing in it, in a reading, is a heading over the word "none". The form needs it —
  // that is where you add the first row — and a reading of a state that declares no operation inputs
  // is better off not mentioning operation inputs.
  if (readOnly && rows.length === 0) return null;
  return (
    <div {...(path === undefined ? { className: "slots" } : markFor(issues, path, "slots"))}>
      <div className="slots-head">
        <span>{title}</span>
        {readOnly ? null : (
          <button type="button" className="ghost sm" onClick={() => onChange([...rows, emptySlotRow()])}>
            + Add
          </button>
        )}
      </div>
      {rows.length === 0 ? (
        <div className="sub">none declared</div>
      ) : (
        <>
          {/* Column headers. Three text boxes in a row look interchangeable, and the middle one is a
              TYPE while the third decides where the value comes from — the difference that matters
              most here was the one the row did not state. */}
          <div className={`slot-row slot-head${optional ? " with-optional" : ""}`}>
            <span>Name</span>
            <span>Type</span>
            <span>{emptyBindingMeans === undefined ? "Binding — where the value comes from" : `Binding — empty means ${emptyBindingMeans}`}</span>
            {optional ? <span /> : null}
            {readOnly ? null : <span />}
          </div>
          {rows.map((row, i) => {
          const rowPath = pathOf(row);
          // Which BOX is wrong. A slot's own diagnostics are binding checks — `checkBinding` reports
          // them at the slot's path — so they belong to the binding box; `<slot>.kind` is the type
          // picker's, and is excluded from the binding box's share.
          const typeMark = rowPath === undefined ? "" : fieldClass(issues, `${rowPath}.kind`);
          const bindingMark = rowPath === undefined ? "" : fieldClass(issues, rowPath, [`${rowPath}.kind`]);
          return (
          <div className="slot-group" key={i}>
            <div
              {...(rowPath === undefined
                ? { className: `slot-row${optional ? " with-optional" : ""}` }
                : markFor(issues, rowPath, `slot-row${optional ? " with-optional" : ""}`))}
            >
              <input
                value={row.name}
                placeholder={optional ? "name" : "name, or prefix* to spread a child"}
                spellCheck={false}
                title={row.spread === true ? "a spread: republishes every output of the bound child, prefixed" : undefined}
                onChange={(e) => edit(i, { name: e.target.value })}
              />
              <SlotTypePicker
                row={row}
                targets={targets}
                mark={typeMark}
                onChange={(type) => edit(i, { type })}
                onLink={(ref) => link(i, ref)}
              />
              <input
                className={`${produced(row) ? "binding-produced" : ""}${bindingMark}`}
                value={row.binding}
                list={bindingListId}
                // The empty box IS the answer where one exists, so it says so rather than showing an
                // example of the other case and looking unfilled.
                // A slot's DEFAULT is what an empty binding means (the panel rulings, 2026-09-24), so it
                // is what the empty box says: `significant`, not an example of some other binding.
                placeholder={produced(row) ? emptyBindingMeans! : row.default.length > 0 ? `default: ${row.default}` : bindingHint}
                spellCheck={false}
                disabled={row.structured === true}
                title={
                  row.structured === true
                    ? "a computed binding — edit it on the JSON tab"
                    : produced(row)
                      ? "§3.3: an output with a binding is derived, one without is produced — there is no third case"
                      : undefined
                }
                onChange={(e) => edit(i, { binding: e.target.value })}
              />
              {optional ? (
                readOnly ? (
                  // Said, not switched — and only when it is true. An empty checkbox labelled `opt`
                  // beside every required slot is a column of boxes reporting that nothing was
                  // ticked. SPEC §4.1: a slot is required unless it says otherwise, so the reading
                  // says the otherwise.
                  <span className="slot-opt sub">{row.optional ? "optional" : ""}</span>
                ) : (
                  <label className="slot-opt" title="SPEC §4.1: a slot is required unless it says otherwise">
                    <input
                      type="checkbox"
                      checked={row.optional}
                      onChange={(e) => edit(i, { optional: e.target.checked })}
                    />
                    opt
                  </label>
                )
              ) : null}
              {readOnly ? null : (
                <button
                  type="button"
                  className="ghost sm"
                  title="remove"
                  onClick={() => onChange(rows.filter((_, j) => j !== i))}
                >
                  ✕
                </button>
              )}
            </div>
            <SlotMore
              readOnly={readOnly}
              hasDefault={row.default.length > 0}
              hasDescription={row.description.length > 0}
              value={slotValueOf(reading, path, row.name, row.binding)}
            >
              <div className="row-controls">
                {/* What this slot actually held, beside what it declares — see `readValue.tsx`. */}
                <ReadValue value={slotValueOf(reading, path, row.name, row.binding)} />
                {/* Labelled in a reading, bare in the form. A form's boxes are told apart by their
                    placeholders, and a placeholder is the one thing a filled box does not show — so
                    a reading of a slot with a default of `3` beside a value of `3` was two identical
                    numbers, one of them unexplained. */}
                {readOnly && row.default.length === 0 ? null : (
                  <Boxed readOnly={readOnly} label="default">
                    <input
                      value={row.default}
                      placeholder="default — also the opt-out from the reachability rule"
                      spellCheck={false}
                      title="JSON, or plain text for a string: significant, 3, [&quot;a&quot;]"
                      onChange={(e) => edit(i, { default: e.target.value })}
                    />
                  </Boxed>
                )}
                {readOnly && row.description.length === 0 ? null : (
                  <Boxed readOnly={readOnly} label="description">
                    <input
                      value={row.description}
                      placeholder="description"
                      onChange={(e) => edit(i, { description: e.target.value })}
                    />
                  </Boxed>
                )}
              </div>
            </SlotMore>
            {/* A linked TYPE is the same trade as a linked prompt: the schema moved to another file
                and this row shows its path. So it shows what that file says, too. */}
            {row.typeRef !== undefined && row.typeRef.length > 0 ? <LinkPreview reference={row.typeRef} /> : null}
          </div>
          );
          })}
        </>
      )}
    </div>
  );
}

