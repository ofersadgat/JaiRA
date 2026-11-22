import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type JSX } from "react";
import { TextInput, type GestureResponderEvent } from "react-native";
import { View, isWeb } from "@tamagui/core";
import { processEnded, type ProcessSummary, type ProcessTreeNode as EngineNode, type TerminalSummary } from "@jaira/shared/browser";
import { terminalEntryOf } from "@jaira/ui/panelStack";
import {
  OTHER_SCOPES,
  TERMINALS_VIEWS,
  TERMINALS_VIEW_MODE,
  engineTreeOf,
  pressOf,
  rowEndOf,
  sessionRowsOf,
  scopeTreeOf,
  stopKeysOf,
  stopTargetsOf,
  terminalTreeOf,
  toggled,
  type OtherScope,
  type ProcessGlyph,
  type ProcessTagTone,
  type ProcessTreeNode,
  type TerminalsView,
} from "@jaira/ui/processTreeModel";
import { processes } from "@jaira/ui/processStore";
import { PLACES, taskPaneEntryOf, type Place } from "@jaira/ui/splitModel";
import { runYours, signalTerminal, terminals } from "@jaira/ui/terminalStore";
import { TERM_INK, terminalTitleOf } from "@jaira/ui/terminalModel";
import { modeOf } from "@jaira/ui/uiState";
import { ENTER_KEEPS_FOCUS, Press, Txt, edge, font, useHover } from "../../primitives";
import { useTokens, type Tokens } from "../../tokens";
import { moveEntry, useEntryPlaces, usePlacesHere } from "../../app/places";
import { usePhone } from "../../app/phone";
import { useShellOrNull } from "../../app/shell";
import { useCanHover } from "../../canHover";
import { ContextMenu, MENU_WIDTH, type MenuAt } from "../Menu";
import { Icon, type IconName } from "../panel/Icon";
import { PlaceButtons } from "../panel/PlaceButtons";
import { colourOr } from "../panel/SidePanel";
import { ProcessCard } from "../process/ProcessCard";
import { PortChip } from "../process/ProcessParts";
import { ScreenLine } from "./TermParts";
import { MoreButton, TerminalView, pressedAt, terminalMenuOf } from "./TerminalView";
import { useTerminals } from "./useTerminal";

/**
 * The side panel's Terminals tab (decision 0028, ruling 7; decision 0032's view, ruling 2; round 2, boards
 * 1–3): a line to run a command of your own in the conversation's workspace (0028, ruling 8), then a
 * List | Tree toggle.
 *
 * List is the conversation's processes and commands — each process with its pid, its ports and where it
 * came from (`background`, `left running`, `escaped · WMI`, `Claude's Bash`) — live ones under "This
 * conversation", then "Ended", then the processes you watch from another scope under "Mine · watched".
 * Tree is the engine's process tree for the session (`process:tree`): each process and what it started,
 * the escaped ones under the program that started them, then the other scopes (Mine, JaiRA, System)
 * folded below, each read when it is opened. Both draw one row anatomy (`processTreeModel.ts`). Hovered,
 * a row's time gives way to the three place buttons (the place it is in lit), `…` and Stop; pressed, it
 * opens in place as the card, and its head folds it back — another scope's process is watched first.
 * A row waiting for the person shows its last two lines and `Answer it`. How it looks:
 *
 *   the run line     row, gap 8, padding 0 6 0 10, height 34, 1px --line, radius 8: `›`, the field
 *                    (data 12/12), Run
 *   the toolbar      the toggle: one joined switch, 1px --line, radius 7; each half 26 tall, padding 0 8,
 *                    app 12.5, --dim on --panel; on: --text 600 on --panel-2
 *   a caption        data 10.5/12, 0.06em, uppercase, --dim; the count at the far end
 *   a row            row, gap 8, height 34 (Tree: 28, a session 32; indented 16 a level, a 1px --line
 *                    guide down each level), padding 0 8, radius 6, a 1px edge that shows only hovered:
 *                    a chevron (right; Tree: the twisty), the state glyph (14), the label (data 12.5 600),
 *                    the pid (data 11.5 --dim), the rest of its line (data 11.5 --dim), its tag (a pill,
 *                    19 tall, app 11 600), its ports (chips), a spacer, then the places it is in as lit
 *                    chips and its time (data 12 --dim); hovered, on --fill-ghost-hover: the place
 *                    buttons, `…` and Stop
 *   waiting          under the row, indented to its label: its last two lines (data 11/12 on the
 *                    terminal's ground, radius 6, padding 4 8) and `Answer it` (app 11.5 600 --warn)
 *   opened           the card (`ProcessCard`, or `TerminalView` for a command that is no process), its
 *                    title bar the row's head with a chevron (down); margin 2 0 8, indented as its row
 *   the foot         app 11 --dim: what Run does
 */
export function TerminalsTab({ taskId, project, onOpen }: { taskId: string; project: string | undefined; onOpen: (terminal: TerminalSummary) => void }): JSX.Element {
  const list = useTerminals(taskId, project);
  useSyncExternalStore(processes.subscribe, processes.version, processes.version);
  useEffect(() => processes.ensureSession(taskId, project), [taskId, project]);
  const mine = processes.ofSession(taskId);
  const watched = processes.all().filter((p) => p.origin === "watched" && (project === undefined || p.project === undefined || p.project === project));
  const [view, setView] = useTerminalsView();
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  const [scopes, setScopes] = useState<ReadonlyMap<string, { nodes?: EngineNode[]; said?: string }>>(() => new Map());
  const now = useTicking(list.some((one) => one.endedAt === undefined) || mine.some((p) => !processEnded(p.state)));
  const rows = useMemo(() => sessionRowsOf(list, mine, now), [list, mine, now]);
  const engine = useSessionTree(view === "tree", taskId, project, `${list.length}:${mine.map((p) => `${p.key}${p.state}${(p.children ?? []).join(",")}`).join("|")}`);
  const tree = useMemo(
    () => (engine !== undefined ? engineTreeOf({ id: taskId, label: "This conversation" }, engine, list, now) : terminalTreeOf({ id: taskId, label: "This conversation" }, list, now)),
    [engine, taskId, list, now],
  );
  const others = OTHER_SCOPES.map((scope) => {
    const read = scopes.get(scope.scope);
    return scopeTreeOf(scope, read?.nodes, now, read?.said);
  });
  const readScope = (scope: OtherScope): void => {
    setScopes((was) => new Map(was).set(scope.scope, { said: "reading…" }));
    processes.tree({ scope: scope.scope, ...(project !== undefined ? { project } : {}) }).then(
      (nodes) => setScopes((was) => new Map(was).set(scope.scope, { nodes })),
      (e: unknown) => setScopes((was) => new Map(was).set(scope.scope, { said: e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "") : String(e) })),
    );
  };
  const show = (node: ProcessTreeNode): void => {
    const p = node.process;
    if (p !== undefined && p.processTaskId === undefined && !processEnded(p.state)) {
      // Another scope's process, or a child no task keeps: watched, then opened.
      void processes.watch(p.pid, project).then(() => setOpen((was) => new Set(was).add(node.id)), () => undefined);
      return;
    }
    setOpen((was) => toggled(was, node.id));
  };
  const press = (node: ProcessTreeNode): void => {
    const scope = OTHER_SCOPES.find((one) => `scope:${one.scope}` === node.id);
    if (scope !== undefined) {
      if (!opened(node.id) && scopes.get(scope.scope)?.nodes === undefined) readScope(scope);
      setFolded((was) => toggled(was, node.id));
      return;
    }
    const does = pressOf(node);
    if (does === "open") show(node);
    else if (does === "fold") setFolded((was) => toggled(was, node.id));
  };
  const twist = (node: ProcessTreeNode): void => (node.id.startsWith("scope:") ? press(node) : setFolded((was) => toggled(was, node.id)));
  // The other scopes start folded: in `folded`, a scope's id means it was opened.
  const opened = (id: string): boolean => folded.has(id);
  const shutOf = (id: string): boolean => (id.startsWith("scope:") ? !opened(id) : folded.has(id));
  const row = (node: ProcessTreeNode, depth: number, tree: boolean, shut = false): JSX.Element => (
    <ProcessRow key={node.id} node={node} depth={depth} tree={tree} project={project} open={open.has(node.id)} folded={shut} onPress={() => press(node)} onTwisty={() => twist(node)} onFold={() => setOpen((was) => toggled(was, node.id))} />
  );
  const walk = (root: ProcessTreeNode): Array<{ node: ProcessTreeNode; depth: number; folded: boolean }> => {
    const out: Array<{ node: ProcessTreeNode; depth: number; folded: boolean }> = [];
    const go = (node: ProcessTreeNode, depth: number): void => {
      const shut = shutOf(node.id);
      out.push({ node, depth, folded: shut });
      if (!shut) for (const child of node.children) go(child, depth + 1);
    };
    go(root, 0);
    return out;
  };
  const nothing = list.length === 0 && mine.length === 0;
  return (
    <View flexDirection="column" gap={10} minWidth={0}>
      <RunLine taskId={taskId} project={project} onRan={onOpen} />
      <View flexDirection="row" alignItems="center" gap={8}>
        <ViewToggle view={view} onView={setView} />
      </View>
      {view === "list" ? (
        <>
          {nothing ? <Txt spec={{ voice: "app", scale: 12 / 12.5, color: "dim" }}>No commands yet. The agent's shell commands and processes, and yours, are listed here as they run.</Txt> : null}
          {rows.live.length > 0 ? <Caption words="This conversation" count={rows.live.length} /> : null}
          {rows.live.length > 0 ? <View flexDirection="column" minWidth={0}>{rows.live.map((node) => row(node, 0, false))}</View> : null}
          {rows.ended.length > 0 ? <Caption words="Ended" count={rows.ended.length} /> : null}
          {rows.ended.length > 0 ? <View flexDirection="column" minWidth={0}>{rows.ended.map((node) => row(node, 0, false))}</View> : null}
          {watched.length > 0 ? <Caption words="Mine · watched" count={watched.length} /> : null}
          {watched.length > 0 ? <View flexDirection="column" minWidth={0}>{sessionRowsOf([], watched, now).live.concat(sessionRowsOf([], watched, now).ended).map((node) => row(node, 0, false))}</View> : null}
        </>
      ) : (
        <View role="tree" aria-label="This conversation's processes, and the machine's" flexDirection="column" minWidth={0}>
          {walk(tree).map(({ node, depth, folded: shut }) => row(node, depth, true, shut))}
          {others.flatMap((scope) => walk(scope).map(({ node, depth, folded: shut }) => row(node, depth, true, shut)))}
        </View>
      )}
      <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }} marginTop={4}>
        Each row is the card folded: press one to open it here, hover it for the three places. What you run above runs as you — permission sets decide what an agent may run, not you — and the agent hears of it with your next message.
      </Txt>
    </View>
  );
}

/** The engine's process tree for the session, read while Tree shows and again when what it holds moves (at most every 2 s). */
function useSessionTree(on: boolean, taskId: string, project: string | undefined, moved: string): EngineNode[] | undefined {
  const [nodes, setNodes] = useState<EngineNode[] | undefined>(undefined);
  const read = useCallback(() => {
    void processes.tree({ scope: "session", taskId, ...(project !== undefined ? { project } : {}) }).then(setNodes, () => undefined);
  }, [taskId, project]);
  useEffect(() => {
    if (!on) return;
    const timer = setTimeout(read, 150);
    return () => clearTimeout(timer);
  }, [on, read, moved]);
  useEffect(() => {
    if (!on) return;
    const timer = setInterval(read, 4_000);
    return () => clearInterval(timer);
  }, [on, read]);
  return on ? nodes : undefined;
}

/** List or Tree, remembered with the window's other such choices (`uiState.ts`'s modes); held here outside the app. */
function useTerminalsView(): [TerminalsView, (view: TerminalsView) => void] {
  const app = useShellOrNull();
  const [local, setLocal] = useState<TerminalsView>("list");
  if (app === null) return [local, setLocal];
  return [modeOf(app.state.settings.ui, TERMINALS_VIEW_MODE, TERMINALS_VIEWS, "list"), (view) => app.actions.setMode(TERMINALS_VIEW_MODE, view)];
}

/** A second's tick while anything runs, for the rows' elapsed times. */
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

/** The List | Tree toggle (round 1, board 6): one joined switch. */
function ViewToggle({ view, onView }: { view: TerminalsView; onView: (view: TerminalsView) => void }): JSX.Element {
  const t = useTokens();
  const all: Array<[TerminalsView, string]> = [
    ["list", "List"],
    ["tree", "Tree"],
  ];
  return (
    <View role="group" aria-label="Show as" flexDirection="row" flexShrink={0} borderRadius={7} overflow="hidden" {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }) as object)}>
      {all.map(([id, label], i) => {
        const on = id === view;
        return (
          <Press
            key={id}
            onPress={() => onView(id)}
            label={`Show as a ${label.toLowerCase()}`}
            {...({ "aria-pressed": on } as object)}
            height={26}
            paddingHorizontal={8}
            justifyContent="center"
            {...(i > 0 ? (edge(t, { left: 1 }) as object) : {})}
            box={({ hovered }) => ({ backgroundColor: on ? t.v("panel-2") : hovered ? t.v("fill-ghost-hover") : t.v("panel") })}
          >
            <Txt spec={{ voice: "app", scale: 12.5 / 12.5, weight: on ? 600 : 400, color: on ? "text" : "dim" }}>{label}</Txt>
          </Press>
        );
      })}
    </View>
  );
}

function Caption({ words, count }: { words: string; count: number }): JSX.Element {
  return (
    <View flexDirection="row" alignItems="center" marginTop={4} marginBottom={-6}>
      <Txt spec={{ voice: "data", scale: 10.5 / 12, ls: 0.06, upper: true, color: "dim" }} flex={1}>
        {words}
      </Txt>
      <Txt spec={{ voice: "data", scale: 10.5 / 12, color: "dim" }}>{String(count)}</Txt>
    </View>
  );
}

const PLACE_CHIP: Record<Place, { icon: IconName; words: string }> = {
  main: { icon: "placeMain", words: "main view" },
  split: { icon: "placeSplit", words: "split" },
  panel: { icon: "placePanel", words: "side panel" },
};

/** What a row's place buttons place: its terminal, else its process task's view (a process no task keeps is watched first). */
function usePlaceable(node: ProcessTreeNode, project: string | undefined): { key: string; place: (target: Place, lit: readonly Place[], phone: boolean) => void } | undefined {
  const ref = node.terminal;
  const p = node.process;
  return useMemo(() => {
    if (ref !== undefined) {
      const entry = terminalEntryOf({ ...ref, project });
      return { key: entry.key, place: (target, lit, phone) => moveEntry(target, entry, lit, phone) };
    }
    if (p === undefined) return undefined;
    if (p.processTaskId !== undefined) {
      const entry = taskPaneEntryOf(p.processTaskId, p.project ?? project);
      return { key: entry.key, place: (target, lit, phone) => moveEntry(target, entry, lit, phone) };
    }
    return {
      key: "",
      place: (target, _lit, phone) =>
        void processes.watch(p.pid, project).then((w) => {
          if (w.processTaskId !== undefined) moveEntry(target, taskPaneEntryOf(w.processTaskId, w.project ?? project), [], phone);
        }, () => undefined),
    };
  }, [ref, p?.key, p?.processTaskId, project]);
}

/** Stop what a row holds: its terminals through themselves, its processes through the engine (one no task keeps, watched first). */
function stopNode(node: ProcessTreeNode, project: string | undefined): void {
  for (const one of stopTargetsOf(node)) void signalTerminal(one.taskId, one.callId, "stop", project);
  const byKey = new Map<string, ProcessSummary>();
  const walk = (n: ProcessTreeNode): void => {
    if (n.process !== undefined) byKey.set(n.process.key, n.process);
    n.children.forEach(walk);
  };
  walk(node);
  for (const key of stopKeysOf(node)) {
    const p = byKey.get(key);
    if (p === undefined) continue;
    if (p.processTaskId !== undefined) void processes.stop(key, "stop", project).catch(() => undefined);
    else void processes.watch(p.pid, project).then((w) => processes.stop(w.key, "stop", project), () => undefined);
  }
}

/** One row of the tab, List or Tree; opened, the card in its place. */
function ProcessRow({ node, depth, tree, project, open, folded, onPress, onTwisty, onFold }: { node: ProcessTreeNode; depth: number; tree: boolean; project: string | undefined; open: boolean; folded: boolean; onPress: () => void; onTwisty: () => void; onFold: () => void }): JSX.Element {
  const t = useTokens();
  const canHover = useCanHover();
  const phone = usePhone();
  const here = usePlacesHere(phone);
  const ref = node.terminal;
  const placeable = usePlaceable(node, project);
  const lit = useEntryPlaces(placeable?.key ?? "");
  const [menu, setMenu] = useState<MenuAt | null>(null);
  const [hovered, hover] = useHover();
  const offered = PLACES.filter((place) => place === "main" || here[place] || lit.includes(place));
  const place = (target: Place): void => placeable?.place(target, lit, phone);
  const stop = (): void => stopNode(node, project);
  const openMenu = (e: GestureResponderEvent): void => {
    const at = pressedAt(e);
    const copy = ref !== undefined ? terminals.get(ref.taskId, ref.callId) : undefined;
    const command = ref?.command ?? node.process?.command ?? node.label;
    setMenu({
      x: at.x - MENU_WIDTH,
      y: at.y,
      items: terminalMenuOf({
        offered,
        lit,
        place,
        running: node.running,
        typable: ref !== undefined && copy?.summary.tool === undefined,
        lines: copy?.screen.count ?? 0,
        plain: () => (ref !== undefined ? (terminals.get(ref.taskId, ref.callId)?.screen.plain() ?? "") : ""),
        command,
        title: node.process?.name ?? (ref !== undefined ? terminalTitleOf(ref.command, ref.dialect) : node.label),
        stop,
        interrupt: () => (ref !== undefined ? void signalTerminal(ref.taskId, ref.callId, "interrupt", project) : undefined),
      }),
    });
  };
  const indent = tree ? 6 + depth * 16 : 0;

  // Opened in place: the process card (a process another scope's is drawn once watched), or the terminal's.
  const shown = node.process !== undefined ? (node.process.processTaskId !== undefined ? (processes.get(node.process.key) ?? node.process) : processes.watchedAt(node.process.pid)) : undefined;
  if (open && (shown !== undefined || ref !== undefined)) {
    return (
      <View marginTop={2} marginBottom={8} marginLeft={indent} minWidth={0}>
        {shown !== undefined ? (
          <ProcessCard process={shown} project={project} fill={false} onFold={onFold} />
        ) : (
          <TerminalView taskId={ref!.taskId} project={project} callId={ref!.callId} command={ref!.command} dialect={ref!.dialect} onFold={onFold} />
        )}
      </View>
    );
  }

  const session = node.kind === "session";
  const twisty = tree && (node.children.length > 0 || node.id.startsWith("scope:"));
  // The row is hovered as a whole; what a press opens is its main part, and the buttons hovering shows
  // stand beside it, not inside it — a button is never inside another.
  const end = rowEndOf(node, hovered || menu !== null, lit);
  const chevron = (turned: boolean): JSX.Element => (
    <View transform={turned ? [{ rotate: "-90deg" }] : []}>
      <Icon name="chevron" size={11} color={String(t.v("dim"))} />
    </View>
  );
  const opens = ref !== undefined || node.process !== undefined;
  return (
    <>
      <View
        {...(hover as object)}
        {...(tree ? { role: "treeitem", "aria-level": depth + 1, ...(twisty ? { "aria-expanded": !folded } : {}) } : {})}
        flexDirection="row"
        alignItems="center"
        gap={tree ? 6 : 8}
        height={tree ? (session ? 32 : 28) : 34}
        paddingLeft={tree ? 4 + depth * 16 : 8}
        paddingRight={tree ? 6 : 8}
        borderRadius={6}
        borderWidth={1}
        borderStyle="solid"
        minWidth={0}
        position="relative"
        backgroundColor={(hovered || menu !== null ? t.v("fill-ghost-hover") : node.glyph === "escaped" && node.kind === "call" ? t.tint("warn", 8) : "transparent") as never}
        borderColor={(hovered ? t.v("line") : "transparent") as never}
      >
        {tree
          ? Array.from({ length: depth }, (_, level) => (
              <View key={level} position="absolute" top={-1} bottom={-1} left={4 + level * 16 + 5} width={1} backgroundColor={t.v("line") as never} pointerEvents="none" />
            ))
          : null}
        {twisty ? (
          <Press onPress={onTwisty} label={`${folded ? "Unfold" : "Fold"} ${node.label}`} fill={false} width={12} height={16} alignItems="center" justifyContent="center" flexShrink={0}>
            {chevron(folded)}
          </Press>
        ) : null}
        <Press
          onPress={onPress}
          label={opens ? `Open ${node.title ?? node.label} here` : `${folded ? "Unfold" : "Fold"} ${node.label}`}
          title={node.title}
          flexDirection="row"
          alignItems="center"
          gap={tree ? 6 : 8}
          flex={1}
          minWidth={0}
          alignSelf="stretch"
        >
          {tree && !twisty ? (
            <View width={12} alignItems="center" justifyContent="center" flexShrink={0}>
              {opens ? chevron(true) : null}
            </View>
          ) : null}
          {!tree ? (
            <View width={14} alignItems="center" justifyContent="center" flexShrink={0}>
              {chevron(true)}
            </View>
          ) : null}
          {session ? <Icon name={node.id.startsWith("scope:") ? "system" : "comment"} size={13} color={String(t.v("dim"))} /> : node.glyph !== undefined ? <StateGlyph glyph={node.glyph} t={t} /> : null}
          <Txt spec={session ? { voice: "app", scale: 12.5 / 12.5, weight: 600 } : { voice: "data", scale: 12.5 / 12, weight: 600, ...(node.glyph === "escaped" && node.kind === "call" ? { color: "warn" } : {}) }} numberOfLines={1} flexShrink={0} maxWidth="60%">
            {node.label}
          </Txt>
          {node.pid !== undefined ? <Txt spec={{ voice: "data", scale: 11.5 / 12, color: "dim", tabular: true }} flexShrink={0}>{String(node.pid)}</Txt> : null}
          {node.note !== undefined ? (
            <Txt spec={session ? { voice: "app", scale: 12 / 12.5, color: "dim" } : { voice: "data", scale: 11.5 / 12, color: "dim" }} ellip flexShrink={1} minWidth={0}>
              {node.note}
            </Txt>
          ) : null}
          {node.tag !== undefined ? <Tag words={node.tag.words} tone={node.tag.tone} t={t} /> : null}
          {(node.ports ?? []).slice(0, 1).map((port) => (
            <PortChip key={port} port={port} />
          ))}
          <View flex={1} minWidth={0} />
          {end.chips.map((one) => (
            <View key={one} flexDirection="row" alignItems="center" gap={4} height={20} paddingHorizontal={6} borderRadius={6} flexShrink={0} backgroundColor={colourOr(t, "tint-accent", "fill-ghost-selected") as never}>
              <Icon name={PLACE_CHIP[one].icon} size={12} color={String(t.v("accent"))} />
              <Txt spec={{ voice: "app", scale: 11.5 / 12.5, color: "accent" }}>{PLACE_CHIP[one].words}</Txt>
            </View>
          ))}
          {end.time ? (
            <Txt spec={{ voice: "data", scale: 12 / 12, color: node.timeBad === true ? "bad" : "dim", tabular: true }} flexShrink={0}>
              {node.time}
            </Txt>
          ) : null}
        </Press>
        {end.places && placeable !== undefined ? <PlaceButtons offered={offered} lit={lit} onPlace={place} /> : null}
        {end.more || (!canHover && opens) ? <MoreButton open={menu !== null} onPress={openMenu} /> : null}
        {end.stop && node.process?.protected === undefined ? <StopIcon onPress={stop} t={t} /> : null}
      </View>
      {node.waiting === true && ref !== undefined ? <Waiting taskId={ref.taskId} callId={ref.callId} indent={tree ? 4 + depth * 16 + 30 : 30} onAnswer={onPress} /> : null}
      {menu !== null ? <ContextMenu anchor={menu} onClose={() => setMenu(null)} /> : null}
    </>
  );
}

/** Under a row waiting for the person: its last two lines, and `Answer it`, which opens its card here. */
function Waiting({ taskId, callId, indent, onAnswer }: { taskId: string; callId: string; indent: number; onAnswer: () => void }): JSX.Element | null {
  const t = useTokens();
  const snapshot = useCallback(() => terminals.get(taskId, callId)?.version ?? 0, [taskId, callId]);
  useSyncExternalStore(terminals.subscribe, snapshot, snapshot);
  const screen = terminals.get(taskId, callId)?.screen;
  const lines = screen === undefined ? [] : screen.tail(3).filter((line) => line.some((span) => span.text.trim().length > 0)).slice(-2);
  return (
    <View flexDirection="row" alignItems="flex-end" gap={8} marginLeft={indent} marginRight={8} marginBottom={6} minWidth={0}>
      <View flex={1} minWidth={0} paddingVertical={4} paddingHorizontal={8} borderRadius={6} backgroundColor={TERM_INK.ground}>
        {lines.length > 0 ? lines.map((line, i) => <ScreenLine key={i} line={line} t={t} />) : <Txt spec={{ voice: "data", scale: 11 / 12, color: TERM_INK.dim }}>waiting for input</Txt>}
      </View>
      <Press onPress={onAnswer} label="Answer it: open its card here" height={24} paddingHorizontal={8} borderRadius={6} justifyContent="center" flexShrink={0} {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }, String(t.mix(t.v("warn"), 45, "transparent"))) as object)} box={({ hovered }) => ({ backgroundColor: hovered ? t.v("tint-warn") : "transparent" })}>
        <Txt spec={{ voice: "app", scale: 11.5 / 12.5, weight: 600, color: "warn" }}>Answer it</Txt>
      </Press>
    </View>
  );
}

/** The state glyph (round 2's `px-st-glyph`): 14 square, an 8 mark in it. */
function StateGlyph({ glyph, t }: { glyph: ProcessGlyph; t: Tokens }): JSX.Element {
  const ring = (colour: string, tint: string): JSX.Element => (
    <View width={14} height={14} borderRadius={7} alignItems="center" justifyContent="center" backgroundColor={tint as never}>
      <View width={8} height={8} borderRadius={4} backgroundColor={colour as never} />
    </View>
  );
  const box = (mark: JSX.Element): JSX.Element => (
    <View width={14} height={14} alignItems="center" justifyContent="center" flexShrink={0}>
      {mark}
    </View>
  );
  switch (glyph) {
    case "run":
      return box(ring(String(t.v("accent")), colourOr(t, "tint-accent", "fill-ghost-selected")));
    case "wait":
      return box(ring(String(t.v("warn")), String(t.v("tint-warn"))));
    case "left":
      return box(<View width={8} height={8} borderRadius={4} borderWidth={1.5} borderStyle="solid" borderColor={t.v("text") as never} />);
    case "escaped":
      return box(<View width={8} height={8} borderRadius={2} backgroundColor={t.v("warn") as never} transform={[{ rotate: "45deg" }]} />);
    case "external":
      return box(<View width={8} height={8} borderRadius={4} borderWidth={1.5} borderStyle="solid" borderColor={t.v("p3") as never} backgroundColor={t.mix(t.v("p3"), 25, "transparent") as never} />);
    case "bad":
      return box(<View width={8} height={8} borderRadius={4} backgroundColor={t.v("bad") as never} />);
    case "end":
      return box(<View width={8} height={8} borderRadius={4} backgroundColor={t.v("dim") as never} />);
  }
}

const TAG: Record<ProcessTagTone, { color: string; ground: string }> = {
  plain: { color: "dim", ground: "panel-2" },
  accent: { color: "accent", ground: "tint-accent" },
  warn: { color: "warn", ground: "tint-warn" },
  bad: { color: "bad", ground: "tint-bad" },
};

/** A row's tag (round 2's `px-tag`): a pill, 19 tall, padding 0 7, app 11 600. */
function Tag({ words, tone, t }: { words: string; tone: ProcessTagTone; t: Tokens }): JSX.Element {
  const { color, ground } = TAG[tone];
  return (
    <View height={19} paddingHorizontal={7} borderRadius={999} justifyContent="center" flexShrink={0} backgroundColor={(tone === "accent" ? colourOr(t, ground, "fill-ghost-selected") : t.v(ground)) as never}>
      <Txt spec={{ voice: "app", scale: 11 / 12.5, weight: 600, color }} numberOfLines={1}>
        {words}
      </Txt>
    </View>
  );
}

/** A row's Stop: the glyph alone (round 2's `px-stop icon`), 26 by 24. */
function StopIcon({ onPress, t }: { onPress: () => void; t: Tokens }): JSX.Element {
  return (
    <Press onPress={onPress} label="Stop it" title="end the command" width={26} height={24} alignItems="center" justifyContent="center" borderRadius={5} flexShrink={0} box={({ hovered }) => (hovered ? { backgroundColor: t.v("tint-bad") } : {})}>
      <Icon name="stop" size={10} color={String(t.v("bad"))} />
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
      {failed !== null ? <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "bad" }}>{failed}</Txt> : null}
    </View>
  );
}
