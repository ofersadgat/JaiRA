import { useEffect, useMemo, useState, type JSX } from "react";
import { TextInput, type GestureResponderEvent } from "react-native";
import { View, isWeb } from "@tamagui/core";
import type { TerminalSummary } from "@jaira/shared/browser";
import { terminalEntryOf } from "@jaira/ui/panelStack";
import {
  TERMINALS_VIEWS,
  TERMINALS_VIEW_MODE,
  pressOf,
  rowEndOf,
  shownNodesOf,
  stopTargetsOf,
  terminalListOf,
  terminalTreeOf,
  toggled,
  type ProcessGlyph,
  type ProcessTagTone,
  type ProcessTreeNode,
  type TerminalsView,
} from "@jaira/ui/processTreeModel";
import { PLACES, type Place } from "@jaira/ui/splitModel";
import { runYours, signalTerminal, terminals } from "@jaira/ui/terminalStore";
import { terminalTitleOf } from "@jaira/ui/terminalModel";
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
import { MoreButton, TerminalView, pressedAt, terminalMenuOf } from "./TerminalView";
import { useTerminals } from "./useTerminal";

/**
 * The side panel's Terminals tab (decision 0028, ruling 7; decision 0032's view, ruling 2): a line to run
 * a command of your own in the conversation's workspace (0028, ruling 8), then a List | Tree toggle.
 *
 * List is today's rows — Running (those waiting for the person first), then Ended. Tree goes from the
 * session to its terminals to what started them: a tool call's processes under that call. Both draw one
 * row anatomy (`processTreeModel.ts`'s `ProcessTreeNode`), so the engine's process tree can feed Tree
 * later in place of the window's terminals. Hovered, a row's time gives way to the three place buttons
 * (the place it is in lit), `…` and Stop; pressed, it opens in place as the card, and its head folds it
 * back. More than one can be open. How it looks:
 *
 *   the run line     row, gap 8, padding 0 6 0 10, height 34, 1px --line, radius 8: `›`, the field
 *                    (data 12/12), Run
 *   the toolbar      the toggle: one joined switch, 1px --line, radius 7; each half 26 tall, padding 0 8,
 *                    app 12.5, --dim on --panel; on: --text 600 on --panel-2
 *   a caption        data 10.5/12, 0.06em, uppercase, --dim; the count at the far end
 *   a row            row, gap 8, height 34 (Tree: 28, a session 32; indented 16 a level), padding 0 8,
 *                    radius 6, a 1px edge that shows only hovered: a chevron (right; Tree: the twisty),
 *                    the state glyph (14), the label (data 12.5 600), the rest of its line (data 11.5
 *                    --dim), its tag (a pill, 19 tall, app 11 600), a spacer, then the places it is in as
 *                    lit chips and its time (data 12 --dim); hovered, on --fill-ghost-hover: the place
 *                    buttons, `…` and Stop
 *   opened           the card (`TerminalView`), its title bar the row's head with a chevron (down);
 *                    margin 2 0 8, indented as its row in Tree
 */
export function TerminalsTab({ taskId, project, onOpen }: { taskId: string; project: string | undefined; onOpen: (terminal: TerminalSummary) => void }): JSX.Element {
  const list = useTerminals(taskId, project);
  const [view, setView] = useTerminalsView();
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  const now = useTicking(list.some((one) => one.endedAt === undefined));
  const rows = useMemo(() => terminalListOf(list, now), [list, now]);
  const tree = useMemo(() => terminalTreeOf({ id: taskId, label: "This conversation" }, list, now), [taskId, list, now]);
  const press = (node: ProcessTreeNode): void => {
    const does = pressOf(node);
    if (does === "open") setOpen((was) => toggled(was, node.id));
    else if (does === "fold") setFolded((was) => toggled(was, node.id));
  };
  const twisty = (node: ProcessTreeNode): void => setFolded((was) => toggled(was, node.id));
  const row = (node: ProcessTreeNode, depth: number, tree: boolean, shut = false): JSX.Element => (
    <ProcessRow key={node.id} node={node} depth={depth} tree={tree} project={project} open={open.has(node.id)} folded={shut} onPress={() => press(node)} onTwisty={() => twisty(node)} />
  );
  return (
    <View flexDirection="column" gap={10} minWidth={0}>
      <RunLine taskId={taskId} project={project} onRan={onOpen} />
      <View flexDirection="row" alignItems="center" gap={8}>
        <ViewToggle view={view} onView={setView} />
      </View>
      {list.length === 0 ? (
        <Txt spec={{ voice: "app", scale: 12 / 12.5, color: "dim" }}>No commands yet. The agent's shell commands, and yours, are listed here as they run.</Txt>
      ) : view === "list" ? (
        <>
          {rows.running.length > 0 ? <Caption words="Running" count={rows.running.length} /> : null}
          {rows.running.length > 0 ? <View flexDirection="column" minWidth={0}>{rows.running.map((node) => row(node, 0, false))}</View> : null}
          {rows.ended.length > 0 ? <Caption words="Ended" count={rows.ended.length} /> : null}
          {rows.ended.length > 0 ? <View flexDirection="column" minWidth={0}>{rows.ended.map((node) => row(node, 0, false))}</View> : null}
        </>
      ) : (
        <View role="tree" aria-label="This conversation's processes" flexDirection="column" minWidth={0}>
          {shownNodesOf(tree, folded, open).map(({ node, depth, folded: shut }) => row(node, depth, true, shut))}
        </View>
      )}
    </View>
  );
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

/** One row of the tab, List or Tree; opened, the card in its place. */
function ProcessRow({ node, depth, tree, project, open, folded, onPress, onTwisty }: { node: ProcessTreeNode; depth: number; tree: boolean; project: string | undefined; open: boolean; folded: boolean; onPress: () => void; onTwisty: () => void }): JSX.Element {
  const t = useTokens();
  const canHover = useCanHover();
  const phone = usePhone();
  const here = usePlacesHere(phone);
  const ref = node.terminal;
  const entry = useMemo(() => (ref === undefined ? undefined : terminalEntryOf({ ...ref, project })), [ref, project]);
  const lit = useEntryPlaces(entry?.key ?? "");
  const [menu, setMenu] = useState<MenuAt | null>(null);
  const [hovered, hover] = useHover();
  const offered = PLACES.filter((place) => place === "main" || here[place] || lit.includes(place));
  const place = (target: Place): void => {
    if (entry !== undefined) moveEntry(target, entry, lit, phone);
  };
  const stop = (): void => {
    for (const one of stopTargetsOf(node)) void signalTerminal(one.taskId, one.callId, "stop", project);
  };
  const openMenu = (e: GestureResponderEvent): void => {
    if (ref === undefined) return;
    const at = pressedAt(e);
    const copy = terminals.get(ref.taskId, ref.callId);
    const title = terminalTitleOf(ref.command, ref.dialect);
    setMenu({
      x: at.x - MENU_WIDTH,
      y: at.y,
      items: terminalMenuOf({
        offered,
        lit,
        place,
        running: node.running,
        typable: copy?.summary.tool === undefined,
        lines: copy?.screen.count ?? 0,
        plain: () => terminals.get(ref.taskId, ref.callId)?.screen.plain() ?? "",
        command: ref.command,
        title,
        stop,
        interrupt: () => void signalTerminal(ref.taskId, ref.callId, "interrupt", project),
      }),
    });
  };

  if (open && ref !== undefined) {
    return (
      <View marginTop={2} marginBottom={8} marginLeft={tree ? 6 + depth * 16 : 0} minWidth={0}>
        <TerminalView taskId={ref.taskId} project={project} callId={ref.callId} command={ref.command} dialect={ref.dialect} onFold={onPress} />
      </View>
    );
  }

  const session = node.kind === "session";
  const twisty = tree && node.children.length > 0;
  // The row is hovered as a whole; what a press opens is its main part, and the buttons hovering shows
  // stand beside it, not inside it — a button is never inside another.
  const end = rowEndOf(node, hovered || menu !== null, lit);
  const chevron = (turned: boolean): JSX.Element => (
    <View transform={turned ? [{ rotate: "-90deg" }] : []}>
      <Icon name="chevron" size={11} color={String(t.v("dim"))} />
    </View>
  );
  return (
    <>
      <View
        {...(hover as object)}
        {...(tree ? { role: "treeitem", "aria-level": depth + 1, ...(node.children.length > 0 ? { "aria-expanded": !folded } : {}) } : {})}
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
        backgroundColor={(hovered || menu !== null ? t.v("fill-ghost-hover") : "transparent") as never}
        borderColor={(hovered ? t.v("line") : "transparent") as never}
      >
        {twisty ? (
          <Press onPress={onTwisty} label={`${folded ? "Unfold" : "Fold"} ${node.label}`} fill={false} width={12} height={16} alignItems="center" justifyContent="center" flexShrink={0}>
            {chevron(folded)}
          </Press>
        ) : null}
        <Press
          onPress={onPress}
          label={ref !== undefined ? `Open ${node.title ?? node.label} here` : `${folded ? "Unfold" : "Fold"} ${node.label}`}
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
              {ref !== undefined ? chevron(true) : null}
            </View>
          ) : null}
          {!tree ? (
            <View width={14} alignItems="center" justifyContent="center" flexShrink={0}>
              {chevron(true)}
            </View>
          ) : null}
          {session ? <Icon name="comment" size={13} color={String(t.v("dim"))} /> : node.glyph !== undefined ? <StateGlyph glyph={node.glyph} t={t} /> : null}
          <Txt spec={session ? { voice: "app", scale: 12.5 / 12.5, weight: 600 } : { voice: "data", scale: 12.5 / 12, weight: 600 }} numberOfLines={1} flexShrink={0} maxWidth="60%">
            {node.label}
          </Txt>
          {node.pid !== undefined ? <Txt spec={{ voice: "data", scale: 11.5 / 12, color: "dim", tabular: true }}>{String(node.pid)}</Txt> : null}
          {node.note !== undefined ? (
            <Txt spec={session ? { voice: "app", scale: 12 / 12.5, color: "dim" } : { voice: "data", scale: 11.5 / 12, color: "dim" }} ellip flexShrink={1} minWidth={0}>
              {node.note}
            </Txt>
          ) : null}
          {node.tag !== undefined ? <Tag words={node.tag.words} tone={node.tag.tone} t={t} /> : null}
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
        {end.places ? <PlaceButtons offered={offered} lit={lit} onPlace={place} /> : null}
        {end.more || (!canHover && ref !== undefined) ? <MoreButton open={menu !== null} onPress={openMenu} /> : null}
        {end.stop ? <StopIcon onPress={stop} t={t} /> : null}
      </View>
      {menu !== null ? <ContextMenu anchor={menu} onClose={() => setMenu(null)} /> : null}
    </>
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
      <Txt spec={{ voice: "app", scale: 11 / 12.5, color: failed !== null ? "bad" : "dim" }}>{failed ?? "Runs as you: permission sets decide what an agent may run, not you. The agent hears of it with your next message."}</Txt>
    </View>
  );
}
