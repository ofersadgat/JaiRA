import { createContext, isValidElement, useContext, useEffect, useState, type JSX, type ReactNode } from "react";
import { View } from "@tamagui/core";
import type { ArtifactSummary, SessionRef, TaskDetail } from "@jaira/shared/browser";
import { sizeOf } from "@jaira/ui/liveStatusModel";
import { countOf, durationWords, previewOf, runMetricsOf, valueRowsOf } from "@jaira/ui/panelViewsModel";
import { invoke } from "@jaira/ui/store";
import { Press, Txt, edge, lengthToken, type FontSpec } from "../../primitives";
import { useTokens } from "../../tokens";

/**
 * `panelViews.tsx`'s small shared pieces and the tabs made only of them, universal (decision 0015): a
 * heading over one card of rows (`PanelSection`), a row (`PanelRow`), Outputs, what a run consumed,
 * Produced and Held. What they say is `panelViewsModel.ts`'s, shared with the DOM. The rules:
 *
 *   .pv-section            column, gap 6
 *   .set-section-title     row, centred, spaced, gap 12, at least 20 tall, padding 0 4; app 450 at
 *                          --size-app × .98 / 1.3, −0.005em, --text 68% over transparent
 *   .count                 --dim, 400 (in the title's font)
 *   .set-group             1px --line, radius 9, --panel, 0 1 2 rgba(0,0,0,.03)
 *   .set-group > * + *     a --line over every row but the first
 *   .pv-row                row, baseline, gap 12, padding 6 10, --text; .clickable hovered
 *                          --fill-ghost-hover, .sel --fill-ghost-selected
 *   .pv-row-name           app × .95, --dim, flex none, at most 48%, ellipsed
 *   .pv-row-value          app × .95, flex 1, ellipsed, right-aligned; .mono data 11/12 (line normal)
 *   .pv-none               a row saying there is nothing: app × .95, --dim
 *   .chip                  app 10/12.5, --dim, 1px --line, radius 999, padding 0 6; -ok/-bad/-warn
 *                          take the colour for ink and edge
 *   p.empty                app 13/12.5, --dim, padding 8 0, the paragraph's 1em margins
 */

/** Whether a row stands after another in its card — `* + *`, which draws its rule. */
const RowAfter = createContext(false);

const TITLE: FontSpec = { voice: "app", scale: 0.98, weight: 450, lineHeight: 1.3, ls: -0.005 };
const ROW: FontSpec = { voice: "app", scale: 0.95 };

/** `p.empty`: a quiet sentence where there is nothing to draw. */
export function PanelEmpty({ children }: { children: ReactNode }): JSX.Element {
  const t = useTokens();
  return (
    <Txt spec={{ voice: "app", scale: 13 / 12.5, color: "dim" }} paddingVertical={8} marginVertical={t.scaled("size-app", 13 / 12.5) as number}>
      {children}
    </Txt>
  );
}

/** A heading over one card of rows — `SettingsSection`'s markup at panel density. */
export function PanelSection({ title, action, children, plain = false }: { title: string; action?: ReactNode; children: ReactNode; plain?: boolean }): JSX.Element {
  const t = useTokens();
  const rows = (Array.isArray(children) ? children : [children]).flat().filter((one) => one !== null && one !== undefined && one !== false);
  return (
    <View flexDirection="column" gap={6} minWidth={0}>
      <View role="heading" aria-level={2} flexDirection="row" alignItems="center" justifyContent="space-between" gap={12} minHeight={20} paddingHorizontal={4}>
        <Txt spec={{ ...TITLE, color: t.mix(t.v("text"), 68, "transparent") }} flexShrink={1} minWidth={0}>
          {title}
        </Txt>
        {action}
      </View>
      {plain ? (
        children
      ) : (
        <View flexDirection="column" borderWidth={1} borderStyle="solid" borderColor={t.v("line") as never} borderRadius={9} backgroundColor={t.v("panel") as never} {...({ boxShadow: "0px 1px 2px rgba(0, 0, 0, 0.03)" } as object)}>
          {rows.map((row, i) =>
            // `.set-group > * + *`: a --line over every row but the first. A row draws its own (a button
            // row keeps the button's radius, so its rule curves at the corners); anything else is edged here.
            isValidElement(row) && (row.type === PanelRow || row.type === NoneRow) ? (
              <RowAfter.Provider key={i} value={i > 0}>
                {row}
              </RowAfter.Provider>
            ) : (
              <View key={i} {...(i > 0 ? (edge(t, { top: 1 }) as object) : {})}>
                {row}
              </View>
            ),
          )}
        </View>
      )}
    </View>
  );
}

/** `.count` in a section's title: its font, at 400, --dim. */
export function SectionCount({ children }: { children: ReactNode }): JSX.Element {
  return (
    <Txt spec={{ ...TITLE, weight: 400, color: "dim" }} flexShrink={0}>
      {children}
    </Txt>
  );
}

/** One line: a name, and what it is at the right. Dense — the panel is narrow and these repeat. */
export function PanelRow({
  name,
  value,
  title,
  onPress,
  mono = false,
  selected = false,
  nameInk,
}: {
  name: ReactNode;
  value?: ReactNode;
  title?: string | undefined;
  onPress?: (() => void) | undefined;
  mono?: boolean;
  selected?: boolean;
  /** The name's colour, where it says more than a name (`.pv-bad`, `.pv-warn`). */
  nameInk?: string | undefined;
}): JSX.Element {
  const t = useTokens();
  const valueFont: FontSpec = mono ? { voice: "data", scale: 11 / 12, lineHeight: { px: monoLine(t) } } : ROW;
  const body = (
    <>
      <Txt spec={{ ...ROW, color: nameInk ?? "dim" }} ellip flexShrink={0} maxWidth="48%">
        {name}
      </Txt>
      {value === undefined ? null : typeof value === "string" || typeof value === "number" ? (
        <Txt spec={valueFont} ellip flex={1} minWidth={0} textAlign="right">
          {value}
        </Txt>
      ) : (
        <View flex={1} minWidth={0} flexDirection="row" alignItems="baseline" justifyContent="flex-end" overflow="hidden">
          {value}
        </View>
      )}
    </>
  );
  const after = useContext(RowAfter);
  const box = { flexDirection: "row", alignItems: "baseline", gap: 12, width: "100%", minWidth: 0, paddingVertical: 6, paddingHorizontal: 10, ...(after ? edge(t, { top: 1 }) : {}) } as const;
  if (onPress === undefined) {
    return (
      <View {...(box as object)} {...((title !== undefined ? { title } : {}) as object)} {...(selected ? { backgroundColor: t.v("fill-ghost-selected") as never } : {})}>
        {body}
      </View>
    );
  }
  return (
    // A `button.set-row`: the button's radius (--control-radius) stays, and its rule curves with it.
    <Press onPress={onPress} title={title} {...(box as object)} borderRadius={lengthToken(t, "control-radius", 7)} box={({ hovered }) => ({ backgroundColor: selected ? t.v("fill-ghost-selected") : hovered ? t.v("fill-ghost-hover") : "transparent" })}>
      {body}
    </Press>
  );
}

/** A run of words in a row's value, in the row's font (for values made of several pieces). */
export function RowWords({ children, ink = "text", ...rest }: { children: ReactNode; ink?: string } & Record<string, unknown>): JSX.Element {
  return (
    <Txt spec={{ ...ROW, color: ink }} numberOfLines={1} {...rest}>
      {children}
    </Txt>
  );
}

/** `.set-row.pv-row.pv-none`: a row saying there is nothing. */
export function NoneRow({ children, ink = "dim" }: { children: ReactNode; ink?: string }): JSX.Element {
  const t = useTokens();
  const after = useContext(RowAfter);
  return (
    <View paddingVertical={6} paddingHorizontal={10} width="100%" {...((after ? edge(t, { top: 1 }) : {}) as object)}>
      <Txt spec={{ ...ROW, color: ink }}>{children}</Txt>
    </View>
  );
}

/**
 * JetBrains Mono's `line-height: normal` — `.pv-row-value.mono`'s `font` shorthand resets the line — as
 * Blink works it out: the ascent and descent, each rounded to whole pixels.
 */
function monoLine(t: ReturnType<typeof useTokens>): number {
  const size = Number(t.scaled("size-data", 11 / 12)) || 11;
  return Math.round(size * 1.02) + Math.round(size * 0.3);
}

/** `.chip`: a small word in a pill-shaped rule; `tone` is `-ok`, `-bad` or `-warn`. */
export function Chip({ children, tone, title }: { children: ReactNode; tone?: "ok" | "bad" | "warn" | undefined; title?: string | undefined }): JSX.Element {
  const t = useTokens();
  const ink = tone ?? "dim";
  return (
    <View flexShrink={0} borderWidth={1} borderStyle="solid" borderColor={t.v(tone ?? "line") as never} borderRadius={999} paddingHorizontal={6} {...((title !== undefined ? { title } : {}) as object)}>
      <Txt spec={{ voice: "app", scale: 10 / 12.5, color: ink, lineHeight: 1.3333 }} {...({ whiteSpace: "nowrap" } as object)}>
        {children}
      </Txt>
    </View>
  );
}

/**
 * Rows for a value: one per key of an object, one for anything else. Each opens the value whole. A list
 * rather than a component, so the section they are put in draws its rule between each (`* + *`).
 */
export function valueRows(value: unknown, onOpen: (name: string, value: unknown) => void): ReactNode[] {
  const { rows, keyed } = valueRowsOf(value);
  if (keyed && rows.length === 0) return [<NoneRow key="empty">empty</NoneRow>];
  if (!keyed) return [<PanelRow key="value" name="value" value={previewOf(value)} mono onPress={() => onOpen("value", value)} />];
  return rows.map(([key, one]) => <PanelRow key={key} name={key} value={previewOf(one)} mono title={`open ${key}`} onPress={() => onOpen(key, one)} />);
}

/** What the run consumed, summed across every call it made (`RunMetrics`). */
export function RunMetrics({ states }: { states: SessionRef[] }): JSX.Element | null {
  const metrics = runMetricsOf(states);
  if (metrics === null) return null;
  const { started, spent, cost, source, input, output, cached, written, reasoning } = metrics;
  return (
    <PanelSection title="What it consumed" action={<SectionCount>{states.length} calls</SectionCount>}>
      {started !== undefined ? <PanelRow name="started" value={new Date(started).toLocaleString()} title={new Date(started).toISOString()} /> : null}
      {spent !== undefined ? <PanelRow name="in calls" value={durationWords(spent)} /> : null}
      {cost !== undefined ? (
        <PanelRow
          name="cost"
          value={
            <>
              <RowWords flexShrink={1} minWidth={0}>${cost.toFixed(4)}</RowWords>
              {/* Only when it is NOT the provider's own charge. */}
              {source !== undefined && source !== "provider" ? (
                <Chip tone="warn" title="not the provider's own charge">
                  {source === "table" ? "price table" : "unknown"}
                </Chip>
              ) : null}
            </>
          }
        />
      ) : null}
      {input !== undefined ? <PanelRow name="in" value={countOf(input)} title="total billed input, including cache reads and writes" /> : null}
      {output !== undefined ? (
        <PanelRow
          name="out"
          value={
            <>
              <RowWords>{countOf(output)}</RowWords>
              {reasoning !== undefined ? <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }}> · {countOf(reasoning)} thinking</Txt> : null}
            </>
          }
        />
      ) : null}
      {cached !== undefined || written !== undefined ? (
        <PanelRow
          name="cache"
          title="read at roughly a tenth of the base rate; written above it"
          value={`${cached !== undefined ? `${countOf(cached)} read` : "—"}${written !== undefined ? ` · ${countOf(written)} written` : ""}`}
        />
      ) : null}
    </PanelSection>
  );
}

/** The Outputs tab: what the task's last run published, a row per output — and what the run consumed. */
export function OutputsView({ detail, sessions, onOpen }: { detail: TaskDetail; sessions: SessionRef[]; onOpen: (title: string, value: unknown) => void }): JSX.Element {
  const latest = detail.runs[detail.runs.length - 1];
  return (
    <>
      {latest?.outputs === undefined ? (
        <PanelEmpty>{detail.status === "running" ? "Nothing published yet." : "This task published no outputs."}</PanelEmpty>
      ) : (
        <PanelSection title="Published">
          {valueRows(latest.outputs, (slot, value) => onOpen(`output · ${slot}`, value))}
        </PanelSection>
      )}
      <RunMetrics states={sessions} />
    </>
  );
}

/** A value somebody asked the panel to hold (`valuePanel.tsx`'s `PinnedValue`, as far as the list needs it). */
export interface HeldValue {
  title: string;
  value?: unknown;
}

/** The Held tab: the values somebody asked the panel to HOLD, each with a way to let go of it. */
export function HeldView({ held, onOpen, onDrop, dropIcon }: { held: readonly HeldValue[]; onOpen: (item: HeldValue) => void; onDrop: (item: HeldValue) => void; dropIcon: (item: HeldValue) => ReactNode }): JSX.Element {
  if (held.length === 0) return <PanelEmpty>Nothing held. A value&apos;s ⋯ → Hold keeps it here while the conversation goes on.</PanelEmpty>;
  return (
    <PanelSection title="Held" action={<SectionCount>{held.length}</SectionCount>}>
      {held.map((item) => (
        <View key={item.title} flexDirection="row" alignItems="baseline" gap={12} paddingVertical={6} paddingHorizontal={10}>
          <Press onPress={() => onOpen(item)} title={`open ${item.title}`} flex={1} minWidth={0}>
            {({ hovered }) => (
              <Txt spec={{ ...ROW, color: "accent" }} ellip {...(hovered ? { textDecorationLine: "underline" } : {})}>
                {item.title}
              </Txt>
            )}
          </Press>
          {dropIcon(item)}
        </View>
      ))}
    </PanelSection>
  );
}

/**
 * The Produced tab: what a conversation PRODUCED — the artifact map as a list. Choosing one draws it
 * under the list in the desktop's value viewer, which is {@link onShow}'s to draw.
 */
export function ProducedView({ taskId, project, signal, onShow }: { taskId: string; project?: string | undefined; signal: unknown; onShow?: ((row: ArtifactSummary, text: string) => ReactNode) | undefined }): JSX.Element {
  const [list, setList] = useState<ArtifactSummary[] | undefined>(undefined);
  const [selected, setSelected] = useState<string | null>(null);
  const [doc, setDoc] = useState<{ path: string; text: string } | null>(null);
  useEffect(() => {
    let live = true;
    void invoke("artifact:list", { taskId, ...(project !== undefined ? { project } : {}) })
      .then((rows) => live && setList(rows))
      .catch(() => live && setList([]));
    return () => {
      live = false;
    };
  }, [taskId, project, signal]);
  useEffect(() => {
    if (selected === null) {
      setDoc(null);
      return;
    }
    let live = true;
    void invoke("uri:read", { uri: `artifact://${taskId}/${selected}`, ...(project !== undefined ? { project } : {}) })
      .then((content) => live && setDoc({ path: selected, text: content.text }))
      .catch(() => live && setDoc(null));
    return () => {
      live = false;
    };
  }, [selected, taskId, project]);
  if (list === undefined) return <PanelEmpty>Reading what it produced…</PanelEmpty>;
  if (list.length === 0) return <PanelEmpty>Nothing produced yet.</PanelEmpty>;
  const shown = list.find((row) => row.path === selected);
  return (
    <>
      <PanelSection title="Produced" action={<SectionCount>{list.length}</SectionCount>}>
        {list.map((row) => (
          <PanelRow
            key={row.path}
            name={row.path}
            title={row.path}
            selected={row.path === selected}
            onPress={() => setSelected(row.path === selected ? null : row.path)}
            value={
              <>
                {row.interactive ? <Chip>runs</Chip> : null}
                <RowWords> {sizeOf(row.bytes)}</RowWords>
              </>
            }
          />
        ))}
      </PanelSection>
      {shown !== undefined && doc !== null && onShow !== undefined ? onShow(shown, doc.text) : null}
    </>
  );
}
