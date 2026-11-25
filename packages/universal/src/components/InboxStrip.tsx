import { useMemo, type JSX } from "react";
import { View, isWeb } from "@tamagui/core";
import type { PendingApproval, PendingInteraction, PendingQuestion, ProjectSummary, ProjectTask } from "@jaira/shared/browser";
import { SHARED_SESSION } from "@jaira/shared/browser";
import { LANE_METRICS, entryTitle, fitLanes, inboxLanesOf, type Lane, type LaneEntry, type LaneMode, type Measure } from "@jaira/ui/inboxLanesModel";
import { awaitingCount, moreTitle, noticeMeta, noticeTitle, type ShownNotice } from "@jaira/ui/noticesModel";
import { projectName } from "@jaira/ui/projects";
import { Press, Txt, edge, landmark } from "../primitives";
import { useTokens } from "../tokens";
import { useDrawnWidth } from "./drawnWidth";
import { Pill } from "./Pill";
import { colorOf } from "./Sidebar";
import { RowRing } from "./StatusRing";

/**
 * The inbox strip at the foot of the window: what is awaiting you, as project lanes, and the newest
 * unread notice at the right end (decision 0010 §4; the status-bar mockups of 2026-11-24, round 2,
 * design 09: `docs/ui/assets/inbox-strip/explore-status-bar-2.html`).
 *
 * Each lane is a project, named once, holding the TOP-LEVEL chats and tasks something under them asks
 * (`inboxLanesModel.ts`): each with the ring the chat list draws — a segment per ask, one more while it
 * works, the oldest ask's age in the middle — and its title. As the room runs out it gives up words a
 * step at a time (`fitLanes`): titles cut short, the last lanes' titles dropped, those lanes folded to
 * one ring and a count, the first lane's titles last, and only then lanes left out under "+N more". How
 * it looks:
 *
 *   the strip                40 tall, row, gap 12, padding 0 14, --panel, a --line on top
 *   "Awaiting you"           app-title at 11.5/12.5, then the waiting pill with every request counted
 *   a lane                   the strip's full height, padding 0 12, the project's hue at 7% as ground
 *                            and at 70% as a 2px edge on its left; lanes sit flush
 *   its name                 a 7px dot in the hue, then the name in the data face, 600, the hue mixed
 *                            85% into --text; 8 before its entries
 *   an entry                 the 22 ring (`RowRing`), 6, its title in the app face at 12/12.5, 500,
 *                            220 at most (120 when cut short); 12 between entries, 5 between rings alone
 *   a folded lane            its name, the ring of everything in it, and its count in --warn
 *   "+N more"                app-secondary, the requests in lanes left out
 *   the notice               the newest unread one at the right end: 🔔, the chip, the text, its meta,
 *                            "+N", and ×; at most 40% of the strip
 */
export function InboxStrip({
  pending,
  approvals,
  questions,
  tasks,
  projects,
  hues,
  onSelect,
  notice,
  now = Date.now(),
  onOpenNotice,
  onDismissNotice,
}: {
  pending: PendingInteraction[];
  approvals: PendingApproval[];
  questions: PendingQuestion[];
  /** Every task the window holds: the titles and parent links an ask is filed under its top-level task by. */
  tasks: readonly ProjectTask[];
  projects: ProjectSummary[];
  hues: Readonly<Record<string, string>>;
  onSelect: (taskId: string, project: string) => void;
  notice?: ShownNotice | undefined;
  now?: number;
  onOpenNotice?: ((shown: ShownNotice["notice"]) => void) | undefined;
  onDismissNotice?: ((shown: ShownNotice["notice"]) => void) | undefined;
}): JSX.Element | null {
  const t = useTokens();
  const total = awaitingCount({ pending: pending.filter((p) => p.moves !== true), approvals, questions });
  const lanes = useMemo(() => inboxLanesOf({ pending, approvals, questions, tasks, projects, now }), [pending, approvals, questions, tasks, projects, now]);
  const [width, measured] = useDrawnWidth();
  const fit = useMemo(() => (width === undefined ? null : fitLanes(lanes, width, measureWords())), [lanes, width]);
  if (total === 0 && notice === undefined) return null;
  const chipOf = (project: string): { label: string; hue: string } => {
    const found = project === SHARED_SESSION ? projects.find((p) => p.kind === "shared") : projects.find((p) => p.project === project);
    if (project === SHARED_SESSION) return { label: found?.label ?? "Shared", hue: (found !== undefined ? hues[found.project] : undefined) ?? "var(--p0)" };
    return { label: found?.label ?? projectName(project), hue: hues[project] ?? "var(--p0)" };
  };
  const open = (entry: LaneEntry): void => {
    const ask = entry.asks[0];
    const taskId = ask?.taskId ?? entry.taskId;
    if (taskId !== undefined) onSelect(taskId, ask?.project ?? entry.project);
  };
  return (
    <View {...(landmark("contentinfo") as object)} flexDirection="row" alignItems="center" gap={12} paddingHorizontal={14} height={40} flexShrink={0} backgroundColor={t.v("panel") as never} {...(edge(t, { top: 1 }) as object)}>
      {total > 0 ? (
        <>
          <Txt register="app-title" spec={{ scale: 11.5 / 12.5 }} flexShrink={0}>
            Awaiting you
          </Txt>
          <Pill kind="waiting" n={total} title={`${total} waiting on you`} />
        </>
      ) : null}
      {/* Grows into what is left and is measured, so how much the lanes say follows the room, not their words. */}
      <View {...(measured as object)} flexGrow={1} flexBasis={0} minWidth={0} alignSelf="stretch" flexDirection="row" overflow="hidden">
        {lanes.map((lane, i) => {
          const mode: LaneMode = fit?.modes[i] ?? "titles";
          return mode === "hidden" ? null : <LaneView key={lane.project} lane={lane} mode={mode} titleMax={fit?.titleMax ?? LANE_METRICS.fullTitle} chip={chipOf(lane.project)} onOpen={open} />;
        })}
      </View>
      {fit !== null && fit.more > 0 ? (
        <Txt register="app-secondary" flexShrink={0} whiteSpace="nowrap">
          +{fit.more} more
        </Txt>
      ) : null}
      {notice !== undefined ? <NoticeItem shown={notice} chip={chipOf(notice.notice.project)} now={now} onOpen={onOpenNotice} onDismiss={onDismissNotice} /> : null}
    </View>
  );
}

/** One project's lane: its name once, then its entries — titled, rings alone, or folded to one ring. */
function LaneView({ lane, mode, titleMax, chip, onOpen }: { lane: Lane; mode: LaneMode; titleMax: number; chip: { label: string; hue: string }; onOpen: (entry: LaneEntry) => void }): JSX.Element {
  const t = useTokens();
  const hue = colorOf(t, chip.hue);
  const m = LANE_METRICS;
  const all = useMemo(() => lane.entries.flatMap((e) => e.ring), [lane]);
  return (
    <View
      flexDirection="row"
      alignItems="center"
      gap={m.headGap}
      flexShrink={0}
      paddingLeft={m.lanePad + m.laneEdge}
      paddingRight={m.lanePad}
      position="relative"
      backgroundColor={t.mix(hue, 7, "transparent") as never}
    >
      {/* The hued edge: drawn, not a border, so no other side of the lane takes one. */}
      <View position="absolute" left={0} top={0} bottom={0} width={m.laneEdge} backgroundColor={t.mix(hue, 70, "transparent") as never} />
      <View flexDirection="row" alignItems="center" gap={5} flexShrink={0} {...((isWeb ? { title: `${chip.label}: ${lane.asks} waiting` } : {}) as object)}>
        <View width={7} height={7} borderRadius={999} backgroundColor={hue as never} />
        <Txt spec={{ voice: "data", scale: 11 / 12, weight: 600, color: String(t.mix(hue, 85, t.v("text"))), lineHeight: { px: 14 } }} whiteSpace="nowrap">
          {chip.label}
        </Txt>
      </View>
      {mode === "folded" ? (
        <Press onPress={() => onOpen(lane.entries[0]!)} title={lane.entries.map(entryTitle).join("\n")} label={`${chip.label}: ${lane.asks} waiting`} flexDirection="row" alignItems="center" gap={5} flexShrink={0}>
          <RowRing items={all} />
          <Txt spec={{ voice: "data", scale: 0.875, weight: 700, color: "warn", tabular: true }}>{lane.asks}</Txt>
        </Press>
      ) : (
        <View flexDirection="row" alignItems="center" gap={mode === "rings" ? m.ringGap : m.entryGap} flexShrink={0}>
          {lane.entries.map((entry) => (
            <Press
              key={entry.key}
              onPress={() => onOpen(entry)}
              title={entryTitle(entry)}
              label={`${entry.title}: ${entry.asks.length} waiting`}
              flexDirection="row"
              alignItems="center"
              gap={m.ringTitle}
              flexShrink={0}
              box={({ hovered }) => ({ opacity: hovered ? 0.8 : 1 })}
            >
              <RowRing items={entry.ring} />
              {mode === "titles" ? (
                <Txt spec={{ voice: "app", scale: 12 / 12.5, weight: 500, color: "text" }} ellip maxWidth={titleMax}>
                  {entry.title}
                </Txt>
              ) : null}
            </Press>
          ))}
        </View>
      )}
    </View>
  );
}

/**
 * How wide the strip's words are drawn, for {@link fitLanes}: on web the canvas, in the faces and sizes
 * the strip sets them in, read from the page's own variables so a size preference moves them too; on a
 * phone an even estimate.
 */
let canvas: HTMLCanvasElement | null = null;
function measureWords(): Measure {
  const even = (perChar: number) => (text: string) => Math.ceil(text.length * perChar);
  if (!isWeb || typeof document === "undefined") return { title: even(6.6), name: even(6.7) };
  const root = getComputedStyle(document.documentElement);
  const px = (name: string, fallback: number): number => parseFloat(root.getPropertyValue(name)) || fallback;
  const appFace = root.getPropertyValue("--font-app").trim() || "system-ui";
  const dataFace = root.getPropertyValue("--font-data").trim() || "monospace";
  canvas ??= document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (ctx === null) return { title: even(6.6), name: even(6.7) };
  const width = (font: string) => (text: string) => {
    ctx.font = font;
    return Math.ceil(ctx.measureText(text).width);
  };
  return {
    title: width(`500 ${px("--size-app", 12.5) * (12 / 12.5)}px ${appFace}`),
    name: width(`600 ${px("--size-data", 12) * (11 / 12)}px ${dataFace}`),
  };
}

/** A project's chip: its name on its hue, with the hue as a dot before it. */
export function ProjectChip({ label, hue }: { label: string; hue: string }): JSX.Element {
  const t = useTokens();
  const color = colorOf(t, hue);
  return (
    <View
      flexDirection="row"
      alignItems="center"
      gap={4}
      flexShrink={0}
      paddingHorizontal={6}
      borderRadius={999}
      backgroundColor={t.mix(color, 16, "transparent") as never}
      {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }) as object)}
    >
      <View width={5} height={5} borderRadius={999} flexShrink={0} backgroundColor={color as never} />
      <Txt spec={{ voice: "data", scale: 1, color: "dim", lineHeight: { px: 15 } }} {...({ fontSize: t.scaled("size-app", 10 / 12.5) } as object)} whiteSpace="nowrap">
        {label}
      </Txt>
    </View>
  );
}

function NoticeItem({
  shown,
  chip,
  now,
  onOpen,
  onDismiss,
}: {
  shown: ShownNotice;
  chip: { label: string; hue: string };
  now: number;
  onOpen?: ((notice: ShownNotice["notice"]) => void) | undefined;
  onDismiss?: ((notice: ShownNotice["notice"]) => void) | undefined;
}): JSX.Element {
  const t = useTokens();
  const { notice, more } = shown;
  const title = noticeTitle(notice);
  return (
    <>
      <View flexDirection="row" alignItems="center" gap={2} flexShrink={1} minWidth={0} maxWidth="40%">
        <Press
          onPress={() => onOpen?.(notice)}
          title={title}
          label={`Notice from ${chip.label}: ${title}`}
          flexDirection="row"
          alignItems="center"
          gap={6}
          minWidth={0}
          flexShrink={1}
          paddingVertical={2}
          paddingHorizontal={4}
          borderRadius={t.v("control-radius-sm") as never}
          box={({ hovered }) => ({ backgroundColor: hovered ? t.v("fill-ghost-hover") : "transparent" })}
        >
          <Txt spec={{ voice: "app", scale: (12 / 12.5) * 0.95, color: "dim" }} flexShrink={0}>
            🔔
          </Txt>
          <ProjectChip {...chip} />
          <Txt spec={{ voice: "app", scale: 12 / 12.5, color: "text" }} ellip minWidth={0} flexShrink={1}>
            {notice.text}
          </Txt>
          <Txt register="data-faint" spec={{ scale: 0.8 }} flexShrink={0}>
            {noticeMeta(notice, now)}
          </Txt>
          {more > 0 ? (
            <Txt register="app-secondary" flexShrink={0} {...({ title: moreTitle(more) } as object)}>
              +{more}
            </Txt>
          ) : null}
        </Press>
        <Press onPress={() => onDismiss?.(notice)} title="dismiss" label="Dismiss this notice" flexShrink={0} paddingHorizontal={6}>
          <Txt spec={{ voice: "app", scale: (12 / 12.5) * 1.05, color: "dim", lineHeight: 1.3 }}>×</Txt>
        </Press>
      </View>
    </>
  );
}
