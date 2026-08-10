/**
 * The generic recursive renderer. Ported from findmyprompt's `schemaForm/SchemaForm.tsx`.
 *
 * Resolution per node, in order:
 *
 *  1. a `$type` registry hit renders with that dedicated widget, which owns its own labels and layout;
 *  2. an object/class flattens `allOf` and recurses over `properties`;
 *  3. a primitive maps to a number / enum / boolean / text control.
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
  schema,
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
          // A nested object or a widget member is a full-width block; primitives are grid cells.
          if (widgetFor(subType) || isObjectSchema(sub)) {
            return (
              <div key={key} className="cfg-span">
                {field}
              </div>
            );
          }
          return field;
        })}
      </FieldGrid>
    );
  }

  // 3) Primitives.
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
