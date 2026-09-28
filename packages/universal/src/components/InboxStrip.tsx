import type { JSX } from "react";
import { View } from "@tamagui/core";
import type { PendingApproval, PendingInteraction, PendingQuestion, ProjectSummary } from "@jaira/shared/browser";
import { SHARED_SESSION } from "@jaira/shared/browser";
import { awaitingCount, moreTitle, noticeMeta, noticeTitle, type ShownNotice } from "@jaira/ui/noticesModel";
import { projectName } from "@jaira/ui/projects";
import { Press, Txt, edge } from "../primitives";
import { useTokens } from "../tokens";
import { Pill } from "./Pill";
import { colorOf } from "./Sidebar";

/**
 * `inboxStrip.tsx`'s `InboxStrip`, universal (decision 0015): what is awaiting you, and the newest unread
 * notice at the right end. Read that one for what it says and in what order; the rules, from `styles.css`:
 *
 *   .strip                   40 tall, row, gap 12, padding 0 14, --panel, a --line on top
 *   .strip-label             app-title at 11.5/12.5
 *   .strip-item              row, gap 6, at most 320 wide; a "·" (--tok-hint, 2 right) before every one
 *                            but the first
 *   .chip.strip-project      .chip wins the tie (it is later): 1px --line ring, round, padding 0 6,
 *                            10/12.5 app size in the data face, --dim, 15 line; the project's hue at 16%
 *                            as ground and as a 5px dot before the name (gap 4)
 *   .strip .ellip            data-text at 0.875 × --size-data
 *   .strip .more             app-secondary, pushed to the far end
 *   .strip-notice            after a spacer: 🔔, the chip, the text (app 12/12.5, --text), its meta
 *                            (data-faint at 0.8), "+N", and ×; the open button ghost-hovers
 */
export function InboxStrip({
  pending,
  approvals,
  questions,
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
  projects: ProjectSummary[];
  hues: Readonly<Record<string, string>>;
  onSelect: (taskId: string, project: string) => void;
  notice?: ShownNotice | undefined;
  now?: number;
  onOpenNotice?: ((shown: ShownNotice["notice"]) => void) | undefined;
  onDismissNotice?: ((shown: ShownNotice["notice"]) => void) | undefined;
}): JSX.Element | null {
  const t = useTokens();
  const total = awaitingCount({ pending, approvals, questions });
  if (total === 0 && notice === undefined) return null;
  const chipOf = (project: string): { label: string; hue: string } => {
    const found = project === SHARED_SESSION ? projects.find((p) => p.kind === "shared") : projects.find((p) => p.project === project);
    if (project === SHARED_SESSION) return { label: found?.label ?? "Shared", hue: (found !== undefined ? hues[found.project] : undefined) ?? "var(--p0)" };
    return { label: found?.label ?? projectName(project), hue: hues[project] ?? "var(--p0)" };
  };
  const shown = [
    ...questions.slice(0, 2).map((item) => ({
      key: item.requestId,
      text: item.questions[0]?.question ?? "the agent has a question",
      title: item.questions.map((q) => q.question).join(" · "),
      taskId: item.taskId,
      project: item.project,
    })),
    ...approvals.slice(0, 2).map((item) => ({ key: item.requestId, text: item.command ?? item.tool, title: item.reason ?? "", taskId: item.taskId, project: item.project })),
    ...pending.slice(0, 2).map((item) => ({
      key: item.requestId,
      text: item.config?.prompt ?? item.component,
      title: item.component,
      taskId: item.taskId as string | undefined,
      project: item.project,
    })),
  ].slice(0, 3);
  return (
    <View flexDirection="row" alignItems="center" gap={12} paddingHorizontal={14} height={40} flexShrink={0} backgroundColor={t.v("panel") as never} {...(edge(t, { top: 1 }) as object)}>
      {total > 0 ? (
        <>
          <Txt register="app-title" spec={{ scale: 11.5 / 12.5 }} flexShrink={0}>
            Awaiting you
          </Txt>
          <Pill kind="waiting" n={total} title={`${total} waiting on you`} />
        </>
      ) : null}
      {shown.map((item, i) => (
        <Press
          key={item.key}
          onPress={() => (item.taskId ? onSelect(item.taskId, item.project) : undefined)}
          title={item.title}
          flexDirection="row"
          alignItems="center"
          gap={6}
          minWidth={0}
          maxWidth={320}
          flexShrink={1}
        >
          {i > 0 ? (
            <Txt spec={{ voice: "app", scale: 12 / 12.5, color: "tok-hint" }} flexShrink={0} marginRight={2}>
              ·
            </Txt>
          ) : null}
          <ProjectChip {...chipOf(item.project)} />
          <Txt register="data-text" spec={{ scale: 0.875 }} ellip minWidth={0} flexShrink={1}>
            {item.text}
          </Txt>
        </Press>
      ))}
      {total > shown.length ? (
        <Txt register="app-secondary" marginLeft="auto">
          +{total - shown.length} more
        </Txt>
      ) : null}
      {notice !== undefined ? <NoticeItem shown={notice} chip={chipOf(notice.notice.project)} now={now} onOpen={onOpenNotice} onDismiss={onDismissNotice} /> : null}
    </View>
  );
}

/** `.chip.strip-project`: the project's name on its hue, with the hue as a dot before it. */
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
      <View flex={1} />
      <View flexDirection="row" alignItems="center" gap={2} flexShrink={1} minWidth={0} maxWidth="60%">
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
