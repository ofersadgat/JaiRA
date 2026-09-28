import { useState, type ComponentType, type JSX } from "react";
import { View } from "@tamagui/core";
import { jsonTextOf, jsonValueOf } from "@jaira/ui/jsonText";
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
  summaryOf,
  typeHintOf,
} from "@jaira/ui/schemaForm/model";
import { presentationFor } from "@jaira/ui/schemaForm/presentation";
import type { Schema, SchemaFormContext, WidgetProps } from "@jaira/ui/schemaForm/types";
import { Press, Txt, edge, lengthToken, padToken } from "../../primitives";
import { useTokens } from "../../tokens";
import { Switch } from "../settings/controls";
import { SelectInput } from "../settings/fields";
import { ErrorLine, Field, FieldGrid, Span, useFormSlot } from "./Field";
import { BoolField, Chip, FormInput, NumberText, PickWell, TextArea } from "./inputs";
import { LlmConfigWidget } from "./LlmConfigForm";

/**
 * `schemaForm/SchemaForm.tsx`, universal (decision 0015): the one recursive form every typed value is
 * filled in through — Settings' config blocks, a run's inputs, a gate's form. Every decision with a rule
 * in it is `schemaForm/model.ts`'s, the same functions the DOM's form calls; what is here is which view
 * draws each. The rules it adds to the fields', from `styles.css`:
 *
 *   .sf-req              --bad, 700: the `*` of a required member
 *   .sf-type             data 10/12, --dim: what the value may be
 *   .prov                how a recorded value was settled: a pill, data 600 at 10/12.5 on a 1.6 line,
 *                        padding 0 6, 1px --line (inferred --accent, asked --warn, each 40–45% into
 *                        --line); `.conf` data 11/12.5 --dim
 *   .sf-union            column, gap 6, grows; its chips at the start
 *   .sf-absent           app 11/12.5 --dim, padding 5 9, a dashed --line, radius --control-radius
 *   .cfg-list            column, gap 6, grows; a row: row, top-aligned, gap 8, padding 6 8, 1px --line,
 *                        radius 8, --panel; its buttons `quiet`, padding 2 7, gap 2
 *   .sf-row-head         row, centred, gap 6, 6 above the fields (none when closed); the caret a quiet
 *                        button, padding 0 4, app 10/12.5 on an 18px line (--bad while the row has a
 *                        problem); `.sf-index` data 10.5/12 --dim; closed, the row's summary `.sub ellip`
 *   .sf-map              column, gap 6; a row the key (0.8), the value (1.2) and ✕, gap 6, top-aligned
 */

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

const resolve = (schema: Schema, root: Schema | undefined): Schema => singleShapeOf(deref(schema, root), root);

function itemContext(ctx: SchemaFormContext, path: string): SchemaFormContext {
  const { setAt: _setAt, isSet: _isSet, ...rest } = ctx;
  return { ...rest, path };
}

function errorAt(ctx: SchemaFormContext, path: string): string | undefined {
  if (ctx.reading === true) return undefined;
  if (ctx.touched !== undefined && !ctx.touched(path)) return undefined;
  return ctx.errors?.find((e) => e.path === path)?.message;
}

function unsetNoteOf(ctx: SchemaFormContext, path: string, schema: Schema, value: unknown): string {
  if (ctx.unsetNote !== undefined) return ctx.unsetNote(path, schema, value);
  if (schema["default"] !== undefined) return `not set — the default applies: ${shortText(schema["default"])}`;
  return "not set";
}

function useShape(branches: readonly Schema[] | undefined, value: unknown, root: Schema | undefined): [number, (i: number) => void] {
  const [picked, setPicked] = useState<number | undefined>(undefined);
  if (branches === undefined) return [0, setPicked];
  const held = picked !== undefined && picked < branches.length && (value === undefined || fitsBranch(branches[picked]!, value));
  return [held ? picked! : branchIndexFor(branches, value, root), setPicked];
}

/**
 * The `$type` widgets (`schemaForm/registry.ts`): `llm-config` is the call-settings form. A host may
 * register another.
 */
const WIDGETS: Record<string, ComponentType<WidgetProps>> = {
  // Reached at render time only: the form's module imports this one.
  "llm-config": (props) => <LlmConfigWidget {...props} />,
};
export function registerWidget(type: string, widget: ComponentType<WidgetProps>): void {
  WIDGETS[type] = widget;
}
const widgetFor = (type: string | undefined): ComponentType<WidgetProps> | undefined => (type !== undefined ? WIDGETS[type] : undefined);

function ShapeChips({ branches, index, disabled, onPick, self = false }: { branches: readonly Schema[]; index: number; disabled: boolean; onPick: (i: number) => void; self?: boolean }): JSX.Element {
  const labels = branchLabels(branches);
  return (
    <PickWell label="shape" self={self}>
      {labels.map((label, i) => (
        <Chip key={i} small active={i === index} disabled={disabled} onPress={() => onPick(i)}>
          {label}
        </Chip>
      ))}
    </PickWell>
  );
}

/** `.sf-absent`: where a value would go, and why there is none. */
function Absent({ children }: { children: string }): JSX.Element {
  const t = useTokens();
  return (
    <View flexGrow={1} flexShrink={1} flexBasis="auto" paddingVertical={5} paddingHorizontal={9} borderRadius={lengthToken(t, "control-radius", 7)} {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }, "line", "dashed") as object)}>
      <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }}>{children}</Txt>
    </View>
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
  containerType?: string | undefined;
}): JSX.Element {
  const root = ctx.root ?? declared;
  const ref = typeof declared["$ref"] === "string" ? (declared["$ref"] as string) : undefined;
  const seen = ctx.refs ?? [];
  const at: SchemaFormContext = { ...ctx, root, refs: ref === undefined ? seen : [...seen, ref] };
  const node = resolve(declared, root);
  const branches = branchesOf(node, root, false);
  const [index, pick] = useShape(branches === undefined ? undefined : branchesOf(node, root), value, root);
  if (ref !== undefined && seen.includes(ref)) return <></>;

  if (branches !== undefined) {
    const branch = branches[index]!;
    const body = <SchemaForm schema={branch} value={value} onChange={onChange} ctx={at} containerType={containerType} />;
    if (ctx.reading === true) return body;
    const resolved = branchesOf(node, root)!;
    return (
      <View flexDirection="column" gap={6} flexGrow={1} flexShrink={1} flexBasis="auto" minWidth={0}>
        <ShapeChips
          self
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
      </View>
    );
  }

  const Widget = widgetFor(node["$type"] as string | undefined);
  if (Widget) return <Widget schema={node} value={value} onChange={onChange} ctx={at} />;
  if (isObjectSchema(node)) return <ObjectNode schema={node} value={value} onChange={onChange} ctx={at} containerType={containerType} />;
  if (isArraySchema(node)) return <ListNode schema={node} value={value} onChange={onChange} ctx={at} />;
  return <Leaf schema={node} value={value} onChange={onChange} ctx={at} />;
}

function ObjectNode({ schema, value, onChange, ctx, containerType }: { schema: Schema; value: unknown; onChange: (v: unknown) => void; ctx: SchemaFormContext; containerType?: string | undefined }): JSX.Element {
  const root = ctx.root;
  const { properties, declaredBy, required } = flatten(schema, containerType, root);
  const obj = isRecord(value) ? value : {};
  const every = mapSchema(schema, root);
  const spare = every === undefined ? [] : Object.keys(obj).filter((key) => properties[key] === undefined);
  const shown = ctx.reading === true ? Object.entries(properties).filter(([key]) => obj[key] !== undefined) : Object.entries(properties);
  const layered = ctx.isSet !== undefined;
  const write = (key: string, next: unknown): void => {
    const path = childPath(ctx.path, key);
    ctx.touch?.(path);
    if (ctx.setAt !== undefined) {
      ctx.setAt(path, next);
      return;
    }
    const nextObj = { ...obj };
    if (next === undefined) delete nextObj[key];
    else nextObj[key] = next;
    onChange(nextObj);
  };
  return (
    <FieldGrid>
      {shown.map(([key, sub]) => (
        <Member key={key} name={key} schema={sub} value={obj[key]} required={!layered && required.has(key)} declaredBy={declaredBy[key]} ctx={ctx} onSet={(next) => write(key, next)} />
      ))}
      {every !== undefined ? (
        <MapRows
          every={every}
          keys={spare}
          obj={obj}
          ctx={ctx}
          onChange={(next) => {
            ctx.touch?.(ctx.path);
            onChange(next);
          }}
        />
      ) : null}
    </FieldGrid>
  );
}

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
  const t = useTokens();
  const root = ctx.root;
  const path = childPath(ctx.path, name);
  const node = resolve(declared, root);
  const shapes = branchesOf(node, root);
  const [index, pick] = useShape(shapes, value, root);
  const reading = ctx.reading === true;
  const disabled = ctx.disabled === true;
  const options = reading ? undefined : ctx.sources?.optionsFor(path);
  const offered = options !== undefined && options.length > 0;
  const sourced = offered ? ctx.sources!.picked(path) : undefined;
  const settled = ctx.provenance?.(path);
  const layered = ctx.isSet !== undefined && !reading;
  const on = reading || required || sourced !== undefined || layered ? true : value !== undefined;
  const ref = typeof declared["$ref"] === "string" ? (declared["$ref"] as string) : undefined;
  const seen = ctx.refs ?? [];
  if (shapes !== undefined && ref !== undefined && seen.includes(ref)) return <></>;

  const held = shapes === undefined ? node : shapes[index]!;
  const body = shapes === undefined ? declared : branchesOf(node, root, false)![index]!;
  const baseCtx: SchemaFormContext = shapes !== undefined && ref !== undefined ? { ...ctx, path, refs: [...seen, ref] } : { ...ctx, path };
  const pres = ctx.labels === "keys" ? { label: name, ...(typeof node["description"] === "string" ? { tooltip: node["description"] as string } : {}) } : presentationFor(declaredBy, name, node);
  const hint = reading ? "" : typeHintOf(held, root);
  const chosen = sourced !== undefined ? options!.find((option) => option.id === sourced) : undefined;

  const field = (
    <Field
      label={pres.label}
      mono={ctx.labels === "keys"}
      param={ctx.labels === "keys" || ctx.hidePaths === true ? undefined : path}
      {...(pres.tooltip !== undefined ? { hint: pres.tooltip } : {})}
      error={on && sourced === undefined ? errorAt(ctx, path) : undefined}
      off={!on}
      {...(layered && sourced === undefined ? { layer: { stated: ctx.isSet!(path), disabled, onInherit: () => onSet(undefined) } } : {})}
      wide={isComposite(held, root)}
      lead={
        !required && !reading && !layered && sourced === undefined ? (
          <Switch on={on} label={on ? `leave ${name} out` : `set ${name}`} disabled={disabled} onChange={(next) => onSet(next ? (value !== undefined ? value : seedFor(declared, root)) : undefined)} />
        ) : undefined
      }
      after={
        <>
          {required && !reading ? (
            <Txt spec={{ voice: "app", scale: 13 / 12.5, weight: 700, color: "bad" }} title="required">
              *
            </Txt>
          ) : null}
          {hint.length > 0 ? <Txt spec={{ voice: "data", scale: 10 / 12, color: "dim" }}>{hint}</Txt> : null}
          {settled !== undefined ? (
            <>
              <Txt
                spec={{ voice: "data", scale: (10 / 12.5) * (12.5 / 12), weight: 600, lineHeight: 1.6, color: settled.via === "inferred" ? "accent" : settled.via === "asked" ? "warn" : "dim" }}
                {...(settled.note !== undefined ? { title: settled.note } : {})}
                flexShrink={0}
                paddingHorizontal={6}
                borderRadius={999}
                {...(edge(
                  t,
                  { top: 1, right: 1, bottom: 1, left: 1 },
                  settled.via === "inferred" ? t.mix(t.v("accent"), 40, t.v("line")) : settled.via === "asked" ? t.mix(t.v("warn"), 45, t.v("line")) : "line",
                ) as object)}
              >
                {settled.via}
              </Txt>
              {settled.confidence !== undefined ? <Txt spec={{ voice: "data", scale: (11 / 12.5) * (12.5 / 12), color: "dim" }}>{settled.confidence.toFixed(2)}</Txt> : null}
            </>
          ) : null}
          {offered ? (
            <PickWell label="where the value comes from">
              <Chip
                small
                active={sourced !== undefined}
                disabled={disabled}
                title={sourced !== undefined ? "type the value instead" : "take the value from somewhere else"}
                onPress={() => {
                  ctx.touch?.(path);
                  ctx.sources!.pick(path, sourced !== undefined ? undefined : options![0]!.id);
                }}
              >
                {ctx.sources!.label}
              </Chip>
            </PickWell>
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
        <>
          <SelectInput fill value={sourced} options={options!.map((option): [string, string] => [option.label, option.id])} disabled={disabled} onChange={(id) => ctx.sources!.pick(path, id)} />
          {chosen?.note !== undefined ? <Absent>{chosen.note}</Absent> : null}
        </>
      ) : !on ? (
        <Absent>{unsetNoteOf(ctx, path, node, value)}</Absent>
      ) : (
        <SchemaForm schema={body} value={value} onChange={onSet} ctx={baseCtx} containerType={node["$type"] as string | undefined} />
      )}
    </Field>
  );

  const block = widgetFor(node["$type"] as string | undefined) !== undefined || (on && sourced === undefined && (isObjectSchema(held) || isArraySchema(held) || leafControlOf(held) === "multiline"));
  if (!block) return field;
  return <Span block={isArraySchema(held) || leafControlOf(held) === "multiline"}>{field}</Span>;
}

function MapRows({ every, keys, obj, ctx, onChange }: { every: Schema; keys: string[]; obj: Record<string, unknown>; ctx: SchemaFormContext; onChange: (next: Record<string, unknown>) => void }): JSX.Element {
  const t = useTokens();
  const root = ctx.root;
  useFormSlot(false, false);
  if (ctx.reading === true) {
    return (
      <>
        {keys.map((key) => {
          const path = childPath(ctx.path, key);
          return (
            <Span key={`+${key}`}>
              <Field label={key} param={path}>
                <SchemaForm schema={every} value={obj[key]} onChange={() => undefined} ctx={itemContext(ctx, path)} />
              </Field>
            </Span>
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
  const disabled = ctx.disabled === true;
  return (
    <View flexDirection="column" gap={6} minWidth={0}>
      {keys.map((key) => {
        const path = childPath(ctx.path, key);
        const value = (
          <View minWidth={0} {...(composite ? { paddingLeft: 10, ...edge(t, { left: 2 }) } : { flexGrow: 1.2, flexShrink: 1, flexBasis: 0 })}>
            <SchemaForm schema={every} value={obj[key]} onChange={(next) => onChange({ ...obj, [key]: next === undefined ? seedFor(every, root) : next })} ctx={itemContext(ctx, path)} />
            {errorAt(ctx, path) !== undefined ? <ErrorLine>{errorAt(ctx, path)}</ErrorLine> : null}
          </View>
        );
        const remove = (
          <QuietButton own title={`remove ${key}`} disabled={disabled} onPress={() => onChange(Object.fromEntries(Object.entries(obj).filter(([k]) => k !== key)))}>
            ✕
          </QuietButton>
        );
        return composite ? (
          <View key={key} flexDirection="column" gap={6}>
            <View flexDirection="row" alignItems="flex-start" gap={6}>
              <View flexGrow={1} flexShrink={1} flexBasis={0} minWidth={0}>
                <KeyBox name={key} disabled={disabled} onRename={(to) => rename(key, to)} />
              </View>
              {remove}
            </View>
            {value}
          </View>
        ) : (
          <View key={key} flexDirection="row" alignItems="flex-start" gap={6}>
            <View flexGrow={0.8} flexShrink={1} flexBasis={0} minWidth={0}>
              <KeyBox name={key} disabled={disabled} onRename={(to) => rename(key, to)} />
            </View>
            {value}
            {remove}
          </View>
        );
      })}
      <View flexDirection="row">
        <GhostButton
          disabled={disabled}
          onPress={() => {
            let name = "key";
            for (let n = 2; obj[name] !== undefined; n++) name = `key${n}`;
            onChange({ ...obj, [name]: seedFor(every, root) });
          }}
        >
          + add key
        </GhostButton>
      </View>
    </View>
  );
}

function KeyBox({ name, disabled, onRename }: { name: string; disabled: boolean; onRename: (to: string) => boolean }): JSX.Element {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = (): void => {
    if (draft === null) return;
    onRename(draft.trim());
    setDraft(null);
  };
  return <FormInput value={draft ?? name} mono label="key" disabled={disabled} onChange={setDraft} onBlur={commit} onSubmit={commit} onEscape={() => setDraft(null)} />;
}

/** `button.quiet` in a list row's actions (`.cfg-list-acts button`: padding 2 7). */
function QuietButton({
  title,
  disabled,
  onPress,
  children,
  caret = false,
  bad = false,
  own = false,
}: {
  title: string;
  disabled: boolean;
  onPress: () => void;
  children: string;
  caret?: boolean;
  bad?: boolean;
  /** A `button.quiet` outside a list's actions: the button's own padding (`--control-pad`). */
  own?: boolean;
}): JSX.Element {
  const t = useTokens();
  const [padV, padH] = own ? padToken(t, "control-pad", [3, 10]) : caret ? [0, 4] : [2, 7];
  return (
    <Press
      onPress={onPress}
      disabled={disabled}
      title={title}
      label={title}
      flexDirection="row"
      alignItems="center"
      justifyContent="center"
      paddingVertical={padV}
      paddingHorizontal={padH}
      borderWidth={1}
      borderStyle="solid"
      borderColor="transparent"
      borderRadius={lengthToken(t, "control-radius", 7)}
      {...(disabled && !bad ? { opacity: 0.5 } : {})}
      box={({ hovered }) => ({ backgroundColor: hovered && !disabled ? t.v("fill-ghost-hover") : "transparent" })}
    >
      {({ hovered }) => (
        <Txt spec={{ voice: "app", scale: caret ? 10 / 12.5 : 13 / 12.5, color: bad ? "bad" : hovered && !disabled ? "text" : "dim", ...(caret ? { lineHeight: { px: 18 } } : {}) }} numberOfLines={1}>
          {children}
        </Txt>
      )}
    </Press>
  );
}

/** `button.ghost`: the list's and the map's add. */
function GhostButton({ disabled, onPress, children }: { disabled: boolean; onPress: () => void; children: string }): JSX.Element {
  const t = useTokens();
  return (
    <Press
      onPress={onPress}
      disabled={disabled}
      flexDirection="row"
      alignItems="center"
      justifyContent="center"
      gap={5}
      paddingVertical={3}
      paddingHorizontal={10}
      borderWidth={1}
      borderStyle="solid"
      borderRadius={lengthToken(t, "control-radius", 7)}
      {...(disabled ? { opacity: 0.5 } : {})}
      box={({ hovered }) => ({ backgroundColor: hovered && !disabled ? t.v("fill-ghost-hover") : "transparent", borderColor: t.v(hovered && !disabled ? "rule" : "line") })}
    >
      <Txt spec={{ voice: "app", scale: 13 / 12.5 }} numberOfLines={1}>
        {children}
      </Txt>
    </Press>
  );
}

function ListNode({ schema, value, onChange, ctx }: { schema: Schema; value: unknown; onChange: (v: unknown) => void; ctx: SchemaFormContext }): JSX.Element {
  const t = useTokens();
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
    <View flexDirection="column" gap={6} flexGrow={1} flexShrink={1} flexBasis="auto" minWidth={0}>
      {list.map((item, i) => {
        const path = itemPath(ctx.path, i);
        const troubled = (ctx.errors ?? []).some((e) => isWithin(e.path, path)) && ctx.reading !== true;
        const isOpen = !composite || open.has(i) || troubled;
        const acts =
          ctx.reading === true ? null : (
            <View flexDirection="row" gap={2} flexShrink={0} {...(composite ? { marginLeft: "auto" } : {})}>
              <QuietButton title="move up" disabled={disabled || i === 0} onPress={() => swap(i, i - 1)}>
                ↑
              </QuietButton>
              <QuietButton title="move down" disabled={disabled || i === list.length - 1} onPress={() => swap(i, i + 1)}>
                ↓
              </QuietButton>
              <QuietButton title="remove" disabled={disabled} onPress={() => remove(i)}>
                ✕
              </QuietButton>
            </View>
          );
        return (
          <View key={i} flexDirection="row" alignItems="flex-start" gap={8} paddingVertical={6} paddingHorizontal={8} borderRadius={8} backgroundColor={t.v("panel") as never} {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }) as object)}>
            <View flexGrow={1} flexShrink={1} flexBasis="auto" minWidth={0}>
              {composite ? (
                <View flexDirection="row" alignItems="center" gap={6} minWidth={0} marginBottom={isOpen ? 6 : 0}>
                  <QuietButton
                    caret
                    bad={troubled}
                    title={troubled ? "this row has a problem in it" : isOpen ? "close this row" : "open this row"}
                    disabled={troubled}
                    onPress={() => {
                      const next = new Set(open);
                      if (next.has(i)) next.delete(i);
                      else next.add(i);
                      setOpen(next);
                    }}
                  >
                    {isOpen ? "▾" : "▸"}
                  </QuietButton>
                  <Txt spec={{ voice: "data", scale: 10.5 / 12, color: "dim" }} flexShrink={0}>
                    [{i}]
                  </Txt>
                  {!isOpen ? (
                    <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }} ellip minWidth={0} flexShrink={1}>
                      {summaryOf(items, item, root)}
                    </Txt>
                  ) : null}
                  {acts}
                </View>
              ) : null}
              {isOpen ? (
                <SchemaForm
                  schema={items}
                  value={item}
                  onChange={(next) => {
                    ctx.touch?.(path);
                    onChange(list.map((held, j) => (j === i ? (next === undefined ? seedFor(items, root) : next) : held)));
                  }}
                  ctx={itemContext(ctx, path)}
                  containerType={items["$type"] as string | undefined}
                />
              ) : null}
              {!composite && errorAt(ctx, path) !== undefined ? <ErrorLine>{errorAt(ctx, path)}</ErrorLine> : null}
              {(ctx.itemNote?.(ctx.path, item, i) as never) ?? null}
            </View>
            {composite ? null : acts}
          </View>
        );
      })}
      {ctx.reading === true ? null : (
        <View flexDirection="row">
          <GhostButton disabled={disabled} onPress={() => write([...list, seedFor(items, root)], new Set([...open, list.length]))}>
            {ctx.addLabel?.(ctx.path) ?? "+ add"}
          </GhostButton>
        </View>
      )}
    </View>
  );
}

function Leaf({ schema, value, onChange, ctx }: { schema: Schema; value: unknown; onChange: (v: unknown) => void; ctx: SchemaFormContext }): JSX.Element {
  const disabled = ctx.disabled === true;
  const bad = errorAt(ctx, ctx.path) !== undefined;
  switch (leafControlOf(schema)) {
    case "boolean":
      return <BoolField value={value === true} disabled={disabled} onChange={onChange} />;
    case "number":
    case "integer":
      return <NumberText value={typeof value === "number" || typeof value === "string" ? value : undefined} disabled={disabled} bad={bad} onChange={(text) => onChange(numberFromText(text))} />;
    case "choice":
      // A box that suggests (`enum`, `examples`); on the desktop its `<datalist>` drops down while typing.
      return <FormInput value={typeof value === "string" ? value : jsonTextOf(value)} mono disabled={disabled} bad={bad} onChange={onChange} />;
    case "multiline":
      return <TextArea value={typeof value === "string" ? value : ""} rows={4} mono={false} disabled={disabled} bad={bad} onChange={onChange} />;
    case "json":
      return <FormInput value={value === "" ? "" : jsonTextOf(value)} mono disabled={disabled} bad={bad} onChange={(text) => onChange(jsonValueOf(text) ?? "")} />;
    case "none":
      return <Absent>{schema["const"] !== undefined ? `sends ${JSON.stringify(schema["const"])}` : "sends null"}</Absent>;
    case "text":
    default:
      return <FormInput value={typeof value === "string" ? value : value === undefined || value === null ? "" : String(value)} disabled={disabled} bad={bad} onChange={onChange} />;
  }
}
