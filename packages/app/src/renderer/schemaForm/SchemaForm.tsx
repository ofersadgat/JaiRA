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
): { properties: Record<string, Schema>; declaredBy: Record<string, string | undefined> } {
  const myType = (schema["$type"] as string | undefined) ?? declaringType;
  let properties: Record<string, Schema> = {};
  let declaredBy: Record<string, string | undefined> = {};
  for (const member of (schema["allOf"] as Schema[] | undefined) ?? []) {
    const f = flatten(member);
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
  // A node written as a choice of shapes is resolved against the value it holds — see `variantFor`.
  const schema = variantFor(declared, value);
  const $type = schema["$type"] as string | undefined;

  // 1) A registered widget owns its own labels and layout.
  const Widget = widgetFor($type);
  if (Widget) return <Widget schema={schema} value={value} onChange={onChange} ctx={ctx} />;

  // 2) Object / class → recurse over the flattened properties.
  if (isObjectSchema(schema)) {
    const { properties, declaredBy } = flatten(schema, containerType);
    const obj = (value ?? {}) as Record<string, unknown>;
    return (
      <FieldGrid>
        {Object.entries(properties).map(([key, sub]) => {
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
                ctx={{ ...ctx, path }}
                containerType={subType}
              />
            </Field>
          );
          // A nested object, a list or a widget member is a full-width block; primitives are grid
          // cells. A list gets the stacked treatment on top of that: its rows carry their own
          // controls, and squeezing them into the right-hand rail of a two-column field leaves the
          // label column empty and the rows unreadable.
          const held = variantFor(sub, obj[key]);
          if (widgetFor(subType) || isObjectSchema(held) || isArraySchema(held)) {
            return (
              <div key={key} className={isArraySchema(held) ? "cfg-span cfg-block" : "cfg-span"}>
                {field}
              </div>
            );
          }
          return field;
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
                ctx={{ ...ctx, path: `${ctx.path}[${i}]` }}
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
