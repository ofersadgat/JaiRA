/**
 * What the graph tab (`StateGraphView`, `packages/universal/src/components/workflow/StateGraph.tsx`)
 * computes beyond the drawing's own model (`stateGraph.ts`): the camera's limits and fit, the attention
 * tiers, and the sightlines — the pills at the pane's edge naming what is off it, and where a condition
 * can still be written.
 */
import {
  samples,
  idOf,
  type Curve,
  type EdgeFlow,
  type Focus,
  type GraphEdge,
  type GraphLayout,
  type GraphNode,
  type GraphPort,
  type PlacedEdge,
  type PlacedWire,
} from "./stateGraph";

/** How far in the map may go. Past 2× the type is enormous; below 0.2 nothing is readable anyway. */
export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 2;
/** One press of − or +, as a ratio. A quarter step: two presses is a noticeable move, not a jump. */
export const ZOOM_STEP = 1.25;
/** The smallest scale at which type is still type. Below this, fitting stops being showing. */
export const READABLE = 0.55;
/** How far a press may travel and still be a click rather than a pan. */
export const SLOP = 3;
/** One arrowhead per direction a move can take, plus the sequence's own. */
export const HEADS = ["spine", "onward", "back", "abort"] as const;

/** Where the map is: the canvas origin in viewport px, and the scale it is drawn at. */
export interface Camera {
  x: number;
  y: number;
  k: number;
}

export const clamp = (k: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));

/** The boxes whose heading is OUR word, in the app's voice; the rest are the author's, in the data voice. */
export const WORDS_OF_OURS = new Set<GraphNode["kind"]>(["entry", "exit", "any"]);

/** What the reader is pointing at, as the two tiers of emphasis it implies. */
export type Attention = { lit: Set<string>; near: Set<string>; on: boolean };

/** How far one thing is raised or faded. Nothing is dimmed while nothing is focused. */
export type Tier = "" | "lit" | "near" | "dim";
export function tierOf(attention: Attention, id: string): Tier {
  if (!attention.on) return "";
  if (attention.lit.has(id)) return "lit";
  if (attention.near.has(id)) return "near";
  return "dim";
}

/** Painted last means painted on top: SVG has no other z-index — see {@link paintOrder}. */
export function depth(attention: Attention, id: string): number {
  if (!attention.on) return 1;
  if (attention.lit.has(id)) return 3;
  if (attention.near.has(id)) return 2;
  return 0;
}

/** How far in from the pane's edge a marker, or a condition kept beside one, may sit. */
export const EDGE_INSET = 10;
/** A marker's height, so a condition kept beside one can sit clear above it. */
export const MARKER_H = 22;
/** How finely a line is walked when asking where it leaves the view. */
export const WALK = 32;

/** Which edge of the pane a line leaves by. */
export type Side = "l" | "r" | "t" | "b";

/**
 * One pill at the pane's edge, naming everything that is off it just there.
 *
 * A LIST rather than one name, because several lines leaving at the same place is the normal case —
 * a box near the edge sends four wires the same way — and four pills stacked on one crossing is four
 * times the ink for one fact. They are merged when they would sit on top of each other, and what is
 * left is pushed apart along the edge, so a pill never covers a pill.
 */
export interface Marker {
  key: string;
  side: Side;
  /** True when the far ends are where the lines GO; false when they are where the lines come FROM. */
  into: boolean;
  x: number;
  y: number;
  /** `port` is the slot at that end — set for a value's line, absent for the cursor's own moves. */
  names: { node: string; port: string | null; label: string; ink: string | undefined }[];
}

export interface Sight {
  markers: Marker[];
  /** Where each guard may be written, in canvas units — `null` when its arc is off screen entirely. */
  labels: Map<string, { x: number; y: number } | null>;
}

/** A box in viewport space, for keeping two things that must both be readable off each other. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const overlaps = (a: Rect, b: Rect): boolean =>
  Math.abs(a.x - b.x) < (a.w + b.w) / 2 && Math.abs(a.y - b.y) < (a.h + b.h) / 2;

/**
 * How many names one pill spells out before it counts the rest instead.
 *
 * A slot-precise name is two words where a box's was one, so a crossing that used to list four boxes
 * now lists eight slots — and eight names in one pill is a pill wider than the pane, which the
 * ellipsis then cuts back to eight prefixes that name nothing. Four is what fits and is read; the
 * remainder is a count, and the whole list is on the pill's tooltip where a list belongs.
 */
export const MARKER_NAMES = 4;

/** The names a pill actually spells out, and how many it is standing in for. */
export const shownNames = (marker: Marker): { names: Marker["names"]; rest: number } => ({
  names: marker.names.slice(0, MARKER_NAMES),
  rest: Math.max(0, marker.names.length - MARKER_NAMES),
});

/** About as wide as a pill gets: the mono face's advance, plus its padding and separators. */
export const markerWidth = (marker: Marker): number => {
  const { names, rest } = shownNames(marker);
  return 26 + names.reduce((wide, name) => wide + name.label.length * 6.6 + 10, 0) + (rest > 0 ? 32 : 0);
};

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
export function sightlines(
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
  const walk = (curves: Curve[]): { x: number; y: number }[] => samples(curves, WALK).map(at);

  // --- where each line leaves, and what is out there -------------------------
  /** One line's exit: the side it crossed, where along that side, and what is beyond it. */
  type Exit = {
    side: Side;
    along: number;
    into: boolean;
    node: string;
    port: string | null;
    label: string;
    ink: string | undefined;
  };
  /** Which end of a line, as the two things it takes to name one: a box, and the slot on it. */
  type End = { node: string; port: string | null };
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
  /**
   * What is out there, named as far as it can be named.
   *
   * A box for the cursor's own move — "where does this arrow go" is a question about a step. For a
   * VALUE it is the box AND the slot, because a wire is one member of a box rather than the box:
   * four wires off the same edge into `review` are four different values, and four pills all reading
   * "review" name the same place four times and answer nothing. `review.findings` is the answer.
   */
  const exit = (
    end: End | null,
    inside: { x: number; y: number },
    outside: { x: number; y: number },
    into: boolean,
    hue: string | undefined,
  ): void => {
    const title = end === null ? undefined : titles.get(end.node);
    if (end === null || title === undefined) return;
    const slot = end.port === null ? "" : `.${end.port.slice(end.port.indexOf(":") + 1)}`;
    const side = sideOf(outside);
    const along = side === "l" || side === "r" ? inside.y : inside.x;
    exits.push({ side, along, into, node: end.node, port: end.port, label: `${title}${slot}`, ink: hue });
  };

  const crossing = (line: PlacedEdge | PlacedWire, id: string, from: End | null, to: End | null): void => {
    if (!shows(id)) return;
    const pts = walk(line.curves);
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
    const to = line.wire.to.node.startsWith("rule:") ? null : { node: line.wire.to.node, port: line.wire.to.port };
    crossing(line, idOf.wire(line.wire.id), { node: line.wire.from.node, port: line.wire.from.port }, to);
  }
  for (const line of layout.edges) {
    crossing(line, idOf.edge(line.edge.id), { node: line.edge.from, port: null }, { node: line.edge.to, port: null });
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
        // Said once per SLOT rather than once per box: two values leaving the same box the same way
        // are two facts, and the pill that named the box twice named neither of them.
        if (!last.names.some((n) => n.node === one.node && n.port === one.port)) last.names.push(one);
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
    const pts = walk(placed.curves);
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

/** What a box offers, in the order the two gestures cost: look at it, then go to it. */
export function hint(node: GraphNode, shows: boolean, opens: boolean): string | undefined {
  const lines = [
    shows ? "click to put its configuration in the side panel" : "",
    opens ? `double-click to open ${node.stateId}` : "",
  ].filter((line) => line.length > 0);
  return lines.length === 0 ? undefined : lines.join("\n");
}

/** A port's tooltip: the slot, which way it goes, and whatever the wire cannot say. */
export function portTitle(port: GraphPort): string {
  return [
    `${port.name} — ${port.side === "in" ? "taken" : "handed back"}`,
    port.note.length > 0 ? port.note : "",
    port.inferred ? "nothing declares this slot; a binding names it" : port.wired ? "" : "nothing is wired here",
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

/** A box's session line's tooltip. */
export function nodeSessionTitle(session: NonNullable<GraphNode["session"]>): string {
  return (
    `runs in the conversation "${session.name}", scoped ${session.scope}\n\n` +
    `declared ${
      session.from === "child"
        ? "by the state this mounts"
        : session.from === "mount"
          ? "on this mount"
          : "by this state, and inherited"
    }`
  );
}

/** A session frame's tooltip. */
export function frameTitle(session: { name: string; scope: string; members: readonly unknown[] }): string {
  return (
    `${session.name} — one conversation, shared by ${session.members.length} of these\n\n` +
    `scoped ${session.scope}: two states are in one conversation only when the name AND ` +
    `the scope match, so the same name written somewhere else is somewhere else`
  );
}

/** An edge-mark pill's tooltip. */
export function markerTitle(marker: Marker): string {
  return (
    `off the screen ${marker.into ? "at the end of" : "at the start of"} the lines that cross here\n\n` +
    marker.names.map((name) => name.label).join("\n")
  );
}

/** Why a rule is eligible, and where it sits in its list — said in words rather than numbered. */
export function edgeTitle(edge: GraphEdge): string {
  const where =
    edge.kind === "mount"
      ? "declared on this child — considered in the round its completion triggers"
      : "declared in the state's own list — considered after every round, whatever finished";
  const order = edge.count > 1 ? `\nweighed ${nth(edge.order + 1)} of ${edge.count}; the first match wins` : "";
  return `${edge.when ?? "unconditional"}\n\n${where}${order}`;
}

/** The three things that can happen to a run, in the words the legend uses. */
export const FLOW_WORD: Record<EdgeFlow, string> = { onward: "onward", back: "back", abort: "abort" };
export const FLOW_TITLE: Record<EdgeFlow, string> = {
  onward: "nearer the end: on to a later step, or out",
  back: "over ground already covered: a loop, or a step re-entered",
  abort: "an ending that is not success — terminate.error, .canceled, .timeout",
};

/** "1st", "2nd", "3rd" — for saying a rule's position without stamping a number on the drawing. */
export function nth(n: number): string {
  const tail = n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${tail}`;
}

/**
 * The whole drawing, centred, at the largest scale that shows it — within reason at both ends.
 *
 * Blowing a small graph up to fill the pane does not make it easier to read, it just makes it big,
 * so a state that fits sits at 100% with air around it. The floor matters more: a nine-child state
 * fits a pane only at a third of life size, where the type is a grey smudge and the picture has
 * been "shown" to nobody. Below {@link READABLE} the fit gives up and parks at the BEGINNING
 * instead — the entry, where the run starts and where a reader would have panned to anyway.
 */
export function fitOf(room: { w: number; h: number }, layout: Pick<GraphLayout, "width" | "height">): Camera {
  if (room.w === 0 || room.h === 0) return { x: 0, y: 0, k: 1 };
  const whole = clamp(Math.min(1, (room.w - 16) / layout.width, (room.h - 16) / layout.height));
  if (whole >= READABLE) {
    return { x: (room.w - layout.width * whole) / 2, y: (room.h - layout.height * whole) / 2, k: whole };
  }
  // Vertically it parks at the TOP of what it can show rather than at the middle of what it
  // cannot: the spine is the row the eye starts on, and a drawing taller than the pane centred on
  // its own middle puts the spine off the top of it — the loops below are the part a reader pans
  // to, not the part they are shown first. Only a drawing SHORTER than the pane is centred, and
  // then no further down than the inset the horizontal one uses.
  const k = READABLE;
  const spare = (room.h - layout.height * k) / 2;
  return { x: 16, y: spare > 0 ? Math.min(16, spare) : 16, k };
}

/** Zoom about a point in the viewport, keeping whatever is under it where it is. */
export function zoomedAt(from: Camera, px: number, py: number, ratio: number): Camera {
  const k = clamp(from.k * ratio);
  const scale = k / from.k;
  return { k, x: px - (px - from.x) * scale, y: py - (py - from.y) * scale };
}

/**
 * What hovering a line means. The line itself is the question, the same as its label is.
 *
 * With one turn: most of a BUNDLED wire is the run it shares with the rest of its bundle, and that
 * run cannot answer for one of them — pointing at it would light one read of a value at random and
 * leave its siblings grey. So a bundled line asks about the port they all leave, whose answer is
 * the whole bundle. The far ends stay separable: each has a stretch of its own past the branch.
 */
export function askAbout(placed: PlacedEdge | PlacedWire): Focus {
  if (!("wire" in placed)) return { kind: "edge", id: placed.edge.id };
  if (placed.bundle === null) return { kind: "wire", id: placed.wire.id };
  return { kind: "port", node: placed.wire.from.node, port: placed.wire.from.port };
}

/** Every line, dim ones first: the last one painted is the one on top — SVG has no other z-index. */
export function paintOrder(layout: GraphLayout, attention: Attention): { id: string; placed: PlacedEdge | PlacedWire }[] {
  return [
    ...layout.wires.map((w) => ({ id: idOf.wire(w.wire.id), placed: w as PlacedEdge | PlacedWire })),
    ...layout.edges.map((e) => ({ id: idOf.edge(e.edge.id), placed: e as PlacedEdge | PlacedWire })),
  ].sort((a, b) => depth(attention, a.id) - depth(attention, b.id));
}

/** The arrowhead a step's line ends in: the sequence's own, or its flow's. */
export const headOf = (placed: PlacedEdge): (typeof HEADS)[number] => (placed.edge.kind === "sequence" ? "spine" : placed.flow);

/** One entry of the legend, in the order it is read: what a line IS, then which way it goes. */
export interface LegendKey {
  swatch: "data" | "spine" | EdgeFlow | "any" | "session";
  word: string;
  title: string;
}

/**
 * The vocabulary this drawing contains — a legend that names a line the state does not have teaches
 * the wrong thing about the state.
 */
export function legendOf(flows: ReadonlySet<EdgeFlow>, hasAny: boolean, hasSessions: boolean): LegendKey[] {
  return [
    {
      swatch: "data",
      word: "values",
      title:
        "a value moving from where it is produced to where it is read\n\n" +
        "grey until you point at something: the lines that answer take the colour of the value " +
        "they carry, one colour per value, wherever it goes",
    },
    { swatch: "spine", word: "the sequence", title: "the cursor's own path: the sequence, in order" },
    ...(["onward", "back", "abort"] as const).filter((flow) => flows.has(flow)).map((flow) => ({ swatch: flow, word: FLOW_WORD[flow], title: FLOW_TITLE[flow] })),
    ...(hasAny ? [{ swatch: "any" as const, word: "from any", title: "a dashed arrow leaves the `any` box: a rule that belongs to no child" }] : []),
    ...(hasSessions
      ? [
          {
            swatch: "session" as const,
            word: "one conversation",
            title:
              "a dotted frame is one conversation, and the boxes inside it share a transcript\n\n" +
              "the run leaves it and comes back, which is why the drawing is not a straight line",
          },
        ]
      : []),
  ];
}

/** The words the map's pan and zoom are discovered by. */
export const GESTURES = "drag to pan · scroll to zoom";
