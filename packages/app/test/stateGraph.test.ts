/**
 * What the graph tab CLAIMS about a state, checked against the format's rules.
 *
 * The drawing is a reading of the document, and a reading can be wrong in ways a picture makes look
 * authoritative: a child shown as a step when the sequence leaves it out, a value shown as arriving
 * from a child that never produced it, a `terminate.error` quietly dropped because it is not a child
 * key. Each of those is a sentence about how the state runs, so each is asserted here rather than
 * left to be noticed on screen.
 *
 * The layout half is checked for the properties the lines depend on — boxes in run order, ports on
 * the edges their wires end at, every coordinate positive — and not for the pixels themselves, which
 * are arithmetic nobody should have to re-derive to move a box eight px.
 */
import { describe, expect, it } from "vitest";
import type { StateSlots } from "@jaira/shared/browser";
import {
  ANY,
  childNodeId,
  ENTRY,
  EXIT,
  focusOf,
  graphOf,
  guardLines,
  guardTerms,
  idOf,
  layoutOf,
  OPERATION,
  pointOn,
  ruleNodeId,
  type GraphEdge,
  type GraphNode,
  type StateGraph,
} from "../src/renderer/stateGraph";

/** A composite using every part of the format the graph reads. */
const PLAN = {
  label: "Planning",
  inputs: { issue: { schema: { type: "string" } }, depth: { schema: { type: "integer" }, default: 2 } },
  outputs: { plan_doc: { binding: ".children.context.outputs.plan_doc" } },
  children: {
    goals: { inputs: { issue: ".inputs.issue" } },
    context: { inputs: { goals: ".children.goals.outputs.goals" }, async: true },
    critique: {
      inputs: { plan_doc: ".children.context.outputs.plan_doc", tone: { text: "strict" } },
      transitions: [
        { to: "terminate.success", when: ".children.critique.outputs.outcome === 'clean'" },
        { to: "goals" },
      ],
    },
    escalate: { state: "$/lib/escalate" },
  },
  sequence: ["goals", "context", "critique"],
  transitions: [{ to: "terminate.error", when: ".run.iteration >= .limits.max_iterations" }],
  limits: { max_iterations: 3, timeout: 600 },
};

const ids = (graph: StateGraph): string[] => graph.nodes.map((n) => n.id);
const node = (graph: StateGraph, id: string): GraphNode | undefined => graph.nodes.find((n) => n.id === id);
const ports = (graph: StateGraph, id: string, side: "in" | "out"): string[] =>
  (node(graph, id)?.ports ?? []).filter((p) => p.side === side).map((p) => p.name);
const wire = (graph: StateGraph, to: string, port: string): string =>
  graph.wires
    .filter((w) => w.to.node === to && w.to.port === `in:${port}`)
    .map((w) => `${w.from.node}.${w.from.port}`)
    .join(" + ");

describe("graphOf", () => {
  it("puts the state's slots on the two ends, facing the way they travel", () => {
    const graph = graphOf(PLAN, "plan");
    // The entry HANDS OUT the inputs, so they are its outputs — which is what the wires leave from.
    expect(ports(graph, ENTRY, "out")).toEqual(["issue", "depth"]);
    expect(ports(graph, ENTRY, "in")).toEqual([]);
    expect(node(graph, ENTRY)?.ports[1]?.note).toBe("= 2");
    expect(ports(graph, EXIT, "in")).toEqual(["plan_doc"]);
  });

  it("shows a child's whole surface, not only what this file wired", () => {
    const declared: Record<string, StateSlots> = {
      "plan/goals": {
        inputs: [
          { name: "issue", optional: false },
          { name: "hint", optional: true },
        ],
        outputs: [{ name: "goals", optional: false }],
      },
    };
    const graph = graphOf(PLAN, "plan", declared);
    // `hint` is declared and nothing is wired into it. That is the port worth seeing.
    expect(ports(graph, childNodeId("goals"), "in")).toEqual(["issue", "hint"]);
    expect(ports(graph, childNodeId("goals"), "out")).toEqual(["goals"]);
    expect(node(graph, childNodeId("goals"))?.ports[1]?.note).toBe("optional");
  });

  /**
   * With nothing known about the children, every port the DOCUMENT proves exists is still drawn —
   * both ends of every binding — and NONE of them is marked suspect. "Nothing declares this slot" is
   * a claim about a declaration that was read; over one that was never loaded it would paint a
   * correct graph as an error in every box.
   */
  it("takes the ports a binding names when the child is unknown, without doubting them", () => {
    const graph = graphOf(PLAN, "plan");
    expect(ports(graph, childNodeId("goals"), "out")).toEqual(["goals"]);
    expect(node(graph, childNodeId("goals"))?.ports.some((p) => p.inferred)).toBe(false);
    expect(wire(graph, childNodeId("context"), "goals")).toBe(`${childNodeId("goals")}.out:goals`);
  });

  /** Once the declaration IS known, a binding naming a slot it does not have is worth marking. */
  it("marks a slot that only a binding claims exists", () => {
    const graph = graphOf(
      { inputs: { issue: {} }, children: { a: { inputs: { issue: ".inputs.ghost" } } } },
      "plan",
      { "plan/a": { inputs: [{ name: "issue", optional: false }], outputs: [] } },
    );
    expect(node(graph, ENTRY)?.ports.find((p) => p.name === "ghost")?.inferred).toBe(true);
    expect(node(graph, ENTRY)?.ports.find((p) => p.name === "issue")?.inferred).toBe(false);
    expect(node(graph, childNodeId("a"))?.ports.every((p) => !p.inferred)).toBe(true);
  });

  it("wires a value from where it is produced to where it is read", () => {
    const graph = graphOf(PLAN, "plan");
    expect(wire(graph, childNodeId("goals"), "issue")).toBe(`${ENTRY}.out:issue`);
    expect(wire(graph, EXIT, "plan_doc")).toBe(`${childNodeId("context")}.out:plan_doc`);
  });

  /**
   * A line ARRIVES somewhere, and the port it arrives at has to say so — in the same colour, since
   * it is the same value. Marked at one end only, a fed slot reads as one nobody wired.
   */
  it("marks both ends of a wire as carrying the value, in one colour", () => {
    const graph = graphOf(PLAN, "plan");
    const from = node(graph, ENTRY)?.ports.find((p) => p.name === "issue");
    const to = node(graph, childNodeId("goals"))?.ports.find((p) => p.name === "issue");
    expect([from?.wired, to?.wired]).toEqual([true, true]);
    expect(to?.hue).toBe(from?.hue);
    // A slot nothing reads stays empty, which is the fact the hollow dot carries. `depth` is
    // declared and wired nowhere in this state, so nothing about it is coloured.
    expect(node(graph, ENTRY)?.ports.find((p) => p.name === "depth")).toMatchObject({
      wired: false,
      hue: null,
    });
  });

  /** A literal is not a read. It gets no line — the port carries the value instead. */
  it("writes a literal on the port rather than drawing a line from nowhere", () => {
    const graph = graphOf(PLAN, "plan");
    expect(wire(graph, childNodeId("critique"), "tone")).toBe("");
    const port = node(graph, childNodeId("critique"))?.ports.find((p) => p.name === "tone");
    expect(port?.note).toBe("strict");
  });

  /** An expression reads several paths, and each one is a line: that is what makes it a join. */
  it("draws one wire per path an expression reads", () => {
    const graph = graphOf({
      children: { a: {}, b: { inputs: { both: { expr: ".children.a.outputs.x + .inputs.y" } } } },
      inputs: { y: {} },
    });
    expect(wire(graph, childNodeId("b"), "both")).toBe(`${childNodeId("a")}.out:x + ${ENTRY}.out:y`);
    expect(graph.wires.every((w) => w.kind === "expr")).toBe(true);
    // One value, one colour — and two DIFFERENT values are two colours, which is the whole reason a
    // bundle of parallel wires can be followed at all.
    expect(new Set(graph.wires.map((w) => w.hue)).size).toBe(2);
  });

  it("runs the sequence between the two ends, and leaves a jump target off it", () => {
    const graph = graphOf(PLAN, "plan");
    const spine = graph.edges.filter((e) => e.kind === "sequence").map((e) => `${e.from}→${e.to}`);
    expect(spine).toEqual([
      `${ENTRY}→${childNodeId("goals")}`,
      `${childNodeId("goals")}→${childNodeId("context")}`,
      `${childNodeId("context")}→${childNodeId("critique")}`,
      `${childNodeId("critique")}→${EXIT}`,
    ]);
    expect(node(graph, childNodeId("escalate"))?.offSpine).toBe(true);
  });

  it("marks the step off an async child as one the cursor does not wait for", () => {
    const graph = graphOf(PLAN, "plan");
    const step = (from: string): GraphEdge | undefined =>
      graph.edges.find((e) => e.kind === "sequence" && e.from === from);
    expect(step(childNodeId("context"))?.nowait).toBe(true);
    expect(step(childNodeId("goals"))?.nowait).toBe(false);
  });

  it("draws a mount's transitions from that child, in the order they are evaluated", () => {
    const graph = graphOf(PLAN, "plan");
    const out = graph.edges.filter((e) => e.kind === "mount" && e.from === childNodeId("critique"));
    expect(out.map((e) => [e.to, e.when, e.order, e.count])).toEqual([
      [EXIT, ".children.critique.outputs.outcome === 'clean'", 0, 2],
      [childNodeId("goals"), null, 1, 2],
    ]);
  });

  /**
   * A rule in the state's own list is evaluated after EVERY round and belongs to no child. It leaves
   * the `any` box — never a child its guard happens to read, which would claim an eligibility rule
   * the engine does not have.
   */
  it("leaves every state-level transition from the any box", () => {
    const graph = graphOf(PLAN, "plan");
    const rule = graph.edges.find((e) => e.kind === "state");
    expect([rule?.from, rule?.to]).toEqual([ANY, "terminate.error"]);
    expect(node(graph, ANY)?.subtitle).toBe("after any round");

    // No state-level list ⇒ no box. It is a source, and a source with nothing to say is furniture.
    expect(ids(graphOf({ children: { a: {} } }))).not.toContain(ANY);
  });

  it("gives an abnormal ending a box of its own, and success the exit", () => {
    const graph = graphOf(PLAN, "plan");
    // `terminate.success` IS the exit: the outputs are what a successful state hands back.
    expect(ids(graph)).not.toContain("terminate.success");
    expect(graph.edges.some((e) => e.to === "terminate.error")).toBe(true);
    expect(node(graph, "terminate.error")?.kind).toBe("outcome");
  });

  /** The linter says it in words. The graph says it by drawing the dead end it leads to. */
  it("draws a transition whose target does not exist", () => {
    const graph = graphOf({ children: { a: { transitions: [{ to: "typo" }] } } });
    const edge = graph.edges.find((e) => e.kind === "mount");
    expect(edge?.dangling).toBe(true);
    expect(node(graph, edge?.to ?? "")?.kind).toBe("missing");
  });

  it("puts the state's own operation between the entry and the first child", () => {
    const graph = graphOf({
      operation: {
        kind: "prompt",
        model: "planner",
        prompt: { $ref: "$/prompts/plan.md" },
        input: { brief: { binding: ".inputs.issue" } },
        outputs: { plan: {} },
      },
      inputs: { issue: {} },
      children: { a: {} },
    });
    const spine = graph.edges.filter((e) => e.kind === "sequence").map((e) => `${e.from}→${e.to}`);
    expect(spine).toEqual([`${ENTRY}→${OPERATION}`, `${OPERATION}→${childNodeId("a")}`, `${childNodeId("a")}→${EXIT}`]);
    // Its parameters and its results are PORTS; what is left over is settings.
    expect(ports(graph, OPERATION, "in")).toEqual(["brief"]);
    expect(ports(graph, OPERATION, "out")).toEqual(["plan"]);
    expect(node(graph, OPERATION)?.rows).toEqual([{ label: "prompt", value: "$/prompts/plan.md" }]);
    expect(wire(graph, OPERATION, "brief")).toBe(`${ENTRY}.out:issue`);
  });

  /** §4.3, the format's documented silent failure: a parameter with no `binding:` resolves to empty. */
  it("marks an operation parameter that was written without a binding", () => {
    const graph = graphOf({ operation: { kind: "prompt", input: { prompt: ".inputs.instruction" } } });
    expect(node(graph, OPERATION)?.ports[0]).toMatchObject({ name: "prompt", note: "no binding:" });
  });

  /** An output that says nothing about where its value comes from — which JaiRA reports (§3.3). */
  it("says an output is unbound rather than leaving it blank", () => {
    const graph = graphOf({ operation: { kind: "prompt" }, outputs: { plan: { schema: { type: "string" } } } });
    expect(node(graph, EXIT)?.ports[0]).toMatchObject({ name: "plan", note: "unbound" });
    // Nothing to draw: this operation declares no result by that name, so there is no port to leave.
    expect(graph.wires).toEqual([]);
  });

  /** The implicit fill IS a value moving, and it is the only wire no line of the document spells. */
  it("wires the operation's result into the output of its own name", () => {
    const graph = graphOf({ operation: { kind: "prompt", outputs: { plan: {} } }, outputs: { plan: {} } });
    expect(wire(graph, EXIT, "plan")).toBe(`${OPERATION}.out:plan`);
  });

  it("draws a state with nothing in it as one step from entry to exit", () => {
    const graph = graphOf({});
    expect(ids(graph)).toEqual([ENTRY, EXIT]);
    expect(graph.edges).toHaveLength(1);
    expect(graph.wires).toEqual([]);
    expect(graph.limits).toEqual([]);
  });
});

/** A guard's lines as `op` + the text of the whole clause — what the label puts on one line. */
const clauses = (when: string): { op: string; text: string }[] =>
  guardLines(when).map((line) => ({ op: line.op, text: line.terms.map((t) => t.text).join("") }));

describe("guardLines", () => {
  it("leaves a simple condition alone", () => {
    expect(clauses(".children.a.outputs.done === true")).toEqual([
      { op: "", text: ".children.a.outputs.done === true" },
    ]);
  });

  it("puts each clause of a conjunction on its own line, led by the operator", () => {
    expect(clauses(".a > 1 && .b < 2 && .c === 'x'")).toEqual([
      { op: "", text: ".a > 1" },
      { op: "&&", text: ".b < 2" },
      { op: "&&", text: ".c === 'x'" },
    ]);
  });

  /**
   * `&&` binds tighter than `||`, so the split happens at the `||`s and a clause that still holds an
   * `&&` is bracketed. Without the brackets the lines would read as three alternatives, which is a
   * different condition from the one in the file.
   */
  it("splits at the loosest operator and brackets what binds tighter", () => {
    expect(clauses(".a && .b || .c")).toEqual([
      { op: "", text: "(.a && .b)" },
      { op: "||", text: ".c" },
    ]);
  });

  it("does not bracket a clause the author already wrapped", () => {
    expect(clauses("(.a && .b) || .c")[0]).toEqual({ op: "", text: "(.a && .b)" });
  });

  it("is not fooled by an operator inside a call or a string", () => {
    expect(clauses("f(.a && .b) > 0")).toEqual([{ op: "", text: "f(.a && .b) > 0" }]);
    expect(clauses(".note === 'a && b'")).toEqual([{ op: "", text: ".note === 'a && b'" }]);
  });

  /**
   * The terms are what makes a condition followable: each runtime path inside it is marked with the
   * port it reads, so hovering it can light the value's own wire. Everything else stays text.
   */
  it("marks the runtime paths inside a clause, and only those", () => {
    const terms = guardTerms(".children.critique.outputs.target === 'explore'");
    expect(terms.map((t) => t.text)).toEqual([".children.critique.outputs.target", " === 'explore'"]);
    expect(terms[0]?.read).toEqual({ node: childNodeId("critique"), port: "out:target" });
    expect(terms[1]?.read).toBeNull();
  });

  it("reads a child's outcome as a port of its own, and leaves a guard-only path alone", () => {
    expect(guardTerms(".children.a.outcome === 'success'")[0]?.read).toEqual({
      node: childNodeId("a"),
      port: "out:outcome",
    });
    // `.run` and `.limits` are guard namespaces, not values anything produced. No port, no wire.
    expect(guardTerms(".run.iteration >= .limits.max_iterations").every((t) => t.read === null)).toBe(true);
    // A path is only a path where a term begins: the tail of a longer one names nothing of ours.
    expect(guardTerms("f(.children.a.inputs.x)").every((t) => t.read === null)).toBe(true);
  });
});

/** A guard's reads are dataflow, so they are wires — which is what makes a term followable. */
describe("guard reads", () => {
  it("wires each path a condition reads to the rule that reads it", () => {
    const graph = graphOf({
      children: {
        a: {},
        b: { transitions: [{ to: "terminate.success", when: ".children.a.outputs.ok === true" }] },
      },
    });
    const edge = graph.edges.find((e) => e.kind === "mount")!;
    const read = graph.wires.find((w) => w.kind === "guard");
    expect(read?.from).toEqual({ node: childNodeId("a"), port: "out:ok" });
    expect(read?.to).toEqual({ node: ruleNodeId(edge.id), port: "in:0" });
  });

  it("says nothing about a condition that reads no value", () => {
    const graph = graphOf({ children: { a: { transitions: [{ to: "terminate.error", when: ".run.iteration > 2" }] } } });
    expect(graph.wires.filter((w) => w.kind === "guard")).toEqual([]);
  });
});

/** What the reader is pointing at, and what that implies — the same answer for all four hovers. */
describe("focusOf", () => {
  const graph = graphOf(PLAN, "plan");

  it("lights a box with every line that touches it, and keeps the far ends legible", () => {
    const { lit, near } = focusOf(graph, { kind: "node", id: childNodeId("critique") });
    expect(lit.has(idOf.node(childNodeId("critique")))).toBe(true);
    // Its own rules, and the step that reaches it.
    expect(lit.has(idOf.edge("mount:critique:0"))).toBe(true);
    expect(lit.has(idOf.edge("seq:2"))).toBe(true);
    // The boxes those lines reach stay readable — an arrow into a faded box answers nothing.
    expect(near.has(idOf.node(EXIT))).toBe(true);
    // Nothing that has no line to it.
    expect(lit.has(idOf.node(ANY))).toBe(false);
    expect(near.has(idOf.node(ANY))).toBe(false);
  });

  /** §2's ask, exactly: the rule, its arrow, and the two boxes it joins — the rest falls away. */
  it("lights a rule with both of the boxes it joins", () => {
    const { lit } = focusOf(graph, { kind: "edge", id: "mount:critique:1" });
    expect(lit.has(idOf.edge("mount:critique:1"))).toBe(true);
    expect(lit.has(idOf.node(childNodeId("critique")))).toBe(true);
    expect(lit.has(idOf.node(childNodeId("goals")))).toBe(true);
    expect(lit.has(idOf.node(childNodeId("context")))).toBe(false);
  });

  it("lights a port with the wires through it and the ports at their far ends", () => {
    const { lit, near } = focusOf(graph, { kind: "port", node: ENTRY, port: "out:issue" });
    expect(lit.has(idOf.port(ENTRY, "out:issue"))).toBe(true);
    expect(lit.has(idOf.port(childNodeId("goals"), "in:issue"))).toBe(true);
    expect(near.has(idOf.node(childNodeId("goals")))).toBe(true);
    expect(lit.has(idOf.port(ENTRY, "out:depth"))).toBe(false);
  });

  it("dims nothing at all while nothing is focused", () => {
    const { lit, near } = focusOf(graph, null);
    expect([lit.size, near.size]).toEqual([0, 0]);
  });
});

/** The shape of a line, which the view asks where it leaves the screen — see `sightlines`. */
describe("pointOn", () => {
  const curve = { x1: 0, y1: 0, c1x: 0, c1y: 100, c2x: 100, c2y: 100, x2: 100, y2: 0 };

  it("starts at the start and ends at the end", () => {
    expect(pointOn(curve, 0)).toEqual({ x: 0, y: 0 });
    expect(pointOn(curve, 1)).toEqual({ x: 100, y: 0 });
  });

  /** The apex a guard's label is placed at: at t = ½ a cubic sits at (y1 + 3c1 + 3c2 + y2) / 8. */
  it("puts the middle where the label goes", () => {
    expect(pointOn(curve, 0.5)).toEqual({ x: 50, y: 75 });
  });

  /**
   * A step of the sequence is a cubic with its control points on its own ends. That is the straight
   * segment — every point of the walk is ON it — though not evenly spaced along it, which costs
   * nothing: the walk is asking where the line leaves the screen, not measuring it.
   */
  it("walks a straight line straight", () => {
    const line = { x1: 0, y1: 4, c1x: 0, c1y: 4, c2x: 10, c2y: 4, x2: 10, y2: 4 };
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const p = pointOn(line, t);
      expect(p.y).toBe(4);
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(10);
    }
  });
});

describe("layoutOf", () => {
  it("lays the spine out in run order, with the two ends bracketing it", () => {
    const layout = layoutOf(graphOf(PLAN, "plan"));
    const x = (id: string): number => layout.nodes.find((n) => n.node.id === id)?.x ?? -1;
    expect(x(ENTRY)).toBeLessThan(x(childNodeId("goals")));
    expect(x(childNodeId("goals"))).toBeLessThan(x(childNodeId("context")));
    expect(x(childNodeId("context"))).toBeLessThan(x(childNodeId("critique")));
    expect(x(childNodeId("critique"))).toBeLessThan(x(EXIT));
  });

  /** A jump target is not a step, so it hangs below the line rather than taking a place on it. */
  it("hangs everything the cursor cannot walk into below the spine", () => {
    const layout = layoutOf(graphOf(PLAN, "plan"));
    const box = (id: string): { y: number; h: number } => layout.nodes.find((n) => n.node.id === id)!;
    const spineBottom = box(ENTRY).y + box(ENTRY).h;
    for (const id of [childNodeId("escalate"), "terminate.error", ANY]) {
      expect(box(id).y).toBeGreaterThanOrEqual(spineBottom);
    }
  });

  /** Every wire has to END somewhere: on the port's own dot, which sits on the box's edge. */
  it("puts each port on the side of the box it belongs to, and ends the wires there", () => {
    const layout = layoutOf(graphOf(PLAN, "plan"));
    for (const box of layout.nodes) {
      for (const port of box.ports) {
        expect(port.x).toBe(port.side === "in" ? box.x : box.x + box.w);
        expect(port.y).toBeGreaterThan(box.y);
        expect(port.y).toBeLessThan(box.y + box.h);
      }
    }
    const first = layout.wires[0]!;
    const from = layout.nodes.flatMap((n) => n.ports).find((p) => p.key === first.wire.from.port);
    expect(first.d.startsWith(`M ${from!.x} `)).toBe(true);
  });

  /** Everything is drawn inside the extent the map is given — a stacked guard above the top row too. */
  it("shifts the whole drawing into positive coordinates", () => {
    const layout = layoutOf(graphOf(PLAN, "plan"));
    for (const box of layout.nodes) {
      expect(box.y).toBeGreaterThan(0);
      expect(box.y + box.h).toBeLessThanOrEqual(layout.height);
      expect(box.x + box.w).toBeLessThanOrEqual(layout.width);
    }
    for (const edge of layout.edges) {
      for (const n of edge.d.matchAll(/-?\d+(\.\d+)?/g)) expect(Number(n[0])).toBeGreaterThanOrEqual(0);
      if (edge.label !== null) expect(edge.label.y - edge.label.h / 2).toBeGreaterThan(0);
    }
  });

  /** A guard is never cut, so the room it needs is measured — and the lanes are stacked around it. */
  it("gives a long condition a taller label than a short one", () => {
    const short = layoutOf(graphOf({ children: { a: { transitions: [{ to: "terminate.success", when: ".a" }] } } }));
    const long = layoutOf(
      graphOf({
        children: {
          a: { transitions: [{ to: "terminate.success", when: ".alpha > 1 && .beta < 2 && .gamma === 'three'" }] },
        },
      }),
    );
    const label = (l: typeof short): { w: number; h: number } => l.edges.find((e) => e.label !== null)!.label!;
    expect(label(long).h).toBeGreaterThan(label(short).h);
    expect(label(long).w).toBeGreaterThan(label(short).w);
  });
});
