import { useState, type JSX, type ReactNode } from "react";
import { View } from "@tamagui/core";
import { levelsFooter, useModelParameters } from "@jaira/ui/modelParameters";
import {
  LIMIT_FIELDS,
  SAMPLING_FIELDS,
  STOPS_FIELD,
  advancedEdit,
  advancedTextOf,
  llmCategoriesOf,
  llmSummariesOf,
  numOf,
  reasoningOf,
  reasoningSchemaOf,
  refusedSamplingOf,
  stopsFromText,
  stopsOf,
  withKey,
  withoutSampling,
  type CategoryKey,
  type LlmConfigDoc,
} from "@jaira/ui/llmConfigModel";
import type { WidgetProps } from "@jaira/ui/schemaForm/types";
import { Press, Txt, edge, lengthToken } from "../../primitives";
import { useTokens } from "../../tokens";
import { Button } from "../settings/Button";
import { Deeper, Field, FieldGrid } from "./Field";
import { FormInput, NumInput, TextArea } from "./inputs";
import { SchemaForm } from "./SchemaForm";

/**
 * `llmConfigForm.tsx`'s call-settings form and its `TabRail`, universal (decision 0015): a rail of
 * categories, each with its live one-line summary, beside the pane that edits the chosen one. What it
 * says and does is `llmConfigModel.ts`'s, the functions the DOM form calls. The rules, from `styles.css`:
 *
 *   .llm-config          grid 168 | 1fr, 1px --line, radius 8, clipped, --panel
 *   .llm-rail            column, gap 2, padding 6, --panel-2, a --line on its right
 *   .llm-rail-item       column, gap 2, start-aligned, padding 7 9, 1px transparent (hovered --line),
 *                        radius 6; on: --panel and --line. Its label app 550 at 12.5/12.5 in --dim
 *                        (on: --text); its summary app 10.5/12.5 --dim, one line, cut with …
 *   .llm-detail          column, gap 12, padding 13 15
 *   .llm-detail-head     column, gap 3: the title app 600 at 13/12.5, its hints `.cfg-hint` (70ch)
 *   .notice.warn         --tint-warn ground, --warn text, radius --control-radius, padding 7 9, app 11/12.5
 *   .pane-actions        row, centred, gap 6, wraps
 */

/** One tab of a {@link TabRail} (`RailItem`): a name over a one-line summary, or a heading between tabs. */
export interface RailItem {
  id: string;
  label?: ReactNode;
  summary: ReactNode;
  mono?: boolean;
  /** `.set-rail-add`: the `+ preset` tab, its summary in --tok-hint. */
  add?: boolean;
  title?: string;
  heading?: ReactNode;
  fold?: { open: boolean; onFold: () => void } | undefined;
  indent?: number;
}

/** A rail of tabs: each a name over a one-line summary, one of them chosen. */
export function TabRail({
  label,
  items,
  selected,
  onSelect,
  ground,
  width,
  pad = [7, 9],
  corner,
}: {
  label: string;
  items: readonly RailItem[];
  selected: string | undefined;
  onSelect: (id: string) => void;
  /** The rail's ground where a host darkens it (`.preset-rail`). */
  ground?: string;
  width: number;
  /** A tab's padding (`.set-config .llm-rail-item`: 5 9). */
  pad?: [number, number];
  /** The rail's bottom-left corner (`.set-config .llm-rail`: 7), in a box that does not clip. */
  corner?: number;
}): JSX.Element {
  const t = useTokens();
  return (
    <View
      width={width}
      flexShrink={0}
      flexDirection="column"
      gap={2}
      padding={6}
      backgroundColor={(ground ?? t.v("panel-2")) as never}
      {...(edge(t, { right: 1 }) as object)}
      {...(corner !== undefined ? { borderBottomLeftRadius: corner } : {})}
      role="tablist"
      aria-label={label}
    >
      {items.map((item) =>
        item.heading !== undefined && typeof item.heading !== "string" ? (
          <View key={item.id}>{item.heading}</View>
        ) : item.heading !== undefined ? (
          <Txt key={item.id} spec={{ voice: "data", scale: (11.5 / 12.5) * (12.5 / 12), weight: 600, lineHeight: 1.3 }} paddingTop={9} paddingHorizontal={8} paddingBottom={3} marginLeft={(item.indent ?? 0) * 12}>
            {item.heading}
          </Txt>
        ) : (
          <Press
            key={item.id}
            onPress={() => onSelect(item.id)}
            {...({ role: "tab", "aria-selected": item.id === selected } as object)}
            {...(item.title !== undefined ? { title: item.title } : {})}
            flexDirection="column"
            gap={2}
            alignItems="flex-start"
            paddingVertical={pad[0]}
            paddingHorizontal={pad[1]}
            borderWidth={1}
            borderStyle="solid"
            borderRadius={6}
            marginLeft={(item.indent ?? 0) * 12}
            box={({ hovered }) =>
              item.id === selected ? { backgroundColor: t.v("panel"), borderColor: t.v("line") } : { backgroundColor: "transparent", borderColor: hovered ? t.v("line") : "transparent" }
            }
          >
            {item.label !== undefined ? (
              <Txt spec={item.mono === true ? { voice: "app", scale: 1, weight: 550, color: item.id === selected ? "text" : "dim" } : { voice: "app", scale: 1, weight: 550, color: item.id === selected ? "text" : "dim" }}>{item.label}</Txt>
            ) : null}
            <Txt spec={{ voice: "app", scale: 10.5 / 12.5, color: item.add === true ? "tok-hint" : "dim" }} numberOfLines={1} maxWidth="100%">
              {item.summary}
            </Txt>
          </Press>
        ),
      )}
    </View>
  );
}

/** `.llm-config`: the rail and the pane, in their box. */
export function RailFrame({ card = false, children }: { card?: boolean; children: ReactNode }): JSX.Element {
  const t = useTokens();
  return (
    <View
      flexDirection="row"
      alignItems="stretch"
      flexShrink={1}
      minWidth={0}
      width="100%"
      borderRadius={8}
      overflow="hidden"
      // Straight in a card (`.set-group > .llm-config`): the card's padding, inside its own ring.
      {...(card ? { paddingVertical: 13, paddingHorizontal: 16 } : {})}
      backgroundColor={t.v("panel") as never}
      {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }) as object)}
    >
      {children}
    </View>
  );
}

/** `.llm-detail` with its head. */
export function RailDetail({
  title,
  hints,
  line,
  minHeight,
  children,
}: {
  title: ReactNode;
  hints: readonly string[];
  /** A line of the host's under the title, before the hints. */
  line?: ReactNode;
  /** `.set-config .llm-detail`: at least 330 tall. */
  minHeight?: number;
  children?: ReactNode;
}): JSX.Element {
  const t = useTokens();
  const head = title !== "" || hints.length > 0 || line !== undefined;
  return (
    <View flexGrow={1} flexShrink={1} flexBasis={0} minWidth={0} flexDirection="column" gap={12} paddingVertical={13} paddingHorizontal={15} {...(minHeight !== undefined ? { minHeight } : {})}>
      <Deeper>
      {head ? (
      <View flexDirection="column" gap={3}>
        {typeof title === "string" ? (title !== "" ? <Txt spec={{ voice: "app", scale: 13 / 12.5, weight: 600 }}>{title}</Txt> : null) : title}
        {line}
        {hints.map((hint, i) => (
          <Txt key={i} spec={{ voice: "app", scale: 11 / 12.5, lineHeight: 1.4, color: "dim" }} maxWidth={chWidth(t, 70)}>
            {hint}
          </Txt>
        ))}
      </View>
      ) : null}
      {children}
      </Deeper>
    </View>
  );
}

/** `n`ch of the hint's face (DM Sans at 11/12.5). */
function chWidth(t: ReturnType<typeof useTokens>, n: number): number | string {
  const size = t.scaled("size-app", 11 / 12.5);
  return typeof size === "number" ? n * (541.1354 / 62 / 12.875) * size : `${n}ch`;
}

/** `.notice.warn`. */
export function WarnNotice({ children }: { children: ReactNode }): JSX.Element {
  const t = useTokens();
  return (
    <View backgroundColor={t.v("tint-warn") as never} borderRadius={lengthToken(t, "control-radius", 7)} paddingVertical={7} paddingHorizontal={9}>
      {typeof children === "string" ? <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "warn" }}>{children}</Txt> : children}
    </View>
  );
}

/** A section a HOST draws first, before the call settings: a preset's Model. */
export interface LeadSection {
  key: "model";
  label: string;
  hint: string;
  summary: string;
  body: ReactNode;
}

/** `LlmConfigForm`: the call settings — sampling, reasoning, output limits and anything else, as JSON. */
export function LlmConfigForm({
  value,
  onChange,
  disabled = false,
  hint,
  section,
  onSection,
  footer,
  unframed = false,
  marks = true,
  lead,
  levelsFor,
  railWidth = 168,
}: {
  levelsFor?: string | undefined;
  /** The sections rail's width (`.preset-config`: 146). */
  railWidth?: number;
  value: LlmConfigDoc;
  onChange: (next: LlmConfigDoc) => void;
  disabled?: boolean;
  hint?: string;
  section?: CategoryKey | undefined;
  onSection?: ((next: CategoryKey) => void) | undefined;
  footer?: ReactNode;
  unframed?: boolean;
  marks?: boolean;
  lead?: LeadSection | undefined;
}): JSX.Element {
  const here = (stated: unknown): boolean => marks && stated !== undefined;
  const [own, setOwn] = useState<CategoryKey>(lead?.key ?? "sampling");
  const asked = section ?? own;
  const active: CategoryKey = asked === "model" && lead === undefined ? "sampling" : asked;
  const setActive = (next: CategoryKey): void => {
    setOwn(next);
    onSection?.(next);
  };
  const reasoning = reasoningOf(value);
  const reasoningOn = reasoning !== undefined;
  const ownModel = typeof value["model"] === "string" ? (value["model"] as string) : undefined;
  const thinking = useModelParameters(levelsFor ?? ownModel);
  const set = (key: string, next: unknown): void => onChange(withKey(value, key, next));
  const stops = stopsOf(value);
  const summaries = llmSummariesOf(value, lead?.summary);
  const categories = llmCategoriesOf(lead);
  const chosen = categories.find((c) => c.key === active)!;
  const hintSpec = { voice: "app", scale: 11 / 12.5, lineHeight: 1.4, color: "dim" } as const;

  const body = (
    <>
      <TabRail width={railWidth} label="Sections" items={categories.map((cat) => ({ id: cat.key, label: cat.label, summary: summaries[cat.key] }))} selected={active} onSelect={(id) => setActive(id as CategoryKey)} />
      <RailDetail title={chosen.label} hints={[chosen.hint, ...(hint !== undefined && hint !== "" && active === "sampling" ? [hint] : [])]}>
        {active === "model" ? lead?.body : null}
        {active === "sampling" ? (
          reasoningOn ? (
            <WarnNotice>
              <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "warn" }}>
                {"Reasoning is on, and a model is sampling "}
                <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "warn", italic: true }}>or</Txt>
                {" reasoning — never both. The sampling knobs are refused by a reasoning endpoint, so they are not offered here. Turn reasoning off to use them."}
              </Txt>
            </WarnNotice>
          ) : (
            <FieldGrid>
              {SAMPLING_FIELDS.map((field) => (
                <Field key={field.param} label={field.label} param={field.param} hint={field.hint} set={here(value[field.param])}>
                  <NumInput value={numOf(value, field.param)} disabled={disabled} onChange={(n) => set(field.param, n)} />
                </Field>
              ))}
            </FieldGrid>
          )
        ) : null}
        {active === "reasoning" ? (
          <View flexDirection="column" gap={10}>
            {here(reasoning) ? (
              <View flexDirection="row" flexWrap="wrap" alignItems="center" gap={6}>
                <SetHere />
              </View>
            ) : null}
            <SchemaForm
              schema={reasoningSchemaOf(thinking)}
              value={reasoning ?? {}}
              onChange={(next) => {
                const doc = (next ?? {}) as Record<string, unknown>;
                set("reasoning", Object.keys(doc).length === 0 ? undefined : doc);
              }}
              ctx={{ path: "reasoning", disabled }}
            />
            {thinking?.via !== undefined ? <Txt spec={hintSpec}>{thinking.via}</Txt> : null}
            {thinking?.resolved !== undefined && thinking.reasoning === false ? (
              <Txt spec={hintSpec}>{`${thinking.resolved} takes no reasoning request, so nothing set here is sent.`}</Txt>
            ) : thinking?.resolved !== undefined && thinking.budget === false ? (
              <Txt spec={hintSpec}>{`No thinking budget: ${thinking.resolved} takes a level only.`}</Txt>
            ) : null}
            <Txt spec={hintSpec}>{levelsFooter(thinking)}</Txt>
            {refusedSamplingOf(value).length > 0 ? (
              <WarnNotice>
                <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "warn" }}>{`This configuration also sets ${refusedSamplingOf(value).join(", ")}, which a reasoning endpoint refuses. Clear them, or turn reasoning off.`}</Txt>
                <View flexDirection="row" alignItems="center" gap={6} flexWrap="wrap">
                  <Button kind="ghost" disabled={disabled} onPress={() => onChange(withoutSampling(value))} font={{ scale: 11 / 12.5, color: "warn" }}>
                    Clear the sampling knobs
                  </Button>
                </View>
              </WarnNotice>
            ) : null}
          </View>
        ) : null}
        {active === "limits" ? (
          <FieldGrid>
            {LIMIT_FIELDS.map((field) => (
              <Field key={field.param} label={field.label} param={field.param} hint={field.hint} set={here(value[field.param])}>
                <NumInput value={numOf(value, field.param)} disabled={disabled} onChange={(n) => set(field.param, n)} />
              </Field>
            ))}
            <Field label={STOPS_FIELD.label} param={STOPS_FIELD.param} hint={STOPS_FIELD.hint} set={here(value[STOPS_FIELD.param])}>
              <FormInput value={stops.join(", ")} placeholder="—" disabled={disabled} onChange={(v) => set("stopSequences", stopsFromText(v))} />
            </Field>
          </FieldGrid>
        ) : null}
        {active === "advanced" ? <AdvancedJson value={value} disabled={disabled} onChange={onChange} /> : null}
        {footer}
      </RailDetail>
    </>
  );
  return unframed ? body : <RailFrame>{body}</RailFrame>;
}

/** `.cfg-set`: this layer states it. */
function SetHere(): JSX.Element {
  const t = useTokens();
  return (
    <Txt spec={{ voice: "app", scale: 9.5 / 12.5, ls: 0.04, upper: true, color: "accent" }} title="set in the layer you are editing" backgroundColor={t.v("tint-accent") as never} borderRadius={4} paddingVertical={1} paddingHorizontal={5}>
      set here
    </Txt>
  );
}

/** The `llm-config` widget of the schema form (`LlmConfigWidget`). */
export function LlmConfigWidget({ value, onChange, ctx }: WidgetProps): JSX.Element {
  return <LlmConfigForm value={(value ?? {}) as LlmConfigDoc} disabled={ctx.disabled === true} onChange={(next) => onChange(Object.keys(next).length === 0 ? undefined : next)} />;
}

/** Every key the form has no control for, as JSON — so the form is never lossy. */
function AdvancedJson({ value, disabled, onChange }: { value: LlmConfigDoc; disabled: boolean; onChange: (next: LlmConfigDoc) => void }): JSX.Element {
  const saved = advancedTextOf(value);
  const [text, setText] = useState(saved);
  const [baseline, setBaseline] = useState(saved);
  const [problem, setProblem] = useState<string | null>(null);
  if (baseline !== saved) {
    if (text === baseline) setText(saved);
    setBaseline(saved);
  }
  return (
    <View flexDirection="column" gap={10}>
      <Field label="Other settings" param="(any)" hint="Everything with no dedicated control above — provider passthroughs, and anything newer than this form. Kept exactly as written.">
          <TextArea
            value={text}
            rows={8}
            placeholder={'{ "providerOptions": { "anthropic": { "cacheControl": true } } }'}
            disabled={disabled}
            onChange={(v) => {
              setText(v);
              const edit = advancedEdit(value, v);
              if ("problem" in edit) {
                setProblem(edit.problem);
                return;
              }
              setProblem(null);
              onChange(edit.doc);
            }}
          />
      </Field>
      {problem ? <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "warn" }}>{`not saved — ${problem}`}</Txt> : null}
    </View>
  );
}
