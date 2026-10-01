/**
 * What the session panels are drawn FROM, beside the bands.
 *
 * `sessionBands.test.ts` covers the model — which sessions band together, and where a conversation
 * was cut. This covers what the page makes of it (`sessionRows.ts`): the rows of the page in order —
 * panels, and the notes on the grey between them — and where each sits on the rail; how a session is
 * timed; which panels are sides of a fork, and what each side is called; what a fold is remembered
 * under; where an armed rewind's counted line and a fork's origin seam fall among the rows; the step
 * a note becomes on the rail, and the name a lane's colour is looked up by.
 *
 * How any of it is laid out — sheets, gutters, letterheads, columns or tabs, the torn edges, and the
 * sentences written on them — is the universal tree's (`SessionBands.tsx`) and is not covered here.
 */
import { describe, expect, it } from "vitest";
import type { InstanceNode, MadeTask, SessionRef } from "@jaira/shared/browser";
import { bandsOf, piecesOf, placeOf, sameAddress, type BandNote } from "../src/renderer/sessionBands";
import { cutNameOf, keyOfPiece, markedRowsOf, pageRowsOf, sideName, sideOf, spanOf, stepOfNote, type PageRows } from "../src/renderer/sessionRows";
import { paletteOfRun, railOf } from "../src/renderer/rail";
import { keyOfNode } from "../src/renderer/runIndexModel";
import { KIND_WORD, surfaceKindOf } from "../src/renderer/stateSurfaceModel";

const node = (patch: Partial<InstanceNode> & Pick<InstanceNode, "instanceId" | "stateId">): InstanceNode => ({
  status: "completed",
  index: 0,
  superseded: false,
  startedAt: 0,
  children: [],
  ...patch,
});

const ref = (instanceId: number, sessionId: string, startedAt: number, at: number): SessionRef =>
  ({ runId: 1, instanceId: String(instanceId), stateId: `s`, sessionId, seq: 0, startedAt, at }) as SessionRef;

/**
 * A composite over leaves that each ran a PROMPT.
 *
 * The operation is on the fixture rather than left off, because it is what makes these children
 * conversations: a leaf with no operation is a state that computed its outputs and never spoke, and
 * the page gives that one a surface instead of a panel (see `stateSurfaceModel.ts`). Most cases in
 * this file are about the panel, so every child here is something that could have one.
 */
const parentOf = (kids: Array<{ id: number; from: number; to: number }>): InstanceNode =>
  node({
    instanceId: "1",
    stateId: "plan",
    children: kids.map((kid) =>
      node({
        instanceId: String(kid.id),
        stateId: `s${kid.id}`,
        childKey: `k${kid.id}`,
        startedAt: kid.from,
        endedAt: kid.to,
        operation: { kind: "prompt", status: "completed" },
      }),
    ),
  });

/** A note. `kind` defaults to `failure`, which is what most of these are about. */
const note = (patch: Partial<BandNote> & Pick<BandNote, "seq" | "at" | "text">): BandNote => ({ kind: "failure", path: "", ...patch });

/** The page for a run: its bands, and the notes among them, as the conversation lays them out. */
const pageOf = (parent: InstanceNode | undefined, refs: SessionRef[], notes: BandNote[] = [], root = ""): PageRows =>
  pageRowsOf(bandsOf(piecesOf(parent, refs)), notes, root);

/**
 * The page's rows, a word each: a note by its kind, a band by the instances whose words its panel
 * holds (`#2`, or `#3 #4` for two states in one sheet; panels side by side are joined by `|`).
 */
const rowsOf = (page: PageRows): string[] =>
  page.rows.map((row) =>
    row.kind === "note" ? row.note.kind : row.band.segments.map((segment) => segment.pieces.map((piece) => `#${piece.node.instanceId}`).join(" ")).join(" | "),
  );

describe("what a conversation draws", () => {
  /**
   * A state that was never going to speak is headed by what it IS.
   *
   * A surface has no session to be named or timed by, so the gutter over it would be saying nothing —
   * and the letterhead, opening with the word for its kind, is the only header it can have.
   */
  it("gives a surface a letterhead that says what kind of state it is", () => {
    const parent = node({
      instanceId: "1",
      stateId: "plan",
      children: [node({ instanceId: "2", stateId: "confidence", childKey: "confidence", startedAt: 0, endedAt: 5 })],
    });
    const [band] = bandsOf(piecesOf(parent, []));
    const [segment] = band!.segments;
    expect(segment!.pieces.map((piece) => piece.node.instanceId)).toEqual(["2"]);
    expect(segment!.sessionId).toBeUndefined();
    const kind = surfaceKindOf(segment!.pieces[0]!.node);
    expect(kind).toBe("computed");
    expect(KIND_WORD[kind as "computed"]).toBe("computed");
  });

  it("times the SESSION in the gutter — the envelope of its states, not the sum of them", () => {
    // A conversation interrupted and resumed spent the gap doing nothing. Summing the two calls
    // would report 2 ms of talking across a span of twenty.
    const bands = bandsOf(
      piecesOf(parentOf([{ id: 2, from: 0, to: 1 }, { id: 3, from: 19, to: 20 }]), [ref(2, "planning", 0, 1), ref(3, "planning", 19, 20)]),
    );
    expect(bands).toHaveLength(1);
    expect(bands[0]!.segments).toHaveLength(1);
    expect(spanOf(bands[0]!.segments[0]!)).toBe("20 ms");
  });
});

/**
 * The errors that belong to no conversation.
 *
 * A failure in a state that never opened a session has no panel to be a line of — so it is a row of
 * its own on the grey between the sheets, at the point in the run where it happened.
 */
describe("a failure with no panel to appear in", () => {
  it("writes it on the background, between the conversations, where it happened", () => {
    const page = pageOf(
      parentOf([
        { id: 2, from: 10, to: 20 },
        { id: 3, from: 30, to: 40 },
      ]),
      [ref(2, "planning", 10, 20), ref(3, "review", 30, 40)],
      [note({ seq: 1, at: 25, stateId: "plan/draft", text: "input 'framing' is not wired" })],
    );
    // Between the two sheets, not inside either: the state it names never said a word.
    expect(rowsOf(page)).toEqual(["#2", "failure", "#3"]);
    expect(page.rows[1]).toMatchObject({ kind: "note", note: { text: "input 'framing' is not wired" } });
    // On the rail it opens no lane: nothing was entered.
    expect(page.steps[1]).toMatchObject({ opens: false });
  });

  it("is the whole answer when a run failed before it opened any conversation at all", () => {
    // The case that read as "nothing happened yet": nothing ever became an instance, so there is no
    // band to hang anything on — and the reason is the only thing there is to show.
    const page = pageOf(undefined, [], [note({ seq: 1, at: 5, stateId: "plan", text: "child 'draft' terminated with error" })]);
    expect(rowsOf(page)).toEqual(["failure"]);
    // With no note either there is no row at all, which is when the page says nothing has been said.
    expect(rowsOf(pageOf(undefined, [], []))).toEqual([]);
  });
});

/**
 * The machine's own moves, on the same grey.
 *
 * A transition is taken BY a composite, and a composite has no panel — so the path a run took was
 * the one thing a page about that run could not show. It goes where the failures go, in the same
 * column and the same order, because reading a run means reading the two interleaved.
 */
describe("the path on the background", () => {
  it("fills the canvas that used to say a run had not entered a child yet", () => {
    const page = pageOf(undefined, [], [
      note({ seq: 1, at: 5, kind: "entered", path: "product", text: "" }),
      note({ seq: 2, at: 6, kind: "transition", path: "product/context", text: "context" }),
    ]);
    expect(rowsOf(page)).toEqual(["entered", "transition"]);
    // Entering `product` opens its lane; the move to `context` is a row inside it, since a transition
    // is taken by the state it leaves from.
    expect(page.steps.map((step) => [step.at, step.opens])).toEqual([
      [["product"], true],
      [["product"], false],
    ]);
  });
});

describe("the workflow behind a conversation", () => {
  it("names a SURFACE's own state as the one to describe, though it opened no session", () => {
    /*
     * A state that ran no conversation gets no gutter — its three facts (the session, the state that
     * opened it, the span) are all about a conversation it does not have. The workflow link is a
     * fourth fact, about the STATE, and it is the only route from a computed state to the file that
     * computed it. So the page still answers "which state is behind this panel" for a panel with no
     * session: the state itself.
     */
    const parent = node({
      instanceId: "1",
      stateId: "plan",
      children: [node({ instanceId: "9", stateId: "plan/confidence", childKey: "confidence", startedAt: 0, endedAt: 5 })],
    });
    const page = pageOf(parent, []);
    const [segment] = page.bands[0]!.segments;
    expect(segment!.sessionId).toBeUndefined();
    expect(page.starters.get(segment!.key)?.node.stateId).toBe("plan/confidence");
  });
});

/**
 * The colour a lane is drawn in — the fact the index and the conversation are documented as sharing.
 *
 * `paletteOfRun` keys its hues by `childKey ?? stateId`, because that is the name a state has where
 * it is mounted. The rail asks with `RailStep.stateId`, so the two only meet if the step carries the
 * same name — and it carried the bare `stateId`, so every hue lookup in the conversation missed and
 * every lane fell back to `var(--rule)`. The index looked right the whole time, which is what made
 * the two disagree about a colour neither of them is allowed to decide alone.
 */
describe("the colour of a lane in the conversation", () => {
  it("names a lane by the child key, which is the key the palette holds", () => {
    // A lane in the conversation is opened by an `entered` note, so this step is what decides the
    // hue of every row under it. It read `note.stateId` — the state DEFINITION's id — against a
    // palette built from `childKey ?? stateId`, so `feature/product/draft` was looked up in a map
    // holding `draft`, missed, and fell back to `var(--rule)`. Every lane in the gutter was grey.
    const step = stepOfNote(
      { seq: 1, at: 0, kind: "entered", stateId: "feature/product/draft", path: "product/draft", text: "" },
      "",
    );
    expect(step.stateId).toBe("draft");

    const palette = paletteOfRun([
      node({ instanceId: "1", stateId: "feature/product", childKey: "product" }),
      node({ instanceId: "2", stateId: "feature/product/draft", childKey: "draft" }),
    ]);
    // The point of the assertion: the name the rail asks with is a name the palette answers to.
    expect(palette.get(step.stateId)).toBeDefined();
  });

  it("falls back to the state id's last segment for a root, which has no key", () => {
    const step = stepOfNote({ seq: 1, at: 0, kind: "entered", stateId: "feature", path: "", text: "" }, "");
    expect(step.stateId).toBe("feature");
  });

  it("keeps a fan-out element in the lane's PLACE and drops it from the lane's NAME", () => {
    // The projection spells the first element of `build` as `build[0]`, and that is where the lane
    // is; but `build[0]` is not a state anybody coloured, so the name the palette is asked with is
    // the key.
    const step = stepOfNote({ seq: 1, at: 0, kind: "entered", stateId: "feature/build", path: "build[0]", text: "" }, "");
    expect(step.at).toEqual(["build[0]"]);
    expect(step.stateId).toBe("build");
  });
});

describe("a panel under a fan-out", () => {
  /**
   * The same run twice: once mounted plainly, once as the first element of a fan-out. The rail has
   * to draw the two alike — the element changes where the lane is, not how many turns the run took.
   *
   * It did not: the note rows said `build[0]` and the panel's address said `build`, so at every
   * panel the rail closed every lane down to nothing and opened them all again, and read as broken.
   */
  const scene = (element: number | undefined): PageRows => {
    const segment = element === undefined ? "build" : `build[${element}]`;
    const parent = node({
      instanceId: "1",
      stateId: "feature",
      children: [
        node({
          instanceId: "2",
          stateId: "feature/build",
          childKey: "build",
          address: [{ childKey: "build", occurrence: 0, ...(element === undefined ? {} : { element }) }],
          startedAt: 0,
          endedAt: 10,
          operation: { kind: "prompt", status: "completed" },
        }),
      ],
    });
    return pageOf(parent, [ref(2, "planning", 0, 10)], [
      note({ seq: 1, at: 0, kind: "entered", path: segment, text: "", instanceId: "2", stateId: "feature/build" }),
      note({ seq: 2, at: 9, kind: "transition", path: `${segment}/next`, text: "next", stateId: "feature/build" }),
    ]);
  };
  /** The rows the rail curves in: a lane forking off its parent, or joining it. */
  const turns = (page: PageRows): number => railOf(page.steps).rows.filter((row) => row.turn).length;

  it("takes exactly the turns a plain mount takes — no lane closed and reopened around the panel", () => {
    expect(rowsOf(scene(0))).toEqual(["entered", "#2", "transition"]);
    // The panel sits where the note that entered its state put the lane: the element is in both.
    expect(scene(0).steps.map((step) => step.at)).toEqual([["build[0]"], ["build[0]"], ["build[0]"]]);
    // One turn — the lane forking where the state is entered — and the same one a plain mount takes.
    expect(turns(scene(0))).toBe(1);
    expect(turns(scene(0))).toBe(turns(scene(undefined)));
    // No row leaves the lane: the panel and the transition after it are drawn inside it.
    expect(railOf(scene(0).steps).rows.map((row) => row.exit)).toEqual([undefined, undefined, undefined]);
  });

  it("tells the elements of a fan-out apart as places", () => {
    const at = (element?: number) => [{ childKey: "build", occurrence: 0, ...(element === undefined ? {} : { element }) }];
    expect(sameAddress(at(0), at(0))).toBe(true);
    expect(sameAddress(at(0), at(1))).toBe(false);
    expect(sameAddress(at(0), at())).toBe(false);
  });
});

describe("a panel that is one side of a fork", () => {
  /** A retried state: the attempt that took the position, and the branch that had to leave it. */
  const RETRY: SessionRef[] = [
    { instanceId: "2", stateId: "implement", sessionId: "default", seq: 6, startedAt: 0, at: 10, status: "error" },
    {
      instanceId: "3",
      stateId: "implement",
      sessionId: "b7c1e4",
      seq: 6,
      startedAt: 11,
      at: 20,
      status: "success",
      branch: { parent: "default", at: 6 },
    },
  ];
  /** Each panel of the run, with the fork it is a side of — what its gutter's mark is drawn from. */
  const panels = (page: PageRows) => page.bands.flatMap((band) => band.segments.map((segment) => sideOf(segment, page.forks)));
  const retried = (): PageRows =>
    pageOf(
      parentOf([
        { id: 2, from: 0, to: 10 },
        { id: 3, from: 11, to: 20 },
      ]),
      RETRY,
    );

  it("says so in the gutter, beside the id the fork changed", () => {
    // The third fact of the same kind as the two already there. The id says which conversation this
    // is, the state says what opened it, and until this there was nothing saying where it came from
    // — two panels with unrelated names, one silently carrying the other's whole prefix.
    expect(rowsOf(retried())).toEqual(["#2", "#3"]);
    expect(panels(retried()).map((side) => side !== undefined)).toEqual([true, true]);
  });

  it("marks BOTH sides, and counts each as the one it is", () => {
    // A fork is a fact about the division, not about the branch: the attempt that was left behind is
    // as much a side of it as the one that replaced it, and it is the side a reader is most likely
    // to arrive at first.
    const [first, second] = panels(retried());
    // Both panels hold the same two sides, in the order they ran…
    expect(first!.sides.map(placeOf)).toEqual(["default@6", "b7c1e4@6"]);
    expect(second!.sides).toBe(first!.sides);
    // …and each is the one at its own place: the attempt left behind is 1 of 2, the retry 2 of 2.
    expect(first!.place).toBe("default@6");
    expect(second!.place).toBe("b7c1e4@6");
    // A side is called by how that attempt ended, which is all that tells two attempts of one state apart.
    expect(first!.sides.map(sideName)).toEqual(["failed", "finished"]);
  });

  it("leaves an ordinary run unmarked", () => {
    // Nothing is paid for until a conversation actually divides, on screen as in the record.
    const page = pageOf(parentOf([{ id: 2, from: 0, to: 10 }]), [ref(2, "planning", 0, 10)]);
    expect(page.forks.size).toBe(0);
    expect(panels(page)).toEqual([undefined]);
  });
});

/**
 * Folding — remembered, not held by the panel.
 *
 * A fold is a statement about what you are done reading, and navigating away is not a retraction of
 * it. So the set is kept in the settings (`JairaUiState.shut`, under `SHUT.runStates`) and a sheet
 * only looks its states up in it — by the key below.
 */
describe("what a fold does", () => {
  const pieces = () =>
    piecesOf(parentOf([{ id: 2, from: 0, to: 10 }, { id: 3, from: 11, to: 20 }]), [ref(2, "planning", 0, 10), ref(3, "planning", 11, 20)]);

  it("keys a fold by TASK, run and instance, so nothing folds another task's states", () => {
    // Instance ids are minted per run, so `#i2` names a different state in every one of them — and a
    // single-run projection stamps no run at all, which is why the task has to be in the key too.
    expect(pieces().map((piece) => keyOfPiece(piece, "t-1"))).toEqual(["t-1:2:0", "t-1:3:0"]);
    // The same two states in another task are remembered under other keys.
    expect(pieces().map((piece) => keyOfPiece(piece, "t-2"))).toEqual(["t-2:2:0", "t-2:3:0"]);
  });
});

/**
 * Where a bookmark from the Instances index LANDS — see `runIndexModel.ts`.
 *
 * The scroll itself needs a screen and is not tested here, and neither is the stamp a letterhead
 * wears. What is tested is the half both depend on: that the page holds each state under the name
 * the index asks for it by. A jump that finds no target fails silently, so a mismatch is invisible
 * until somebody presses the row and nothing happens.
 */
describe("what a bookmark can land on", () => {
  it("holds every state on the page under the instance the index names it by", () => {
    const parent = parentOf([{ id: 2, from: 0, to: 10 }, { id: 3, from: 11, to: 20 }]);
    const page = pageOf(parent, [ref(2, "planning", 0, 10), ref(3, "planning", 11, 20)]);
    const held = page.bands.flatMap((band) => band.segments.flatMap((segment) => segment.pieces.map((piece) => piece.node.instanceId)));
    /*
     * Asserted against `keyOfNode` rather than against a literal, because the property that matters
     * is that the two AGREE — the index names a row by that key and the conversation stamps its
     * landing with the piece's instance. A literal would keep passing if both sides drifted together.
     */
    expect(held).toEqual(parent.children.map(keyOfNode));
  });
});

/**
 * Rewind and fork on the grey — see `cut.ts`.
 *
 * The entered row is the handle: every state has exactly one, which a letterhead (absent on a
 * one-state sheet) and a gutter (absent on a question) cannot say. Arming a rewind is drawn on the
 * rail — the knot rings, what follows fades under one counted line — and a fork's origin is a seam
 * placed by the clock among the rows the copy inherited.
 */
describe("rewind and fork on the grey", () => {
  const entered = (seq: number, at: number, id: number, key: string): BandNote =>
    note({ seq, at, kind: "entered", stateId: `s${id}`, instanceId: String(id), path: key, text: "" });
  const notes = [entered(5, 9, 2, "k2"), entered(15, 29, 3, "k3")];
  const twoStates = (): PageRows =>
    pageOf(
      parentOf([
        { id: 2, from: 10, to: 20 },
        { id: 3, from: 30, to: 40 },
      ]),
      [ref(2, "planning", 10, 20), ref(3, "review", 30, 40)],
      notes,
    );
  const row = (index: number) => ({ kind: "row", index });

  it("names the state each entered row's two verbs are about, and finds it from the lane", () => {
    const page = twoStates();
    expect(rowsOf(page)).toEqual(["entered", "#2", "entered", "#3"]);
    // Once per entered row — the handle is the row, and a panel is not one.
    expect([...page.noteRows.keys()]).toEqual([0, 2]);
    // "Rewind to before k3", "Fork before k3": the name is the state's path from the module being read.
    expect([...page.noteRows.values()].map((one) => cutNameOf(one, ""))).toEqual(["k2", "k3"]);
    // The knot's menu offers the same two verbs, and finds the entry by its lane.
    expect([...page.laneNotes].map(([lane, one]) => [lane, cutNameOf(one, "")])).toEqual([
      ["i2", "k2"],
      ["i3", "k3"],
    ]);
  });

  it("draws an armed rewind as a ring on the knot, a counted line, and everything after it faded", () => {
    const marked = markedRowsOf(twoStates(), notes, { seq: 15, at: 29 }, undefined);
    // One state would go — k3 — and the line that says so sits right under its entry, after
    // everything `k2` said and before the sheet `k3` opened.
    expect(marked.rows).toEqual([row(0), row(1), row(2), { kind: "cut", states: 1 }, row(3)]);
    // The entry's own row keeps its words and takes the ring; the sheet it opened is what fades.
    expect(marked.cutRow).toBe(2);
    expect(marked.doomedFrom).toBe(4);
    // The line is a row on the rail too, inside the lane the entry opened.
    expect(marked.steps[3]).toEqual({ key: "cut15", stateId: "", at: ["k3"], opens: false });
    // Nothing armed, nothing is ringed, counted or faded.
    const quiet = markedRowsOf(twoStates(), notes, undefined, undefined);
    expect(quiet.rows).toEqual([row(0), row(1), row(2), row(3)]);
    expect([quiet.cutRow, quiet.doomedFrom]).toEqual([-1, -1]);
  });

  it("places a fork's origin seam after the rows the copy inherited", () => {
    // Forked from the parent before `k3`, at 25 on the parent's clock: `k2` and what it said were
    // copied, and keep the parent's clocks; the task's own rows come later.
    const marked = markedRowsOf(twoStates(), notes, undefined, { boundaryAt: 25 });
    expect(marked.rows).toEqual([row(0), row(1), { kind: "origin" }, row(2), row(3)]);
    // The seam is the run's own row, at the top of the view, and it rings and fades nothing.
    expect(marked.steps[2]).toEqual({ key: "origin", stateId: "", at: [], opens: false });
    expect([marked.cutRow, marked.doomedFrom]).toEqual([-1, -1]);
  });
});

describe("the runs a fan-out made, as a line at the mount", () => {
  const run = (taskId: string, title: string, patch: Partial<MadeTask> = {}): MadeTask => ({
    taskId,
    element: 0,
    title,
    status: "queued",
    holding: 0,
    self: false,
    waitsFor: false,
    ...patch,
  });
  const made = (kind: "split" | "task", runs: MadeTask[]): BandNote => ({
    seq: 7,
    at: 25,
    kind: "made",
    stateId: "w",
    instanceId: "i-root",
    path: "work",
    text: "",
    made: { kind, runs },
  });
  const parent = parentOf([{ id: 2, from: 10, to: 20 }]);
  const refs = [ref(2, "planning", 10, 20)];
  const alpha = run("t-alpha00000", "Alpha", { self: true, element: 0 });
  const beta = run("t-beta000000", "Beta", { element: 1 });

  it("is a line on the grey — not a panel, and not a lane", () => {
    // The runs a split made are tasks of their own: the page gains one row for the line, and no panel
    // for any of them.
    const page = pageOf(parent, refs, [made("split", [alpha, beta])]);
    expect(rowsOf(page)).toEqual(["#2", "made"]);
    // A made task's path is the element's, and the row belongs to the state that made it: nothing was
    // entered here, so no lane opens, and the line sits against its parent.
    const step = stepOfNote(made("split", [alpha, beta]), "");
    expect(step.opens).toBe(false);
    expect(step.at).toEqual([]);
  });

  it("draws what a conversation's tool did as a ROW between its turns, not under the call", () => {
    // One conversation, three turns — one band until a `moved` note falls between the first two.
    const conversation = parentOf([
      { id: 2, from: 0, to: 10 },
      { id: 3, from: 20, to: 30 },
      { id: 4, from: 40, to: 50 },
    ]);
    const refs3 = [ref(2, "C", 0, 10), ref(3, "C", 20, 30), ref(4, "C", 40, 50)];
    const moved: BandNote = { seq: 9, at: 5, kind: "moved", path: "", text: "", moved: { verb: "adopted into", standsAt: "feature → ux", workflow: "Feature workflow", adoptedAs: "product" } };
    expect(rowsOf(pageOf(conversation, refs3))).toEqual(["#2 #3 #4"]);
    const page = pageOf(conversation, refs3, [moved]);
    expect(rowsOf(page)).toEqual(["#2", "moved", "#3 #4"]);
    // The row carries the tool note's own words, which is all its sentence is made of.
    expect(page.rows[1]).toMatchObject({ kind: "note", note: { moved: { verb: "adopted into", workflow: "Feature workflow", adoptedAs: "product", standsAt: "feature → ux" } } });
    // A rail row like any other note, at the conversation's own level: it opens no lane.
    expect(stepOfNote(moved, "")).toMatchObject({ opens: false, at: [] });
  });
});
