import { useState, type JSX, type ReactNode } from "react";
import { ScrollView } from "react-native";
import { View, isWeb } from "@tamagui/core";
import type { SessionRef, SessionTurn, SessionView } from "@jaira/shared/browser";
import type { JsonValue } from "@declarative-ai/json";
import { PLAIN_SCROLLER, Press, Txt, edge, scrollbarProps, type FontSpec } from "../../primitives";
import { useTokens, type Tokens } from "../../tokens";
import { Breathing, Caret } from "./motion";

/**
 * The conversation a state actually ran, as the Debug room's "What was actually said" draws it — the
 * task's states down one side, the chosen state's turns verbatim down the other. How it looks:
 *
 *   the panel            320 tall, 1px --line round, radius 8, clipped; 200 | the rest
 *   the states           scroll; 1px --line on their right; padding 6
 *   their heading        row, baseline, space-between, gap 6, margin 2 4 6; app 700 at 11/12.5, 0.04em,
 *                        uppercase, --dim; its count 400
 *   a state's row        row, centred, gap 6, padding 4 6, radius --control-radius-sm, app 12/12.5;
 *                        hovered --fill-ghost-hover; chosen --fill-ghost-selected at 600
 *   its cost             --dim, app 11/12.5, tabular
 *   a dot                7 round, --dim; a success --ok, an error --bad, running --accent (and
 *                        breathing on a phone, `motion.tsx`; a still picture holds none)
 *   the body             column, clipped
 *   its head             row, centred, gap 8, padding 6 10, 1px --line under, app 12/12.5; the agent's
 *                        handle --dim at 11/12.5 (the app face, not mono), one line
 *   the turns            scroll; padding 6 10
 *   a turn               row, gap 8, padding 5 0, 1px --line above (none on the first)
 *   its role             46 wide, app 10/12.5, 0.04em, uppercase, --dim, 2 above
 *   its text             data 11/12 on 1.45, wraps anywhere, as written (`pre-wrap`)
 *   its parts            column, gap 3, 4 above
 *   a part's head        row, baseline, gap 6, no disclosure marker; the kind app 10/12.5, 0.04em,
 *                        uppercase, --dim; the tool's name the data face at app 11/12.5
 *   a part, open         margin 4 0 6 12, app 11/12.5 in the UA's `monospace`, wraps anywhere, 220 at most
 *   the turn in writing  its role --accent, its text at 0.85, and a "▍" after it (blinking on a phone,
 *                        `motion.tsx`)
 *   an empty line        --dim, 8 above and below, a paragraph's margins (1em of the body's 13)
 */

/** A role chip. `user` is what the workflow sent; everything else is what came back. */
const ROLE_LABEL: Record<string, string> = { user: "sent", assistant: "reply", system: "system", tool: "tool" };

export interface SessionPanelProps {
  history: SessionRef[];
  session: SessionView | null;
  /** Which instance is being shown; null means the most recent. */
  showing: string | null;
  /** The answer being written right now, before it is a turn — shown only when it is this conversation's. */
  live?: { sessionId?: string; seq?: number; text: string } | null;
  onShow: (instanceId: string | null) => void;
}

const TABULAR = { fontVariant: ["tabular-nums"] } as object;

export function SessionPanel({ history, session, showing, live, onShow }: SessionPanelProps): JSX.Element {
  const t = useTokens();
  if (session === null) return <Empty t={t}>Select a task to see what it ran.</Empty>;
  const at = showing ?? session.instanceId;
  // Matched on the POSITION, not on the state id: a loop runs one state several times.
  const streaming = live != null && live.sessionId === session.sessionId && live.seq === session.seq ? live.text : undefined;
  const h3: FontSpec = { voice: "app", scale: 11 / 12.5, weight: 700, ls: 0.04, upper: true, color: "dim" };
  return (
    <View flexDirection="row" height={320} borderRadius={8} overflow="hidden" {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }) as object)}>
      <View width={200} flexShrink={0} minHeight={0} {...(edge(t, { right: 1 }) as object)}>
        <ScrollView style={PLAIN_SCROLLER} contentContainerStyle={{ ...PLAIN_SCROLLER, padding: 6 }} {...scrollbarProps(t)}>
          <View flexDirection="row" alignItems="baseline" justifyContent="space-between" gap={6} marginTop={2} marginHorizontal={4} marginBottom={6}>
            <Txt spec={h3}>States</Txt>
            <Txt spec={{ ...h3, weight: 400 }}>{String(history.length)}</Txt>
          </View>
          {history.map((row) => (
            <HistoryRow key={row.instanceId} row={row} sel={row.instanceId === at} onPress={() => onShow(row.instanceId)} t={t} />
          ))}
          {history.length === 0 ? <Empty t={t}>No model call yet.</Empty> : null}
        </ScrollView>
      </View>
      <View flex={1} minWidth={0} minHeight={0} flexDirection="column" overflow="hidden">
        <View flexDirection="row" alignItems="center" gap={8} paddingVertical={6} paddingHorizontal={10} {...(edge(t, { bottom: 1 }) as object)}>
          <Txt spec={{ voice: "app", scale: 12 / 12.5 }} flex={1} minWidth={0} ellip>
            {session.stateId || "—"}
          </Txt>
          {session.status !== undefined ? <Dot status={session.status} t={t} /> : null}
          {session.costUsd !== undefined ? (
            <Txt spec={{ voice: "app", scale: 12 / 12.5 }} flexShrink={0}>
              ${session.costUsd.toFixed(4)}
            </Txt>
          ) : null}
          {/* The agent's OWN handle, when it had one — what makes its native transcript findable. */}
          {session.providerSessionId !== undefined ? (
            <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }} ellip minWidth={0} flexShrink={1} {...(isWeb ? { title: session.providerSessionId } : {})}>
              {session.providerSessionId}
            </Txt>
          ) : null}
        </View>
        {/* An empty conversation is an ANSWER — a function op ran no model call. */}
        {session.empty !== undefined ? <Empty t={t}>{session.empty}</Empty> : null}
        <ScrollView style={{ ...PLAIN_SCROLLER, flexGrow: 0, flexShrink: 1 }} contentContainerStyle={{ ...PLAIN_SCROLLER, paddingVertical: 6, paddingHorizontal: 10 }} {...scrollbarProps(t)}>
          {session.turns.map((turn, i) => (
            <Turn key={i} turn={turn} first={i === 0} t={t} />
          ))}
          {/* Marked as unfinished rather than shown as an ordinary turn: it may still change. */}
          {streaming !== undefined ? <Turn turn={{ role: "assistant", text: streaming }} first={session.turns.length === 0} live t={t} /> : null}
        </ScrollView>
      </View>
    </View>
  );
}

/** A state's row: its dot, the state, and what the call cost. */
function HistoryRow({ row, sel, onPress, t }: { row: SessionRef; sel: boolean; onPress: () => void; t: Tokens }): JSX.Element {
  const weight = sel ? 600 : 400;
  return (
    <Press
      onPress={onPress}
      title={`${row.sessionId} @ ${row.seq}`}
      flexDirection="row"
      alignItems="center"
      gap={6}
      paddingVertical={4}
      paddingHorizontal={6}
      borderRadius={t.v("control-radius-sm") as never}
      box={({ hovered }) => ({ backgroundColor: sel ? t.v("fill-ghost-selected") : hovered ? t.v("fill-ghost-hover") : "transparent" })}
    >
      <Dot status={row.status ?? "unknown"} t={t} />
      <Txt spec={{ voice: "app", scale: 12 / 12.5, weight }} flex={1} minWidth={0} ellip>
        {row.stateId}
      </Txt>
      {row.costUsd !== undefined ? (
        <Txt spec={{ voice: "app", scale: 11 / 12.5, weight, color: "dim" }} flexShrink={0} {...({ style: TABULAR } as object)}>
          ${row.costUsd.toFixed(3)}
        </Txt>
      ) : null}
    </Press>
  );
}

/** A call's dot: 7 round, in the colour of how the call ended. */
function Dot({ status, t }: { status: string; t: Tokens }): JSX.Element {
  const ink = status === "success" ? "ok" : status === "error" ? "bad" : status === "running" ? "accent" : "dim";
  const dot = <View width={7} height={7} borderRadius={999} flexShrink={0} backgroundColor={t.v(ink) as never} />;
  // Not a verdict: a call that has not ended breathes (`motion.tsx`) — on a phone; on web it stands still.
  return status === "running" ? <Breathing>{dot}</Breathing> : dot;
}

/** A turn: the role in its 46, and the text and the calls beside it. */
function Turn({ turn, first, live = false, t }: { turn: SessionTurn; first: boolean; live?: boolean; t: Tokens }): JSX.Element {
  const role = live ? "writing" : ROLE_LABEL[turn.role] ?? turn.role;
  return (
    <View flexDirection="row" gap={8} paddingVertical={5} {...(first ? {} : (edge(t, { top: 1 }) as object))}>
      {/* A word longer than the 46 runs past it: no breaking inside a word. */}
      <Txt spec={{ voice: "app", scale: 10 / 12.5, ls: 0.04, upper: true, color: live ? "accent" : "dim" }} width={46} flexShrink={0} paddingTop={2} {...({ style: { overflowWrap: "normal" } } as object)}>
        {role}
        {/* Not typed by the person — the record's own mark (`MessageAuthor`). */}
        {!live && turn.by !== undefined ? ` · ${turn.by === "host" ? "by JaiRA" : "the workflow's"}` : null}
      </Txt>
      <View flex={1} minWidth={0}>
        {turn.text !== undefined ? (
          <Txt spec={{ voice: "data", scale: 11 / 12, lineHeight: 1.45 }} opacity={live ? 0.85 : 1} {...({ style: { whiteSpace: "pre-wrap", overflowWrap: "anywhere" } } as object)}>
            {turn.text}
            {live ? <Caret /> : null}
          </Txt>
        ) : null}
        {turn.parts !== undefined ? <Parts parts={turn.parts} t={t} /> : null}
      </View>
    </View>
  );
}

/** A turn's tool calls and results, each shut until pressed. */
function Parts({ parts, t }: { parts: JsonValue; t: Tokens }): JSX.Element | null {
  const list = Array.isArray(parts) ? parts : [];
  const calls = list.filter((p) => typeof (p as { type?: unknown })?.type === "string" && (p as { type: string }).type !== "text");
  if (calls.length === 0) return null;
  return (
    <View flexDirection="column" gap={3} marginTop={4}>
      {calls.map((part, i) => (
        <Part key={i} part={part as { type: string; toolName?: string; args?: unknown; result?: unknown; text?: string }} t={t} />
      ))}
    </View>
  );
}

function Part({ part, t }: { part: { type: string; toolName?: string; args?: unknown; result?: unknown; text?: string }; t: Tokens }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <View>
      <Press onPress={() => setOpen((v) => !v)} {...({ "aria-expanded": open } as object)} flexDirection="row" alignItems="baseline" gap={6} alignSelf="stretch">
        <Txt spec={{ voice: "app", scale: 10 / 12.5, ls: 0.04, upper: true, color: "dim" }}>{part.type}</Txt>
        {part.toolName !== undefined ? <Txt spec={{ voice: "data", scale: dataOfApp(t, 11 / 12.5) }}>{part.toolName}</Txt> : null}
      </Press>
      {open ? (
        <View marginTop={4} marginBottom={6} marginLeft={12} maxHeight={220} {...((isWeb ? { overflow: "auto" } : { overflow: "hidden" }) as object)}>
          <Txt spec={{ voice: "app", scale: 11 / 12.5 }} {...({ style: { whiteSpace: "pre-wrap", overflowWrap: "anywhere", ...(isWeb ? { fontFamily: "monospace" } : {}) } } as object)}>
            {JSON.stringify(part.args ?? part.result ?? part.text ?? part, null, 2)}
          </Txt>
        </View>
      ) : null}
    </View>
  );
}

/** A size stated against the app voice, as a scale of the data voice. */
function dataOfApp(t: Tokens, f: number): number {
  const app = t.v("size-app");
  const data = t.v("size-data");
  return typeof app === "number" && typeof data === "number" && data > 0 ? (f * app) / data : (f * 12.5) / 12;
}

/** An empty line: --dim, 8 above and below, and a paragraph's margins (1em of the body's 13). */
function Empty({ children, t }: { children: ReactNode; t: Tokens }): JSX.Element {
  return (
    <Txt spec={{ voice: "app", scale: 13 / 12.5, color: "dim" }} paddingVertical={8} marginVertical={t.scaled("size-app", 13 / 12.5) as number}>
      {children}
    </Txt>
  );
}
