/**
 * The generic recursive renderer. Ported from findmyprompt's `schemaForm/SchemaForm.tsx`.
 *
 * Resolution per node, in order:
 *
 *  1. a `$type` registry hit renders with that dedicated widget, which owns its own labels and layout;
 *  2. an object/class flattens `allOf` and recurses over `properties`;
 *  3. an array renders its items as rows, each recursing;
 *  4. a primitive maps to a number / enum / boolean / text control.
 *
 * Labels and tooltips come from the presentation map (resolved against the IMMEDIATE container's
 * `$type`), never from the renderer. What differs from the original is only the styling seam: this
 * one emits JaiRA's `Field`/`FieldGrid` classes instead of inline styles, because the app has two
 * themes and an inline `#fff` is a light-mode assumption dark mode cannot override.
 *
 * The property this earns is the one that matters: a step that gains a field in
 * `@jaira/shared`'s `executorStack.ts` gains a control here, with its label, its hint and its
 * validation, without anyone editing a form.
 */
import type { JSX } from "react";
import { Field, FieldGrid, NumInput, SelectInput, TextInput } from "../controls";
import { presentationFor } from "./presentation";
import { widgetFor } from "./registry";
import type { Schema, SchemaFormContext } from "./types";

function isObjectSchema(s: Schema): boolean {
  return s["type"] === "object" || s["properties"] !== undefined || s["allOf"] !== undefined;
}

function isArraySchema(s: Schema): boolean {
  return s["type"] === "array" || s["items"] !== undefined;
}

/**
 * Follow a local `$ref` to the node the document declares it as.
 *
 * Ported code renders schemas somebody wrote FOR a form — flat objects of scalars, with every shape
 * spelled out where it is used. The schemas in `shared/schemas.ts` are not those: they are written
 * for an editor's completion and for validation, so a shape used twice is declared once under
 * `definitions` and referred to. Three hundred `$ref`s in the state schema alone, and without this
 * every one of them was an object with no properties — which the form drew as a heading with
 * nothing under it.
 *
 * Local pointers only (`#/definitions/x`, `#/$defs/x`). A `$ref` to another document is a fetch, and
 * a form that quietly fetched would be a form that renders differently depending on the network.
 * Anything it cannot follow comes back unchanged, which is the same "draw what you can" this whole
 * renderer is built on.
 *
 * Siblings beside the `$ref` WIN, which is 2019-09's rule and also the useful one: a member written
 * `{$ref: "#/definitions/slot", description: "the issue to work"}` means the shared shape with that
 * description, and a reader is owed the one written at the point of use.
 */
function deref(schema: Schema, root: Schema | undefined, depth = 0): Schema {
  const ref = schema["$ref"];
  // Eight is far past anything real and stops a document that refers to itself from hanging the
  // renderer — a cycle is a bug in the schema, not a reason for the window to stop responding.
  if (typeof ref !== "string" || root === undefined || depth > 8 || !ref.startsWith("#/")) return schema;
  let at: unknown = root;
  for (const step of ref.slice(2).split("/")) {
    const key = decodeURIComponent(step).replace(/~1/g, "/").replace(/~0/g, "~");
    if (at === null || typeof at !== "object") return schema;
    at = (at as Record<string, unknown>)[key];
  }
  if (at === null || typeof at !== "object" || Array.isArray(at)) return schema;
  const rest = Object.fromEntries(Object.entries(schema).filter(([key]) => key !== "$ref"));
  return deref({ ...(at as Schema), ...rest }, root, depth + 1);
}

/**
 * The schema every OTHER key of a map answers to, when the document declares one.
 *
 * `additionalProperties: true` and `false` are not schemas and mean the opposite things about
 * whether extra keys are allowed; neither says what one would LOOK like, so neither produces fields.
 */
function mapSchema(schema: Schema, root: Schema | undefined): Schema | undefined {
  const extra = schema["additionalProperties"];
  if (extra === null || typeof extra !== "object" || Array.isArray(extra)) return undefined;
  return deref(extra as Schema, root);
}

/**
 * A branch of an `anyOf`/`oneOf`, chosen by what the value ALREADY is.
 *
 * The alternative — a discriminator control, "is this a string or an object?" — asks the reader
 * about a distinction the format has deliberately made invisible: a `choose_option` option may be
 * written as a bare string or as a labelled object, and both are the same option. So the value
 * decides, an absent value takes the first branch (the spelling the schema puts first is the one it
 * recommends), and nothing here can silently retype a value the author wrote the other way.
 */
function variantFor(schema: Schema, value: unknown): Schema {
  const branches = (schema["anyOf"] ?? schema["oneOf"]) as Schema[] | undefined;
  if (branches === undefined || branches.length === 0) return schema;
  const actual =
    value === null || value === undefined
      ? undefined
      : Array.isArray(value)
        ? "array"
        : typeof value === "object"
          ? "object"
          : typeof value;
  const hit =
    actual === undefined
      ? undefined
      : branches.find((b) => {
          if (actual === "array") return isArraySchema(b);
          if (actual === "object") return isObjectSchema(b);
          return b["type"] === actual;
        });
  return hit ?? branches[0]!;
}

/** What a newly added array item starts as — empty of content, right in shape. */
function seedFor(schema: Schema): unknown {
  const variant = variantFor(schema, undefined);
  if (isArraySchema(variant)) return [];
  if (isObjectSchema(variant)) return {};
  if (variant["type"] === "boolean") return false;
  if (variant["type"] === "number") return 0;
  if (Array.isArray(variant["enum"])) return (variant["enum"] as string[])[0] ?? "";
  return "";
}

/**
 * Merge `allOf` (inlined object schemas) + own `properties` — base first, own overrides — while
 * tracking the `$type` that DECLARED each member, so a base-defined member resolves its presentation
 * under that base (define-once) rather than under the flattened leaf type.
 */
function flatten(
  schema: Schema,
  declaringType?: string,
  root?: Schema,
): { properties: Record<string, Schema>; declaredBy: Record<string, string | undefined> } {
  const myType = (schema["$type"] as string | undefined) ?? declaringType;
  let properties: Record<string, Schema> = {};
  let declaredBy: Record<string, string | undefined> = {};
  // A base written as `{$ref: …}` is the ordinary way to say "and everything that one has", so the
  // members it contributes have to be found before they can be flattened in.
  for (const member of (schema["allOf"] as Schema[] | undefined) ?? []) {
    const f = flatten(deref(member, root), undefined, root);
    properties = { ...properties, ...f.properties };
    declaredBy = { ...declaredBy, ...f.declaredBy };
  }
  for (const [key, sub] of Object.entries((schema["properties"] as Record<string, Schema> | undefined) ?? {})) {
    properties[key] = sub;
    declaredBy[key] = myType;
  }
  return { properties, declaredBy };
}

export function SchemaForm({
  schema: declared,
  value,
  onChange,
  ctx,
  containerType,
}: {
  schema: Schema;
  value: unknown;
  onChange: (v: unknown) => void;
  ctx: SchemaFormContext;
  /** The `$type` of the schema declaring THIS node, for presentation lookup of its members. */
  containerType?: string;
}): JSX.Element {
  /**
   * The document, for following a `$ref` — this node's own schema at the top, the context's below.
   *
   * The top-level caller passes a whole document and no root, so the schema it hands over IS the
   * root; every recursion carries it down on the context. That is why nothing else in this file had
   * to change to gain reference resolution.
   */
  const root = ctx.root ?? declared;
  /**
   * A reference already expanded on the way here — see {@link SchemaFormContext.refs}.
   *
   * Drawn as NOTHING rather than as an unresolved node, because the alternative was worse than
   * either: the node's own `$ref` object has no `type` and no `properties`, so it falls through to
   * the primitive control at the bottom of this file and a nested object becomes a text box reading
   * `[object Object]`. The label and the description still come from the parent's `Field`, so what
   * the reader loses is one level of a shape that describes itself — and the source below the form
   * is where anybody reading that would go anyway.
   */
  const ref = typeof declared["$ref"] === "string" ? (declared["$ref"] as string) : undefined;
  const seen = ctx.refs ?? [];
  if (ref !== undefined && seen.includes(ref)) return <></>;
  const at = { ...ctx, root, refs: ref === undefined ? seen : [...seen, ref] };
  // Followed FIRST, then resolved against the value it holds: a node may be a reference to a choice
  // of shapes, and a choice of shapes may have references for branches — so both directions happen.
  const schema = deref(variantFor(deref(declared, root), value), root);
  const $type = schema["$type"] as string | undefined;

  // 1) A registered widget owns its own labels and layout.
  const Widget = widgetFor($type);
  if (Widget) return <Widget schema={schema} value={value} onChange={onChange} ctx={at} />;

  // 2) Object / class → recurse over the flattened properties.
  if (isObjectSchema(schema)) {
    const { properties, declaredBy } = flatten(schema, containerType, root);
    const obj = (value ?? {}) as Record<string, unknown>;
    /**
     * A MAP's members — `inputs`, `outputs`, `env`: the keys are the author's, not the schema's.
     *
     * Rendered from the VALUE rather than from the schema, because that is the only place the names
     * exist. Without this a map was drawn as a heading with nothing under it, which is how a state
     * file's whole input and output list came to be invisible in a form built from its own schema.
     * Only the keys `properties` does not already claim, so a document that declares some members
     * and allows others does not draw the declared ones twice.
     */
    const every = mapSchema(schema, root);
    const spare = every === undefined ? [] : Object.keys(obj).filter((key) => properties[key] === undefined);
    // Reading a document: only what it STATES — see `SchemaFormContext.reading`. A state file says
    // four things and its schema declares thirty, so the unfiltered form buries the document in its
    // own possibilities; and every one of those empty branches is a subtree this renderer would
    // otherwise walk and draw.
    const shown = ctx.reading === true ? Object.entries(properties).filter(([key]) => obj[key] !== undefined) : Object.entries(properties);
    return (
      <FieldGrid>
        {shown.map(([key, sub]) => {
          const path = ctx.path.length > 0 ? `${ctx.path}.${key}` : key;
          const set = (next: unknown): void => {
            // An UNSET member is REMOVED rather than written as undefined: an empty box means "this
            // layer says nothing", and a key with an undefined value is neither that nor a value.
            const nextObj = { ...obj };
            if (next === undefined) delete nextObj[key];
            else nextObj[key] = next;
            onChange(nextObj);
          };
          const subType = sub["$type"] as string | undefined;
          const pres = presentationFor(declaredBy[key], key, sub);
          const field = (
            <Field
              key={key}
              label={pres.label}
              param={path}
              {...(pres.tooltip !== undefined ? { hint: pres.tooltip } : {})}
              set={ctx.isSet?.(path) ?? obj[key] !== undefined}
            >
              <SchemaForm
                schema={sub}
                value={obj[key]}
                onChange={set}
                ctx={{ ...at, path }}
                containerType={subType}
              />
            </Field>
          );
          // A nested object, a list or a widget member is a full-width block; primitives are grid
          // cells. A list gets the stacked treatment on top of that: its rows carry their own
          // controls, and squeezing them into the right-hand rail of a two-column field leaves the
          // label column empty and the rows unreadable.
          const held = deref(variantFor(deref(sub, root), obj[key]), root);
          if (widgetFor(subType) || isObjectSchema(held) || isArraySchema(held)) {
            return (
              <div key={key} className={isArraySchema(held) ? "cfg-span cfg-block" : "cfg-span"}>
                {field}
              </div>
            );
          }
          return field;
        })}
        {spare.map((key) => {
          const path = ctx.path.length > 0 ? `${ctx.path}.${key}` : key;
          const set = (next: unknown): void => {
            const nextObj = { ...obj };
            if (next === undefined) delete nextObj[key];
            else nextObj[key] = next;
            onChange(nextObj);
          };
          return (
            // The KEY is the label, with no presentation lookup: these names were written by whoever
            // wrote the document, and there is nothing for a table of ours to say about `plan_doc`.
            // Full width, because what a map holds is nearly always an object.
            <div key={`+${key}`} className="cfg-span">
              <Field label={key} param={path} set={ctx.isSet?.(path) ?? true}>
                <SchemaForm schema={every!} value={obj[key]} onChange={set} ctx={{ ...at, path }} />
              </Field>
            </div>
          );
        })}
      </FieldGrid>
    );
  }

  // 3) Array → a row per item, each recursing.
  //
  // Without this an array fell through to the text control, which showed an empty box for a list of
  // five options and replaced the whole list with a string the moment anybody typed in it. The
  // controls are add / remove / reorder because order is part of what an array MEANS here: options
  // are buttons left to right, and fields are a form top to bottom.
  if (isArraySchema(schema)) {
    const items = ((schema["items"] as Schema | undefined) ?? {}) as Schema;
    const list = Array.isArray(value) ? (value as unknown[]) : [];
    const write = (next: unknown[]): void => onChange(next);
    const swap = (i: number, j: number): void => {
      const next = [...list];
      [next[i], next[j]] = [next[j], next[i]];
      write(next);
    };
    return (
      <div className="cfg-list">
        {list.map((item, i) => (
          // Index-keyed, and it has to be: the items have no identity of their own, and a key
          // derived from content would remount the row being typed in on every keystroke.
          <div className="cfg-list-row" key={i}>
            <div className="cfg-list-body">
              <SchemaForm
                schema={items}
                value={item}
                onChange={(next) =>
                  // An emptied primitive comes back `undefined`, which JSON would write as `null` in
                  // an array. A hole is not what "I cleared this box" means, so it reseeds instead.
                  write(list.map((held, j) => (j === i ? (next === undefined ? seedFor(items) : next) : held)))
                }
                ctx={{ ...at, path: `${ctx.path}[${i}]` }}
                containerType={items["$type"] as string | undefined}
              />
            </div>
            <div className="cfg-list-acts">
              <button className="ghost" title="move up" disabled={ctx.disabled === true || i === 0} onClick={() => swap(i, i - 1)}>
                ↑
              </button>
              <button
                className="ghost"
                title="move down"
                disabled={ctx.disabled === true || i === list.length - 1}
                onClick={() => swap(i, i + 1)}
              >
                ↓
              </button>
              <button
                className="ghost"
                title="remove"
                disabled={ctx.disabled === true}
                onClick={() => write(list.filter((_, j) => j !== i))}
              >
                ✕
              </button>
            </div>
          </div>
        ))}
        <div className="cfg-list-add">
          <button className="ghost" disabled={ctx.disabled === true} onClick={() => write([...list, seedFor(items)])}>
            + add
          </button>
        </div>
      </div>
    );
  }

  // 4) Primitives.
  if (Array.isArray(schema["enum"])) {
    return (
      <SelectInput
        value={(value as string | undefined) ?? ""}
        disabled={ctx.disabled === true}
        options={[["— inherit", ""], ...(schema["enum"] as string[]).map((o): [string, string] => [o, o])]}
        onChange={(v) => onChange(v === "" ? undefined : v)}
      />
    );
  }
  if (schema["type"] === "boolean") {
    // A tri-state as a select, not a checkbox. A checkbox has two states and this has three: on, off,
    // and "say nothing and inherit" — and an unchecked box that silently means `false` is how a layer
    // ends up overriding a shared default nobody meant to override.
    return (
      <SelectInput
        value={value === undefined ? "" : value === true ? "yes" : "no"}
        disabled={ctx.disabled === true}
        options={[
          ["— inherit", ""],
          ["yes", "yes"],
          ["no", "no"],
        ]}
        onChange={(v) => onChange(v === "" ? undefined : v === "yes")}
      />
    );
  }
  if (schema["type"] === "number") {
    return (
      <NumInput
        value={typeof value === "number" ? value : undefined}
        disabled={ctx.disabled === true}
        onChange={onChange}
      />
    );
  }
  return (
    <TextInput
      value={typeof value === "string" ? value : ""}
      disabled={ctx.disabled === true}
      onChange={(v) => onChange(v === "" ? undefined : v)}
    />
  );
}
