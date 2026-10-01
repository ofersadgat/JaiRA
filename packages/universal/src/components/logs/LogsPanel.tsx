import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import { ScrollView, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { View, isWeb } from "@tamagui/core";
import type { JobOutputChunk, LogEntry, LogLevel, LogQuery } from "@jaira/shared/browser";
import type { LogsPanelProps } from "@jaira/ui/logsModel";
import { datedOf, detailParts, keyOf, logQueryOf, nearEnd, reasonOf, sourcesOf, stamp, streamsOf, LEVELS } from "@jaira/ui/logsModel";
import { isUnseenLog, type LogUnseen } from "@jaira/ui/updatesModel";
import { PLAIN_SCROLLER, Press, Txt, appCh, edge, scrollbarProps, useHover, type FontSpec } from "../../primitives";
import { useTokens, type Tokens } from "../../tokens";
import { Pills } from "../Pills";
import { Button } from "../settings/Button";
import { ConfigPanel } from "./ConfigPanel";
import { BODY, BarInput } from "./Field";
import { Select, SourceSelect } from "./Select";

/**
 * `logs.tsx`'s `LogsPanel`, universal (decision 0015): the bar of filters, the column heads, the list of
 * entries (newest first, one line each, a row unfolding when pressed), older pages as the list is
 * scrolled, the Configure panel and a process's output. What it derives is `logsModel.ts`, shared with the
 * desktop's. The rules, from `styles.css`:
 *
 *   .logs              column, flex 1; --log-cols 11ch 5ch 22ch minmax(0,1fr) 92px (dated: 10ch first)
 *   .logs-bar          row, gap 8, centred, padding 6 10, a --line under it
 *   .logs-bar select   the plain `select` (see `Select`), min-width 150
 *   .logs-bar input    width 220, padding 5 9, the body's font, --bg, 1px --line (hovered --rule)
 *   .log-unseen-bar    row, gap 6, centred: the pills (budget 140), "not seen" (.sub), Dismiss
 *   .sub               --dim, app at 11/12.5
 *   .logs-head         the tracks, gap 8, padding 4 10, a --line under it; --dim, app at 10/12.5,
 *                      uppercase, 0.4px spacing. Its `ch` is DM Sans's at 10px (the head is not mono).
 *                      The date and time heads right-aligned.
 *   .logs-list         flex 1, scrolls, padding 2 0
 *   .log-row           the tracks, gap 8, baseline, padding 2 10; data at 11.5/12, one line, each cell
 *                      clipped with an ellipsis. Hovered or open: --panel-2. Unseen: --tint-bad or
 *                      --tint-warn (after the hover rule, so it wins). Open: cells wrap, top-aligned.
 *   .log-day/.log-at   --dim, right-aligned, tabular
 *   .log-level         uppercase, app size × 10/12.5 (still mono); warn --warn, error --bad
 *   .log-source        --dim;  .log-reason --dim;  .log-new ● at 0.8em, 6 right, the level's colour
 *   .log-row .link     --accent, data face at app size × 11/12.5, padding 0 2; hovered underlined
 *   .log-detail        padding 2 10 8 --log-indent (whose `ch` is DM Sans's at 13px: it is resolved on
 *                      the detail, which is not mono); pre: padding 6 8, --panel-2, 1px --line,
 *                      radius 4, data at 11/12, --dim, no wrapping; the fields 4 under the stack
 *   p.empty            --dim, padding 8 0, the p's 13px margins
 *   .console           a --line above, column, at most 45% tall
 */
/** A length in `ch` of the data face (JetBrains Mono, whose `0` is 0.6 of the size), or the stylesheet's own. */
function monoCh(t: Tokens, scale: number, n: number): number | string {
  const size = t.scaled("size-data", scale);
  return typeof size === "number" ? n * 0.6 * size : `calc(${String(size)} * ${n * 0.6})`;
}

/** The tracks: `[date?], time, level, source` in `ch` of the row's face, then the message and 92 for the links. */
function tracks(t: Tokens, voice: "app" | "data", scale: number, dated: boolean): (number | string)[] {
  return [...(dated ? [10] : []), 11, 5, 22].map((n) => (voice === "app" ? appCh(t, scale, n) : monoCh(t, scale, n)));
}

export function LogsPanel({
  entries,
  hasOlder,
  loading,
  onSearch,
  onOlder,
  policy,
  onPolicy,
  output,
  onOpenJob,
  onOpenTask,
  onClearOutput,
  unseen,
  onDismissUnseen,
}: LogsPanelProps): JSX.Element {
  const t = useTokens();
  const [level, setLevel] = useState<LogLevel>("debug");
  const [source, setSource] = useState("");
  const [text, setText] = useState("");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [showConfig, setShowConfig] = useState(false);
  const query = useMemo((): LogQuery => logQueryOf(level, source, text), [level, source, text]);

  // Debounced and skipped on the first render, as the desktop's (see `logs.tsx`).
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return undefined;
    }
    const timer = setTimeout(() => onSearch(query), 180);
    return () => clearTimeout(timer);
  }, [query, onSearch]);

  const toggle = (key: string): void =>
    setExpanded((held) => {
      const next = new Set(held);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (!hasOlder || loading) return;
      const { contentOffset, layoutMeasurement, contentSize } = e.nativeEvent;
      if (nearEnd(contentOffset.y, layoutMeasurement.height, contentSize.height)) onOlder(query);
    },
    [hasOlder, loading, onOlder, query],
  );

  const sources = useMemo(() => sourcesOf(entries), [entries]);
  const dated = useMemo(() => datedOf(entries), [entries]);

  return (
    <View flex={1} minHeight={0} minWidth={0} flexDirection="column" backgroundColor={t.v("bg") as never}>
      <View flexDirection="row" gap={8} alignItems="center" paddingVertical={6} paddingHorizontal={10} {...(edge(t, { bottom: 1 }) as object)}>
        <Select value={level} label="Minimum level" minWidth={150} options={LEVELS.map((l) => ({ label: `${l} and worse`, value: l }))} onChange={(v) => setLevel(v as LogLevel)} />
        <SourceSelect value={source} sources={sources} onChange={setSource} minWidth={150} />
        <BarInput value={text} onChange={setText} placeholder="Filter…" label="Filter" width={220} />
        <View flex={1} minWidth={0} />
        {unseen !== undefined ? (
          <View flexDirection="row" alignItems="center" gap={6} flexShrink={0}>
            <Pills counts={unseen.counts} budget={140} />
            <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }} numberOfLines={1}>
              not seen
            </Txt>
            {onDismissUnseen !== undefined ? (
              <Button title="Mark these seen: clears the counts here and on the Settings row" onPress={onDismissUnseen} flexShrink={0}>
                Dismiss
              </Button>
            ) : null}
          </View>
        ) : null}
        <Button onPress={() => setShowConfig((v) => !v)} flexShrink={0}>
          Configure
        </Button>
        <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }} numberOfLines={1} flexShrink={0}>
          {entries.length}
          {hasOlder ? "+" : ""} shown
        </Txt>
      </View>
      {showConfig ? <ConfigPanel policy={policy} onPolicy={onPolicy} sources={sources} /> : null}
      <Head dated={dated} />
      <ScrollView
        style={{ flex: 1, minHeight: 0, ...PLAIN_SCROLLER } as never}
        contentContainerStyle={{ paddingVertical: 2, ...PLAIN_SCROLLER } as never}
        onScroll={onScroll}
        scrollEventThrottle={16}
        {...scrollbarProps(t)}
      >
        {entries.map((entry) => {
          const key = keyOf(entry);
          return <LogLine key={key} entry={entry} dated={dated} open={expanded.has(key)} unseen={unseen} onToggle={() => toggle(key)} onOpenTask={onOpenTask} onOpenJob={onOpenJob} />;
        })}
        {entries.length === 0 && !loading ? <Empty>Nothing to show.</Empty> : null}
        {loading ? <Empty>Reading…</Empty> : hasOlder ? <Empty>Scroll for older entries.</Empty> : null}
      </ScrollView>
      {output !== null ? <Console chunks={output.chunks} onClose={onClearOutput} /> : null}
    </View>
  );
}

/** `p.empty`: the body's face in --dim, padding 8 0 and the p's 1em margins. */
function Empty({ children }: { children: string }): JSX.Element {
  const t = useTokens();
  const em = t.scaled("size-app", 13 / 12.5);
  return (
    <Txt spec={{ ...BODY, color: "dim" }} paddingVertical={8} marginVertical={em as number}>
      {children}
    </Txt>
  );
}

/** `.logs-head`: the column names, on the rows' tracks (in the head's own face's `ch`). */
function Head({ dated }: { dated: boolean }): JSX.Element {
  const t = useTokens();
  const spec: Partial<FontSpec> = { voice: "app", scale: 10 / 12.5, color: "dim", upper: true, ls: 0.04, lineHeight: 1.5 };
  const widths = tracks(t, "app", 10 / 12.5, dated);
  const names = [...(dated ? ["date"] : []), "time", "level", "source"];
  return (
    <View flexDirection="row" gap={8} paddingVertical={4} paddingHorizontal={10} {...(edge(t, { bottom: 1 }) as object)}>
      {names.map((name, i) => (
        <Txt key={name} spec={spec} width={widths[i] as number} flexShrink={0} numberOfLines={1} {...(i < (dated ? 2 : 1) ? { textAlign: "right" } : {})}>
          {name}
        </Txt>
      ))}
      <Txt spec={spec} flex={1} minWidth={0} numberOfLines={1}>
        message
      </Txt>
      <View width={92} flexShrink={0} />
    </View>
  );
}

const LEVEL_INK: Partial<Record<LogLevel, string>> = { warn: "warn", error: "bad" };

/** One entry: `.log-line`, its row and, when open, what it was hiding. */
function LogLine({
  entry,
  dated,
  open,
  unseen,
  onToggle,
  onOpenTask,
  onOpenJob,
}: {
  entry: LogEntry;
  dated: boolean;
  open: boolean;
  unseen: LogUnseen | undefined;
  onToggle: () => void;
  onOpenTask: (taskId: string) => void;
  onOpenJob: (jobId: number) => void;
}): JSX.Element {
  const t = useTokens();
  const { day, time } = stamp(entry.at);
  const fresh = isUnseenLog(entry, unseen);
  const reason = reasonOf(entry);
  const widths = tracks(t, "data", 11.5 / 12, dated);
  const row: FontSpec = { voice: "data", scale: 11.5 / 12 };
  // The level's cell is mono at the app voice's size: the row's face, a size of its own.
  const levelSize = t.scaled("size-app", 10 / 12.5);
  const levelLine = typeof levelSize === "number" ? levelSize * 1.5 : undefined;
  // Closed: one line, clipped. Open: the cells wrap (white-space: normal), the message keeps its breaks.
  const cell = (extra: Record<string, unknown>): Record<string, unknown> => ({ flexShrink: 0, overflow: "hidden", ...(open ? {} : { numberOfLines: 1 }), ...extra });
  const tint = fresh ? (entry.level === "error" ? "tint-bad" : entry.level === "warn" ? "tint-warn" : undefined) : undefined;
  const cells = [...(dated ? [day] : []), time];
  const [hovered, hover] = useHover();
  return (
    <View flexDirection="column">
      {/* The whole row is the control, and its links are controls of their own: the press is a layer under
          the cells (which let it through) rather than their parent, so a link is never a button inside a
          button. The hover is the row's, links and all, as `.log-row:hover` is. */}
      <View
        position="relative"
        flexDirection="row"
        gap={8}
        alignItems={open ? "flex-start" : "baseline"}
        paddingVertical={2}
        paddingHorizontal={10}
        backgroundColor={(tint !== undefined ? t.v(tint) : open || hovered ? t.v("panel-2") : "transparent") as never}
        {...hover}
      >
        <Press onPress={onToggle} {...({ "aria-expanded": open } as object)} position="absolute" top={0} right={0} bottom={0} left={0} />
        <View flex={1} minWidth={0} flexDirection="row" gap={8} alignItems={open ? "flex-start" : "baseline"} pointerEvents="none">
          {cells.map((words, i) => (
            <Txt key={i} spec={{ ...row, color: "dim", tabular: true }} textAlign="right" width={widths[i] as number} {...cell({})}>
              {words}
            </Txt>
          ))}
          <Txt
            spec={{ ...row, upper: true, color: LEVEL_INK[entry.level] ?? "text" }}
            fontSize={levelSize}
            {...(levelLine !== undefined ? { lineHeight: levelLine } : {})}
            width={widths[cells.length] as number}
            {...cell({})}
          >
            {entry.level}
          </Txt>
          <Txt spec={{ ...row, color: "dim" }} width={widths[cells.length + 1] as number} {...cell({})} {...((isWeb ? { title: entry.source } : {}) as object)}>
            {entry.source}
          </Txt>
          <Txt spec={row} flex={1} minWidth={0} {...cell({ flexShrink: 1 })} {...(open && isWeb ? { style: { overflowWrap: "anywhere" } } : {})}>
            {fresh ? (
              // An inline span with a margin: on native a nested text has none, and the dot sits against the words.
              <Txt spec={{ voice: "data", scale: (11.5 / 12) * 0.8, color: LEVEL_INK[entry.level] ?? "text" }} marginRight={6} {...((isWeb ? { title: "Not seen yet" } : {}) as object)} aria-label="not seen yet">
                {"●"}
              </Txt>
            ) : null}
            {entry.message}
            {reason !== undefined ? <Txt spec={{ ...row, color: "dim" }}> — {reason}</Txt> : null}
          </Txt>
        </View>
        {/* Over the press layer (positioned, it paints above anything in flow), so a link takes its own press. */}
        <View width={92} flexShrink={0} flexDirection="row" justifyContent="flex-end" overflow="hidden" position="relative" zIndex={1}>
          {entry.taskId !== undefined ? <RowLink words="task" onPress={() => onOpenTask(entry.taskId!)} /> : null}
          {entry.jobId !== undefined ? <RowLink words="output" onPress={() => onOpenJob(entry.jobId!)} /> : null}
        </View>
      </View>
      {open ? <Detail detail={entry.detail} dated={dated} /> : null}
    </View>
  );
}

/** `.log-row .link`: --accent, the data face at the app size × 11/12.5, padding 0 2; hovered, underlined. */
function RowLink({ words, onPress }: { words: string; onPress: () => void }): JSX.Element {
  const t = useTokens();
  const size = t.scaled("size-app", 11 / 12.5);
  return (
    <Press onPress={onPress} paddingHorizontal={2} flexShrink={0}>
      {({ hovered }) => (
        <Txt spec={{ voice: "data", scale: 11 / 12, color: "accent" }} fontSize={size} {...(typeof size === "number" ? { lineHeight: size * 1.5 } : {})} {...(hovered ? { textDecorationLine: "underline" } : {})}>
          {words}
        </Txt>
      )}
    </Press>
  );
}

/** `.log-detail`: the stack, as itself, and the rest of the detail as JSON — nothing when there is neither. */
function Detail({ detail, dated }: { detail: unknown; dated: boolean }): JSX.Element | null {
  const t = useTokens();
  const { stack, rest } = useMemo(() => detailParts(detail), [detail]);
  if (stack === undefined && rest === undefined) return null;
  // `--log-indent`, resolved where it is used: in the body's face (DM Sans at 13/12.5), not the rows'.
  const ch = appCh(t, 13 / 12.5, dated ? 48 : 38);
  const indent = typeof ch === "number" ? 10 + ch + (dated ? 32 : 24) : `calc(${ch} + ${dated ? 42 : 34}px)`;
  const pre = (words: string, top: number): JSX.Element => (
    <ScrollView horizontal style={{ marginTop: top, flexGrow: 0, borderRadius: 4, backgroundColor: t.v("panel-2") as string, ...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }) as object), ...PLAIN_SCROLLER } as never} contentContainerStyle={{ paddingVertical: 6, paddingHorizontal: 8, ...PLAIN_SCROLLER } as never} {...scrollbarProps(t)}>
      <Txt spec={{ voice: "data", scale: 11 / 12, color: "dim" }} {...((isWeb ? { style: { whiteSpace: "pre" } } : {}) as object)}>
        {words}
      </Txt>
    </ScrollView>
  );
  return (
    <View paddingTop={2} paddingRight={10} paddingBottom={8} paddingLeft={indent as number}>
      {stack !== undefined ? pre(stack, 0) : null}
      {rest !== undefined ? pre(JSON.stringify(rest, null, 2), stack !== undefined ? 4 : 0) : null}
    </View>
  );
}

/** `.console`: a process's captured output, by stream, head and tail with what was dropped marked. */
function Console({ chunks, onClose }: { chunks: JobOutputChunk[]; onClose: () => void }): JSX.Element {
  const t = useTokens();
  const streams = useMemo(() => streamsOf(chunks), [chunks]);
  const small = { voice: "app", scale: 12 / 12.5 } as const;
  return (
    <View flexDirection="column" maxHeight="45%" minHeight={0} {...(edge(t, { top: 1 }) as object)}>
      <View flexDirection="row" gap={8} alignItems="center" paddingVertical={5} paddingHorizontal={10} {...(edge(t, { bottom: 1 }) as object)}>
        <Txt spec={small} flex={1} minWidth={0}>
          Process output
        </Txt>
        <Button onPress={onClose} font={small}>
          Close
        </Button>
      </View>
      {streams.length === 0 ? <Empty>This process printed nothing.</Empty> : null}
      {streams.map(([stream, list]) => (
        <ScrollView key={stream} style={{ minHeight: 0, flexShrink: 1, ...PLAIN_SCROLLER } as never} contentContainerStyle={{ paddingVertical: 4, paddingHorizontal: 10, ...PLAIN_SCROLLER } as never} {...scrollbarProps(t)}>
          <Txt spec={{ voice: "app", scale: 10 / 12.5, weight: 700, upper: true, ls: 0.04, color: "dim" }} marginVertical={4}>
            {stream}
          </Txt>
          {list.map((chunk) => (
            <View key={chunk.id}>
              {chunk.dropped > 0 ? (
                <Txt spec={{ voice: "app", scale: 11 / 12.5, italic: true, color: "dim" }} marginVertical={6}>
                  … {chunk.dropped.toLocaleString()} bytes not kept …
                </Txt>
              ) : null}
              <Txt spec={{ voice: "app", scale: 11 / 12.5, lineHeight: 1.4, color: stream === "stderr" ? "bad" : "text" }} fontFamily="monospace" {...(isWeb ? { style: { overflowWrap: "anywhere" } } : {})}>
                {chunk.chunk}
              </Txt>
            </View>
          ))}
        </ScrollView>
      ))}
    </View>
  );
}

