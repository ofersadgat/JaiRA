import { useState, type JSX } from "react";
import { TextInput } from "react-native";
import { View, isWeb } from "@tamagui/core";
import type { TerminalSummary } from "@jaira/shared/browser";
import { runYours, signalTerminal } from "@jaira/ui/terminalStore";
import { TERM_INK, durationText, isWaiting, terminalStatusOf } from "@jaira/ui/terminalModel";
import { clockOf } from "@jaira/ui/runActivityModel";
import { ENTER_KEEPS_FOCUS, Press, Txt, edge, font } from "../../primitives";
import { useTokens } from "../../tokens";
import { Icon } from "../panel/Icon";
import { useTerminal, useTerminals } from "./useTerminal";

/**
 * The side panel's Terminals tab (decision 0028, ruling 7): the conversation's commands, its agents'
 * and the person's — running first (those waiting for the person at the top, each with its prompt and
 * `Answer it`), then ended — and a line to run one of your own in its workspace (ruling 8). A press
 * opens the terminal on the panel's stack. How it looks:
 *
 *   the run line     row, gap 8, padding 0 6 0 10, height 34, 1px --line, radius 8: `›`, the field
 *                    (data 12/12), Run
 *   a caption        data 10.5/12, 0.06em, uppercase, --dim; the count at the far end
 *   a running one    1px --line (waiting: --warn at 45%), radius 9: the glyph and the command (data
 *                    12/12 600) with Stop; who and how long (app 11.5/12.5 --dim); its last two lines on
 *                    the terminal's ground; waiting, `Answer it`
 *   an ended one     row, gap 8, height 28, padding 0 8, radius 6: ✓ or ✗, the command, its exit or
 *                    duration, its time
 */
export function TerminalsTab({ taskId, project, onOpen }: { taskId: string; project: string | undefined; onOpen: (terminal: TerminalSummary) => void }): JSX.Element {
  const list = useTerminals(taskId, project);
  const running = list.filter((one) => one.endedAt === undefined).sort((a, b) => Number(b.waiting === true) - Number(a.waiting === true) || a.startedAt - b.startedAt);
  const ended = list.filter((one) => one.endedAt !== undefined).reverse();
  return (
    <View flexDirection="column" gap={10} minWidth={0}>
      <RunLine taskId={taskId} project={project} onRan={onOpen} />
      {list.length === 0 ? (
        <Txt spec={{ voice: "app", scale: 12 / 12.5, color: "dim" }}>No commands yet. The agent's shell commands, and yours, are listed here as they run.</Txt>
      ) : null}
      {running.length > 0 ? <Caption words="Running" count={running.length} /> : null}
      {running.map((one) => (
        <Running key={one.callId} summary={one} project={project} onOpen={() => onOpen(one)} />
      ))}
      {ended.length > 0 ? <Caption words="Ended" count={ended.length} /> : null}
      <View flexDirection="column" minWidth={0}>
        {ended.map((one) => (
          <Ended key={one.callId} summary={one} onOpen={() => onOpen(one)} />
        ))}
      </View>
    </View>
  );
}

function Caption({ words, count }: { words: string; count: number }): JSX.Element {
  return (
    <View flexDirection="row" alignItems="center" marginTop={4}>
      <Txt spec={{ voice: "data", scale: 10.5 / 12, ls: 0.06, upper: true, color: "dim" }} flex={1}>
        {words}
      </Txt>
      <Txt spec={{ voice: "data", scale: 10.5 / 12, color: "dim" }}>{String(count)}</Txt>
    </View>
  );
}

function Running({ summary, project, onOpen }: { summary: TerminalSummary; project: string | undefined; onOpen: () => void }): JSX.Element {
  const t = useTokens();
  const copy = useTerminal(summary.taskId, summary.callId, project);
  const waiting = isWaiting(summary);
  const status = terminalStatusOf(summary, waiting, Date.now());
  const tail = copy?.screen.tail(2) ?? [];
  return (
    <Press
      onPress={onOpen}
      label={`Open ${summary.command}`}
      flexDirection="column"
      borderRadius={9}
      overflow="hidden"
      minWidth={0}
      borderWidth={1}
      borderStyle="solid"
      borderColor={(waiting ? t.mix(t.v("warn"), 45, "transparent") : t.v("line")) as never}
      box={({ hovered }) => ({ backgroundColor: hovered ? t.mix(t.v("accent"), 5, t.v("panel")) : t.v("panel") })}
    >
      <View flexDirection="row" alignItems="center" gap={8} paddingTop={8} paddingLeft={10} paddingRight={6} minWidth={0}>
        <Icon name="terminal" size={14} color={String(t.v(waiting ? "warn" : "accent"))} />
        <Txt spec={{ voice: "data", scale: 12 / 12, weight: 600 }} ellip flex={1} minWidth={0} title={summary.command}>
          {summary.command}
        </Txt>
        {waiting ? (
          <View paddingHorizontal={8} height={20} justifyContent="center" borderRadius={999} backgroundColor={t.v("tint-warn") as never}>
            <Txt spec={{ voice: "app", scale: 11 / 12.5, weight: 600, color: "warn" }}>waiting for you</Txt>
          </View>
        ) : null}
        <Press onPress={() => void signalTerminal(summary.taskId, summary.callId, "stop", project)} label="Stop it" title="end the command" width={24} height={22} alignItems="center" justifyContent="center" borderRadius={5} box={({ hovered }) => (hovered ? { backgroundColor: t.v("tint-bad") } : {})}>
          <Icon name="stop" size={10} color={String(t.v("bad"))} />
        </Press>
      </View>
      <Txt spec={{ voice: "app", scale: 11.5 / 12.5, color: "dim" }} paddingLeft={32} paddingRight={10} paddingBottom={6} numberOfLines={1}>
        {summary.by === "you" ? "You" : "Claude"}{summary.tool !== undefined ? ` · ${summary.tool}` : ""} · {status.text}
      </Txt>
      {tail.length > 0 ? (
        <View marginHorizontal={8} marginBottom={8} paddingVertical={6} paddingHorizontal={10} borderRadius={6} backgroundColor={TERM_INK.ground}>
          {tail.map((line, i) => (
            <Txt key={i} spec={{ voice: "data", scale: 11 / 12, color: TERM_INK.text, lineHeight: { px: 17 } }} numberOfLines={1} {...(isWeb ? { style: { whiteSpace: "pre" } } : {})}>
              {line.map((span) => span.text).join("") || " "}
            </Txt>
          ))}
        </View>
      ) : null}
      {waiting ? (
        <View flexDirection="row" paddingHorizontal={10} paddingBottom={8}>
          <View height={26} paddingHorizontal={12} justifyContent="center" borderRadius={6} backgroundColor={t.v("fill-accent") as never}>
            <Txt spec={{ voice: "app", scale: 12 / 12.5, weight: 600, color: "on-accent" }}>Answer it</Txt>
          </View>
        </View>
      ) : null}
    </Press>
  );
}

function Ended({ summary, onOpen }: { summary: TerminalSummary; onOpen: () => void }): JSX.Element {
  const t = useTokens();
  const ok = summary.exitCode === 0;
  const status = terminalStatusOf(summary, false, Date.now());
  return (
    <Press onPress={onOpen} label={`Open ${summary.command}`} flexDirection="row" alignItems="center" gap={8} height={28} paddingHorizontal={8} borderRadius={6} minWidth={0} box={({ hovered }) => (hovered ? { backgroundColor: t.v("fill-ghost-hover") } : {})}>
      <Icon name={ok ? "check" : "cross"} size={12} color={String(t.v(ok ? "ok" : summary.stopped === true ? "dim" : "bad"))} />
      <Txt spec={{ voice: "data", scale: 11.5 / 12 }} ellip flex={1} minWidth={0} title={summary.command}>
        {summary.command}
      </Txt>
      {summary.by === "you" ? <Txt spec={{ voice: "app", scale: 11 / 12.5, weight: 600, color: "accent" }}>you</Txt> : null}
      <Txt spec={{ voice: "data", scale: 11 / 12, color: ok ? "dim" : summary.stopped === true ? "dim" : "bad", tabular: true }}>{ok ? durationText((summary.endedAt ?? 0) - summary.startedAt) : status.text.split(" · ")[0]}</Txt>
      <Txt spec={{ voice: "app", scale: 11.5 / 12.5, color: "dim", tabular: true }}>{clockOf(summary.startedAt)}</Txt>
    </Press>
  );
}

/** Run a line of your own in the conversation's workspace (decision 0028, ruling 8). */
function RunLine({ taskId, project, onRan }: { taskId: string; project: string | undefined; onRan: (terminal: TerminalSummary) => void }): JSX.Element {
  const t = useTokens();
  const [text, setText] = useState("");
  const [failed, setFailed] = useState<string | null>(null);
  const run = (): void => {
    const command = text.trim();
    if (command.length === 0) return;
    setFailed(null);
    runYours(taskId, command, project).then(
      (summary) => {
        setText("");
        onRan(summary);
      },
      (error: unknown) => setFailed(error instanceof Error ? error.message : String(error)),
    );
  };
  return (
    <View flexDirection="column" gap={4}>
      <View flexDirection="row" alignItems="center" gap={8} height={34} paddingLeft={10} paddingRight={4} borderRadius={8} {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }) as object)}>
        <Txt spec={{ voice: "data", scale: 12 / 12, color: "accent" }}>›</Txt>
        <TextInput
          {...(ENTER_KEEPS_FOCUS as object)}
          value={text}
          onChangeText={setText}
          onSubmitEditing={run}
          placeholder="Run a command in this conversation's workspace"
          accessibilityLabel="Run a command in this conversation's workspace"
          autoCapitalize="none"
          autoCorrect={false}
          style={{ ...(font(t, { voice: "data", scale: 12 / 12, color: "text" }) as object), flex: 1, minWidth: 0, ...(isWeb ? { outlineStyle: "none" } : {}) } as never}
        />
        <Press onPress={run} label="Run it" disabled={text.trim().length === 0} height={26} paddingHorizontal={10} borderRadius={6} justifyContent="center" box={({ hovered }) => ({ backgroundColor: hovered ? t.v("fill-ghost-hover") : "transparent" })}>
          <Txt spec={{ voice: "app", scale: 12 / 12.5, weight: 600, color: text.trim().length === 0 ? "dim" : "accent" }}>Run</Txt>
        </Press>
      </View>
      <Txt spec={{ voice: "app", scale: 11 / 12.5, color: failed !== null ? "bad" : "dim" }}>{failed ?? "Runs as you: permission sets decide what an agent may run, not you. The agent hears of it with your next message."}</Txt>
    </View>
  );
}
