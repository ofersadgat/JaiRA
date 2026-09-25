/**
 * The generic recursive renderer — the ONE form every typed value in the app is filled in through.
 *
 * Ported from findmyprompt's `schemaForm/SchemaForm.tsx`, and since grown into what the Run panel,
 * the New-task popover, the `fill_form` gate and Settings all draw with, so that none of them keeps a
 * form of its own. Two renderings of one slot were two places for a type to be read wrongly; the Run
 * panel's own form is the one that did it, drawing a JSON box for any schema richer than a bare type
 * and then refusing `significant` for not being valid JSON.
 *
 * Resolution per node, in order:
 *
 *  1. a node that may take more than one SHAPE (`anyOf`, `oneOf`, a `type` array) draws a chip per
 *     shape and the chosen shape beneath it;
 *  2. a `$type` registry hit renders with that dedicated widget, which owns its own labels and layout;
 *  3. an object recurses over its members, each drawn as a {@link Member};
 *  4. a list draws a row per item, and a row holding more than one line opens and closes;
 *  5. anything else is one control, chosen in `model.leafControlOf`.
 *
 * A member that is not required carries a SWITCH before its name. That is the whole model of
 * optional: `oneOf(value, not set)`, chosen out loud, never inferred from an empty box — so `""` is a
 * string here, and whether a string may be empty is the schema's `minLength` to say. The chips after
 * the name choose only among the value's own shapes (text, none, path + line).
 *
 * Every decision with a rule in it is in `model.ts`, where a test without a DOM can reach it. What is
 * left here is which element draws it.
 */
import { useId, useState, type JSX, type KeyboardEvent } from "react";
import { Chip, Field, FieldGrid, NumberText, SelectInput, Switch, TextArea, TextInput } from "../controls";
import { jsonTextOf, jsonValueOf } from "../jsonText";
import {
  branchesOf,
  branchIndexFor,
  branchLabels,
  childPath,
  deref,
  fitsBranch,
  flatten,
  isArraySchema,
  isComposite,
  isObjectSchema,
  isWithin,
  itemPath,
  leafControlOf,
  mapSchema,
  numberFromText,
  seedFor,
  shortText,
  singleShapeOf,
  suggestionsOf,
  summaryOf,
  typeHintOf,
} from "./model";
import { presentationFor } from "./presentation";
import { widgetFor } from "./registry";
import type { Schema, SchemaFormContext } from "./types";

/** A seed with nothing in it yet: an empty string, or an object of nothing but those. */
function isBlank(value: unknown): boolean {
  if (value === "") return true;
  return isRecord(value) && Object.keys(value).length > 0 && Object.values(value).every(isBlank);
}

/** What `seed` (the value at `root`) holds at the dotted path `at`, or undefined. */
function valueUnder(seed: unknown, root: string, at: string): unknown {
  if (at === root) return seed;
  if (!at.startsWith(`${root}.`)) return undefined;
  let cursor = seed;
  for (const part of at.slice(root.length + 1).split(".")) {
    if (!isRecord(cursor)) return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** A node with its references followed and a one-shape union unwrapped. */
const resolve = (schema: Schema, root: Schema | undefined): Schema => singleShapeOf(deref(schema, root), root);

/** The context a LIST ITEM gets: no dotted-path writer and no layer, because neither reaches `[2]`. */
function itemContext(ctx: SchemaFormContext, path: string): SchemaFormContext {
  const { setAt: _setAt, isSet: _isSet, ...rest } = ctx;
  return { ...rest, path };
}

/** The complaint a field shows under itself, if it has one and has been touched. */
function errorAt(ctx: SchemaFormContext, path: string): string | undefined {
  if (ctx.reading === true) return undefined;
  if (ctx.touched !== undefined && !ctx.touched(path)) return undefined;
  return ctx.errors?.find((e) => e.path === path)?.message;
}

/** What a switched-off member says where its control would be. */
function unsetNoteOf(ctx: SchemaFormContext, path: string, schema: Schema, value: unknown): string {
  if (ctx.unsetNote !== undefined) return ctx.unsetNote(path, schema, value);
  if (ctx.isSet !== undefined) return value !== undefined ? `not set here — inherits ${shortText(value)}` : "not set";
  if (schema["default"] !== undefined) return `not set — the default applies: ${shortText(schema["default"])}`;
  return "not set";
}

/**
 * Which shape a union holds, remembering one somebody PICKED.
 *
 * The value usually says which branch it is in, and that is the default. But a shape just chosen may
 * hold a value that does not show it yet — a number branch whose box is still empty holds `""`, which
 * reads as text — so the pick is kept for as long as the value can still belong to it.
 */
function useShape(branches: readonly Schema[] | undefined, value: unknown, root: Schema | undefined): [number, (i: number) => void] {
  const [picked, setPicked] = useState<number | undefined>(undefined);
  if (branches === undefined) return [0, setPicked];
  const held = picked !== undefined && picked < branches.length && (value === undefined || fitsBranch(branches[picked]!, value));
  return [held ? picked! : branchIndexFor(branches, value, root), setPicked];
}

/** The chips that choose a value's shape. */
function ShapeChips({
  branches,
  index,
  disabled,
  onPick,
}: {
  branches: readonly Schema[];
  index: number;
  disabled: boolean;
  onPick: (i: number) => void;
}): JSX.Element {
  const labels = branchLabels(branches);
  return (
    <span className="sf-pick" role="group" aria-label="shape">
      {labels.map((label, i) => (
        <Chip key={i} active={i === index} disabled={disabled} onClick={() => onPick(i)}>
          {label}
        </Chip>
      ))}
    </span>
  );
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
  containerType?: string | undefined;
}): JSX.Element {
  /**
   * The document, for following a `$ref` — this node's own schema at the top, the context's below.
   * The top-level caller passes a whole document and no root, so the schema it hands over IS the root.
   */
  const root = ctx.root ?? declared;
  /**
   * A reference already expanded on the way here — see {@link SchemaFormContext.refs}. Drawn as
   * NOTHING rather than as an unresolved node: a node that is only a `$ref` has no type, and would fall
   * through to a text box reading `[object Object]`.
   */
  const ref = typeof declared["$ref"] === "string" ? (declared["$ref"] as string) : undefined;
  const seen = ctx.refs ?? [];
  const at: SchemaFormContext = { ...ctx, root, refs: ref === undefined ? seen : [...seen, ref] };
  const node = resolve(declared, root);
  const branches = branchesOf(node, root, false);
  const [index, pick] = useShape(branches === undefined ? undefined : branchesOf(node, root), value, root);
  if (ref !== undefined && seen.includes(ref)) return <></>;

  if (branches !== undefined) {
    // A union with no field head of its own — a list item, a map value, the top of a form. The chips
    // go above the shape they choose. A READING draws the shape the value is in and no chips: it is
    // not asking which one.
    const branch = branches[index]!;
    const body = <SchemaForm schema={branch} value={value} onChange={onChange} ctx={at} containerType={containerType} />;
    if (ctx.reading === true) return body;
    const resolved = branchesOf(node, root)!;
    return (
      <div className="sf-union">
        <ShapeChips
          branches={resolved}
          index={index}
          disabled={ctx.disabled === true}
          onPick={(i) => {
            pick(i);
            ctx.touch?.(ctx.path);
            onChange(fitsBranch(resolved[i]!, value) ? value : seedFor(resolved[i]!, root));
          }}
        />
        {body}
      </div>
    );
  }

  const Widget = widgetFor(node["$type"] as string | undefined);
  if (Widget) return <Widget schema={node} value={value} onChange={onChange} ctx={at} />;
  if (isObjectSchema(node)) return <ObjectNode schema={node} value={value} onChange={onChange} ctx={at} containerType={containerType} />;
  if (isArraySchema(node)) return <ListNode schema={node} value={value} onChange={onChange} ctx={at} />;
  return <Leaf schema={node} value={value} onChange={onChange} ctx={at} />;
}

// --- an object -----------------------------------------------------------------------

function ObjectNode({
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
  containerType?: string | undefined;
}): JSX.Element {
  const root = ctx.root;
  const { properties, declaredBy, required } = flatten(schema, containerType, root);
  const obj = isRecord(value) ? value : {};
  /**
   * A MAP's members — `inputs`, `env`: the keys are the author's, not the schema's. Rendered from the
   * VALUE, because that is the only place the names exist; only the keys `properties` does not
   * already claim, so a document that declares some members and allows others draws neither twice.
   */
  const every = mapSchema(schema, root);
  const spare = every === undefined ? [] : Object.keys(obj).filter((key) => properties[key] === undefined);
  // Reading a document: only what it STATES — see `SchemaFormContext.reading`.
  const shown = ctx.reading === true ? Object.entries(properties).filter(([key]) => obj[key] !== undefined) : Object.entries(properties);
  // A layer requires nothing: the MERGE is what has to be complete, and a layer that leaves a field to
  // the one beneath it is doing its job.
  const layered = ctx.isSet !== undefined;

  const write = (key: string, next: unknown): void => {
    const path = childPath(ctx.path, key);
    ctx.touch?.(path);
    if (ctx.setAt !== undefined) {
      ctx.setAt(path, next);
      return;
    }
    // An UNSET member is REMOVED rather than written as undefined: a key holding undefined is neither
    // "not set" nor a value.
    const nextObj = { ...obj };
    if (next === undefined) delete nextObj[key];
    else nextObj[key] = next;
    onChange(nextObj);
  };

  return (
    <FieldGrid>
      {shown.map(([key, sub]) => (
        <Member
          key={key}
          name={key}
          schema={sub}
          value={obj[key]}
          required={!layered && required.has(key)}
          declaredBy={declaredBy[key]}
          ctx={ctx}
          onSet={(next) => write(key, next)}
        />
      ))}
      {every !== undefined ? (
        <MapRows every={every} keys={spare} obj={obj} ctx={ctx} onChange={(next) => { ctx.touch?.(ctx.path); onChange(next); }} />
      ) : null}
    </FieldGrid>
  );
}

/**
 * One member of an object: whether it is set, what it is called, what it may be, and its control.
 *
 * Its own component because it holds state — which shape was picked — and a loop over members cannot.
 */
function Member({
  name,
  schema: declared,
  value,
  required,
  declaredBy,
  ctx,
  onSet,
}: {
  name: string;
  schema: Schema;
  value: unknown;
  required: boolean;
  declaredBy: string | undefined;
  ctx: SchemaFormContext;
  onSet: (next: unknown) => void;
}): JSX.Element {
  const root = ctx.root;
  const path = childPath(ctx.path, name);
  const node = resolve(declared, root);
  const shapes = branchesOf(node, root);
  const [index, pick] = useShape(shapes, value, root);
  const reading = ctx.reading === true;
  const disabled = ctx.disabled === true;
  // Somewhere else the value can come from (`SchemaFormContext.sources`), and whether it does.
  const options = reading ? undefined : ctx.sources?.optionsFor(path);
  const offered = options !== undefined && options.length > 0;
  const sourced = offered ? ctx.sources!.picked(path) : undefined;
  const settled = ctx.provenance?.(path);
  // A layered row switched on with nothing to pin and nothing typed yet — an empty box, an app with
  // no client ID — is on HERE and written nowhere: every write to a layer is validated before it
  // lands, and an empty value is what a validator refuses. The first thing typed is the first write.
  const [armed, setArmed] = useState<unknown>(undefined);
  const pending = armed !== undefined && ctx.isSet !== undefined && !ctx.isSet(path) ? armed : undefined;
  const on = reading || required || sourced !== undefined ? true : ctx.isSet !== undefined ? ctx.isSet(path) || pending !== undefined : value !== undefined;
  // The cycle guard has to see a reference this member expands ITSELF — a union's branch is handed on
  // without it, and a schema that refers to itself through a union would otherwise never stop.
  const ref = typeof declared["$ref"] === "string" ? (declared["$ref"] as string) : undefined;
  const seen = ctx.refs ?? [];
  if (shapes !== undefined && ref !== undefined && seen.includes(ref)) return <></>;

  const held = shapes === undefined ? node : shapes[index]!;
  const body = shapes === undefined ? declared : branchesOf(node, root, false)![index]!;
  const baseCtx: SchemaFormContext =
    shapes !== undefined && ref !== undefined ? { ...ctx, path, refs: [...seen, ref] } : { ...ctx, path };
  // Under a pending row, the members its seed holds count as set, so a seeded app's client ID is one
  // box to type in rather than a second switch to find.
  const bodyCtx: SchemaFormContext =
    pending === undefined ? baseCtx : { ...baseCtx, isSet: (at) => ctx.isSet!(at) || valueUnder(pending, path, at) !== undefined };
  const pres =
    ctx.labels === "keys"
      ? { label: name, ...(typeof node["description"] === "string" ? { tooltip: node["description"] as string } : {}) }
      : presentationFor(declaredBy, name, node);
  const hint = reading ? "" : typeHintOf(held, root);

  const field = (
    <Field
      label={pres.label}
      mono={ctx.labels === "keys"}
      param={ctx.labels === "keys" || ctx.hidePaths === true ? undefined : path}
      {...(pres.tooltip !== undefined ? { hint: pres.tooltip } : {})}
      error={on && sourced === undefined ? errorAt(ctx, path) : undefined}
      // Switched off, the row says what it inherits and is otherwise disabled — see `Field.toggle`.
      off={!on}
      // A nested object or list is a form of its own: it goes under the name, across the row.
      wide={isComposite(held, root)}
      lead={
        !required && !reading && sourced === undefined ? (
          // In a layered form this switch IS the "set here" mark — it says whether this layer states
          // the value — so the tag is not drawn beside it as well.
          <Switch
            on={on}
            label={
              ctx.isSet !== undefined
                ? on
                  ? `${name} is set here — switch off to inherit it`
                  : `set ${name} here`
                : on
                  ? `leave ${name} out`
                  : `set ${name}`
            }
            disabled={disabled}
            // On: the value it already shows — an inherited one is pinned as it stands — or a fresh
            // one, which is the declared default when there is one. Off: not set at all.
            onChange={(next) => {
              if (!next) {
                setArmed(undefined);
                // A pending row was never written, so there is nothing to remove.
                if (pending === undefined) onSet(undefined);
                return;
              }
              const fresh = value !== undefined ? value : seedFor(declared, root);
              if (ctx.setAt !== undefined && value === undefined && isBlank(fresh)) setArmed(fresh);
              else onSet(fresh);
            }}
          />
        ) : undefined
      }
      after={
        <>
          {required && !reading ? (
            <b className="sf-req" title="required">
              *
            </b>
          ) : null}
          {hint.length > 0 ? <span className="sf-type">{hint}</span> : null}
          {settled !== undefined ? (
            <>
              <span className={`prov prov-${settled.via}`} {...(settled.note !== undefined ? { title: settled.note } : {})}>
                {settled.via}
              </span>
              {settled.confidence !== undefined ? <span className="conf">{settled.confidence.toFixed(2)}</span> : null}
            </>
          ) : null}
          {offered ? (
            <span className="sf-pick" role="group" aria-label="where the value comes from">
              <Chip
                active={sourced !== undefined}
                disabled={disabled}
                title={sourced !== undefined ? "type the value instead" : "take the value from somewhere else"}
                onClick={() => {
                  ctx.touch?.(path);
                  ctx.sources!.pick(path, sourced !== undefined ? undefined : options![0]!.id);
                }}
              >
                {ctx.sources!.label}
              </Chip>
            </span>
          ) : null}
          {shapes !== undefined && on && !reading && sourced === undefined ? (
            <ShapeChips
              branches={shapes}
              index={index}
              disabled={disabled}
              onPick={(i) => {
                pick(i);
                onSet(fitsBranch(shapes[i]!, value) ? value : seedFor(shapes[i]!, root));
              }}
            />
          ) : null}
        </>
      }
    >
      {sourced !== undefined ? (
        // The value is somebody else's to produce: the control is the choice of WHOSE, and what it
        // holds is said beneath it rather than copied into a box that could then be edited.
        <>
          <SelectInput
            value={sourced}
            options={options!.map((option): [string, string] => [option.label, option.id])}
            disabled={disabled}
            onChange={(id) => ctx.sources!.pick(path, id)}
          />
          {options!.find((option) => option.id === sourced)?.note !== undefined ? (
            <div className="sf-absent">{options!.find((option) => option.id === sourced)!.note}</div>
          ) : null}
        </>
      ) : !on ? (
        <div className="sf-absent">{unsetNoteOf(ctx, path, node, value)}</div>
      ) : (
        <SchemaForm schema={body} value={value ?? pending} onChange={onSet} ctx={bodyCtx} containerType={node["$type"] as string | undefined} />
      )}
    </Field>
  );

  // A nested object, a list, a widget or a box with room in it is a full-width block, with its name
  // above it: squeezed into the right-hand rail of a two-column field, its rows are unreadable.
  const block =
    widgetFor(node["$type"] as string | undefined) !== undefined ||
    (on && sourced === undefined && (isObjectSchema(held) || isArraySchema(held) || leafControlOf(held) === "multiline"));
  if (!block) return field;
  return <div className={isArraySchema(held) || leafControlOf(held) === "multiline" ? "cfg-span cfg-block" : "cfg-span"}>{field}</div>;
}

// --- a map ---------------------------------------------------------------------------

/**
 * The author's own keys, as rows of key and value.
 *
 * A key is renamed in place — its row keeps its position — and only when you leave the box or press
 * Enter, because renaming on every keystroke would move the value through `p`, `pa` and `pat` on the
 * way to `path`, colliding with whatever those already name.
 */
function MapRows({
  every,
  keys,
  obj,
  ctx,
  onChange,
}: {
  every: Schema;
  keys: string[];
  obj: Record<string, unknown>;
  ctx: SchemaFormContext;
  onChange: (next: Record<string, unknown>) => void;
}): JSX.Element {
  const root = ctx.root;
  if (ctx.reading === true) {
    return (
      <>
        {keys.map((key) => {
          const path = childPath(ctx.path, key);
          return (
            // The KEY is the label, with no presentation lookup: these names were written by whoever
            // wrote the document, and there is nothing for a table of ours to say about `plan_doc`.
            <div key={`+${key}`} className="cfg-span">
              <Field label={key} param={path}>
                <SchemaForm schema={every} value={obj[key]} onChange={() => undefined} ctx={itemContext(ctx, path)} />
              </Field>
            </div>
          );
        })}
      </>
    );
  }

  const rename = (from: string, to: string): boolean => {
    if (to === from) return true;
    if (to.length === 0 || obj[to] !== undefined) return false;
    onChange(Object.fromEntries(Object.entries(obj).map(([k, v]) => [k === from ? to : k, v])));
    return true;
  };
  const composite = isComposite(every, root);
  return (
    <div className="cfg-span sf-map">
      {keys.map((key) => {
        const path = childPath(ctx.path, key);
        return (
          <div key={key} className={`sf-map-row${composite ? " block" : ""}`}>
            <KeyBox name={key} disabled={ctx.disabled === true} onRename={(to) => rename(key, to)} />
            <div className="sf-map-value">
              <SchemaForm
                schema={every}
                value={obj[key]}
                onChange={(next) => onChange({ ...obj, [key]: next === undefined ? seedFor(every, root) : next })}
                ctx={itemContext(ctx, path)}
              />
              {errorAt(ctx, path) !== undefined ? <div className="reason cfg-error">{errorAt(ctx, path)}</div> : null}
            </div>
            <button
              type="button"
              className="quiet"
              title={`remove ${key}`}
              disabled={ctx.disabled === true}
              onClick={() => onChange(Object.fromEntries(Object.entries(obj).filter(([k]) => k !== key)))}
            >
              ✕
            </button>
          </div>
        );
      })}
      <div className="cfg-list-add">
        <button
          type="button"
          className="ghost"
          disabled={ctx.disabled === true}
          onClick={() => {
            let name = "key";
            for (let n = 2; obj[name] !== undefined; n++) name = `key${n}`;
            onChange({ ...obj, [name]: seedFor(every, root) });
          }}
        >
          + add key
        </button>
      </div>
    </div>
  );
}

function KeyBox({ name, disabled, onRename }: { name: string; disabled: boolean; onRename: (to: string) => boolean }): JSX.Element {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = (): void => {
    if (draft === null) return;
    // A name that is empty or already taken is not applied; the box goes back to the key it names.
    onRename(draft.trim());
    setDraft(null);
  };
  return (
    <TextInput
      value={draft ?? name}
      mono
      label="key"
      disabled={disabled}
      onChange={setDraft}
      onBlur={commit}
      onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") setDraft(null);
      }}
    />
  );
}

// --- a list --------------------------------------------------------------------------

/**
 * A row per item, with add / remove / reorder, because order is part of what a list MEANS here.
 *
 * A row that holds more than one line — an object, a nested list — opens and closes, and a closed row
 * reads as its first couple of values. Rows that were already there when the form opened start
 * closed; a row you add starts open, because you are about to fill it in; and a row with a complaint
 * in it is open whatever it was, because a problem you cannot see is one you cannot fix.
 */
function ListNode({
  schema,
  value,
  onChange,
  ctx,
}: {
  schema: Schema;
  value: unknown;
  onChange: (v: unknown) => void;
  ctx: SchemaFormContext;
}): JSX.Element {
  const root = ctx.root;
  const items = (isRecord(schema["items"]) ? schema["items"] : {}) as Schema;
  const list = Array.isArray(value) ? (value as unknown[]) : [];
  const composite = isComposite(items, root);
  const [open, setOpen] = useState<ReadonlySet<number>>(() => (ctx.reading === true ? new Set(list.map((_, i) => i)) : new Set()));
  const disabled = ctx.disabled === true;

  const write = (next: unknown[], nextOpen?: ReadonlySet<number>): void => {
    ctx.touch?.(ctx.path);
    if (nextOpen !== undefined) setOpen(nextOpen);
    onChange(next);
  };
  const moved = (i: number, j: number): ReadonlySet<number> => {
    const next = new Set([...open].filter((k) => k !== i && k !== j));
    if (open.has(i)) next.add(j);
    if (open.has(j)) next.add(i);
    return next;
  };
  const swap = (i: number, j: number): void => {
    const next = [...list];
    [next[i], next[j]] = [next[j], next[i]];
    write(next, moved(i, j));
  };
  const remove = (i: number): void =>
    write(
      list.filter((_, j) => j !== i),
      new Set([...open].filter((k) => k !== i).map((k) => (k > i ? k - 1 : k))),
    );

  return (
    <div className="cfg-list">
      {list.map((item, i) => {
        const path = itemPath(ctx.path, i);
        const troubled = (ctx.errors ?? []).some((e) => isWithin(e.path, path)) && ctx.reading !== true;
        const isOpen = !composite || open.has(i) || troubled;
        // What you can do to the ROW. On a row that opens and closes it sits in the row's own head line,
        // so the fields beneath get the row's whole width; a one-line row keeps it beside the value.
        const acts =
          ctx.reading === true ? null : (
            <div className="cfg-list-acts">
              <button type="button" className="quiet" title="move up" disabled={disabled || i === 0} onClick={() => swap(i, i - 1)}>
                ↑
              </button>
              <button type="button" className="quiet" title="move down" disabled={disabled || i === list.length - 1} onClick={() => swap(i, i + 1)}>
                ↓
              </button>
              <button type="button" className="quiet" title="remove" disabled={disabled} onClick={() => remove(i)}>
                ✕
              </button>
            </div>
          );
        return (
          // Index-keyed, and it has to be: items have no identity of their own, and a key derived from
          // content would remount the row being typed in on every keystroke.
          <div className="cfg-list-row" key={i}>
            <div className="cfg-list-body">
              {composite ? (
                <div className={`sf-row-head${isOpen ? "" : " closed"}`}>
                  <button
                    type="button"
                    className="quiet sf-caret"
                    aria-expanded={isOpen}
                    title={troubled ? "this row has a problem in it" : isOpen ? "close this row" : "open this row"}
                    disabled={troubled}
                    onClick={() => {
                      const next = new Set(open);
                      if (next.has(i)) next.delete(i);
                      else next.add(i);
                      setOpen(next);
                    }}
                  >
                    {isOpen ? "▾" : "▸"}
                  </button>
                  <span className="sf-index">[{i}]</span>
                  {!isOpen ? <span className="sub ellip">{summaryOf(items, item, root)}</span> : null}
                  {acts}
                </div>
              ) : null}
              {isOpen ? (
                <SchemaForm
                  schema={items}
                  value={item}
                  onChange={(next) => {
                    ctx.touch?.(path);
                    // An emptied item comes back `undefined`, which JSON would write as `null` in a list.
                    // A hole is not what "I cleared this" means, so it reseeds instead.
                    onChange(list.map((held, j) => (j === i ? (next === undefined ? seedFor(items, root) : next) : held)));
                  }}
                  ctx={itemContext(ctx, path)}
                  containerType={items["$type"] as string | undefined}
                />
              ) : null}
              {!composite && errorAt(ctx, path) !== undefined ? <div className="reason cfg-error">{errorAt(ctx, path)}</div> : null}
              {ctx.itemNote?.(ctx.path, item, i) ?? null}
            </div>
            {composite ? null : acts}
          </div>
        );
      })}
      {ctx.reading === true ? null : (
        <div className="cfg-list-add">
          <button
            type="button"
            className="ghost"
            disabled={disabled}
            onClick={() => write([...list, seedFor(items, root)], new Set([...open, list.length]))}
          >
            {ctx.addLabel?.(ctx.path) ?? "+ add"}
          </button>
        </div>
      )}
    </div>
  );
}

// --- one value -----------------------------------------------------------------------

function Leaf({
  schema,
  value,
  onChange,
  ctx,
}: {
  schema: Schema;
  value: unknown;
  onChange: (v: unknown) => void;
  ctx: SchemaFormContext;
}): JSX.Element {
  const id = useId();
  const disabled = ctx.disabled === true;
  switch (leafControlOf(schema)) {
    case "boolean":
      // A checkbox, not a switch: the switch before a name already means "is this set at all", and two
      // of them side by side would be two answers to what looks like one question.
      return (
        <label className="sf-bool">
          <input type="checkbox" checked={value === true} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
          <span className="sub">{value === true ? "yes" : "no"}</span>
        </label>
      );
    case "number":
    case "integer":
      return (
        <NumberText
          value={typeof value === "number" || typeof value === "string" ? value : undefined}
          disabled={disabled}
          onChange={(text) => onChange(numberFromText(text))}
        />
      );
    case "choice": {
      // A box that suggests. `enum` insists on its values, and the validator is what says so; `examples`
      // only offers them. Either way the box takes typing, which a `<select>` never could.
      const { values } = suggestionsOf(schema);
      const listId = `${id}-choices`;
      return (
        <>
          <TextInput value={typeof value === "string" ? value : jsonTextOf(value)} mono list={listId} disabled={disabled} onChange={onChange} />
          <datalist id={listId}>
            {values.map((option) => (
              <option key={option} value={option} />
            ))}
          </datalist>
        </>
      );
    }
    case "multiline":
      return <TextArea value={typeof value === "string" ? value : ""} rows={4} mono={false} disabled={disabled} onChange={onChange} />;
    case "json":
      // No type at all: any value. Read leniently — `significant` is the string, `3` the number — and
      // an emptied box is the empty string, because "not set" is the switch's to say.
      return (
        <TextInput
          value={value === "" ? "" : jsonTextOf(value)}
          mono
          disabled={disabled}
          onChange={(text) => onChange(jsonValueOf(text) ?? "")}
        />
      );
    case "none":
      return <div className="sf-absent">{schema["const"] !== undefined ? `sends ${JSON.stringify(schema["const"])}` : "sends null"}</div>;
    case "text":
    default:
      return (
        <TextInput
          value={typeof value === "string" ? value : value === undefined || value === null ? "" : String(value)}
          disabled={disabled}
          onChange={onChange}
        />
      );
  }
}
