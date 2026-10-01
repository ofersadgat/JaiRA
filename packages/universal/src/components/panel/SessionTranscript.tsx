import { Fragment, memo, useContext, useState, type JSX, type ReactNode } from "react";
import { Platform, Pressable } from "react-native";
import { View, isWeb } from "@tamagui/core";
import type { MessageAuthor, SessionView, ViewId } from "@jaira/shared/browser";
import { MESSAGE_SOURCE, messageReadingOf, workflowSourceTitleOf } from "@jaira/ui/messageReading";
import { typeKeyOf, useMessageTypes } from "@jaira/ui/messageTypes";
import type { ArtifactSurface, EditMessage } from "@jaira/ui/transcriptView";
import { clockOf } from "@jaira/ui/runActivityModel";
import { blocksOf, dayLabelOf, endOfBlock, gapBetween, sidechainEntriesOf, startOfBlock, type LiveTail, type MessageEntry, type TranscriptEntry, type WorkEntry } from "@jaira/ui/transcript";
import { keptUnderSummary, type CallSurface } from "@jaira/ui/transcriptRows";
import { isIdle } from "@jaira/ui/workSummary";
import { WorkLookContext } from "@jaira/ui/workSummaryContext";
import { useValuePanel } from "@jaira/ui/valuePanel";
import type { ContextReading } from "@jaira/shared/browser";
import { Press, Txt, edge, useHover } from "../../primitives";
import { Pulse } from "../chat/Paper";
import { CompactionLine, GapMark } from "./TranscriptMarks";
import { Work, WorkColumn, type TranscriptOf } from "./WorkRows";
import { WorkSummary } from "./WorkSummary";
import { useTokens } from "../../tokens";
import { ValueView } from "./ValueView";
import { Markdown } from "../Markdown";
import { Icon } from "./Icon";
import { Empty } from "./RunTranscript";
import { MessageRail } from "./MessageRail";
import { baselineOf } from "./SessionBands";

/**
 * `transcriptView.tsx`'s `Transcript`, universal (decision 0015): what one session said — the messages,
 * and the work between them — over the same model (`entriesOf`, `blocksOf`, `gapBetween`). A message
 * said to the model (with the badge naming the workflow that wrote it — a button opening its definition
 * where the shell has a panel for it), an answer, a line of work of each kind (`WorkRows.tsx`), a stretch
 * of several steps summarised (`WorkSummary.tsx`), the pause before a block and a compaction
 * (`TranscriptMarks.tsx`), an armed cut, and the answer being written. A subagent's doorway walks into
 * its conversation where the host has somewhere for it (`onOpenSidechain`).
 * Not copied: a reading other than prose, rendered markdown, JSON, data or source (`ValueView`'s
 * table, form, diff …). The message rail — Copy, rewind, fork, the type and reading chips, the clock —
 * is `MessageRail.tsx`; without the host's controls it is only the room it takes (the DOM's is
 * invisible at rest).
 *
 *   .ts                    column, padding 12 16 22
 *   .ts-msg-user           at the end, at most 78% wide, margin 14 0 10; .ts-msg-sent a column ending right
 *   .ts-msg-assistant      margin 10 0 14; .ts-msg-aside the same, 12 in, a 2px --rule on the left
 *   .ts-bubble             padding 8 13, radius 16 16 5 16, --accent 13% into --panel, 1px --accent 24% into
 *                          --line; sent: --accent 5%, a dashed --accent 30% edge
 *   .ts-source             pill: padding 1 7 1 5, 1px --accent 28% into --line on --accent 7% into --panel,
 *                          --dim 500 at --size-app × 10.5/12.5, gap 4, 4 under; the glyph 11, --accent;
 *                          button.ts-source-link hovered: --accent 14% / 45%, --text; in a `.ts-tag`
 *                          8 after the role on its line, raised 1px
 *   .ts-rail               at least 22 tall, 4 above
 *   .ts-msg .vv-source     the app voice at --size-app × 13/12.5, line 1.6, --text, pre-wrap
 *   .vv-body > .markdown   --size-app × 12.5/12.5, line 1.65 in a message, padding 2 2 12, no end margins
 *   .ts-text-live          app 13/12.5 on 1.6, pre-wrap, --dim; .ts-live-line row, gap 7, 6 above,
 *                          app 11/12.5 --dim, a pulse
 *
 * Drawn again only when what it is handed changes (`memo`): the Chat view's box keeps its words in the
 * thread above it, so every key typed drew the whole conversation again — a long one, a few hundred
 * milliseconds a key.
 */
export const Transcript = memo(function Transcript({
  session,
  entries,
  empty,
  narrated,
  doomedFrom,
  onEdit,
  scope,
  rails = false,
  live,
  working,
  calls,
  onOpenSidechain,
  artifacts,
  padding = [12, 16, 22, 16],
}: {
  session: SessionView | null;
  entries: TranscriptEntry[];
  /** What to say when there is nothing (`Transcript`'s `empty`). */
  empty?: string | undefined;
  /** A live status line is saying what is happening: the row for a call being written goes. */
  narrated?: boolean | undefined;
  /** An armed cut: every message from this turn on is faded under one counted line. */
  doomedFrom?: number | undefined;
  /** Replacing, cutting and forking a message — the Chat view's (`EditMessage`). */
  onEdit?: EditMessage | undefined;
  /** What a reader's type corrections are remembered under (`messageTypes.ts`). */
  scope?: string | undefined;
  /** Draw each message's rail's controls (the Chat view's thread); otherwise only the room it takes. */
  rails?: boolean | undefined;
  /** The live tail behind the entries — for the subagents' conversations it streams. */
  live?: LiveTail | null | undefined;
  /** The record is still being written: the last stretch of work is drawn as in progress. */
  working?: boolean | undefined;
  /** Placement decisions for the call rows (`CallSurface`). */
  calls?: CallSurface | undefined;
  /** Walk into a subagent's conversation — the call that spawned it, and its name. Absent ⇒ no doorway goes anywhere. */
  onOpenSidechain?: ((call: string, name: string) => void) | undefined;
  /** How to show an artifact that RUNS, and where its messages go (`ArtifactSurface`). Absent ⇒ drawn inert. */
  artifacts?: ArtifactSurface | undefined;
  /** `.ts`'s padding — top, right, bottom, left — where a host sets another (a preview card's 8 12 10). */
  padding?: readonly [number, number, number, number];
}): JSX.Element {
  const shown = narrated === true ? entries.filter((entry) => entry.kind !== "writing") : entries;
  if (shown.length === 0) return <Empty>{empty ?? session?.empty ?? "Nothing has been said here yet."}</Empty>;
  const chains = session !== null && session !== undefined ? session.sidechains : undefined;
  const sidechainOf = chains !== undefined || live?.sidechains !== undefined ? (call: string) => sidechainEntriesOf(session ?? null, call, live?.sidechains?.[call]) : undefined;
  const blocks = blocksOf(shown);
  const writing = working ?? session?.status === "running";
  // What an armed cut takes, counted once: the messages at or past the turn, replies included.
  const doomedCount = doomedFrom === undefined ? 0 : shown.filter((entry) => entry.kind === "message" && entry.turn !== undefined && entry.turn >= doomedFrom).length;
  let doomed = false;
  // The context readings as the conversation goes: the last one seen, and whether a compaction was
  // drawn since — a reading that DROPS with none between gets a line of its own anyway.
  let lastContext: ContextReading | undefined;
  let compactedSince = false;
  return (
    <View flexDirection="column" width="100%" paddingTop={padding[0]} paddingRight={padding[1]} paddingBottom={padding[2]} paddingLeft={padding[3]} minWidth={0}>
      {blocks.map((block, i) => {
        // Once a doomed message has gone by, everything under it goes too.
        const crossed = !doomed && doomedFrom !== undefined && block.kind === "message" && block.turn !== undefined && block.turn >= doomedFrom;
        if (crossed) doomed = true;
        const cutLine = crossed ? <CutLine key={`cut-${i}`} count={doomedCount} /> : null;
        const fade = doomed ? { opacity: 0.38 } : {};
        const gap = gapBetween(endOfBlock(blocks[i - 1]), startOfBlock(block));
        const before = gap === undefined ? null : <GapMark gap={gap} />;
        if (block.kind === "work") {
          return (
            <Fragment key={i}>
              {before}
              {cutLine}
              <View minWidth={0} {...fade}>
                <WorkBlockView entries={block.entries} working={writing && i === blocks.length - 1} sidechainOf={sidechainOf} onOpenSidechain={onOpenSidechain} artifacts={artifacts} narrated={narrated} calls={calls} />
              </View>
            </Fragment>
          );
        }
        if (block.kind === "compaction") {
          compactedSince = true;
          return (
            <Fragment key={i}>
              {before}
              {cutLine}
              <CompactionLine trigger={block.trigger} before={block.before} after={block.after} durationMs={block.durationMs} window={lastContext?.window} />
            </Fragment>
          );
        }
        if (block.kind === "message") {
          const prior = lastContext;
          const context = block.context;
          // A reading far below the one before, with no compaction drawn between.
          const dropped =
            context !== undefined && prior !== undefined && !compactedSince && prior.used > 0 && context.used < prior.used * 0.6 ? (
              <CompactionLine derived before={prior.used} after={context.used} window={context.window ?? prior.window} />
            ) : null;
          if (context !== undefined) {
            lastContext = context;
            compactedSince = false;
          }
          return (
            <Fragment key={i}>
              {before}
              {cutLine}
              {dropped}
              <View minWidth={0} {...(block.role === "user" ? { alignSelf: "flex-end", maxWidth: "78%" } : {})}>
                <Message
                  entry={block}
                  {...(session?.stateId !== undefined ? { workflow: session.stateId } : {})}
                  {...(rails ? { rails: { onEdit, scope } } : {})}
                  {...(context !== undefined && prior !== undefined ? { contextBefore: prior } : {})}
                  doomed={doomed}
                />
              </View>
            </Fragment>
          );
        }
        return (
          <View key={i} minWidth={0} marginTop={10} marginBottom={14} {...fade}>
            {/* Plain text, not markdown: a half-arrived answer has half a fenced block in it. */}
            <Txt spec={{ voice: "app", scale: 13 / 12.5, lineHeight: 1.6, color: "dim" }} whiteSpace="pre-wrap" {...({ overflowWrap: "anywhere" } as object)}>
              {block.text}
            </Txt>
            {writing ? (
              <View flexDirection="row" alignItems="center" gap={7} marginTop={6}>
                <Pulse color="dim" />
                <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }}>writing…</Txt>
              </View>
            ) : null}
          </View>
        );
      })}
    </View>
  );
});

/** A sub-transcript, for a subagent's conversation under its call — its own doorways walk on, as the desktop's do. */
const Inner: TranscriptOf = ({ entries, working, onOpenSidechain, artifacts }) => <Transcript session={null} entries={entries} working={working} onOpenSidechain={onOpenSidechain} artifacts={artifacts} />;

/**
 * `.ts-cut`: the counted line over what an armed rewind would delete — a dashed rule each side of the
 * words (--bad 60% into --line), 6 above and 2 under, app 10.5/12.5 in --bad, lower case, 0.02em.
 */
function CutLine({ count }: { count: number }): JSX.Element {
  const t = useTokens();
  const rule = <View flex={1} {...(edge(t, { top: 1 }, t.mix(t.v("bad"), 60, t.v("line")), "dashed") as object)} />;
  return (
    <View flexDirection="row" alignItems="center" gap={10} marginTop={6} marginBottom={2} role="note">
      {rule}
      <Txt spec={{ voice: "app", scale: 10.5 / 12.5, color: "bad", ls: 0.02 }} numberOfLines={1}>
        {`${count} message${count === 1 ? "" : "s"} below this line will be deleted`.toLowerCase()}
      </Txt>
      {rule}
    </View>
  );
}

/**
 * `WorkBlockView`: a stretch of work between two messages — one line is its own row, more are
 * summarised (phases, chips and the latest rows).
 */
function WorkBlockView({
  entries,
  working,
  sidechainOf,
  onOpenSidechain,
  artifacts,
  narrated,
  calls,
}: {
  entries: WorkEntry[];
  working: boolean;
  sidechainOf?: ((call: string) => TranscriptEntry[]) | undefined;
  onOpenSidechain?: ((call: string, name: string) => void) | undefined;
  artifacts?: ArtifactSurface | undefined;
  narrated?: boolean | undefined;
  calls?: CallSurface | undefined;
}): JSX.Element | null {
  const look = useContext(WorkLookContext);
  const rowOf = (index: number): ReactNode => <Work entry={entries[index]!} open={working} sidechainOf={sidechainOf} onOpenSidechain={onOpenSidechain} artifacts={artifacts} narrated={narrated} calls={calls} transcript={Inner} />;
  // A stretch of nothing but rate limits and notes did no work: hidden, it is not drawn at all.
  if ((look.notes === "hide-blocks" || look.notes === "hide") && isIdle(entries, entries.map((_, i) => i))) return null;
  // One line has nothing to summarise.
  if (entries.length === 1) return <WorkColumn>{rowOf(0)}</WorkColumn>;
  const kept = entries.flatMap((entry, index) => (keptUnderSummary(entry, calls) ? [index] : []));
  return <WorkSummary entries={entries} working={working} kept={kept} rowOf={rowOf} clock={clockOf} />;
}

/**
 * `Message`: something that was said — an instruction as a bubble on the right, an answer as a
 * document, anything else as an aside with a rule down its left. Its reading is `viewsFor`'s first, as
 * the DOM's is when nobody has picked another.
 */
function Message({
  entry,
  workflow,
  rails,
  doomed = false,
  contextBefore,
}: {
  entry: MessageEntry;
  /** The reading on the answer before this one (the rail's context badge measures from it). */
  contextBefore?: ContextReading | undefined;
  workflow?: string | undefined;
  /** The rail's controls, where the host draws them (`MessageRail.tsx`). */
  rails?: { onEdit: EditMessage | undefined; scope: string | undefined } | undefined;
  /** Past an armed cut: faded, the bubble on --panel-2 with a --line edge (`.ts-doomed`). */
  doomed?: boolean;
}): JSX.Element {
  const t = useTokens();
  const said = entry.text !== undefined && entry.text.length > 0;
  const value = entry.output !== undefined ? entry.output.value : (entry.text ?? "");
  // A reading somebody picked on the rail, and a type somebody asserted — the rail's; absent, the
  // first reading of what JaiRA detected, as the DOM's is when nobody has picked another.
  const [picked, setPicked] = useState<ViewId | null>(null);
  const types = useMessageTypes();
  const [local, setLocal] = useState<string | null | undefined>(undefined);
  const msgKey = rails?.scope !== undefined && entry.turn !== undefined ? typeKeyOf(rails.scope, entry.turn) : undefined;
  const convKey = rails?.scope !== undefined ? typeKeyOf(rails.scope) : undefined;
  const forConversation = convKey === undefined ? undefined : types?.get(convKey);
  const own = local === undefined ? (msgKey === undefined ? undefined : types?.get(msgKey)) : (local ?? undefined);
  const override = rails !== undefined ? (own ?? forConversation) : undefined;
  const reading = messageReadingOf(entry, value, override, picked);
  const view = reading.view;
  const [hovered, hover] = useHover();
  const [held, setHeld] = useState(false);
  const body =
    view === "markdown" && typeof value === "string" ? (
      <Markdown text={value} scale={12.5 / 12.5} lineHeight={1.65} trimEnd padding={[2, 2, 12, 2]} />
    ) : view === "text" && typeof value === "string" ? (
      // The line height as the stylesheet writes it (unitless) on web: Blink multiplies it out in float
      // and floors to its layout unit, so five lines of 13 × 1.6 are 103.98 tall, not 104.
      <Txt spec={{ voice: "app", scale: 13 / 12.5, lineHeight: 1.6, color: entry.role === "user" || entry.role === "assistant" ? "text" : "dim" }} whiteSpace="pre-wrap" {...({ overflowWrap: "anywhere" } as object)} {...(Platform.OS === "web" ? { lineHeight: "1.6" } : {})}>
        {value}
      </Txt>
    ) : (
      <ValueView value={value} hint={reading.hint} view={view} chrome={false} />
    );
  // The rail's room: invisible at rest, as the DOM's is. A row of 21px controls, 4 above. With the host's
  // controls it shows under the pointer (web) or once the message is long-pressed (a phone).
  const rail =
    rails === undefined ? (
      <View marginTop={4} minHeight={22} paddingHorizontal={1} />
    ) : (
      <MessageRail
        entry={entry}
        value={value}
        reading={reading}
        onPick={setPicked}
        picked={picked !== null}
        shown={hovered || held}
        onEdit={rails.onEdit}
        contextBefore={contextBefore}
        types={{
          own,
          override,
          conversation: convKey !== undefined,
          assert: (next, everywhere = false) => {
            if (everywhere) {
              if (convKey !== undefined) types?.set(convKey, next);
              if (msgKey !== undefined) types?.set(msgKey, undefined);
              setLocal(undefined);
              return;
            }
            setLocal(next);
            if (msgKey !== undefined) types?.set(msgKey, next);
          },
          clear: () => {
            setLocal(null);
            if (msgKey !== undefined) types?.set(msgKey, undefined);
            if (own === undefined && convKey !== undefined && forConversation !== undefined) types?.set(convKey, undefined);
          },
        }}
      />
    );
  /** Where the pointer and a long press reach the message (only with the host's rail). */
  const reach = rails === undefined ? {} : { ...(hover as object), ...(Platform.OS !== "web" ? { onLongPress: () => setHeld((was) => !was) } : {}) };

  // `data-day`: what the day chip over the scroller reads (web; a phone's chip is not drawn).
  const day = dayLabelOf(entry.at);
  const stamped = isWeb && day !== undefined ? { "data-day": day } : {};
  // The workflow's words open its definition — the file they were written in (`panel.openState`).
  const panel = useValuePanel();
  const openState = panel?.openState;
  const opens = entry.by === "workflow" && workflow !== undefined && openState !== undefined ? () => openState(workflow) : undefined;
  const source = (tagged: boolean): ReactNode => (entry.by !== undefined ? <Source by={entry.by} workflow={workflow} onOpen={opens} tagged={tagged} /> : null);
  if (entry.role === "user") {
    const sent = entry.by !== undefined;
    return (
      <Reach reach={reach} {...stamped} minWidth={0} marginTop={14} marginBottom={10} {...(doomed ? { opacity: 0.38 } : {})} {...(sent ? { flexDirection: "column", alignItems: "flex-end" } : {})}>
        {source(false)}
        <View
          paddingVertical={8}
          paddingHorizontal={13}
          borderTopLeftRadius={16}
          borderTopRightRadius={16}
          borderBottomLeftRadius={16}
          borderBottomRightRadius={5}
          borderWidth={1}
          borderStyle={sent ? "dashed" : "solid"}
          borderColor={(doomed ? t.v("line") : t.mix(t.v("accent"), sent ? 30 : 24, t.v("line"))) as never}
          backgroundColor={(doomed ? t.v("panel-2") : t.mix(t.v("accent"), sent ? 5 : 13, t.v("panel"))) as never}
          maxWidth="100%"
        >
          {said ? body : <Txt spec={{ voice: "app", scale: 13 / 12.5, color: "dim" }}>(empty)</Txt>}
        </View>
        {rail}
      </Reach>
    );
  }
  if (entry.role === "assistant") {
    return (
      <Reach reach={reach} {...stamped} minWidth={0} marginTop={10} marginBottom={14} {...(doomed ? { opacity: 0.38 } : {})}>
        {said || entry.output !== undefined ? body : <Empty>(no answer was recorded)</Empty>}
        {rail}
      </Reach>
    );
  }
  return (
    <Reach reach={reach} {...stamped} minWidth={0} marginTop={10} marginBottom={14} paddingTop={1} paddingBottom={1} paddingLeft={12} {...(doomed ? { opacity: 0.38 } : {})} {...(edge(t, { left: 2 }, "rule") as object)}>
      {entry.by !== undefined ? (
        <TagLine role={entry.role}>{source(true)}</TagLine>
      ) : (
        <Txt spec={{ voice: "app", scale: 10 / 12.5, weight: 600, upper: true, ls: 0.07, color: "warn" }} marginBottom={3}>
          {entry.role}
        </Txt>
      )}
      {said ? body : null}
      {rail}
    </Reach>
  );
}

/**
 * `MessageSource`: the badge on a message the person did not type — WHO wrote it, in a word, the rest
 * on the tooltip (`MESSAGE_SOURCE`, the desktop's words). The workflow's words name the workflow and,
 * where the shell can open its definition, are a button that does.
 */
function Source({ by, workflow, onOpen, tagged }: { by: MessageAuthor; workflow: string | undefined; onOpen: (() => void) | undefined; tagged: boolean }): JSX.Element {
  const t = useTokens();
  const said = MESSAGE_SOURCE[by];
  const named = by === "workflow" && workflow !== undefined;
  const title = named ? workflowSourceTitleOf(workflow, onOpen !== undefined) : said.title;
  const pill = (hovered: boolean): Record<string, unknown> => ({
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingTop: 1,
    paddingRight: 7,
    paddingBottom: 1,
    paddingLeft: 5,
    borderRadius: 999,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: t.mix(t.v("accent"), hovered ? 45 : 28, t.v("line")),
    backgroundColor: t.mix(t.v("accent"), hovered ? 14 : 7, t.v("panel")),
  });
  const words = (hovered: boolean): JSX.Element => {
    const chip = { voice: "app" as const, scale: 10.5 / 12.5, weight: 500, color: hovered ? "text" : "dim" };
    return (
      <>
        <Icon name={said.icon} size={11} color={String(t.v("accent"))} />
        {/* Flex items, as the DOM's are: "From" and the name are the pill's own children, 4 apart. */}
        {named ? (
          <>
            <Txt spec={chip} numberOfLines={1}>
              From
            </Txt>
            <Txt spec={chip} numberOfLines={1}>
              {workflow}
            </Txt>
          </>
        ) : (
          <Txt spec={chip} numberOfLines={1}>
            {said.label}
          </Txt>
        )}
      </>
    );
  };
  const place = tagged ? { marginLeft: 8 } : { marginBottom: 4 };
  if (named && onOpen !== undefined) {
    return (
      <Press onPress={onOpen} title={title} flexShrink={0} {...place} box={({ hovered }) => pill(hovered)}>
        {({ hovered }) => words(hovered)}
      </Press>
    );
  }
  return (
    <View {...(pill(false) as object)} {...place} {...({ title } as object)}>
      {words(false)}
    </View>
  );
}

/**
 * `.ts-tag` with the badge in it: the role, then the pill 8 after it on the same line, raised 1px
 * (`vertical-align: 1px`). The two stand on one baseline in a line as tall as the taller of them,
 * placed as Blink places them: the role's where DM Sans' rounded ascent puts it (`baselineOf`), the
 * pill's at the foot of its icon — an inline-flex box's baseline is its first item's, and an `svg` has
 * none of its own; 3 under.
 */
function TagLine({ role, children }: { role: string; children: ReactNode }): JSX.Element {
  const t = useTokens();
  const tag = Number(t.scaled("size-app", 10 / 12.5)) || 10;
  const chip = Number(t.scaled("size-app", 10.5 / 12.5)) || 10.5;
  const tagBase = baselineOf(tag, 0.992, 0.31);
  // The pill's 11px icon, centred on its text line, inside a 1px border and 1px of padding.
  const chipBase = 2 + (chip * 1.5 - 11) / 2 + 11;
  const line = Math.max(tagBase, chipBase + 1);
  return (
    <View flexDirection="row" alignItems="flex-start" marginBottom={3} minWidth={0}>
      <Txt spec={{ voice: "app", scale: 10 / 12.5, weight: 600, upper: true, ls: 0.07, color: "warn" }} marginTop={line - tagBase} flexShrink={0}>
        {role}
      </Txt>
      <View marginTop={line - 1 - chipBase} flexShrink={0}>
        {children}
      </View>
    </View>
  );
}

/**
 * A message's box, reachable: the pointer's hover on web, a long press on a phone (which toggles the
 * rail, as keyboard focus does on the desktop). A plain box when the host draws no rail.
 */
function Reach({ reach, children, ...box }: { reach: Record<string, unknown>; children: ReactNode } & Record<string, unknown>): JSX.Element {
  if (typeof reach.onLongPress === "function") {
    return (
      <Pressable onLongPress={reach.onLongPress as () => void} style={{ minWidth: 0 }}>
        <View {...(box as object)}>{children}</View>
      </Pressable>
    );
  }
  return (
    <View {...(reach as object)} {...(box as object)}>
      {children}
    </View>
  );
}
