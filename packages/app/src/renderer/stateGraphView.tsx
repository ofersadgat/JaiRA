/**
 * The graph tab: the drawing itself, the map it is drawn on, and the attention model over both.
 *
 * Rendering only — every decision about what the picture SAYS was made in `stateGraph.ts`, and this
 * file is deliberately unable to make another one. What it owns is the three things that cannot be
 * computed from a document: where the camera is, how far in it is, and what the reader is pointing
 * at. Even the third is only COLLECTED here; what it implies is `focusOf`'s answer.
 *
 * ## HTML boxes over an SVG of lines
 *
 * Rather than an SVG of everything. A box is a heading, some chips and two columns of ports — all of
 * which HTML does for free, in the app's own registers, and none of which SVG text does at all. The
 * lines are the opposite: they are curves with arrowheads, which is SVG's whole job. The two halves
 * agree because the layout hands both of them the same coordinates, and because a box is given its
 * HEIGHT rather than allowed to find one — a box that grew past what the layout measured would leave
 * its wires ending in the wrong place.
 *
 * ## Attention is depth, not colour
 *
 * Hue is spent on WHICH VALUE and WHICH DIRECTION (see the vocabulary in `stateGraph.ts`), so it is
 * not available for "the thing you are looking at". What is left is weight, opacity and depth, and
 * this uses all three at once: the answer to the pointer's question comes forward and everything
 * else falls back hard. Lines are re-ordered rather than merely restyled, because in SVG the only
 * z-index there is is the order they are painted in — a lit wire under six dim ones is still under
 * six wires.
 *
 * ## The canvas is a map
 *
 * Drag to pan, wheel to zoom about the pointer, and the zoom keeps the point under the cursor still
 * — the gesture vocabulary of every map, chosen because it is the one nobody has to be taught. There
 * is no scrollbar: a graph is not a page, and the reader is looking for a region rather than a
 * position in a list. The camera starts fitted, and any deliberate move ends the fitting.
 *
 * ## Read-only, and that is the point
 *
 * The form edits and the JSON tab edits. This one answers the two questions neither of them can —
 * what runs after what and why, and where each value comes from — and answering them takes the whole
 * width of the pane. A control on every box would cost the space the picture is made of.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type {
  ExecutorInfo,
  FileTree,
  StateSlots,
  ValidateSchemaResult,
  WorkflowLayer,
  WorkflowSource,
} from "@jaira/shared/browser";
import type { UiSurface } from "./fileTypes";
import { StatePanel } from "./statePanel";
import { useValuePanel } from "./valuePanel";
import {
  focusOf,
  graphOf,
  idOf,
  layoutOf,
  unconditional,
  type Focus,
  type GraphChip,
  type GraphEdge,
  type GraphNode,
  type GraphPort,
  type GraphRow,
  type PlacedEdge,
  type PlacedNode,
  type PlacedWire,
} from "./stateGraph";
import {
  GESTURES,
  HEADS,
  MAX_ZOOM,
  MIN_ZOOM,
  SLOP,
  WORDS_OF_OURS,
  ZOOM_STEP,
  askAbout,
  edgeTitle,
  fitOf,
  frameTitle,
  headOf,
  hint,
  legendOf,
  markerTitle,
  nodeSessionTitle,
  paintOrder,
  portTitle,
  shownNames,
  sightlines,
  tierOf,
  zoomedAt,
  type Attention,
  type Camera,
} from "./stateGraphViewModel";

/** A chip's tone as a class. `plain` is the shared chip and needs nothing added to it. */
function chipTone(tone: GraphChip["tone"]): string {
  if (tone === "plain") return "";
  return tone === "accent" ? " sg-chip-on" : ` chip-${tone}`;
}

/**
 * A value's colour, from its hue — spent only on what is being asked about.
 *
 * At rest every wire is grey, and that is the whole point of the channel: colour is expensive, and a
 * drawing that spends it on twenty values at once has spent it on nothing. Grey wires are the shape
 * of the dataflow, which is the question at rest ("how much moves, and roughly where"); the moment a
 * box, a port or a line is pointed at, the lines that ARE the answer take their colours and the rest
 * stay as they were. So one hue at a time means one thing, instead of twenty meaning "a value".
 *
 * `oklch` rather than `hsl`, and that is what lets the grey be the same grey: a fixed lightness in
 * OKLCH IS a fixed lightness at every hue, so draining the chroma out of any of these leaves a
 * neutral of exactly the weight the coloured line had. In HSL it would not, and half the wheel would
 * change weight as it lit. The two numbers are theme tokens — see `--wire-l` and `--wire-c`.
 */
const inkOf = (hue: number): string => `oklch(var(--wire-l) var(--wire-c) ${hue})`;

/** The class that raises or fades one thing — see `tierOf`. */
function tier(attention: Attention, id: string): string {
  const t = tierOf(attention, id);
  return t === "" ? "" : ` is-${t}`;
}

/**
 * One port: a dot on the box's edge, the slot's name, and whatever the wire cannot say.
 *
 * The dot is on the border rather than inside it because that is where the layout put the end of the
 * line — see `place` in `stateGraph.ts`. It is FILLED when something is wired through it and hollow
 * when nothing is, which is the same question the whole drawing is about, asked one slot at a time.
 */
function Port({
  port,
  mark,
  hot,
  onEnter,
  onLeave,
}: {
  port: GraphPort;
  mark: string;
  /** True when this port is what is being asked about — the one condition colour is spent under. */
  hot: boolean;
  onEnter: () => void;
  onLeave: () => void;
}): JSX.Element {
  // Filled or hollow says whether anything is wired here, and it says it in grey: the DOT is the end
  // of a line, so it wears whatever that line is wearing — see `inkOf`.
  const ink = port.hue === null || !hot ? undefined : inkOf(port.hue);
  const dot: CSSProperties = port.inferred
    ? {}
    : {
        ...(ink === undefined ? {} : { borderColor: ink }),
        background: port.wired ? (ink ?? "var(--wire-idle)") : "var(--panel)",
      };
  const title = portTitle(port);
  return (
    <div
      className={`sg-port sg-port-${port.side}${port.inferred ? " sg-port-loose" : ""}${mark}`}
      title={title}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <i className="sg-dot" style={dot} />
      <span className="sg-pname data-text">{port.name}</span>
      {port.note.length > 0 ? <span className="sg-pnote data-faint">{port.note}</span> : null}
    </div>
  );
}

/** A body line that is not a port — an operation's settings. */
function Row({ row }: { row: GraphRow }): JSX.Element {
  return (
    <div className="sg-row" title={`${row.label} — ${row.value}`}>
      <span className="sg-name data-text">{row.label}</span>
      <span className="sg-value data-secondary">{row.value}</span>
    </div>
  );
}

function Box({
  box,
  mark,
  onFocus,
  onOpen,
  onShow,
  portMark,
  portHot,
}: {
  box: PlacedNode;
  mark: string;
  onFocus: (focus: Focus | null) => void;
  onOpen: (() => void) | null;
  /** Put this box's own configuration in the side panel. Absent ⇒ there is no panel to put it in. */
  onShow: (() => void) | null;
  portMark: (port: GraphPort) => string;
  portHot: (port: GraphPort) => boolean;
}): JSX.Element {
  const { node } = box;
  const ins = node.ports.filter((p) => p.side === "in");
  const outs = node.ports.filter((p) => p.side === "out");
  const self = (): void => onFocus({ kind: "node", id: node.id });
  const side = (ports: GraphPort[], out: boolean): JSX.Element => (
    <div className={out ? "sg-side sg-side-out" : "sg-side"}>
      {ports.map((port) => (
        <Port
          key={port.key}
          port={port}
          mark={portMark(port)}
          hot={portHot(port)}
          onEnter={() => onFocus({ kind: "port", node: node.id, port: port.key })}
          // Leaving a port does not leave the box it is on — the pointer is still inside, so the
          // question falls back to the box rather than to nothing.
          onLeave={self}
        />
      ))}
    </div>
  );
  return (
    <div
      className={`sg-node sg-${node.kind}${node.offSpine ? " sg-aside" : ""}${mark}`}
      // Named in the DOM: what a `document.querySelector` — in the devtools console, or in the
      // `shots/` driver — needs in order to say "that box" without counting siblings.
      data-node={node.id}
      style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
      onMouseEnter={self}
      onMouseLeave={() => onFocus(null)}
      // Click asks what this box IS; double-click goes to it. The two do not compete: the first
      // fills a panel that is already there, and the second is the only one that moves you.
      {...(onShow !== null ? { onClick: onShow } : {})}
      {...(onOpen !== null ? { onDoubleClick: onOpen } : {})}
      title={hint(node, onShow !== null, onOpen !== null)}
    >
      {/* The app's own words take the app voice; a key, a state reference and an outcome are the
          author's and take the data one — see the registers in `styles.css`. */}
      <div className={`sg-title ${WORDS_OF_OURS.has(node.kind) ? "app-text" : "data-title"}`}>{node.title}</div>
      {node.subtitle.length > 0 ? (
        <div className="sg-subtitle data-secondary" title={node.subtitle}>
          {node.subtitle}
        </div>
      ) : null}
      {node.session !== null ? (
        // On every box that has one, framed or not: a session of one is still a fact about the box —
        // that its transcript outlives the loop it sits in — and it is a fact nothing else says.
        <div
          className="sg-node-session"
          title={nodeSessionTitle(node.session)}
        >
          <i className="sg-session-mark" />
          <span className="data-text ellip">{node.session.name}</span>
        </div>
      ) : null}
      {node.chips.length > 0 ? (
        <div className="sg-node-chips">
          {node.chips.map((chip) => (
            <span
              key={`${chip.text}:${chip.title ?? ""}`}
              className={`chip${chipTone(chip.tone)}`}
              {...(chip.title !== undefined ? { title: chip.title } : {})}
            >
              {chip.text}
            </span>
          ))}
        </div>
      ) : null}
      {node.rows.map((row) => (
        <Row key={row.label} row={row} />
      ))}
      {/* A side with nothing on it is not rendered, so the other one gets the whole width. The entry
          hands everything out and takes nothing; half a box of empty column beside its outputs cost
          them the room their names needed. */}
      {node.ports.length > 0 ? (
        <div className="sg-ports">
          {ins.length > 0 ? side(ins, false) : null}
          {outs.length > 0 ? side(outs, true) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * A guard, whole.
 *
 * Never truncated and never on one line if it is a compound: a condition you have to hover to read
 * is a condition the picture did not show you, and `a && b && c` on one line is a sentence to parse
 * where three lines are a list to scan. The operator leads each line so the shape of the condition
 * is visible down the left edge — see `guardLines`, which does the splitting and the bracketing.
 *
 * Every runtime path inside it is a TERM: hovering one follows the value back to the port that
 * produced it, because "where does this number come from" is the same question the wires answer
 * everywhere else, and a condition is the one place it used to go unanswered.
 */
function Guard({
  edge,
  wireMark,
  onFocus,
}: {
  edge: GraphEdge;
  wireMark: (id: string) => string;
  onFocus: (focus: Focus | null) => void;
}): JSX.Element {
  let read = -1;
  return (
    <>
      {edge.lines.length === 0 ? (
        <div className="sg-clause sg-always app-secondary">{unconditional(edge)}</div>
      ) : (
        edge.lines.map((line, i) => (
          <div key={`${i}:${line.op}`} className={`sg-clause ${edge.structured ? "data-faint" : "data-text"}`}>
            {line.op === "" ? null : <span className="sg-op">{line.op}</span>}
            {line.terms.map((term, j) => {
              if (term.read === null) return <span key={j}>{term.text}</span>;
              read++;
              const wire = `g:${edge.id}:${read}`;
              return (
                <span
                  key={j}
                  className={`sg-term${wireMark(wire)}`}
                  title={`reads ${term.text}`}
                  onMouseEnter={() => onFocus({ kind: "wire", id: wire })}
                  // Back to the rule, which is what the pointer is still inside.
                  onMouseLeave={() => onFocus({ kind: "edge", id: edge.id })}
                >
                  {term.text}
                </span>
              );
            })}
          </div>
        ))
      )}
    </>
  );
}

export function StateGraphView({
  text,
  stateId,
  declared,
  onOpenState,
  readState,
  saveState,
  tree = null,
  executors = [],
  busy = false,
  validateSchema,
  loadStateSlots,
  wrapJson,
  onWrapJson,
  ui,
  readFile,
}: {
  /** The document as it stands — the same text the JSON tab is showing, drafts included. */
  text: string;
  /** This file's own state id, so a child's `./key` resolves into something openable. */
  stateId: string;
  /**
   * What the children declare, keyed by state id — see {@link graphOf}.
   *
   * Absent ⇒ each child shows only the ports something reads or wires. That is a degraded drawing
   * rather than a wrong one, and it is what a graph rendered outside the shell gets.
   */
  declared?: Record<string, StateSlots> | undefined;
  /** Open a child's own file. Absent ⇒ the boxes are inert, which is what a graph outside the shell is. */
  onOpenState?: ((stateId: string) => void) | undefined;
  /**
   * Everything the side panel's editor needs, for the state a clicked box mounts.
   *
   * All optional together: without `readState` a click shows the box's own declaration instead,
   * which is the most a graph rendered outside the shell can prove. See `statePanel.tsx`.
   */
  readState?: ((id: string) => Promise<WorkflowSource | null>) | undefined;
  saveState?: ((source: WorkflowSource, text: string) => void) | undefined;
  tree?: FileTree | null;
  executors?: ExecutorInfo[];
  busy?: boolean;
  validateSchema?: ((schemaId: string, text: string) => Promise<ValidateSchemaResult | null>) | undefined;
  loadStateSlots?: ((stateIds: string[]) => Promise<Record<string, StateSlots> | null>) | undefined;
  wrapJson?: boolean | undefined;
  onWrapJson?: ((wrap: boolean) => void) | undefined;
  ui?: UiSurface | undefined;
  /** Any file's text, so a linked property in the panel's form shows what it says. */
  readFile?: ((layer: WorkflowLayer, path: string) => Promise<string | null>) | undefined;
}): JSX.Element {
  /** `null` ⇒ nobody has moved the map, so it stays fitted to the pane. */
  const [camera, setCamera] = useState<Camera | null>(null);
  const [room, setRoom] = useState({ w: 0, h: 0 });
  const [focus, setFocus] = useState<Focus | null>(null);
  const [dragging, setDragging] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);
  /**
   * The pan in progress, and whether it has actually MOVED.
   *
   * `panning` is not bookkeeping: the pointer is not captured until the pointer travels, because a
   * capture retargets the compatibility mouse events too — so capturing on the way down handed the
   * map every click and double-click meant for a box, and double-clicking a child did nothing at
   * all. Capturing only once a drag is real leaves plain clicks where they belong.
   */
  const drag = useRef<{ id: number; x: number; y: number; from: Camera; panning: boolean } | null>(null);
  const panel = useValuePanel();

  const parsed = useMemo<{ doc: unknown; error: string | null }>(() => {
    try {
      return { doc: JSON.parse(text.length > 0 ? text : "{}"), error: null };
    } catch (e) {
      return { doc: null, error: (e as Error).message };
    }
  }, [text]);
  const graph = useMemo(() => graphOf(parsed.doc, stateId, declared ?? {}), [parsed.doc, stateId, declared]);
  const layout = useMemo(() => layoutOf(graph), [graph]);
  const attention = useMemo<Attention>(() => ({ ...focusOf(graph, focus), on: focus !== null }), [graph, focus]);

  useLayoutEffect(() => {
    const box = viewport.current;
    if (box === null) return;
    const measure = (): void => setRoom({ w: box.clientWidth, h: box.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  /**
   * The whole drawing, centred, at the largest scale that shows it — within reason at both ends.
   *
   * Blowing a small graph up to fill the pane does not make it easier to read, it just makes it big,
   * so a state that fits sits at 100% with air around it. The floor matters more: a nine-child state
   * fits a pane only at a third of life size, where the type is a grey smudge and the picture has
   * been "shown" to nobody. Below {@link READABLE} the fit gives up and parks at the BEGINNING
   * instead — the entry, where the run starts and where a reader would have panned to anyway.
   */
  const fit = useMemo<Camera>(() => fitOf(room, layout), [room, layout]);
  const shown = camera ?? fit;
  /**
   * The camera as it is RIGHT NOW, for the handlers that start a gesture.
   *
   * A wheel is a burst — a dozen notches inside one frame — and a drag reads where the map is when
   * the button goes down. Both computed from the last PAINTED camera would apply one notch of twelve
   * and undo a zoom begun in the same frame. This is written by the gestures and mirrored by the
   * render, so it is never a frame behind.
   */
  const held = useRef(shown);
  held.current = shown;

  const move = (next: Camera): void => {
    held.current = next;
    setCamera(next);
  };
  /** Zoom about a point in the viewport, keeping whatever is under it where it is. */
  const zoomAt = useCallback((px: number, py: number, ratio: number): void => {
    move(zoomedAt(held.current, px, py, ratio));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * The wheel, natively and not through React.
   *
   * React's own `onWheel` is registered passively at the root, so `preventDefault` inside it is
   * ignored and the surrounding panel scrolls while the map zooms. This listener asks for the
   * opposite explicitly, which is the only way to own the gesture.
   */
  useEffect(() => {
    const box = viewport.current;
    if (box === null) return;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const rect = box.getBoundingClientRect();
      // A trackpad's pinch arrives as ctrl+wheel and a mouse's notch as a large deltaY; the same
      // exponential covers both, so neither gesture needs a case of its own.
      zoomAt(e.clientX - rect.left, e.clientY - rect.top, Math.exp(-e.deltaY * 0.0015));
    };
    box.addEventListener("wheel", onWheel, { passive: false });
    return () => box.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    // Left button only, so a context menu or a middle-click paste is not a pan that never ends.
    if (e.button !== 0) return;
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, from: held.current, panning: false };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const from = drag.current;
    if (from === null || from.id !== e.pointerId) return;
    const dx = e.clientX - from.x;
    const dy = e.clientY - from.y;
    if (!from.panning) {
      // Not a pan until it is one. Under the slop a press is a click, and a click belongs to
      // whatever is under it.
      if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
      from.panning = true;
      // Capture keeps the pan alive when the pointer leaves the pane mid-drag. It throws for a
      // pointer the browser no longer considers active — a released stylus, a synthesised event —
      // and a pan that refused to start because of that would be worse than one that ends at the
      // pane's edge.
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* not capturable; the move handler still works while the pointer is over the map */
      }
      setDragging(true);
    }
    move({ k: from.from.k, x: from.from.x + dx, y: from.from.y + dy });
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (drag.current?.id !== e.pointerId) return;
    drag.current = null;
    setDragging(false);
  };

  if (parsed.error !== null) {
    return (
      <div className="reason">
        This file is not valid JSON ({parsed.error}) — fix it on the JSON tab to see the graph.
      </div>
    );
  }

  const has = (kind: GraphEdge["kind"]): boolean => graph.edges.some((e) => e.kind === kind);
  const flows = new Set(layout.edges.map((e) => e.flow));

  /**
   * Put what a box IS in the side panel.
   *
   * The panel is the window's answer to "what is this", and it already holds documents, artifacts
   * and payloads from five other places — so this goes there rather than into a popover of its own.
   * Clicking never MOVES you: the address bar, the open file and the camera all stay where they
   * were, which is what makes it safe to click around a graph while reading it.
   *
   * A CHILD shows the state it mounts, in the same form and the same JSON tab as the middle column —
   * the mount declaration is four lines of wiring and the question a reader is asking is what the
   * thing it wires actually does. Every other box IS part of this file, and the middle column is
   * already showing that, so those show their own slice of it and nothing more.
   */
  const show = (node: GraphNode): void => {
    if (node.stateId.length > 0 && readState !== undefined) {
      panel?.open({
        title: node.stateId,
        value: node.config,
        node: (
          <StatePanel
            stateId={node.stateId}
            read={readState}
            save={saveState ?? (() => undefined)}
            tree={tree ?? null}
            executors={executors}
            busy={busy}
            {...(validateSchema !== undefined ? { validateSchema } : {})}
            {...(loadStateSlots !== undefined ? { loadStateSlots } : {})}
            {...(wrapJson !== undefined ? { wrapJson } : {})}
            onWrapJson={onWrapJson}
            ui={ui}
            {...(readFile !== undefined ? { readFile } : {})}
            onOpenState={onOpenState}
          />
        ),
      });
      return;
    }
    panel?.open({ title: node.title, value: node.config });
  };

  /** Lit and nothing less: `near` is what a lit line TOUCHES, and touching is not being asked about. */
  const isLit = (id: string): boolean => attention.on && attention.lit.has(id);
  /**
   * A wire's colour, or nothing — in which case the stylesheet's grey stands.
   *
   * Nothing rather than an explicit grey, so that the one place the resting colour is written is the
   * `.sg-flow` rule beside the weight and the dash it goes with.
   */
  const wireStyle = (placed: PlacedWire): CSSProperties =>
    isLit(idOf.wire(placed.wire.id)) ? { stroke: inkOf(placed.wire.hue) } : {};
  const lineClass = (placed: PlacedEdge | PlacedWire): string => {
    if ("wire" in placed) return `sg-flow sg-flow-${placed.wire.kind}`;
    const { edge, flow } = placed;
    const marks = ["sg-step", `sg-step-${flow}`, `sg-step-${edge.kind}`];
    if (edge.nowait) marks.push("sg-step-nowait");
    return marks.join(" ");
  };
  /** A guard's pill wears its arrow's direction and its arrow's dash: the two are one statement. */
  const labelClass = (placed: PlacedEdge): string => {
    const marks = ["sg-label", `sg-label-${placed.flow}`];
    if (placed.edge.kind === "state") marks.push("sg-label-any");
    return marks.join(" ") + tier(attention, idOf.edge(placed.edge.id));
  };
  /** A line's own colour, which its edge marker borrows: the pill and the line are one statement. */
  const inkFor = (line: PlacedEdge | PlacedWire): string | undefined =>
    "wire" in line
      ? isLit(idOf.wire(line.wire.id))
        ? inkOf(line.wire.hue)
        : undefined
      : line.edge.kind === "sequence"
        ? undefined
        : `var(--go-${line.flow})`;
  const sight = sightlines(
    layout,
    shown,
    room,
    new Map(layout.nodes.map((n) => [n.node.id, n.node.title])),
    inkFor,
    (id) => !attention.on || attention.lit.has(id) || attention.near.has(id),
  );
  /** Every line, dim ones first: the last one painted is the one on top — see the module header. */
  const lines = paintOrder(layout, attention);
  return (
    <div className="sg">
      {/* The vocabulary, in the order it is read: what a line IS, then which way it goes. Only the
          kinds this drawing contains — a legend that names a line the state does not have teaches
          the wrong thing about the state. */}
      <div className="sg-bar edit-bar">
        {legendOf(flows, has("state"), graph.sessions.length > 0).map((key) => (
          <span key={key.swatch} className="sg-key" title={key.title}>
            <i className={`sg-swatch sg-swatch-${key.swatch}`} />
            {key.word}
          </span>
        ))}
        {graph.limits.map((limit) => (
          <span key={limit} className="chip">
            {limit}
          </span>
        ))}
        <span className="spacer" />
        {/* The two gestures that have no other way of being discovered. What a BOX offers is on the
            box's own tooltip, where it is asked for rather than announced. */}
        <span className="sub">{GESTURES}</span>
        <div className="tabs seg">
          <button
            className="ghost"
            onClick={() => zoomAt(room.w / 2, room.h / 2, 1 / ZOOM_STEP)}
            disabled={shown.k <= MIN_ZOOM}
            title="zoom out"
          >
            −
          </button>
          <button
            className={camera === null ? "layer-on" : "ghost"}
            onClick={() => setCamera(null)}
            title="fit the whole state in the pane"
          >
            {Math.round(shown.k * 100)}%
          </button>
          <button
            className="ghost"
            onClick={() => zoomAt(room.w / 2, room.h / 2, ZOOM_STEP)}
            disabled={shown.k >= MAX_ZOOM}
            title="zoom in"
          >
            +
          </button>
        </div>
      </div>

      <div
        className={`sg-map${dragging ? " sg-panning" : ""}${attention.on ? " sg-focused" : ""}`}
        ref={viewport}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div
          className="sg-canvas"
          style={{
            width: layout.width,
            height: layout.height,
            transform: `translate(${shown.x}px, ${shown.y}px) scale(${shown.k})`,
          }}
        >
          {/* Behind the lines and behind the boxes: a frame is the ground its members stand on, and
              a region drawn over a line would be claiming to be one. */}
          {layout.frames.map((frame) => (
            <div
              key={frame.session.id}
              className={`sg-frame${tier(attention, idOf.session(frame.session.id))}`}
              data-session={frame.session.id}
              style={{ left: frame.x, top: frame.y, width: frame.w, height: frame.h }}
              title={frameTitle(frame.session)}
              onMouseEnter={() => setFocus({ kind: "session", id: frame.session.id })}
              onMouseLeave={() => setFocus(null)}
            >
              <span className="sg-frame-name data-text">{frame.session.name}</span>
              <span className="sg-frame-scope sub">{frame.session.scope}</span>
            </div>
          ))}
          <svg className="sg-lines" width={layout.width} height={layout.height} aria-hidden focusable="false">
            <defs>
              {HEADS.map((head) => (
                <marker
                  key={head}
                  id={`sg-arrow-${head}`}
                  viewBox="0 0 8 8"
                  refX="7"
                  refY="4"
                  markerWidth="7"
                  markerHeight="7"
                  orient="auto"
                >
                  <path d="M 0 0 L 8 4 L 0 8 z" className={`sg-head-${head}`} />
                </marker>
              ))}
            </defs>
            {lines.map(({ id, placed }) => (
              <g key={id}>
                {"wire" in placed ? (
                  <path
                    d={placed.d}
                    className={lineClass(placed) + tier(attention, id)}
                    style={wireStyle(placed)}
                  />
                ) : (
                  <path
                    d={placed.d}
                    className={lineClass(placed) + tier(attention, id)}
                    markerEnd={`url(#sg-arrow-${headOf(placed)})`}
                  />
                )}
                {/* The line as a TARGET, which the drawn one cannot be: two pixels of stroke is not
                    something a pointer can be expected to find. Invisible, fat, and carrying the
                    same question the line's label carries — a line IS a statement, so pointing at it
                    has to ask about it. */}
                <path
                  d={placed.d}
                  className="sg-hit"
                  data-line={id}
                  onMouseEnter={() => setFocus(askAbout(placed))}
                  onMouseLeave={() => setFocus(null)}
                >
                  <title>{"wire" in placed ? placed.wire.binding : edgeTitle(placed.edge)}</title>
                </path>
              </g>
            ))}
          </svg>

          {layout.edges.map((placed) => {
            if (placed.label === null) return null;
            // Where it can actually be read right now, which is its own place until the camera takes
            // that off screen — see `sightlines`.
            const spot = sight.labels.get(placed.edge.id) ?? placed.label;
            return spot === null ? null : (
              <div
                key={`label:${placed.edge.id}`}
                data-edge={placed.edge.id}
                className={labelClass(placed)}
                style={{ left: spot.x, top: spot.y, minWidth: placed.label.w }}
                title={edgeTitle(placed.edge)}
                onMouseEnter={() => setFocus({ kind: "edge", id: placed.edge.id })}
                onMouseLeave={() => setFocus(null)}
              >
                <Guard
                  edge={placed.edge}
                  wireMark={(id) => tier(attention, idOf.wire(id))}
                  onFocus={setFocus}
                />
                {placed.edge.dangling ? <span className="chip chip-bad">no such target</span> : null}
              </div>
            );
          })}

          {layout.nodes.map((box) => (
            <Box
              key={box.node.id}
              box={box}
              mark={tier(attention, idOf.node(box.node.id))}
              onFocus={setFocus}
              portMark={(port) => tier(attention, idOf.port(box.node.id, port.key))}
              portHot={(port) => isLit(idOf.port(box.node.id, port.key))}
              onOpen={
                onOpenState !== undefined && box.node.stateId.length > 0
                  ? () => onOpenState(box.node.stateId)
                  : null
              }
              onShow={panel === null || box.node.config === undefined ? null : () => show(box.node)}
            />
          ))}
        </div>

        {/* Outside the canvas, so these do not scale: they are chrome about the camera rather than
            part of the drawing, and a pill that shrank as you zoomed in would disappear exactly when
            it started being needed. */}
        <div className="sg-edge-marks">
          {sight.markers.map((marker) => (
            <div
              key={marker.key}
              className={`sg-edge-mark sg-edge-${marker.side}${marker.into ? " sg-edge-mark-to" : ""}`}
              style={{ left: marker.x, top: marker.y }}
              title={markerTitle(marker)}
            >
              {/* The arrow points the way the lines run: `goals →` is what they come FROM, and
                  `→ exit` is where they go. Once, for the whole list — the direction is the same for
                  everything in one pill, which is why they were allowed to merge. */}
              {marker.into ? <span className="sg-edge-arrow">→</span> : null}
              {shownNames(marker).names.map((name) => (
                <span
                  key={`${name.node}/${name.port ?? ""}`}
                  className="sg-edge-name data-text"
                  style={{ color: name.ink }}
                  // Whatever the name says: a slot when it names one, the box when it names a box.
                  onMouseEnter={() =>
                    setFocus(
                      name.port === null
                        ? { kind: "node", id: name.node }
                        : { kind: "port", node: name.node, port: name.port },
                    )
                  }
                  onMouseLeave={() => setFocus(null)}
                >
                  {name.label}
                </span>
              ))}
              {shownNames(marker).rest > 0 ? (
                <span className="sg-edge-name sg-edge-rest sub">+{shownNames(marker).rest}</span>
              ) : null}
              {marker.into ? null : <span className="sg-edge-arrow">→</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
