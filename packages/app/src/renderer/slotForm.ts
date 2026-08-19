/**
 * One declared slot, in and out — the shape three different places in a state file share.
 *
 * A state's `inputs`, a state's `outputs`, and an operation's `input` are all
 * `Record<string, ParameterDecl>`; an operation's `output` is a single `NamedParameterDecl`, which
 * is the same thing with a `name`. One model for all four, because they ARE one shape, and because
 * the alternative is four editors and three of them missing whatever the fourth learned.
 *
 * Sharing it also happens to close WORKFLOWS.md §4.3, "the single most common silent failure":
 *
 * ```jsonc
 * "input": { "prompt": ".inputs.instruction" }              // ✗ a parameter with NO binding
 * "input": { "prompt": { "binding": ".inputs.instruction" } } // ✓
 * ```
 *
 * The first spelling loads as a slot that resolves to empty — the agent runs with no instruction and
 * the state reports success. A row with a separate binding column cannot produce it.
 */
import {
  ANY_TYPE,
  readRef,
  sameSchema,
  schemaForSlotType,
  slotTypeOf,
  writeRef,
  type SlotType,
} from "@jaira/shared/browser";
import { jsonTextOf, jsonValueOf } from "./jsonText";

/** One row of a slot table. */
export interface SlotRow {
  name: string;
  /**
   * The slot's TYPE, read from its `schema`.
   *
   * `null` means the schema is richer than the picker's vocabulary — it has `properties`, an `enum`,
   * a bound, a type name from elsewhere. The row then shows it read-only and writes nothing, for the
   * same reason a structured binding is read-only: a control that can only round the value down is a
   * control that deletes the parts it could not show.
   */
  type: SlotType | null;
  /** The schema as written, when {@link type} is `null` — for the read-only display. */
  schemaText: string;
  /**
   * Set when the schema is a LINK to a named type: `"schema": "$/types/markdown"`.
   *
   * The BARE STRING only. Inside a schema, `$ref` is always JSON Schema's own (WORKFLOWS.md §2.2),
   * so `{"$ref": "#/$defs/plan"}` here is not a document reference and must not be rewritten as one
   * — which is what the `schema` position in `references.ts` exists to say.
   *
   * It needed a control of its own rather than falling into `schemaText`: a string there reads as
   * "richer than the vocabulary" to {@link slotTypeOf}, so the row showed it read-only and there was
   * no way to author one, even though a shared type library is the whole point of `$/types/`.
   *
   * Presence is the link; the value may be empty while it is being typed. Held beside `type` rather
   * than instead of it so that unlinking restores whatever the picker last had, the same
   * non-destructive toggle the operation form's links use.
   *
   * A LIST of a named type is `{"type": "array", "items": "$/types/plan"}` — `items` is one of
   * the keywords the expander recurses into, so a bare-string reference there is ours in exactly
   * the way it is at the top of a `schema`. `type.list` carries the wrapper while this carries the
   * target, which is why the two are held side by side rather than one replacing the other.
   */
  typeRef?: string;
  /** Inputs only: SPEC §4.1 makes a slot required unless it says otherwise. */
  optional: boolean;
  /** Where the value comes from. Kept as text — it is a reference, not a value. */
  binding: string;
  /**
   * Authoring convenience for a free slot, and the explicit opt-out from the §7.2 REACHABILITY rule:
   * a reference to a producer not provably run on every path is an error, and a default is how an
   * author says "that is fine, here is what to use instead". Held as JSON text — see `jsonText`.
   */
  default: string;
  /** SPEC §4.1 also treats a slot with a `default` as satisfied, so the two are shown together. */
  description: string;
  /**
   * True when the KEY ends in `*` — an output spread (§3.5), which republishes every output of the
   * bound child as a prefixed slot of this state.
   *
   * A spread declares N slots rather than one, and each keeps the child's own schema and
   * optionality. So the type picker means nothing on this row and is hidden rather than shown
   * offering to overwrite schemas it does not own.
   */
  spread?: boolean;
  /**
   * True when the binding is a STRUCTURED form (`{ expr }`, `{ text }`) rather than a plain path.
   *
   * The row cannot represent one, so it shows it read-only instead of as an empty box. An empty box
   * invites typing, and typing would replace a computed expression with a literal path — silently,
   * and with no way to tell from the form that anything was lost.
   */
  structured?: boolean;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * A schema that is a LINK, in either of its two spellings: the bare reference, or an array wrapping
 * one. Anything else — including an array of an inline schema — is not this and is read elsewhere.
 */
function linkedSchemaOf(schema: unknown): { ref: string; list: boolean } | undefined {
  const direct = readRef(schema, "schema");
  if (direct !== undefined) return { ref: direct, list: false };
  const wrapper = asRecord(schema);
  if (wrapper["type"] !== "array") return undefined;
  // Only `items` may accompany it, for the same reason `slotTypeOf` insists on that: a tuple form or
  // a bound is a schema this row cannot round-trip, and showing it as "a list of X" would drop it.
  if (Object.keys(wrapper).some((key) => key !== "type" && key !== "items")) return undefined;
  const items = readRef(wrapper["items"], "schema");
  return items === undefined ? undefined : { ref: items, list: true };
}

/** Read one declaration into a row. `name` is the map key, or an authored `name` for an output. */
export function slotRowOf(name: string, raw: unknown): SlotRow {
  const decl = asRecord(raw);
  const binding = decl["binding"];
  const linked = linkedSchemaOf(decl["schema"]);
  // A linked type has no vocabulary type — the referenced document decides. `ANY_TYPE` is what the
  // picker falls back to when the link is removed, which is the least surprising thing to reveal;
  // its `list` flag is NOT a fallback, it is the wrapper the schema actually carries.
  const type = linked === undefined ? slotTypeOf(decl["schema"]) : { ...ANY_TYPE, list: linked.list };
  return {
    name,
    type,
    schemaText: type === null ? JSON.stringify(decl["schema"]) : "",
    ...(linked !== undefined ? { typeRef: linked.ref } : {}),
    optional: decl["optional"] === true,
    binding: typeof binding === "string" ? binding : binding === undefined ? "" : JSON.stringify(binding),
    default: jsonTextOf(decl["default"]),
    description: typeof decl["description"] === "string" ? decl["description"] : "",
    ...(name.endsWith("*") ? { spread: true } : {}),
    ...(binding !== undefined && typeof binding !== "string" ? { structured: true } : {}),
  };
}

/** Read one `inputs`/`outputs`/`input` map into rows, in declaration order. */
export function slotsOf(map: unknown): SlotRow[] {
  return Object.entries(asRecord(map)).map(([name, raw]) => slotRowOf(name, raw));
}

/** A blank row, as "+ Add" produces it — untyped until someone says otherwise. */
export function emptySlotRow(): SlotRow {
  return { name: "", type: ANY_TYPE, schemaText: "", optional: false, binding: "", default: "", description: "" };
}

/**
 * Write a row's type onto its declaration — or leave the declaration entirely alone.
 *
 * Three cases, and the middle one is the one that matters:
 *
 *  - **outside the vocabulary** (`type === null`) — the row rendered the schema read-only, so nothing
 *    is written. A `properties` block survives being looked at.
 *  - **unchanged** — the schema the row would write is the schema already there, so neither `schema`
 *    NOR `kind` is touched. This is what lets a file that authored `kind` explicitly round-trip
 *    byte-for-byte instead of being "corrected" on the way past.
 *  - **changed** — the new schema is written and any authored `kind` is DELETED, because `kindFor`
 *    derives it and a stale `kind: "blob"` sitting next to a fresh `{"type":"string"}` is not a
 *    leftover, it is a lie. Deleting it is how the slot gets the right transport tag.
 */
function applySlotType(decl: Record<string, unknown>, row: SlotRow): void {
  // A SPREAD declares N slots, each keeping the child's own schema. There is no one schema here to
  // write, so the row does not offer to write one.
  if (row.spread === true) return;
  if (row.typeRef !== undefined) {
    // A LINKED type. Object position, so the reference is the bare string — and `kind` goes with it
    // for the same reason a changed schema drops it: the referenced document decides the transport
    // tag, and a stale one beside it is a lie rather than a leftover.
    const ref = row.typeRef.trim();
    if (ref.length === 0) {
      // Nothing named yet. The previous schema is left alone rather than replaced with an empty
      // reference, which is what every other half-typed control in this form does.
      return;
    }
    const named = writeRef(ref, "schema");
    // `list` applies to a named type as much as to a vocabulary one — "three plans" is a shape the
    // picker could say in one half of its own control and not in the other.
    decl["schema"] = row.type?.list === true ? { type: "array", items: named } : named;
    delete decl["kind"];
    return;
  }
  // Unlinked: a `schema` this form put there as a reference is one it may take away.
  if (typeof decl["schema"] === "string") delete decl["schema"];
  if (row.type === null) return;
  const next = schemaForSlotType(row.type);
  if (sameSchema(decl["schema"], next)) return;
  if (next === undefined) delete decl["schema"];
  else decl["schema"] = next;
  delete decl["kind"];
}

/** Fold one row onto the declaration it came from, keeping every field the row does not model. */
export function applySlotRow(previous: unknown, row: SlotRow, includeOptional: boolean): Record<string, unknown> {
  const decl: Record<string, unknown> = { ...asRecord(previous) };
  applySlotType(decl, row);
  if (includeOptional && row.optional) decl["optional"] = true;
  else delete decl["optional"];
  const fallback = jsonValueOf(row.default);
  if (fallback === undefined) delete decl["default"];
  else decl["default"] = fallback;
  if (row.description.trim().length > 0) decl["description"] = row.description.trim();
  else delete decl["description"];
  if (row.structured === true) {
    // Left exactly as it was: the row rendered it read-only, so there is nothing to write back.
  } else if (row.binding.trim().length > 0) decl["binding"] = row.binding.trim();
  else if (typeof decl["binding"] === "string") delete decl["binding"];
  return decl;
}

/**
 * Fold one slot table back into its map, keeping every field the rows do not model.
 *
 * A slot may carry an `index` or a structured binding beyond what a row shows, so each surviving
 * name is merged onto whatever was there before. Renaming a slot keeps its other fields, which is
 * what makes fixing a typo in a name safe.
 */
export function applySlots(
  previous: unknown,
  rows: SlotRow[],
  includeOptional: boolean,
): Record<string, unknown> | undefined {
  const before = asRecord(previous);
  const after: Record<string, unknown> = {};
  // Named rows only, and indexed among THEMSELVES: a half-typed row is not written, so counting it
  // would shift every positional lookup after it onto the wrong declaration.
  rows
    .filter((row) => row.name.trim().length > 0)
    .forEach((row, index) => {
      const name = row.name.trim();
      // Positional carry-over: a renamed row keeps the declaration it had, so `schema` and friends
      // follow the slot rather than being lost the moment its name changes.
      after[name] = applySlotRow(before[name] ?? Object.values(before)[index], row, includeOptional);
    });
  return Object.keys(after).length > 0 ? after : undefined;
}
