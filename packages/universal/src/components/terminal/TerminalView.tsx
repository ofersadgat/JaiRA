import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type JSX, type ReactNode } from "react";
import { ScrollView, TextInput, type GestureResponderEvent } from "react-native";
import { Text, View, isWeb } from "@tamagui/core";
import { processEnded, type CommandDialect, type ProcessSummary } from "@jaira/shared/browser";
import { processStatusOf, statusBelow } from "@jaira/ui/processCardModel";
import { processes } from "@jaira/ui/processStore";
import { hueOf } from "@jaira/ui/approvalModel";
import { terminalEntryOf } from "@jaira/ui/panelStack";
import { commandLinesOf } from "@jaira/ui/transcript";
import { PLACES, type Place } from "@jaira/ui/splitModel";
import { invoke } from "@jaira/ui/store";
import { signalTerminal, typeInto } from "@jaira/ui/terminalStore";
import {
  TERM_INK,
  TermScreen,
  durationText,
  endsInText,
  isWaiting,
  promptChoicesOf,
  requestRowsOf,
  terminalStatusOf,
  terminalTitleOf,
  type TermLine,
  type TerminalTone,
} from "@jaira/ui/terminalModel";
import { base64Of } from "@jaira/ui/valueViewMeta";
import { copyText } from "../../clipboard";
import { ENTER_KEEPS_FOCUS, Press, Txt, edge, font } from "../../primitives";
import { useTokens, type Tokens } from "../../tokens";
import { moveEntry, useEntryPlaces, usePlacesHere } from "../../app/places";
import { usePhone } from "../../app/phone";
import type { MenuItem } from "@jaira/ui/menuTypes";
import { ContextMenu, MENU_WIDTH, type MenuAt } from "../Menu";
import { colorOf } from "../Sidebar";
import { Icon } from "../panel/Icon";
import { PlaceButtons } from "../panel/PlaceButtons";
import { PortChip, StatsLine, StatusText, TellClaude, useSampling } from "../process/ProcessParts";
import { CommandLine, CopyButton, Following, ScreenLine, WRAP_WEB } from "./TermParts";
import { useTerminal } from "./useTerminal";

/**
 * A shell command as a terminal (decision 0028), drawn like an artifact: in the conversation a card
 * under its row; in a pane or the side panel (`fill`) the same without its title bar, the head of what
 * holds it naming it. How it looks:
 *
 *   the card         1px --line (waiting: --warn at 45%), radius 10, on --panel; clipped
 *   the title bar    row, centred, gap 8, height 38, padding 0 8 0 10: the glyph box (18, radius 5,
 *                    --panel-3, --accent), the title (app 13/12.5 600), the status (app 12/12.5, in its
 *                    tone), a spacer, Stop while running, the place buttons, …
 *   the reading row  row, centred, gap 6, padding 0 8 8 10 (fill: 7 10, a --line under): the readings
 *                    as one joined switch (Terminal | Text | Command), a spacer, then (fill) the status,
 *                    Stop, the places and …, then Following while it runs, and Copy: what the reading shows
 *                    (the line on Command; `❯` and the line, then what it printed, on Terminal and Text)
 *   the screen       on the terminal's ground (#0f1120), padding 8 14 10, data 11.5/12 on 19px: the
 *                    command line taken apart as the approval takes it (each request on its hue at 22%,
 *                    what joins them dim), then what it printed, in its colours; the person's typing
 *                    marked. A card shows the last 12 lines, more a press away; a filled one scrolls,
 *                    following the end while Following is on. Text: the same, plain and selectable —
 *                    `❯` and the line as written, then what it printed; italic --dim when it printed nothing
 *   the choices      while it waits and its prompt names answers: a key per answer, its meaning beside
 *   the input line   while it runs: `›`, a field that sends a line to its stdin, Ctrl-C; while it
 *                    waits, when its time limit ends
 */
export interface TerminalViewProps {
  taskId: string;
  project?: string | undefined;
  callId: string;
  command: string;
  dialect: CommandDialect;
  /** Filling a pane or the side panel. */
  fill?: boolean;
  /** For a call the engine no longer keeps: what its result carried. */
  fallback?: { output: string; exitCode?: number | null } | undefined;
  /**
   * Opened in place from a row (the Terminals tab, decision 0032's view, ruling 2): the row became the
   * card's title bar, a chevron (down) at its start, and a press on it folds the card back to the row.
   */
  onFold?: (() => void) | undefined;
  /**
   * The engine's process whose output this terminal is (`run_in_background`, a command of this turn, a
   * process another tool call started); looked up by the terminal when not given. The card is then the process card (decision 0032, "The view", ruling 1) — named by its short name, its
   * status said as a process's, its stats line under the title bar (ports as links, pid, CPU, memory,
   * the load trace), "Tell Claude when it prints…" among the readings, and Stop through the engine.
   */
  process?: ProcessSummary | undefined;
  /** Filling a view whose head already says its status and carries Stop and the places (the process task view): no status row. */
  bare?: boolean;
}

type Reading = "terminal" | "text" | "command";

/** A command and what it printed, as the Text reading shows them and Copy takes them: `❯ line`, then the output. */
function shownText(command: string, output: string): string {
  return output.trim().length > 0 ? `❯ ${command}\n${output}` : `❯ ${command}`;
}

const CARD_LINES = 12;
const MORE_LINES = 400;
const FILL_LINES = 3_000;

const TONE: Record<TerminalTone, string> = { accent: "accent", warn: "warn", ok: "dim", bad: "bad", dim: "dim" };

export function TerminalView({ taskId, project, callId, command, dialect, fill = false, fallback, onFold, process: given, bare = false }: TerminalViewProps): JSX.Element {
  const t = useTokens();
  // Wherever a terminal is drawn — under a tool call, in the Terminals tab, placed — a process behind it
  // brings the process's controls with it: its stats, "Tell Claude when it prints…", Stop through the engine.
  const found = useProcessOfTerminal(given === undefined ? taskId : undefined, callId, project);
  const process = given ?? found;
  const copy = useTerminal(taskId, callId, project);
  const summary = copy?.summary;
  const running = summary !== undefined ? summary.endedAt === undefined : process !== undefined && !processEnded(process.state);
  useSampling(process !== undefined && running);
  const [width, setWidth] = useState<number | undefined>(undefined);
  // Narrow, or opened in place in a row, the status drops under the name rather than being squeezed out.
  const below = !fill && statusBelow(width, onFold !== undefined);
  const waiting = summary !== undefined && isWaiting(summary);
  // A process another tool call started has no stdin a person can reach: it is watched and stopped.
  const typable = summary?.tool === undefined;
  const now = useTicking(running);
  const [reading, setReading] = useState<Reading>("terminal");
  const [following, setFollowing] = useState(true);
  const [more, setMore] = useState(false);
  const [menu, setMenu] = useState<MenuAt | null>(null);

  // What it printed: the engine's terminal, else the result it left.
  const kept = useMemo(() => {
    if (copy !== undefined) return copy.screen;
    if (fallback === undefined) return undefined;
    const screen = new TermScreen();
    screen.write(fallback.output);
    return screen;
  }, [copy, copy?.version, fallback]);

  const status = process !== undefined ? processStatusOf(process, now) : summary !== undefined ? terminalStatusOf(summary, waiting, now) : fallback !== undefined ? { text: fallback.exitCode === 0 || fallback.exitCode === undefined ? "ended" : `exit ${String(fallback.exitCode)}`, tone: (fallback.exitCode ?? 0) === 0 ? ("dim" as const) : ("bad" as const) } : { text: "not kept", tone: "dim" as const };
  const title = process?.name ?? terminalTitleOf(command, dialect);

  // The three places, as an artifact's (decision 0028, ruling 2).
  const entry = useMemo(() => terminalEntryOf({ taskId, project, callId, command, dialect }), [taskId, project, callId, command, dialect]);
  const lit = useEntryPlaces(entry.key);
  const phone = usePhone();
  const here = usePlacesHere(phone);
  const offered = PLACES.filter((place) => place === "main" || here[place] || lit.includes(place));
  const place = (target: Place): void => moveEntry(target, entry, lit, phone);

  const plain = (): string => kept?.plain() ?? "";
  const stop = (): void => void (process !== undefined ? processes.stop(process.key, "stop", project ?? process.project) : signalTerminal(taskId, callId, "stop", project));
  const stoppable = running && process?.protected === undefined;
  const interrupt = (): void => void signalTerminal(taskId, callId, "interrupt", project);
  const openMenu = (e: GestureResponderEvent): void => {
    const at = pressedAt(e);
    setMenu({
      x: at.x - MENU_WIDTH,
      y: at.y,
      items: terminalMenuOf({ offered, lit, place, running, typable, following: { on: following, toggle: () => setFollowing((v) => !v) }, lines: kept?.count ?? 0, plain, command, title, stop, interrupt }),
    });
  };

  const verbs = (
    <>
      {stoppable ? <StopButton onPress={stop} /> : null}
      <PlaceButtons offered={offered} lit={lit} onPlace={place} />
      <MoreButton open={menu !== null} onPress={openMenu} />
    </>
  );

  const statusTail = `${summary?.shell !== undefined && summary.shell !== "emulated" && summary.shell !== "background" ? ` · live ${summary.shell}` : ""}${summary?.by === "you" ? " · yours" : ""}${summary?.tool !== undefined ? ` · ${summary.tool}` : ""}`;
  const lines = kept === undefined ? [] : fill ? kept.tail(FILL_LINES) : kept.tail(more ? MORE_LINES : CARD_LINES);
  const earlier = kept === undefined ? 0 : Math.max(0, kept.count - lines.length - (kept.partial().length === 0 ? 1 : 0));
  const choices = waiting && kept !== undefined ? promptChoicesOf(kept.partial()) : [];
  const ends = summary !== undefined && waiting ? endsInText(summary, now) : undefined;

  return (
    <View
      flexDirection="column"
      minWidth={0}
      onLayout={(e) => setWidth(Math.round(e.nativeEvent.layout.width))}
      {...(fill ? { flex: 1, minHeight: 0 } : { borderRadius: 10, overflow: "hidden", backgroundColor: t.v("panel") as never, ...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }, waiting ? undefined : "line") as object) })}
      {...(!fill && waiting ? { borderWidth: 1, borderStyle: "solid", borderColor: t.mix(t.v("warn"), 45, "transparent") as never } : {})}
    >
      {!fill ? (
        <View flexDirection="row" alignItems="center" gap={8} height={38} paddingLeft={onFold !== undefined ? 6 : 10} paddingRight={8} minWidth={0}>
          <FoldHead onFold={onFold} label={`Fold ${title} back to its row`}>
            {onFold !== undefined ? (
              <View width={14} alignItems="center" justifyContent="center" flexShrink={0}>
                <Icon name="chevron" size={11} color={String(t.v("dim"))} />
              </View>
            ) : null}
            <View width={18} height={18} borderRadius={5} alignItems="center" justifyContent="center" flexShrink={0} backgroundColor={(waiting ? t.mix(t.v("warn"), 14, "transparent") : t.v("panel-3")) as never}>
              <Icon name="terminal" size={12} color={String(t.v(waiting ? "warn" : "accent"))} />
            </View>
            <Txt spec={{ voice: "app", scale: 13 / 12.5, weight: 600 }} numberOfLines={1} flexShrink={0} maxWidth="60%" {...((isWeb ? { title: process !== undefined ? `${commandLinesOf(process.command, dialect)}

pid ${process.pid}` : commandLinesOf(command, dialect) } : {}) as object)}>
              {title}
            </Txt>
            {below ? (
              <View flex={1} minWidth={0} flexDirection="row" alignItems="center" gap={6} overflow="hidden">
                {(process?.ports ?? []).slice(0, 1).map((port) => (
                  <PortChip key={port} port={port} />
                ))}
              </View>
            ) : (
              <Txt spec={{ voice: "app", scale: 12 / 12.5, color: TONE[status.tone], weight: status.tone === "warn" ? 600 : 400 }} ellip flex={1} minWidth={0}>
                {status.text}
                {statusTail}
              </Txt>
            )}
          </FoldHead>
          {verbs}
        </View>
      ) : null}

      {!fill && process !== undefined ? <StatsLine process={process} status={below ? status : undefined} /> : null}
      {!fill && process === undefined && below ? (
        <View paddingLeft={12} paddingRight={10} paddingBottom={8} minWidth={0}>
          <StatusText status={{ text: `${status.text}${statusTail}`, tone: status.tone }} />
        </View>
      ) : null}

      {fill && !bare ? (
        // Filling a pane or the panel, the title bar's other half: the status, Stop, the places and `…`.
        <View flexDirection="row" alignItems="center" gap={8} paddingVertical={7} paddingLeft={12} paddingRight={8} minWidth={0} {...(edge(t, { bottom: 1 }) as object)}>
          <Txt spec={{ voice: "app", scale: 12 / 12.5, color: TONE[status.tone], weight: status.tone === "warn" ? 600 : 400 }} ellip flex={1} minWidth={0}>
            {status.text}
            {summary?.shell !== undefined && summary.shell !== "emulated" && summary.shell !== "background" ? ` · live ${summary.shell}` : ""}{summary?.by === "you" ? " · yours" : ""}
          </Txt>
          {verbs}
        </View>
      ) : null}
      {fill && process !== undefined ? (
        <View paddingTop={7} minWidth={0} {...(edge(t, { bottom: 1 }) as object)}>
          <StatsLine process={process} />
        </View>
      ) : null}

      <View flexDirection="row" flexWrap="wrap" alignItems="center" gap={6} minWidth={0} {...(fill ? { paddingVertical: 7, paddingHorizontal: 10, ...(edge(t, { bottom: 1 }) as object) } : { paddingLeft: 10, paddingRight: 8, paddingBottom: 8 })}>
        <Readings reading={reading} onReading={setReading} />
        {process !== undefined ? <TellClaude process={process} project={project ?? process.project} /> : null}
        <View flex={1} />
        {running ? <Following on={following} onPress={() => setFollowing((v) => !v)} /> : null}
        <CopyButton label={reading === "command" ? "Copy the command" : "Copy the command and what it printed"} text={() => (reading === "command" ? command : shownText(command, plain()))} />
      </View>

      <View backgroundColor={TERM_INK.ground} paddingTop={8} paddingBottom={10} paddingHorizontal={14} minWidth={0} {...(fill ? { flex: 1, minHeight: 0 } : {})}>
        {reading === "command" ? (
          <CommandRows command={command} dialect={dialect} />
        ) : reading === "text" ? (
          // The command as it was written, then what it printed, as plain text to select — and a line
          // that says so when it printed nothing, so a quiet command is not read as a broken tab.
          <Scroller fill={fill} follow={following && running} signal={copy?.version ?? 0}>
            <Text {...(font(t, { voice: "data", scale: 11.5 / 12, lineHeight: { px: 19 } }) as object)} color={TERM_INK.text} {...(isWeb ? { style: { ...WRAP_WEB, userSelect: "text" } } : { selectable: true })}>
              {shownText(command, kept?.plain() ?? "")}
            </Text>
            {kept === undefined || kept.plain().length === 0 ? (
              <Txt spec={{ voice: "app", scale: 11.5 / 12.5, italic: true, color: TERM_INK.dim }}>{kept === undefined ? (running ? "starting…" : "The engine no longer keeps this command's output.") : running ? "Nothing printed yet." : "It printed nothing."}</Txt>
            ) : null}
          </Scroller>
        ) : (
          <Scroller fill={fill} follow={following && running} signal={copy?.version ?? 0} capped={!fill && more}>
            <View flexDirection="row" alignItems="flex-start" gap={8} minWidth={0}>
              <Text {...(font(t, { voice: "data", scale: 11.5 / 12, lineHeight: { px: 19 } }) as object)} color={TERM_INK.accent}>
                ❯
              </Text>
              <Text {...(font(t, { voice: "data", scale: 11.5 / 12, lineHeight: { px: 19 } }) as object)} color={TERM_INK.text} flex={1} minWidth={0} {...((isWeb ? { style: WRAP_WEB } : {}) as object)}>
                <CommandLine command={command} dialect={dialect} t={t} />
              </Text>
              {summary?.by === "you" ? <YouChip /> : null}
            </View>
            {earlier > 0 && !fill ? (
              <Press onPress={() => setMore((v) => !v)} alignSelf="flex-start" paddingVertical={1}>
                <Txt spec={{ voice: "app", scale: 11 / 12.5, color: TERM_INK.dim }}>{more ? "↓ fewer lines" : `↑ ${earlier} earlier line${earlier === 1 ? "" : "s"}`}</Txt>
              </Press>
            ) : null}
            {lines.map((line, i) => (
              <ScreenLine key={i} line={line} t={t} />
            ))}
            {kept === undefined ? (
              <Txt spec={{ voice: "app", scale: 11.5 / 12.5, italic: true, color: TERM_INK.dim }}>{running ? "starting…" : "The engine no longer keeps this command's output."}</Txt>
            ) : null}
          </Scroller>
        )}
      </View>

      {choices.length > 0 ? (
        <View flexDirection="row" flexWrap="wrap" gap={6} paddingHorizontal={12} paddingTop={8} paddingBottom={2} backgroundColor={TERM_INK.head}>
          {choices.map((choice) => (
            <Press
              key={choice.key}
              onPress={() => void typeInto(taskId, callId, choice.send, project)}
              label={`Answer ${choice.key}: ${choice.label}`}
              flexDirection="row"
              alignItems="center"
              gap={7}
              height={28}
              paddingLeft={4}
              paddingRight={10}
              borderRadius={7}
              borderWidth={1}
              borderStyle="solid"
              borderColor="#2f3358"
              box={({ hovered }) => ({ backgroundColor: hovered ? "#262a4d" : "#1b1e38" })}
            >
              <View minWidth={20} height={20} paddingHorizontal={4} borderRadius={4} alignItems="center" justifyContent="center" backgroundColor="#2a2e52">
                <Txt spec={{ voice: "data", scale: 11 / 12, weight: 600, color: "#eceefa" }}>{choice.key}</Txt>
              </View>
              <Txt spec={{ voice: "app", scale: 12 / 12.5, color: TERM_INK.text }}>{choice.label}</Txt>
            </Press>
          ))}
        </View>
      ) : null}

      {running && typable ? (
        <InputLine
          title={title}
          waiting={waiting}
          ends={ends}
          onSend={(text) => void typeInto(taskId, callId, `${text}\n`, project)}
          onInterrupt={interrupt}
        />
      ) : null}

      {menu !== null ? <ContextMenu anchor={menu} onClose={() => setMenu(null)} /> : null}
    </View>
  );
}

const PLACE_WORDS: Record<Place, string> = { main: "Open in the main view", split: "Open in a split", panel: "Open in the side panel" };

/**
 * A terminal's `…`: the same items wherever it is offered — the card's title bar, and a row of the
 * Terminals tab (decision 0032's view, ruling 2): the places (the one it is in marked), Follow while it
 * runs (the card only: a row has no screen to follow), copying, the log, and Ctrl-C and Stop while it runs.
 */
export function terminalMenuOf(of: {
  offered: readonly Place[];
  lit: readonly Place[];
  place: (place: Place) => void;
  running: boolean;
  typable: boolean;
  following?: { on: boolean; toggle: () => void } | undefined;
  lines: number;
  plain: () => string;
  command: string;
  title: string;
  stop: () => void;
  interrupt: () => void;
}): MenuItem[] {
  const program = of.title.split(" ")[0] ?? of.title;
  const follow = of.running && of.following !== undefined;
  return [
    ...of.offered.map((one) => ({ label: PLACE_WORDS[one], ...(of.lit.includes(one) ? { note: "here", disabled: one !== "panel" } : {}), onSelect: () => of.place(one) })),
    ...(follow ? [{ label: "Follow the output", separator: true, checked: of.following!.on, onSelect: of.following!.toggle }] : []),
    { label: "Copy the output", ...(follow ? {} : { separator: true }), note: `${of.lines} lines`, onSelect: () => void copyText(of.plain()) },
    { label: "Copy the command", onSelect: () => void copyText(of.command) },
    { label: "Download the log…", note: `${program}.log`, onSelect: () => void invoke("shell:saveFile", { name: `${program}.log`, data: base64Of(of.plain()) }).catch(() => undefined) },
    ...(of.running
      ? [
          ...(of.typable ? [{ label: "Send Ctrl-C", separator: true, note: "interrupt", onSelect: of.interrupt }] : []),
          { label: `Stop ${program}`, separator: true, danger: true, note: "ends the process", onSelect: of.stop },
        ]
      : []),
  ];
}

/** The title bar's glyph, title and status: a press that folds the card back to its row, when it was opened from one. */
function FoldHead({ onFold, label, children }: { onFold: (() => void) | undefined; label: string; children: ReactNode }): JSX.Element {
  if (onFold === undefined) return <>{children}</>;
  return (
    <Press onPress={onFold} label={label} {...({ "aria-expanded": true } as object)} flexDirection="row" alignItems="center" gap={8} flex={1} minWidth={0} alignSelf="stretch">
      {children}
    </Press>
  );
}

/** The engine's process a terminal is the output of, as the window knows it — none while `taskId` is undefined. */
function useProcessOfTerminal(taskId: string | undefined, callId: string, project: string | undefined): ProcessSummary | undefined {
  const snapshot = useCallback(() => (taskId === undefined ? undefined : processes.ofTerminal(taskId, callId)), [taskId, callId]);
  const found = useSyncExternalStore(processes.subscribe, snapshot, snapshot);
  useEffect(() => {
    if (taskId !== undefined) processes.ensureSession(taskId, project);
  }, [taskId, project]);
  return found;
}

/** A second's tick while a command runs, for its elapsed time. */
function useTicking(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [running]);
  return running ? now : Date.now();
}

export function pressedAt(e: GestureResponderEvent): { x: number; y: number } {
  const el = (e as unknown as { currentTarget?: { getBoundingClientRect?: () => DOMRect } }).currentTarget;
  const rect = isWeb && typeof el?.getBoundingClientRect === "function" ? el.getBoundingClientRect() : undefined;
  return rect !== undefined ? { x: rect.right, y: rect.bottom + 4 } : { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY + 12 };
}

/** The screen's scroller: a card's is as tall as its lines (at most 320 once opened out); a filled one scrolls and follows the end. */
function Scroller({ fill, follow, signal, capped = false, children }: { fill: boolean; follow: boolean; signal: number; capped?: boolean; children: ReactNode }): JSX.Element {
  const ref = useRef<ScrollView>(null);
  useEffect(() => {
    if (follow) ref.current?.scrollToEnd({ animated: false });
  }, [follow, signal]);
  if (!fill && !capped) return <View minWidth={0}>{children}</View>;
  return (
    <ScrollView ref={ref} style={fill ? { flex: 1 } : { maxHeight: 320 }} contentContainerStyle={{ minWidth: 0 }} onContentSizeChange={() => (follow ? ref.current?.scrollToEnd({ animated: false }) : undefined)}>
      {children}
    </ScrollView>
  );
}

/** The `Command` reading: the line's requests, as the approval lists them (decision 0028, ruling 4). */
function CommandRows({ command, dialect }: { command: string; dialect: CommandDialect }): JSX.Element {
  const t = useTokens();
  const rows = useMemo(() => requestRowsOf(command, dialect), [command, dialect]);
  if (rows.length === 0) return <Txt spec={{ voice: "app", scale: 12 / 12.5, color: TERM_INK.dim }}>The line could not be taken apart.</Txt>;
  return (
    <View flexDirection="column" gap={4}>
      {rows.map((row, i) => (
        <View key={i} flexDirection="row" alignItems="center" gap={8} paddingLeft={row.nested ? 17 : 0} minWidth={0}>
          <View width={9} height={9} flexShrink={0} backgroundColor={colorOf(t, hueOf(i)) as never} opacity={row.nested ? 0.6 : 1} />
          <Txt spec={{ voice: "data", scale: 11.5 / 12, color: TERM_INK.text }} ellip flexShrink={1} minWidth={0}>
            {row.words}
          </Txt>
          <Txt spec={{ voice: "data", scale: 11.5 / 12, color: TERM_INK.hint }}>→</Txt>
          <Txt spec={{ voice: "data", scale: 11.5 / 12, weight: 600, color: "#eceefa" }} ellip flexShrink={1} minWidth={0}>
            {row.what}
          </Txt>
        </View>
      ))}
      <Txt spec={{ voice: "app", scale: 11 / 12.5, color: TERM_INK.dim }} paddingTop={4}>
        Taken apart as the policy read it. What decided each part is on the approval, when one was asked.
      </Txt>
    </View>
  );
}

function YouChip(): JSX.Element {
  return (
    <View paddingHorizontal={6} borderRadius={4} backgroundColor="rgba(179,182,255,0.18)">
      <Txt spec={{ voice: "app", scale: 10.5 / 12.5, weight: 600, color: TERM_INK.accent }}>you</Txt>
    </View>
  );
}

/** The line you type on: a line sent to its stdin, Ctrl-C, and while it waits, when it ends. */
function InputLine({ title, waiting, ends, onSend, onInterrupt }: { title: string; waiting: boolean; ends: string | undefined; onSend: (text: string) => void; onInterrupt: () => void }): JSX.Element {
  const t = useTokens();
  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);
  const program = title.split(" ")[0] ?? title;
  return (
    <View
      flexDirection="row"
      alignItems="center"
      gap={8}
      height={36}
      paddingLeft={12}
      paddingRight={8}
      backgroundColor={TERM_INK.head}
      borderTopWidth={1}
      borderStyle="solid"
      borderColor={(focused ? "rgba(179,182,255,0.55)" : TERM_INK.line) as never}
    >
      <Txt spec={{ voice: "data", scale: 11.5 / 12, color: TERM_INK.accent }}>›</Txt>
      <TextInput
        {...(ENTER_KEEPS_FOCUS as object)}
        value={text}
        onChangeText={setText}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onSubmitEditing={() => {
          onSend(text);
          setText("");
        }}
        placeholder={waiting ? `${program} is waiting — type an answer, ⏎ sends it` : `Type to ${program} — ⏎ sends the line`}
        placeholderTextColor={TERM_INK.dim}
        accessibilityLabel={`Type to ${program}`}
        autoCapitalize="none"
        autoCorrect={false}
        style={{ ...(font(t, { voice: "data", scale: 11.5 / 12, color: TERM_INK.text }) as object), flex: 1, minWidth: 0, ...(isWeb ? { outlineStyle: "none" } : {}) } as never}
      />
      {ends !== undefined ? (
        <Txt spec={{ voice: "app", scale: 11 / 12.5, color: TERM_INK.warn }} numberOfLines={1}>
          {ends}
        </Txt>
      ) : null}
      <Press onPress={onInterrupt} label="Send Ctrl-C: interrupt it" title="interrupt it" height={24} paddingHorizontal={8} borderRadius={6} borderWidth={1} borderStyle="solid" borderColor="#2f3358" justifyContent="center" box={({ hovered }) => ({ backgroundColor: hovered ? "#262a4d" : "transparent" })}>
        <Txt spec={{ voice: "data", scale: 11 / 12, color: TERM_INK.text }}>Ctrl-C</Txt>
      </Press>
    </View>
  );
}

/** The readings, as one joined switch — the value view's, at the terminal's three. */
function Readings({ reading, onReading }: { reading: Reading; onReading: (reading: Reading) => void }): JSX.Element {
  const t = useTokens();
  const all: Array<[Reading, string]> = [
    ["terminal", "Terminal"],
    ["text", "Text"],
    ["command", "Command"],
  ];
  return (
    <View role="group" aria-label="Reading" flexDirection="row" flexShrink={0} borderRadius={6} overflow="hidden" {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }) as object)}>
      {all.map(([id, label], i) => {
        const on = id === reading;
        return (
          <Press
            key={id}
            onPress={() => onReading(id)}
            {...({ "aria-pressed": on } as object)}
            height={22}
            paddingHorizontal={9}
            justifyContent="center"
            {...(i > 0 ? (edge(t, { left: 1 }) as object) : {})}
            box={({ hovered }) => ({ backgroundColor: on ? t.v("fill-ghost-selected") : hovered ? t.v("fill-ghost-hover") : "transparent" })}
          >
            <Txt spec={{ voice: "app", scale: 11.5 / 12.5, weight: on ? 600 : 400, color: on ? "text" : "dim" }}>{label}</Txt>
          </Press>
        );
      })}
    </View>
  );
}

export function StopButton({ onPress }: { onPress: () => void }): JSX.Element {
  const t = useTokens();
  return (
    <Press
      onPress={onPress}
      label="Stop it"
      title="end the command"
      flexDirection="row"
      alignItems="center"
      gap={5}
      height={24}
      paddingHorizontal={9}
      borderRadius={6}
      borderWidth={1}
      borderStyle="solid"
      borderColor={t.mix(t.v("bad"), 35, "transparent") as never}
      box={({ hovered }) => ({ backgroundColor: hovered ? t.v("tint-bad") : "transparent" })}
    >
      <Icon name="stop" size={10} color={String(t.v("bad"))} />
      <Txt spec={{ voice: "app", scale: 11.5 / 12.5, color: "bad" }}>Stop</Txt>
    </Press>
  );
}

export function MoreButton({ open, onPress }: { open: boolean; onPress: (e: GestureResponderEvent) => void }): JSX.Element {
  const t = useTokens();
  return (
    <Press
      onPress={onPress}
      label="What else can be done with this"
      title="What else can be done with this"
      {...({ "aria-expanded": open } as object)}
      width={26}
      height={24}
      alignItems="center"
      justifyContent="center"
      borderRadius={5}
      box={({ hovered }) => ({ backgroundColor: open ? t.v("fill-ghost-selected") : hovered ? t.v("fill-ghost-hover") : "transparent" })}
    >
      <Txt spec={{ voice: "app", scale: 15 / 12.5, weight: 600, color: open ? "text" : "dim", lineHeight: { px: 16 } }}>…</Txt>
    </Press>
  );
}

/** How long a finished terminal ran, for a row's note. */
export function tookOf(startedAt: number, endedAt: number | undefined): string {
  return durationText((endedAt ?? Date.now()) - startedAt);
}
