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
  pointOn,
  unconditional,
  type Curve,
  type EdgeFlow,
  type Focus,
  type GraphChip,
  type GraphEdge,
  type GraphLayout,
  type GraphNode,
  type GraphPort,
  type GraphRow,
  type GraphWire,
  type PlacedEdge,
  type PlacedNode,
  type PlacedWire,
} from "./stateGraph";

/** How far in the map may go. Past 2× the type is enormous; below 0.2 nothing is readable anyway. */
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 2;
/** One press of − or +, as a ratio. A quarter step: two presses is a noticeable move, not a jump. */
const ZOOM_STEP = 1.25;
/** The smallest scale at which type is still type. Below this, fitting stops being showing. */
const READABLE = 0.55;
/** How far a press may travel and still be a click rather than a pan. */
const SLOP = 3;
/** One arrowhead per direction a move can take, plus the sequence's own. */
const HEADS = ["spine", "onward", "back", "abort"] as const;

/** Where the map is: the canvas origin in viewport px, and the scale it is drawn at. */
interface Camera {
  x: number;
  y: number;
  k: number;
}

const clamp = (k: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));

/** Whose words a box's heading is — see the two voices in `styles.css`. */
const WORDS_OF_OURS = new Set<GraphNode["kind"]>(["entry", "exit", "any"]);

/** A chip's tone as a class. `plain` is the shared chip and needs nothing added to it. */
function chipTone(tone: GraphChip["tone"]): string {
  if (tone === "plain") return "";
  return tone === "accent" ? " sg-chip-on" : ` chip-${tone}`;
}

/**
 * A value's colour, from its hue.
 *
 * `oklch` rather than `hsl`, and that is the whole reason the palette can afford twenty of these: in
 * OKLCH a fixed lightness IS a fixed lightness at every hue, so yellow and blue come out equally
 * readable on the same ground. In HSL they do not, and half a wheel of wires would be invisible. The
 * two numbers are theme tokens — see `--wire-l` and `--wire-c`.
 */
const inkOf = (hue: number): string => `oklch(var(--wire-l) var(--wire-c) ${hue})`;

/** What the reader is pointing at, as the two tiers of emphasis it implies. */
type Attention = { lit: Set<string>; near: Set<string>; on: boolean };

/** The class that raises or fades one thing. Nothing is dimmed while nothing is focused. */
function tier(attention: Attention, id: string): string {
  if (!attention.on) return "";
  if (attention.lit.has(id)) return " is-lit";
  if (attention.near.has(id)) return " is-near";
  return " is-dim";
}

/** Painted last means painted on top: SVG has no other z-index — see the module header. */
function depth(attention: Attention, id: string): number {
  if (!attention.on) return 1;
  if (attention.lit.has(id)) return 3;
  if (attention.near.has(id)) return 2;
  return 0;
}

/** How far in from the pane's edge a marker, or a condition kept beside one, may sit. */
const EDGE_INSET = 10;
/** A marker's height, so a condition kept beside one can sit clear above it. */
const MARKER_H = 22;
/** How finely a line is walked when asking where it leaves the view. */
const WALK = 32;

/** Which edge of the pane a line leaves by. */
type Side = "l" | "r" | "t" | "b";

/**
 * One pill at the pane's edge, naming everything that is off it just there.
 *
 * A LIST rather than one name, because several lines leaving at the same place is the normal case —
 * a box near the edge sends four wires the same way — and four pills stacked on one crossing is four
 * times the ink for one fact. They are merged when they would sit on top of each other, and what is
 * left is pushed apart along the edge, so a pill never covers a pill.
 */
interface Marker {
  key: string;
  side: Side;
  /** True when the far ends are where the lines GO; false when they are where the lines come FROM. */
  into: boolean;
  x: number;
  y: number;
  names: { node: string; label: string; ink: string | undefined }[];
}

interface Sight {
  markers: Marker[];
  /** Where each guard may be written, in canvas units — `null` when its arc is off screen entirely. */
  labels: Map<string, { x: number; y: number } | null>;
}

/** A box in viewport space, for keeping two things that must both be readable off each other. */
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const overlaps = (a: Rect, b: Rect): boolean =>
  Math.abs(a.x - b.x) < (a.w + b.w) / 2 && Math.abs(a.y - b.y) < (a.h + b.h) / 2;

/** About as wide as a pill gets: the mono face's advance, plus its padding and separators. */
const markerWidth = (marker: Marker): number =>
  26 + marker.names.reduce((wide, name) => wide + name.label.length * 6.6 + 10, 0);

/**
 * What zooming in costs, and how to give it back.
 *
 * Close enough to read a box, most of what the boxes are JOINED to is off the screen — so a line
 * running off the edge stops saying anything at all, and the tab's whole answer ("what runs after
 * what, and where does this come from") is exactly the part that has left. Two repairs, both worked
 * out here in viewport space because both are questions about the CAMERA rather than the drawing:
 *
 *  - a line crossing the edge gets a pill AT that edge naming what is at its far end — pinned to the
 *    edge rather than left at the crossing, merged with any pill it would have sat on, and pushed
 *    along the edge until it clears the rest;
 *  - a condition whose natural place on its arc has gone off screen slides ALONG the arc to the
 *    nearest place that is still visible, and then off anything already written there.
 *
 * `shows` is the attention model, so that a focused reading marks only the lines it is about.
 */
function sightlines(
  layout: GraphLayout,
  cam: Camera,
  room: { w: number; h: number },
  titles: Map<string, string>,
  ink: (line: PlacedEdge | PlacedWire) => string | undefined,
  shows: (id: string) => boolean,
): Sight {
  const labels = new Map<string, { x: number; y: number } | null>();
  if (room.w === 0 || room.h === 0) return { markers: [], labels };
  const at = (p: { x: number; y: number }): { x: number; y: number } => ({
    x: p.x * cam.k + cam.x,
    y: p.y * cam.k + cam.y,
  });
  const rect = { l: EDGE_INSET, t: EDGE_INSET, r: room.w - EDGE_INSET, b: room.h - EDGE_INSET };
  const seen = (p: { x: number; y: number }): boolean =>
    p.x >= rect.l && p.x <= rect.r && p.y >= rect.t && p.y <= rect.b;
  const walk = (curve: Curve): { x: number; y: number }[] =>
    Array.from({ length: WALK + 1 }, (_, i) => at(pointOn(curve, i / WALK)));

  // --- where each line leaves, and what is out there -------------------------
  /** One line's exit: the side it crossed, where along that side, and what is beyond it. */
  type Exit = { side: Side; along: number; into: boolean; node: string; label: string; ink: string | undefined };
  const exits: Exit[] = [];
  /**
   * Which edge a line left by.
   *
   * Measured from the first point PAST the edge rather than from the last one inside it: the inside
   * point is by definition within the rectangle and says nothing about which way the line was going.
   */
  const sideOf = (out: { x: number; y: number }): Side => {
    const over = [
      { side: "l" as const, by: rect.l - out.x },
      { side: "r" as const, by: out.x - rect.r },
      { side: "t" as const, by: rect.t - out.y },
      { side: "b" as const, by: out.y - rect.b },
    ].sort((a, b) => b.by - a.by);
    return over[0]!.side;
  };
  const exit = (
    node: string | null,
    inside: { x: number; y: number },
    outside: { x: number; y: number },
    into: boolean,
    hue: string | undefined,
  ): void => {
    const label = node === null ? undefined : titles.get(node);
    if (node === null || label === undefined) return;
    const side = sideOf(outside);
    const along = side === "l" || side === "r" ? inside.y : inside.x;
    exits.push({ side, along, into, node, label, ink: hue });
  };

  const crossing = (line: PlacedEdge | PlacedWire, id: string, from: string | null, to: string | null): void => {
    if (!shows(id)) return;
    const pts = walk(line.curve);
    const vis = pts.map(seen);
    const first = vis.indexOf(true);
    if (first < 0) return; // the whole line is somewhere else
    const last = vis.lastIndexOf(true);
    if (!vis[0]) exit(from, pts[first]!, pts[Math.max(0, first - 1)]!, false, ink(line));
    if (!vis[vis.length - 1]) exit(to, pts[last]!, pts[Math.min(pts.length - 1, last + 1)]!, true, ink(line));
  };

  for (const line of layout.wires) {
    // A guard's read ends at a RULE rather than at a box, and "a condition" is not a place a reader
    // can be sent — so that end is left unmarked.
    const to = line.wire.to.node.startsWith("rule:") ? null : line.wire.to.node;
    crossing(line, idOf.wire(line.wire.id), line.wire.from.node, to);
  }
  for (const line of layout.edges) {
    crossing(line, idOf.edge(line.edge.id), line.edge.from, line.edge.to);
  }

  // --- merge what would collide, then push apart what is left ----------------
  const markers: Marker[] = [];
  const groups = new Map<string, Exit[]>();
  for (const one of exits) {
    const key = `${one.side}:${one.into}`;
    const found = groups.get(key);
    if (found === undefined) groups.set(key, [one]);
    else found.push(one);
  }
  for (const [key, group] of groups) {
    /**
     * Lines that leave CLOSE TOGETHER are one pill listing what is at the end of each.
     *
     * Close together and nothing else: merging by name instead — one pill per node, wherever its
     * lines crossed — put a single pill at the average of two crossings a screen apart, which named
     * a box neither line was anywhere near. Two crossings that far apart are two facts, and the
     * same name twice is the honest answer. Inside one cluster a name is still said once.
     *
     * The anchor stays at the FIRST crossing of the cluster rather than moving to their mean, so a
     * pill never drifts away from the lines it speaks for.
     */
    group.sort((a, b) => a.along - b.along);
    const held: { along: number; names: Marker["names"] }[] = [];
    for (const one of group) {
      const last = held.at(-1);
      if (last !== undefined && one.along - last.along < MARKER_H + 8) {
        if (!last.names.some((n) => n.node === one.node)) last.names.push(one);
        continue;
      }
      held.push({ along: one.along, names: [one] });
    }
    for (const [i, cluster] of held.entries()) {
      const side = key.slice(0, 1) as Side;
      const into = key.endsWith("true");
      const marker: Marker = { key: `${key}:${i}`, side, into, x: 0, y: 0, names: cluster.names };
      const wide = markerWidth(marker);
      // Pinned to the edge it crossed, a hair inside it: what is off the screen is announced AT the
      // screen's edge, not wherever the curve happened to still be visible.
      if (side === "l") marker.x = rect.l + wide / 2;
      else if (side === "r") marker.x = rect.r - wide / 2;
      else marker.x = Math.min(rect.r - wide / 2, Math.max(rect.l + wide / 2, cluster.along));
      if (side === "t") marker.y = rect.t + MARKER_H / 2;
      else if (side === "b") marker.y = rect.b - MARKER_H / 2;
      else marker.y = Math.min(rect.b - MARKER_H / 2, Math.max(rect.t + MARKER_H / 2, cluster.along));
      markers.push(marker);
    }
  }
  /**
   * Nothing on one edge may cover anything else on it.
   *
   * Resolved per SIDE rather than per group, because the pills that come from that edge and the ones
   * that go out of it share the same strip of screen. Each is pushed along the edge past the last —
   * along, never away from it, since being at the edge is what a marker is for.
   */
  for (const side of ["l", "r", "t", "b"] as const) {
    const strip = markers.filter((m) => m.side === side);
    const vertical = side === "l" || side === "r";
    strip.sort((a, b) => (vertical ? a.y - b.y : a.x - b.x));
    let free = vertical ? rect.t : rect.l;
    for (const marker of strip) {
      const size = vertical ? MARKER_H : markerWidth(marker);
      if (vertical) marker.y = Math.min(rect.b - size / 2, Math.max(marker.y, free + size / 2));
      else marker.x = Math.min(rect.r - size / 2, Math.max(marker.x, free + size / 2));
      free = (vertical ? marker.y : marker.x) + size / 2 + 4;
    }
  }

  // --- where each condition can be written -----------------------------------
  /** What is already written on the pane, so that nothing is written over it. */
  const taken: Rect[] = markers.map((marker) => ({
    x: marker.x,
    y: marker.y,
    w: markerWidth(marker),
    h: MARKER_H,
  }));
  /** Every label, with the ones that need no help placed first so they hold their ground. */
  const written = layout.edges
    .filter((placed) => placed.label !== null)
    .map((placed) => {
      const label = placed.label!;
      const box = { w: label.w * cam.k, h: label.h * cam.k };
      const home = at(label);
      const fits =
        home.x - box.w / 2 >= rect.l &&
        home.x + box.w / 2 <= rect.r &&
        home.y - box.h / 2 >= rect.t &&
        home.y + box.h / 2 <= rect.b;
      return { placed, label, box, home, fits };
    })
    .sort((a, b) => Number(b.fits) - Number(a.fits));

  for (const { placed, label, box, home, fits } of written) {
    if (fits) {
      taken.push({ ...home, ...box });
      labels.set(placed.edge.id, { x: label.x, y: label.y });
      continue;
    }
    const pts = walk(placed.curve);
    // Nearest to where it belongs — the apex — among the places it can still be read. Whole first;
    // then merely on screen, because a condition half over the edge is worth more than none.
    const nearest = (ok: (p: { x: number; y: number }) => boolean): number => {
      let best = -1;
      let score = Infinity;
      pts.forEach((p, i) => {
        const off = Math.abs(i / WALK - 0.5);
        if (ok(p) && off < score) {
          score = off;
          best = i;
        }
      });
      return best;
    };
    const room2 = (p: { x: number; y: number }): boolean =>
      p.x - box.w / 2 >= rect.l && p.x + box.w / 2 <= rect.r && p.y - box.h / 2 >= rect.t && p.y + box.h / 2 <= rect.b;
    const best = nearest(room2) >= 0 ? nearest(room2) : nearest(seen);
    if (best < 0) {
      labels.set(placed.edge.id, null);
      continue;
    }
    /**
     * Off whatever is already there, upwards.
     *
     * Up because what it is most likely to have landed on is the pill naming what is off the end of
     * its own arc, and the condition belongs above that; down only when up would take it off the
     * top, which is the one direction there is no room to give.
     */
    const spot = { x: pts[best]!.x, y: pts[best]!.y, w: box.w, h: box.h };
    for (let tries = 0; tries < 12; tries++) {
      const hit = taken.find((other) => overlaps(spot, other));
      if (hit === undefined) break;
      const up = hit.y - hit.h / 2 - box.h / 2 - 4;
      const down = hit.y + hit.h / 2 + box.h / 2 + 4;
      spot.y = up - box.h / 2 >= rect.t ? up : down;
    }
    taken.push({ ...spot });
    labels.set(placed.edge.id, { x: (spot.x - cam.x) / cam.k, y: (spot.y - cam.y) / cam.k });
  }

  return { markers, labels };
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
  onEnter,
  onLeave,
}: {
  port: GraphPort;
  mark: string;
  onEnter: () => void;
  onLeave: () => void;
}): JSX.Element {
  const ink = port.hue === null ? undefined : inkOf(port.hue);
  const dot: CSSProperties = port.inferred
    ? {}
    : { borderColor: ink, background: port.wired ? ink : "var(--panel)" };
  const title = [
    `${port.name} — ${port.side === "in" ? "taken" : "handed back"}`,
    port.note.length > 0 ? port.note : "",
    port.inferred ? "nothing declares this slot; a binding names it" : port.wired ? "" : "nothing is wired here",
  ]
    .filter((line) => line.length > 0)
    .join("\n");
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

/** What a box offers, in the order the two gestures cost: look at it, then go to it. */
function hint(node: GraphNode, shows: boolean, opens: boolean): string | undefined {
  const lines = [
    shows ? "click to put its configuration in the side panel" : "",
    opens ? `double-click to open ${node.stateId}` : "",
  ].filter((line) => line.length > 0);
  return lines.length === 0 ? undefined : lines.join("\n");
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
}: {
  box: PlacedNode;
  mark: string;
  onFocus: (focus: Focus | null) => void;
  onOpen: (() => void) | null;
  /** Put this box's own configuration in the side panel. Absent ⇒ there is no panel to put it in. */
  onShow: (() => void) | null;
  portMark: (port: GraphPort) => string;
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
  const fit = useMemo<Camera>(() => {
    if (room.w === 0 || room.h === 0) return { x: 0, y: 0, k: 1 };
    const whole = clamp(Math.min(1, (room.w - 16) / layout.width, (room.h - 16) / layout.height));
    if (whole >= READABLE) {
      return { x: (room.w - layout.width * whole) / 2, y: (room.h - layout.height * whole) / 2, k: whole };
    }
    // Vertically it still centres what it can: the spine sits near the top of the drawing, and it is
    // the row the eye starts on whether or not the loops below it are on screen.
    const k = READABLE;
    return { x: 16, y: Math.min(16, (room.h - layout.height * k) / 2), k };
  }, [room, layout]);
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
    const from = held.current;
    const k = clamp(from.k * ratio);
    const scale = k / from.k;
    move({ k, x: px - (px - from.x) * scale, y: py - (py - from.y) * scale });
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

  /** Why a rule is eligible, and where it sits in its list — said in words rather than numbered. */
  const edgeTitle = (edge: GraphEdge): string => {
    const where =
      edge.kind === "mount"
        ? "declared on this child — considered in the round its completion triggers"
        : "declared in the state's own list — considered after every round, whatever finished";
    const order = edge.count > 1 ? `\nweighed ${nth(edge.order + 1)} of ${edge.count}; the first match wins` : "";
    return `${edge.when ?? "unconditional"}\n\n${where}${order}`;
  };

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

  const wireStyle = (wire: GraphWire): CSSProperties => ({ stroke: inkOf(wire.hue) });
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
      ? inkOf(line.wire.hue)
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
  const lines = [
    ...layout.wires.map((w) => ({ id: idOf.wire(w.wire.id), placed: w as PlacedEdge | PlacedWire })),
    ...layout.edges.map((e) => ({ id: idOf.edge(e.edge.id), placed: e as PlacedEdge | PlacedWire })),
  ].sort((a, b) => depth(attention, a.id) - depth(attention, b.id));
  /** What hovering a line means. The line itself is the question, the same as its label is. */
  const askAbout = (placed: PlacedEdge | PlacedWire): Focus =>
    "wire" in placed ? { kind: "wire", id: placed.wire.id } : { kind: "edge", id: placed.edge.id };

  return (
    <div className="sg">
      {/* The vocabulary, in the order it is read: what a line IS, then which way it goes. Only the
          kinds this drawing contains — a legend that names a line the state does not have teaches
          the wrong thing about the state. */}
      <div className="sg-bar edit-bar">
        <span
          className="sg-key"
          title="a value moving from where it is produced to where it is read — one colour per value"
        >
          <i className="sg-swatch sg-swatch-data" />
          values
        </span>
        <span className="sg-key" title="the cursor's own path: the sequence, in order">
          <i className="sg-swatch sg-swatch-spine" />
          the sequence
        </span>
        {(["onward", "back", "abort"] as const)
          .filter((flow) => flows.has(flow))
          .map((flow) => (
            <span key={flow} className="sg-key" title={FLOW_TITLE[flow]}>
              <i className={`sg-swatch sg-swatch-${flow}`} />
              {FLOW_WORD[flow]}
            </span>
          ))}
        {has("state") ? (
          <span className="sg-key" title="a dashed arrow leaves the `any` box: a rule that belongs to no child">
            <i className="sg-swatch sg-swatch-any" />
            from any
          </span>
        ) : null}
        {graph.limits.map((limit) => (
          <span key={limit} className="chip">
            {limit}
          </span>
        ))}
        <span className="spacer" />
        {/* The two gestures that have no other way of being discovered. What a BOX offers is on the
            box's own tooltip, where it is asked for rather than announced. */}
        <span className="sub">drag to pan · scroll to zoom</span>
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
                    style={wireStyle(placed.wire)}
                  />
                ) : (
                  <path
                    d={placed.d}
                    className={lineClass(placed) + tier(attention, id)}
                    markerEnd={`url(#sg-arrow-${placed.edge.kind === "sequence" ? "spine" : placed.flow})`}
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
              title={`off the screen ${marker.into ? "at the end of" : "at the start of"} the lines that cross here`}
            >
              {/* The arrow points the way the lines run: `goals →` is what they come FROM, and
                  `→ exit` is where they go. Once, for the whole list — the direction is the same for
                  everything in one pill, which is why they were allowed to merge. */}
              {marker.into ? <span className="sg-edge-arrow">→</span> : null}
              {marker.names.map((name) => (
                <span
                  key={name.node}
                  className="sg-edge-name data-text"
                  style={{ color: name.ink }}
                  onMouseEnter={() => setFocus({ kind: "node", id: name.node })}
                  onMouseLeave={() => setFocus(null)}
                >
                  {name.label}
                </span>
              ))}
              {marker.into ? null : <span className="sg-edge-arrow">→</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** The three things that can happen to a run, in the words the legend uses. */
const FLOW_WORD: Record<EdgeFlow, string> = { onward: "onward", back: "back", abort: "abort" };
const FLOW_TITLE: Record<EdgeFlow, string> = {
  onward: "nearer the end: on to a later step, or out",
  back: "over ground already covered: a loop, or a step re-entered",
  abort: "an ending that is not success — terminate.error, .canceled, .timeout",
};

/** "1st", "2nd", "3rd" — for saying a rule's position without stamping a number on the drawing. */
function nth(n: number): string {
  const tail = n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${tail}`;
}
