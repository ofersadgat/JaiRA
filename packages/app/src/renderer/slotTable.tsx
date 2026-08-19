/**
 * The slot table — one editor for `inputs`, `outputs`, and an operation's `input`.
 *
 * All three are `Record<string, ParameterDecl>`, so all three get the same rows. See `slotForm` for
 * why sharing the shape also closes WORKFLOWS.md §4.3's "single most common silent failure".
 */
import type { JSX } from "react";
import {
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

/**
 * The type control on one slot row: the vocabulary, a `list of` toggle, and an artifact's media type.
 *
 * A schema the vocabulary does not cover is shown as a read-only summary instead. That is not a
 * fallback, it is the honest rendering — the alternative is a dropdown that can only round
 * `{"type":"object","properties":{…}}` down to "object" and delete the properties on the way.
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
  if (row.spread === true) {
    // A spread declares N slots, each keeping the child's own schema and optionality. There is no
    // one type here to pick.
    return (
      <span className={`slot-type-custom${mark}`} title="a spread — each slot keeps the child's own schema (§3.5)">
        per child
      </span>
    );
  }
  // A LINKED type: the named type's document decides the schema, so the vocabulary picker has
  // nothing to say and is replaced rather than shown beside it claiming otherwise.
  //
  // Both branches, and the second one is a bug this used to have: a picker with no link control fell
  // THROUGH to the vocabulary, which showed `any` with `list` unchecked over a document that said
  // `"schema": "$/types/markdown"`. Every control on it was dead — `applySlotType` writes the
  // reference and returns before it reads a thing the picker holds — so checking `list` there
  // toggled a checkbox and changed nothing in the file.
  if (row.typeRef !== undefined) {
    if (onLink === undefined) {
      return (
        <span className={`slot-type-custom${mark}`} title={`${row.typeRef} — a linked type; edit it on the JSON tab`}>
          🔗 {row.typeRef}
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
}): JSX.Element {
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
  return (
    <div {...(path === undefined ? { className: "slots" } : markFor(issues, path, "slots"))}>
      <div className="slots-head">
        <span>{title}</span>
        <button type="button" className="ghost sm" onClick={() => onChange([...rows, emptySlotRow()])}>
          + Add
        </button>
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
            <span />
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
                placeholder={produced(row) ? emptyBindingMeans! : bindingHint}
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
                <label className="slot-opt" title="SPEC §4.1: a slot is required unless it says otherwise">
                  <input
                    type="checkbox"
                    checked={row.optional}
                    onChange={(e) => edit(i, { optional: e.target.checked })}
                  />
                  opt
                </label>
              ) : null}
              <button
                type="button"
                className="ghost sm"
                title="remove"
                onClick={() => onChange(rows.filter((_, j) => j !== i))}
              >
                ✕
              </button>
            </div>
            <details className="slot-more" open={row.default.length > 0 || row.description.length > 0}>
              <summary>default &amp; description</summary>
              <div className="row-controls">
                <input
                  value={row.default}
                  placeholder="default — also the opt-out from the reachability rule"
                  spellCheck={false}
                  title="JSON, or plain text for a string: significant, 3, [&quot;a&quot;]"
                  onChange={(e) => edit(i, { default: e.target.value })}
                />
                <input
                  value={row.description}
                  placeholder="description"
                  onChange={(e) => edit(i, { description: e.target.value })}
                />
              </div>
            </details>
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

