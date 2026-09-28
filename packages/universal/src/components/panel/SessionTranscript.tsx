import { useState, type JSX, type ReactNode } from "react";
import { Platform, Pressable } from "react-native";
import { View } from "@tamagui/core";
import type { SessionView, ViewId } from "@jaira/shared/browser";
import { messageReadingOf } from "@jaira/ui/messageReading";
import { typeKeyOf, useMessageTypes } from "@jaira/ui/messageTypes";
import type { EditMessage } from "@jaira/ui/transcriptView";
import { clockOf } from "@jaira/ui/runActivityModel";
import { blocksOf, endOfBlock, gapBetween, iconOf, startOfBlock, type MessageEntry, type TranscriptEntry, type WorkEntry } from "@jaira/ui/transcript";
import { Txt, edge, useHover } from "../../primitives";
import { useTokens } from "../../tokens";
import { Uncopied } from "../../app/Uncopied";
import { ValueView } from "./ValueView";
import { Markdown } from "../Markdown";
import { Icon } from "./Icon";
import { Empty } from "./RunTranscript";
import { MessageRail } from "./MessageRail";

/**
 * `transcriptView.tsx`'s `Transcript`, universal (decision 0015): what one session said — the messages,
 * and the work between them — over the same model (`entriesOf`, `blocksOf`, `gapBetween`). Copied: a
 * message said to the model (with the badge naming the workflow that wrote it), an answer, a stretch
 * of work that is one event. {@link Uncopied}: a tool call's row (`Tool`), a stretch of several steps
 * (`WorkSummary`), a pause between blocks (`GapMark`), a compaction, and a reading other than prose or
 * rendered markdown (`ValueView`'s code, JSON, form, table, diff …). The message rail — Copy, rewind,
 * fork, the type and reading chips, the clock — is the room it takes: the DOM's is invisible at rest
 * (`opacity: 0`), and its menus are not copied yet.
 *
 *   .ts                    column, padding 12 16 22
 *   .ts-msg-user           at the end, at most 78% wide, margin 14 0 10; .ts-msg-sent a column ending right
 *   .ts-msg-assistant      margin 10 0 14; .ts-msg-aside the same, 12 in, a 2px --rule on the left
 *   .ts-bubble             padding 8 13, radius 16 16 5 16, --accent 13% into --panel, 1px --accent 24% into
 *                          --line; sent: --accent 5%, a dashed --accent 30% edge
 *   .ts-source             pill: padding 1 7 1 5, 1px --accent 28% into --line on --accent 7% into --panel,
 *                          --dim 500 at --size-app × 10.5/12.5, gap 4, 4 under; the glyph 11, --accent
 *   .ts-rail               at least 22 tall, 4 above
 *   .ts-msg .vv-source     the app voice at --size-app × 13/12.5, line 1.6, --text, pre-wrap
 *   .vv-body > .markdown   --size-app × 12.5/12.5, line 1.65 in a message, padding 2 2 12, no end margins
 *   .ts-work               column, margin 6 −6 10
 *   .ts-row-line           row, centred, gap 7, padding 3 6, radius 6; .ts-icon 16 wide (the glyph 14);
 *                          .ts-preview flex 1, ellipsed (prose: app voice 12/12.5), --dim; .ts-at data
 *                          11/12 --dim; .ts-chev, .ts-mark 14 wide. muted: the icon --tok-hint
 */
export function Transcript({
  session,
  entries,
  empty,
  narrated,
  doomedFrom,
  onEdit,
  scope,
  rails = false,
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
  /** The live tail and whether the record is still being written — taken for the Chat view's call; not drawn yet. */
  live?: unknown;
  working?: boolean | undefined;
}): JSX.Element {
  const shown = narrated === true ? entries.filter((entry) => entry.kind !== "writing") : entries;
  if (shown.length === 0) return <Empty>{empty ?? session?.empty ?? "Nothing has been said here yet."}</Empty>;
  const blocks = blocksOf(shown);
  // What an armed cut takes, counted once: the messages at or past the turn, replies included.
  const doomedCount = doomedFrom === undefined ? 0 : shown.filter((entry) => entry.kind === "message" && entry.turn !== undefined && entry.turn >= doomedFrom).length;
  let doomed = false;
  return (
    <View flexDirection="column" width="100%" paddingTop={12} paddingHorizontal={16} paddingBottom={22} minWidth={0}>
      {blocks.map((block, i) => {
        // Once a doomed message has gone by, everything under it goes too.
        const crossed = !doomed && doomedFrom !== undefined && block.kind === "message" && block.turn !== undefined && block.turn >= doomedFrom;
        if (crossed) doomed = true;
        const cutLine = crossed ? <CutLine key={`cut-${i}`} count={doomedCount} /> : null;
        const fade = doomed ? { opacity: 0.38 } : {};
        const gap = gapBetween(endOfBlock(blocks[i - 1]), startOfBlock(block));
        const before = gap === undefined ? null : <Uncopied name={`a pause (${gap.label})`} />;
        if (block.kind === "work") {
          return (
            <View key={i} minWidth={0}>
              {before}
              {cutLine}
              <View minWidth={0} {...fade}>
                <Work entries={block.entries} />
              </View>
            </View>
          );
        }
        if (block.kind === "compaction") return <Uncopied key={i} name="a compaction line" />;
        if (block.kind === "message") {
          return (
            <View key={i} minWidth={0} {...(block.role === "user" ? { alignSelf: "flex-end", maxWidth: "78%" } : {})}>
              {before}
              {cutLine}
              <Message
                entry={block}
                {...(session?.stateId !== undefined ? { workflow: session.stateId } : {})}
                {...(rails ? { rails: { onEdit, scope } } : {})}
                doomed={doomed}
              />
            </View>
          );
        }
        return (
          <View key={i} minWidth={0} marginTop={10} marginBottom={14} {...fade}>
            <Txt spec={{ voice: "app", scale: 13 / 12.5, lineHeight: 1.6 }} whiteSpace="pre-wrap">
              {block.text}
            </Txt>
          </View>
        );
      })}
    </View>
  );
}

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

/** A stretch of work: one line is its own row (`WorkBlockView`); more are summarised — not copied yet. */
function Work({ entries }: { entries: WorkEntry[] }): JSX.Element {
  if (entries.length !== 1) return <Uncopied name={`the work summary (${entries.length} steps)`} />;
  const entry = entries[0]!;
  if (entry.kind !== "event") return <Uncopied name={`a ${entry.kind} row`} />;
  return (
    <View flexDirection="column" minWidth={0} marginTop={6} marginHorizontal={-6} marginBottom={10}>
      <Row entry={entry} preview={entry.text} tone={entry.tone === "plain" ? "muted" : entry.tone} prose canOpen={entry.detail !== undefined} />
    </View>
  );
}

/** `Row`: one line of work — its glyph, what it was, when, and whether it opens. The body is not copied. */
function Row({ entry, preview, tone, prose, canOpen }: { entry: WorkEntry; preview: string; tone: "muted" | "warn" | "bad"; prose: boolean; canOpen: boolean }): JSX.Element {
  const t = useTokens();
  const ink = tone === "warn" ? "warn" : tone === "bad" ? "bad" : "dim";
  return (
    <View borderRadius={6} minWidth={0}>
      <View flexDirection="row" alignItems="center" gap={7} paddingVertical={3} paddingHorizontal={6} borderRadius={6} width="100%" minWidth={0}>
        <View width={16} flexShrink={0} alignItems="center" justifyContent="center">
          <Icon name={iconOf(entry)} size={14} color={String(t.v(tone === "muted" ? "tok-hint" : ink))} />
        </View>
        <Txt spec={prose ? { voice: "app", scale: 12 / 12.5, color: ink } : { voice: "data", scale: 11.5 / 12, color: ink }} ellip flex={1} minWidth={0}>
          {preview}
        </Txt>
        <Txt spec={{ voice: "data", scale: 11 / 12, color: "dim", tabular: true }} flexShrink={0}>
          {clockOf(entry.at)}
        </Txt>
        <View width={14} flexShrink={0}>
          {canOpen ? <Icon name="chevron" size={14} color={String(t.v("tok-hint"))} /> : null}
        </View>
        <View width={14} flexShrink={0} />
      </View>
    </View>
  );
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
}: {
  entry: MessageEntry;
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
        shown={hovered || held}
        onEdit={rails.onEdit}
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

  const chip = { voice: "app" as const, scale: 10.5 / 12.5, weight: 500, color: "dim" };
  const source =
    entry.by !== undefined ? (
      <View
        flexDirection="row"
        alignItems="center"
        gap={4}
        marginBottom={4}
        paddingTop={1}
        paddingRight={7}
        paddingBottom={1}
        paddingLeft={5}
        borderRadius={999}
        borderWidth={1}
        borderStyle="solid"
        borderColor={t.mix(t.v("accent"), 28, t.v("line")) as never}
        backgroundColor={t.mix(t.v("accent"), 7, t.v("panel")) as never}
      >
        <Icon name={entry.by === "workflow" ? "workflow" : "send"} size={11} color={String(t.v("accent"))} />
        {/* Flex items, as the DOM's are: "From" and the name are the pill's own children, 4 apart. */}
        {entry.by === "workflow" && workflow !== undefined ? (
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
            {entry.by === "workflow" ? "From the workflow" : "Written by JaiRA"}
          </Txt>
        )}
      </View>
    ) : null;
  if (entry.role === "user") {
    const sent = entry.by !== undefined;
    return (
      <Reach reach={reach} minWidth={0} marginTop={14} marginBottom={10} {...(doomed ? { opacity: 0.38 } : {})} {...(sent ? { flexDirection: "column", alignItems: "flex-end" } : {})}>
        {source}
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
      <Reach reach={reach} minWidth={0} marginTop={10} marginBottom={14} {...(doomed ? { opacity: 0.38 } : {})}>
        {said || entry.output !== undefined ? body : <Empty>(no answer was recorded)</Empty>}
        {rail}
      </Reach>
    );
  }
  return (
    <Reach reach={reach} minWidth={0} marginTop={10} marginBottom={14} paddingTop={1} paddingBottom={1} paddingLeft={12} {...(doomed ? { opacity: 0.38 } : {})} {...(edge(t, { left: 2 }, "rule") as object)}>
      <Txt spec={{ voice: "app", scale: 10 / 12.5, weight: 600, upper: true, ls: 0.07, color: "warn" }} marginBottom={3}>
        {entry.role}
      </Txt>
      {said ? body : null}
      {rail}
    </Reach>
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
