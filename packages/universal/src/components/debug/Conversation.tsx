import type { JSX } from "react";
import { View } from "@tamagui/core";
import type { ConversationTurn, ConversationView } from "@jaira/shared/browser";
import { BADGE } from "@jaira/ui/panelFaceModel";
import { Txt, edge, type FontSpec } from "../../primitives";
import { useTokens, type Tokens } from "../../tokens";
import { Button } from "../settings/Button";

/**
 * The journal read as turns — what the Debug room's self-test shows under its run. How it looks:
 *
 *   the block        column, gap 8, padding 12 14, the rest of its column
 *   its heading      app 700 at 11/12.5, 0.09em, uppercase, --dim; a row, space-between, gap 8, 8 below
 *                    (kept: the block is a flex column); the count at its end is written the same
 *   the turns        column, gap 7
 *   a turn           62 | the rest, 10 apart, top-aligned
 *   its role         app 10/12.5, 0.06em, uppercase, --dim, right-aligned, 2 above
 *   its body         row, wraps, baseline, gap 6, app 12.5/12.5
 *   the state        data 11/12, --accent;  the tool's name the same in --dim
 *   the text         wraps anywhere;  the data  data 10.5/12, --dim, wraps anywhere
 *   a TOOL turn      the data face through its row (the role and the text keep their sizes), in --dim
 *   a policy or a failed turn's text  --bad;  an output turn's  --ok
 *   waiting on you   row, centred, gap 9, padding 9 11, 1px --warn, radius 8, --bg, --warn
 *   an empty line    --dim, 8 above and below, a paragraph's margins (1em of the body's 13)
 */

/** How each turn kind introduces itself. Short, because the column is narrow and repeated. */
const TURN_ROLE: Record<string, string> = {
  operation: "state",
  tool: "tool",
  output: "output",
  policy: "policy",
  interaction: "waiting",
  failure: "failed",
  blocked: "blocked",
  transition: "→",
};

/** A size stated against the app voice (`calc(var(--size-app) * f)`), as a scale of the data voice. */
function appAt(t: Tokens, f: number): number {
  const app = t.v("size-app");
  const data = t.v("size-data");
  return typeof app === "number" && typeof data === "number" && data > 0 ? (f * app) / data : (f * 12.5) / 12;
}

export function Conversation({ conversation, waiting, onAnswer }: { conversation: ConversationView | null; waiting?: { component: string } | undefined; onAnswer?: () => void }): JSX.Element {
  const t = useTokens();
  if (!conversation) return <Empty>Select a task to see its conversation.</Empty>;
  if (conversation.turns.length === 0) return <Empty>This task has not run yet.</Empty>;
  const head: FontSpec = { voice: "app", scale: 11 / 12.5, weight: 700, ls: 0.09, upper: true, color: "dim" };
  return (
    <View flexDirection="column" flexGrow={1} flexShrink={1} flexBasis="auto" minHeight={0} paddingVertical={12} paddingHorizontal={14} gap={8}>
      <View flexDirection="row" alignItems="center" justifyContent="space-between" gap={8} marginBottom={8}>
        <Txt spec={head}>
          {"Conversation · "}
          {conversation.title}
        </Txt>
        <Txt spec={head}>{conversation.turns.length} turns</Txt>
      </View>
      <View flexDirection="column" gap={7} minHeight={0}>
        {conversation.turns.map((turn) => (
          <Turn key={`${turn.kind}-${turn.seq}`} turn={turn} t={t} />
        ))}
      </View>
      {waiting ? (
        // Pinned rather than in the flow: it is the one turn that is not history.
        <View flexDirection="row" alignItems="center" gap={9} paddingVertical={9} paddingHorizontal={11} borderRadius={8} backgroundColor={t.v("bg") as never} flexShrink={0} {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }, "warn") as object)}>
          <Txt spec={{ voice: "app", scale: 13 / 12.5, color: "warn" }} width={16} textAlign="center" flexShrink={0}>
            {BADGE["waiting_for_user"] ?? "·"}
          </Txt>
          <Txt spec={{ voice: "app", scale: 13 / 12.5, color: "warn" }} flex={1} minWidth={0}>
            {"Waiting on you — "}
            {waiting.component}
          </Txt>
          {onAnswer ? (
            <Button kind="primary" onPress={onAnswer}>
              Answer
            </Button>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/** One turn: its role in the 62 track, and what it said beside it. */
function Turn({ turn, t }: { turn: ConversationTurn; t: Tokens }): JSX.Element {
  // A tool turn's row: the data face, --dim, for everything that does not set its own.
  const tool = turn.kind === "tool";
  const text = turn.kind === "policy" || turn.ok === false ? "bad" : tool ? "dim" : turn.kind === "output" ? "ok" : "text";
  const role: FontSpec = tool ? { voice: "data", scale: appAt(t, 10 / 12.5), ls: 0.06, upper: true, color: "dim" } : { voice: "app", scale: 10 / 12.5, ls: 0.06, upper: true, color: "dim" };
  const body: FontSpec = tool ? { voice: "data", scale: appAt(t, 1), color: text } : { voice: "app", scale: 1, color: text };
  const wraps = { style: { overflowWrap: "anywhere" } } as object;
  return (
    <View flexDirection="row" alignItems="flex-start" gap={10}>
      <Txt spec={role} width={62} flexShrink={0} textAlign="right" paddingTop={2}>
        {TURN_ROLE[turn.kind] ?? turn.kind}
      </Txt>
      <View flex={1} minWidth={0} flexDirection="row" flexWrap="wrap" alignItems="baseline" gap={6}>
        {turn.stateId ? <Txt spec={{ voice: "data", scale: 11 / 12, color: "accent" }}>{turn.stateId}</Txt> : null}
        {turn.tool ? <Txt spec={{ voice: "data", scale: 11 / 12, color: "dim" }}>{turn.tool}</Txt> : null}
        {turn.text ? (
          <Txt spec={body} minWidth={0} {...wraps}>
            {turn.text}
          </Txt>
        ) : null}
        {turn.data !== undefined ? (
          <Txt spec={{ voice: "data", scale: 10.5 / 12, color: "dim" }} minWidth={0} {...wraps}>
            {JSON.stringify(turn.data)}
          </Txt>
        ) : null}
      </View>
    </View>
  );
}

/** An empty line: --dim, 8 above and below, and a paragraph's margins (1em of the body's 13). */
function Empty({ children }: { children: string }): JSX.Element {
  const t = useTokens();
  return (
    <Txt spec={{ voice: "app", scale: 13 / 12.5, color: "dim" }} paddingVertical={8} marginVertical={t.scaled("size-app", 13 / 12.5) as number}>
      {children}
    </Txt>
  );
}
