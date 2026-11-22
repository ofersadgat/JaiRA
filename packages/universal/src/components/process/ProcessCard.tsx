import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type JSX, type ReactNode } from "react";
import { ScrollView, type GestureResponderEvent } from "react-native";
import { View, isWeb } from "@tamagui/core";
import type { CommandDialect, ProcessSummary } from "@jaira/shared/browser";
import { processEnded } from "@jaira/shared/browser";
import { notOursOf, outputNoteOf, processStatusOf, statusBelow } from "@jaira/ui/processCardModel";
import { processes } from "@jaira/ui/processStore";
import { invoke } from "@jaira/ui/store";
import { PLACES, taskPaneEntryOf, type Place } from "@jaira/ui/splitModel";
import { terminals } from "@jaira/ui/terminalStore";
import { TERM_INK, TermScreen } from "@jaira/ui/terminalModel";
import { copyText } from "../../clipboard";
import { Press, Txt, edge } from "../../primitives";
import { useTokens } from "../../tokens";
import { moveEntry, useEntryPlaces, usePlacesHere } from "../../app/places";
import { usePhone } from "../../app/phone";
import { ContextMenu, MENU_WIDTH, type MenuAt } from "../Menu";
import { Icon } from "../panel/Icon";
import { PlaceButtons } from "../panel/PlaceButtons";
import { Following, IconButton, ScreenLine, WRAP_WEB } from "../terminal/TermParts";
import { MoreButton, StopButton, TerminalView, pressedAt } from "../terminal/TerminalView";
import { PortChip, StatsLine, StatusText, TellClaude, useSampling } from "./ProcessParts";

/**
 * THE SEAM (decision 0032, "The view", ruling 1; round 1, board 7): the card a process is drawn as,
 * wherever it is — under its row in the chat, opened in place in the Terminals tab, in a split, the main
 * view, the side panel and its task view. It shows its name and status (`running in background · 4m`),
 * its ports as links, pid, CPU, memory and the load trace, the last lines of what it printed, "Tell Claude
 * when it prints…", Stop (refused, saying why, for a protected one) and the three places.
 *
 *  - A process with a terminal (`run_in_background`, a command of this turn) is its terminal's card,
 *    given the process (`TerminalView`'s `process`): typed into, its screen kept from the start.
 *  - One without (left running, escaped, Claude's own, watched) is drawn here: the same title bar,
 *    stats line and readings, its output followed read-only from where it writes (`process:read`), and
 *    why when it cannot be read.
 *  - `brief`: one line, for a process under the chat row that started it with nothing to show unasked —
 *    left running, escaped: its name, status, port, why, Stop and the places. Pressed, the whole card.
 *
 * `fill`: filling a pane, the panel or the main view — the title bar's other half (status, Stop, the
 * places) leads; `bare`: the view's own head already carries those (the process task view).
 */
export function ProcessCard({
  process,
  project,
  fill = true,
  bare = false,
  brief = false,
  onFold,
}: {
  process: ProcessSummary;
  project?: string | undefined;
  fill?: boolean;
  bare?: boolean;
  brief?: boolean;
  onFold?: (() => void) | undefined;
}): JSX.Element {
  const [whole, setWhole] = useState(false);
  const at = project ?? process.project;
  if (process.terminal !== undefined && process.taskId !== undefined) {
    return <TerminalView taskId={process.taskId} project={at} callId={process.terminal} command={process.command} dialect={dialectOf(process)} fill={fill} bare={bare} onFold={onFold} process={process} />;
  }
  if (brief && !whole) return <ProcessBrief process={process} project={at} onOpen={() => setWhole(true)} />;
  return <ProcessFollowCard process={process} project={at} fill={fill} bare={bare} onFold={onFold ?? (brief ? () => setWhole(false) : undefined)} />;
}

/** The process whose output a task's terminal is, as the window knows it: redrawn as it moves. */
export function useTerminalProcess(taskId: string | undefined, callId: string | undefined, project: string | undefined): ProcessSummary | undefined {
  useSyncExternalStore(processes.subscribe, processes.version, processes.version);
  useEffect(() => {
    if (taskId !== undefined) processes.ensureSession(taskId, project);
  }, [taskId, project]);
  return taskId === undefined || callId === undefined ? undefined : processes.ofTerminal(taskId, callId);
}

/** What a tool call started that its task keeps: its background process, and what it left running or let escape. */
export function useCallProcesses(taskId: string | undefined, callId: string | undefined, project: string | undefined): ProcessSummary[] {
  useSyncExternalStore(processes.subscribe, processes.version, processes.version);
  useEffect(() => {
    if (taskId !== undefined) processes.ensureSession(taskId, project);
  }, [taskId, project]);
  return taskId === undefined || callId === undefined ? [] : processes.ofCall(taskId, callId);
}

/** The tool calls of a task whose processes still run, as the window knows them: their rows stay out of a summary. */
export function useLiveProcessCalls(taskId: string | undefined, project: string | undefined): ReadonlySet<string> {
  const key = useSyncExternalStore(
    processes.subscribe,
    () => (taskId === undefined ? "" : processes.ofSession(taskId).filter((p) => !processEnded(p.state)).flatMap((p) => [p.callId ?? "", p.terminal ?? ""]).filter((c) => c.length > 0).join(",")),
    () => "",
  );
  useEffect(() => {
    if (taskId !== undefined) processes.ensureSession(taskId, project);
  }, [taskId, project]);
  return useMemo(() => new Set(key.length > 0 ? key.split(",") : []), [key]);
}

/** The dialect its terminal was started in, as the terminals store knows it; else a guess from the line. */
function dialectOf(process: ProcessSummary): CommandDialect {
  const known = process.taskId !== undefined && process.terminal !== undefined ? terminals.get(process.taskId, process.terminal)?.summary.dialect : undefined;
  if (known !== undefined) return known;
  return /powershell|pwsh/i.test(process.command) ? "powershell" : "posix";
}

/** A second's tick while it runs, for its age. */
function useNow(live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [live]);
  return live ? now : Date.now();
}

/** The three places for a process with no terminal: its process task's view (a pane's task entry), lit where it stands. */
function usePlaces(process: ProcessSummary): { offered: Place[]; lit: Place[]; place: (target: Place) => void } | undefined {
  const id = process.processTaskId;
  const entry = useMemo(() => (id === undefined ? undefined : taskPaneEntryOf(id, process.project)), [id, process.project]);
  const lit = useEntryPlaces(entry?.key ?? "");
  const phone = usePhone();
  const here = usePlacesHere(phone);
  if (entry === undefined) return undefined;
  return { offered: PLACES.filter((place) => place === "main" || here[place] || lit.includes(place)), lit, place: (target) => moveEntry(target, entry, lit, phone) };
}

const PLACE_WORDS: Record<Place, string> = { main: "Open in the main view", split: "Open in a split", panel: "Open in the side panel" };

/** The card's verbs: Stop while it runs (unless protected), the places, `…`. */
function Verbs({ process, project, text }: { process: ProcessSummary; project: string | undefined; text: () => string }): JSX.Element {
  const places = usePlaces(process);
  const [menu, setMenu] = useState<MenuAt | null>(null);
  const [why, setWhy] = useState<string | null>(null);
  const live = !processEnded(process.state);
  const stop = (): void =>
    void processes.stop(process.key, "stop", project).then(
      (r) => setWhy(r.stopped ? null : (r.why ?? "it could not be stopped")),
      (e: unknown) => setWhy(e instanceof Error ? e.message : String(e)),
    );
  const open = (e: GestureResponderEvent): void => {
    const at = pressedAt(e);
    setMenu({
      x: at.x - MENU_WIDTH,
      y: at.y,
      items: [
        ...(places?.offered ?? []).map((one) => ({ label: PLACE_WORDS[one], ...(places!.lit.includes(one) ? { note: "here", disabled: one !== "panel" } : {}), onSelect: () => places!.place(one) })),
        { label: "Copy what it printed", separator: true, onSelect: () => void copyText(text()) },
        { label: "Copy the command", onSelect: () => void copyText(process.command) },
        ...(live && process.protected === undefined ? [{ label: `Stop ${process.name}`, separator: true, danger: true, note: "and what it started", onSelect: stop }] : []),
        ...(process.origin === "watched" ? [{ label: "Stop watching it", separator: true, onSelect: () => void invokeUnwatch(process, project) }] : []),
      ],
    });
  };
  return (
    <>
      {why !== null ? (
        <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "bad" }} ellip flexShrink={1} minWidth={0} {...((isWeb ? { title: why } : {}) as object)}>
          {why}
        </Txt>
      ) : null}
      {live && process.protected === undefined ? <StopButton onPress={stop} /> : null}
      {live && process.protected !== undefined ? (
        <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }} ellip flexShrink={1} minWidth={0} {...((isWeb ? { title: `Stop is refused: ${process.protected}` } : {}) as object)}>
          protected
        </Txt>
      ) : null}
      {places !== undefined ? <PlaceButtons offered={places.offered} lit={places.lit} onPlace={places.place} /> : null}
      <MoreButton open={menu !== null} onPress={open} />
      {menu !== null ? <ContextMenu anchor={menu} onClose={() => setMenu(null)} /> : null}
    </>
  );
}

function invokeUnwatch(process: ProcessSummary, project: string | undefined): Promise<unknown> {
  return invoke("process:unwatch", { key: process.key, ...(project !== undefined ? { project } : {}) });
}

/** The glyph box: --panel-3 with the terminal mark; escaped, --warn on its tint. */
function Glyph({ process }: { process: ProcessSummary }): JSX.Element {
  const t = useTokens();
  const warn = process.origin === "escaped" || process.state === "waiting";
  return (
    <View width={18} height={18} borderRadius={5} alignItems="center" justifyContent="center" flexShrink={0} backgroundColor={(warn ? t.mix(t.v("warn"), 14, "transparent") : t.v("panel-3")) as never}>
      <Icon name={process.origin === "escaped" || process.origin === "left" || process.origin === "watched" ? "external" : "terminal"} size={12} color={String(t.v(warn ? "warn" : process.origin === "left" ? "dim" : "accent"))} />
    </View>
  );
}

/** The frame a card has under a row; a filled one has none. */
function Frame({ fill, warn, children }: { fill: boolean; warn: boolean; children: ReactNode }): JSX.Element {
  const t = useTokens();
  if (fill) return <View flex={1} minHeight={0} flexDirection="column" minWidth={0}>{children}</View>;
  return (
    <View flexDirection="column" minWidth={0} borderRadius={10} overflow="hidden" backgroundColor={t.v("panel") as never} {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }, warn ? String(t.mix(t.v("warn"), 45, "transparent")) : "line") as object)}>
      {children}
    </View>
  );
}

/**
 * One line under the chat row (round 2, board 1): `serve left running · 9m :5050 output not kept: … Stop
 * ⧉ ⧉ ⧉ …`; escaped, an amber edge. Its name pressed opens the whole card.
 */
function ProcessBrief({ process, project, onOpen }: { process: ProcessSummary; project: string | undefined; onOpen: () => void }): JSX.Element {
  const now = useNow(!processEnded(process.state));
  const status = processStatusOf(process, now);
  return (
    <Frame fill={false} warn={process.origin === "escaped"}>
      <View flexDirection="row" alignItems="center" gap={8} height={38} paddingLeft={10} paddingRight={8} minWidth={0}>
        <Press onPress={onOpen} label={`Open ${process.name}'s card`} title={`${process.command} · pid ${process.pid}`} flexDirection="row" alignItems="center" gap={8} flex={1} minWidth={0} alignSelf="stretch">
          <Glyph process={process} />
          <Txt spec={{ voice: "app", scale: 13 / 12.5, weight: 600 }} numberOfLines={1} flexShrink={0}>
            {process.name}
          </Txt>
          <StatusText status={status} flex={false} />
          {process.ports.slice(0, 1).map((port) => (
            <PortChip key={port} port={port} />
          ))}
          <Txt spec={{ voice: "app", scale: 11.5 / 12.5, color: "dim" }} ellip flex={1} minWidth={0}>
            {outputNoteOf(process)}
          </Txt>
        </Press>
        <Verbs process={process} project={project} text={() => ""} />
      </View>
    </Frame>
  );
}

const FOLLOW_MS = 1500;
const CARD_LINES = 12;

/** What a process with no terminal printed, followed read-only (`process:read` from its offset while it runs). */
function useFollowed(process: ProcessSummary, project: string | undefined): { screen: TermScreen; version: number; why: string | null; from?: number } {
  const screen = useMemo(() => new TermScreen(), [process.key]);
  const [version, setVersion] = useState(0);
  const [why, setWhy] = useState<string | null>(null);
  const [from, setFrom] = useState<number | undefined>(undefined);
  const offset = useRef<number | undefined>(undefined);
  const live = !processEnded(process.state);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = (): void => {
      void processes
        .read(process.key, offset.current, project)
        .then((answer) => {
          if (stopped) return;
          offset.current = answer.offset;
          if (answer.from !== undefined) setFrom(answer.from);
          if (answer.output.length > 0) {
            screen.write(answer.output);
            setVersion((v) => v + 1);
          }
          setWhy(answer.source === "unreadable" ? (answer.why ?? "its output cannot be read") : answer.output.length === 0 && answer.why !== undefined && screen.count === 0 ? answer.why : null);
        })
        .catch((e: unknown) => !stopped && setWhy(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "") : String(e)))
        .finally(() => {
          if (!stopped && live) timer = setTimeout(read, FOLLOW_MS);
        });
    };
    read();
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [process.key, project, live, screen]);
  return { screen, version, why, ...(from !== undefined ? { from } : {}) };
}

/** The card of a process with no terminal: title bar (or the filled status row), stats, readings, what it printed, and whose it is. */
function ProcessFollowCard({ process, project, fill, bare, onFold }: { process: ProcessSummary; project: string | undefined; fill: boolean; bare: boolean; onFold?: (() => void) | undefined }): JSX.Element {
  const t = useTokens();
  const live = !processEnded(process.state);
  useSampling(live);
  const now = useNow(live);
  const status = processStatusOf(process, now);
  const followed = useFollowed(process, project);
  const [reading, setReading] = useState<"terminal" | "text">("terminal");
  const [following, setFollowing] = useState(true);
  const [width, setWidth] = useState<number | undefined>(undefined);
  const below = !fill && statusBelow(width, onFold !== undefined);
  const lines = useMemo(() => followed.screen.tail(fill ? 3_000 : CARD_LINES), [followed.screen, followed.version, fill]);
  const earlier = Math.max(0, followed.screen.count - lines.length - (followed.screen.partial().length === 0 ? 1 : 0));
  const plain = (): string => followed.screen.plain();
  const foot = notOursOf(process);
  const scroller = useRef<ScrollView>(null);
  useEffect(() => {
    if (following) scroller.current?.scrollToEnd({ animated: false });
  }, [following, followed.version]);
  const verbs = <Verbs process={process} project={project} text={plain} />;
  const body = (
    <View paddingTop={8} paddingBottom={10} paddingHorizontal={14} minWidth={0}>
      <Txt spec={{ voice: "app", scale: 11 / 12.5, color: TERM_INK.dim }} paddingBottom={4} ellip>
        {followed.why !== null ? `Not following: ${followed.why}` : `${outputNoteOf(process)}${followed.from !== undefined ? ` · following since ${new Date(followed.from).toLocaleTimeString(undefined, { hour12: false })}` : ""}`}
      </Txt>
      {earlier > 0 && !fill ? <Txt spec={{ voice: "app", scale: 11 / 12.5, color: TERM_INK.dim }}>{`↑ ${earlier} earlier line${earlier === 1 ? "" : "s"}`}</Txt> : null}
      {reading === "text" ? (
        <Txt spec={{ voice: "data", scale: 11.5 / 12, color: TERM_INK.text, lineHeight: { px: 19 } }} {...(isWeb ? { style: { ...WRAP_WEB, userSelect: "text" } } : { selectable: true })}>
          {plain()}
        </Txt>
      ) : (
        lines.map((line, i) => <ScreenLine key={i} line={line} t={t} />)
      )}
      {followed.screen.count === 0 && followed.why === null ? <Txt spec={{ voice: "app", scale: 11.5 / 12.5, italic: true, color: TERM_INK.dim }}>Nothing printed since it was followed.</Txt> : null}
    </View>
  );
  return (
    <View flexDirection="column" minWidth={0} {...(fill ? { flex: 1, minHeight: 0 } : {})} onLayout={(e) => setWidth(Math.round(e.nativeEvent.layout.width))}>
      <Frame fill={fill} warn={process.origin === "escaped"}>
        {!fill ? (
          <View flexDirection="row" alignItems="center" gap={8} height={38} paddingLeft={onFold !== undefined ? 6 : 10} paddingRight={8} minWidth={0}>
            <Press onPress={onFold ?? (() => undefined)} disabled={onFold === undefined} label={`Fold ${process.name} back to its row`} flexDirection="row" alignItems="center" gap={8} flex={1} minWidth={0} alignSelf="stretch">
              {onFold !== undefined ? (
                <View width={14} alignItems="center" justifyContent="center" flexShrink={0}>
                  <Icon name="chevron" size={11} color={String(t.v("dim"))} />
                </View>
              ) : null}
              <Glyph process={process} />
              <Txt spec={{ voice: "app", scale: 13 / 12.5, weight: 600 }} numberOfLines={1} flexShrink={0} maxWidth="60%" {...((isWeb ? { title: `${process.command} · pid ${process.pid}` } : {}) as object)}>
                {process.name}
              </Txt>
              {below ? (
                <View flex={1} minWidth={0} flexDirection="row" gap={6} overflow="hidden">
                  {process.ports.slice(0, 1).map((port) => (
                    <PortChip key={port} port={port} />
                  ))}
                </View>
              ) : (
                <View flex={1} minWidth={0} flexDirection="row">
                  <StatusText status={status} />
                </View>
              )}
            </Press>
            {verbs}
          </View>
        ) : !bare ? (
          <View flexDirection="row" alignItems="center" gap={8} paddingVertical={7} paddingLeft={12} paddingRight={8} minWidth={0} {...(edge(t, { bottom: 1 }) as object)}>
            <View flex={1} minWidth={0} flexDirection="row">
              <StatusText status={status} />
            </View>
            {verbs}
          </View>
        ) : null}
        <View {...(fill ? { paddingTop: 7, ...(edge(t, { bottom: 1 }) as object) } : {})} minWidth={0}>
          <StatsLine process={process} status={below ? status : undefined} />
        </View>
        <View flexDirection="row" flexWrap="wrap" alignItems="center" gap={6} minWidth={0} {...(fill ? { paddingVertical: 7, paddingHorizontal: 10, ...(edge(t, { bottom: 1 }) as object) } : { paddingLeft: 10, paddingRight: 8, paddingBottom: 8 })}>
          <ReadingSwitch reading={reading} onReading={setReading} />
          <TellClaude process={process} project={project} />
          <View flex={1} />
          {live ? <Following on={following} onPress={() => setFollowing((v) => !v)} /> : null}
          <IconButton icon="copy" label="Copy what it printed" onPress={() => void copyText(plain())} />
        </View>
        <View backgroundColor={TERM_INK.ground} minWidth={0} {...(fill ? { flex: 1, minHeight: 0 } : {})}>
          {fill ? (
            <ScrollView ref={scroller} style={{ flex: 1 }} onContentSizeChange={() => (following ? scroller.current?.scrollToEnd({ animated: false }) : undefined)}>
              {body}
            </ScrollView>
          ) : (
            body
          )}
          {foot !== undefined ? (
            <View flexDirection="row" alignItems="center" gap={8} paddingHorizontal={14} paddingVertical={8} backgroundColor={TERM_INK.head} borderTopWidth={1} borderStyle="solid" borderColor={TERM_INK.line as never}>
              <Txt spec={{ voice: "app", scale: 11 / 12.5, color: TERM_INK.dim }} ellip flex={1} minWidth={0}>
                {foot}
              </Txt>
            </View>
          ) : null}
        </View>
      </Frame>
    </View>
  );
}

/** Terminal | Text, as the terminal card's readings switch (no Command: the line is not JaiRA's to take apart). */
function ReadingSwitch({ reading, onReading }: { reading: "terminal" | "text"; onReading: (r: "terminal" | "text") => void }): JSX.Element {
  const t = useTokens();
  const all: Array<["terminal" | "text", string]> = [
    ["terminal", "Terminal"],
    ["text", "Text"],
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
