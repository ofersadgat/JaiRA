/**
 * The conversation grouped by SESSION rather than by state.
 *
 * The bug this closes: a composite with no operation of its own showed a transcript above its
 * children anyway, because `sessionView` falls back to the last conversation in the whole task when
 * asked about an instance that never spoke. A state with no operation is exactly that instance, so
 * the panel opened with an unrelated run's words. Nothing here can produce that any more — a piece
 * exists because an operation ran, and a composite that only orchestrates contributes none.
 *
 * The rest is the layout rule: vertical space is time. Overlapping calls share a band; a session
 * that appears in two bands was interrupted, and its halves carry the pause and resume marks.
 */
import { describe, expect, it } from "vitest";
import type { ConversationTurn, InstanceNode, RunView, SessionRef } from "@jaira/shared/browser";
import {
  bandsOf,
  forksOf,
  instancesOf,
  notesOf,
  mountPathOf,
  pathFrom,
  piecesOf,
  placeNotes,
  startersOf,
  type BandNote,
  type SessionPiece,
} from "../src/renderer/sessionBands";

const node = (patch: Partial<InstanceNode> & Pick<InstanceNode, "instanceId" | "stateId">): InstanceNode => ({
  status: "completed",
  index: 0,
  superseded: false,
  startedAt: 0,
  children: [],
  ...patch,
});

/** A session row: `ref(instance, session, from, to)`. Numeric for brevity; ids are strings. */
const ref = (instanceId: number, sessionId: string, startedAt: number, at: number): SessionRef =>
  ({ instanceId: String(instanceId), stateId: `s${instanceId}`, sessionId, seq: 0, startedAt, at }) as SessionRef;

/** A composite parent over leaves that ran between the given times. */
const tree = (kids: Array<{ id: number; from: number; to: number }>): InstanceNode =>
  node({
    instanceId: "1",
    stateId: "plan",
    startedAt: 0,
    children: kids.map((kid) =>
      node({ instanceId: String(kid.id), stateId: `s${kid.id}`, childKey: `k${kid.id}`, startedAt: kid.from, endedAt: kid.to }),
    ),
  });

/** `[["A", 2], ...]` — one entry per segment of each band, in order. */
const shape = (bands: ReturnType<typeof bandsOf>): Array<Array<[string, number]>> =>
  bands.map((band) => band.segments.map((s) => [s.sessionId ?? s.key, s.pieces.length] as [string, number]));

describe("piecesOf", () => {
  it("gives a composite with no operation nothing of its own — the bug", () => {
    const parent = tree([
      { id: 2, from: 0, to: 10 },
      { id: 3, from: 11, to: 20 },
    ]);
    const pieces = piecesOf(parent, [ref(2, "A", 0, 10), ref(3, "A", 11, 20)]);
    expect(pieces.map((p) => p.node.instanceId)).toEqual(["2", "3"]);
    expect(pieces.some((p) => p.node.instanceId === "1")).toBe(false);
  });

  it("includes the run's OWN operation when it has one", () => {
    const parent = tree([{ id: 2, from: 5, to: 10 }]);
    const pieces = piecesOf(parent, [ref(1, "A", 0, 20), ref(2, "B", 5, 10)]);
    expect(pieces.map((p) => [p.node.instanceId, p.sessionId])).toEqual([
      ["1", "A"],
      ["2", "B"],
    ]);
  });

  it("flattens the whole subtree, so a grandchild lands in the session it continued", () => {
    const parent = node({
      instanceId: "1",
      stateId: "plan",
      children: [
        node({
          instanceId: "2",
          stateId: "plan/mid",
          startedAt: 0,
          endedAt: 30,
          children: [node({ instanceId: "3", stateId: "plan/mid/leaf", startedAt: 5, endedAt: 25 })],
        }),
      ],
    });
    const pieces = piecesOf(parent, [ref(3, "A", 5, 25)]);
    expect(pieces.map((p) => p.node.instanceId)).toEqual(["3"]);
  });

  it("keeps a leaf that ran no model call — it happened, and a function op has no session", () => {
    const parent = tree([{ id: 2, from: 0, to: 10 }]);
    const [piece] = piecesOf(parent, []);
    expect(piece?.node.instanceId).toBe("2");
    expect(piece?.sessionId).toBeUndefined();
  });

  it("joins on the durable instance id — every call the instance ever made lands on its node", () => {
    // A resume continues the same instance under the same id, so a stop-and-continue's two calls
    // are two pieces of ONE node, in the order they happened.
    const parent = tree([{ id: 2, from: 0, to: 30 }]);
    const early = { ...ref(2, "A", 0, 10), seq: 0 } as SessionRef;
    const late = { ...ref(2, "A", 11, 20), seq: 1 } as SessionRef;
    const pieces = piecesOf(parent, [late, early]);
    expect(pieces.map((p) => [p.node.instanceId, p.seq])).toEqual([
      ["2", 0],
      ["2", 1],
    ]);
  });

  it("draws history the tree has no node for as its OWN piece rather than hiding it", () => {
    // A chat child's record is filed under an id the tree never holds, and a legacy attempt the
    // machine-root filter dropped still cost money and said things.
    const parent = tree([{ id: 2, from: 0, to: 10 }]);
    const stray = { ...ref(9, "OLD", 0, 10) } as SessionRef;
    const pieces = piecesOf(parent, [stray, ref(2, "A", 0, 10)]);
    expect(pieces.map((p) => p.sessionId).sort()).toEqual(["A", "OLD"]);
    expect(pieces.find((p) => p.sessionId === "OLD")?.node.instanceId).toBe("9");
  });

  it("keeps a pass a sequence reset superseded — the branch still happened", () => {
    // These used to be dropped, and the loop is where that hurt: re-entering a child key supersedes
    // the previous instance under it, so looping back to `explore` deleted the entire previous
    // iteration from the transcript — panels that had been read, and the answers the next pass is a
    // response to. `superseded` governs expression resolution, not history; the projection keeps the
    // history in as many words, and every other reader already shows it.
    const parent = node({
      instanceId: "1",
      stateId: "plan",
      children: [
        node({ instanceId: "2", stateId: "s2", startedAt: 0, endedAt: 10, superseded: true }),
        node({ instanceId: "3", stateId: "s3", startedAt: 11, endedAt: 20 }),
      ],
    });
    const pieces = piecesOf(parent, [ref(2, "A", 0, 10), ref(3, "A", 11, 20)]);
    // In time order, so the superseded pass reads as the earlier one it is.
    expect(pieces.map((p) => p.node.instanceId)).toEqual(["2", "3"]);
  });

  it("keeps the whole subtree under a superseded pass, not only its root", () => {
    // The walk used to stop descending, so a superseded COMPOSITE took every conversation beneath it
    // off the page — which is exactly the shape a loop over a module produces.
    const parent = node({
      instanceId: "1",
      stateId: "plan",
      children: [
        node({
          instanceId: "2",
          stateId: "explore",
          startedAt: 0,
          endedAt: 10,
          superseded: true,
          children: [node({ instanceId: "4", stateId: "explore/brief", startedAt: 1, endedAt: 9 })],
        }),
        node({ instanceId: "3", stateId: "explore", startedAt: 11, endedAt: 20 }),
      ],
    });
    const pieces = piecesOf(parent, [ref(4, "A", 1, 9), ref(3, "B", 11, 20)]);
    expect(pieces.map((p) => p.node.instanceId)).toEqual(["4", "3"]);
  });

  it("prefers the operation's start over the instance's — they differ by a whole subtree", () => {
    const parent = tree([{ id: 2, from: 0, to: 100 }]);
    const [piece] = piecesOf(parent, [ref(2, "A", 90, 100)]);
    expect(piece?.startedAt).toBe(90);
  });
});

describe("bandsOf", () => {
  it("keeps a run of states in one session as ONE panel, with no pause invented", () => {
    const parent = tree([
      { id: 2, from: 0, to: 10 },
      { id: 3, from: 11, to: 20 },
      { id: 4, from: 21, to: 30 },
    ]);
    const bands = bandsOf(piecesOf(parent, [ref(2, "A", 0, 10), ref(3, "A", 11, 20), ref(4, "A", 21, 30)]));
    expect(shape(bands)).toEqual([[["A", 3]]]);
    expect(bands[0]!.segments[0]!.paused).toBe(false);
    expect(bands[0]!.segments[0]!.resumed).toBe(false);
  });

  it("cuts a session in two when another one runs in the gap, and marks both edges", () => {
    const parent = tree([
      { id: 2, from: 0, to: 10 },
      { id: 3, from: 11, to: 20 },
      { id: 4, from: 21, to: 30 },
    ]);
    const bands = bandsOf(piecesOf(parent, [ref(2, "A", 0, 10), ref(3, "B", 11, 20), ref(4, "A", 21, 30)]));
    expect(shape(bands)).toEqual([[["A", 1]], [["B", 1]], [["A", 1]]]);
    expect(bands[0]!.segments[0]).toMatchObject({ paused: true, resumed: false });
    expect(bands[1]!.segments[0]).toMatchObject({ paused: false, resumed: false });
    expect(bands[2]!.segments[0]).toMatchObject({ paused: false, resumed: true });
  });

  it("puts overlapping calls in one band, across rather than down", () => {
    const parent = tree([
      { id: 2, from: 0, to: 20 },
      { id: 3, from: 5, to: 25 },
    ]);
    const bands = bandsOf(piecesOf(parent, [ref(2, "A", 0, 20), ref(3, "B", 5, 25)]));
    expect(shape(bands)).toEqual([
      [
        ["A", 1],
        ["B", 1],
      ],
    ]);
  });

  it("puts the elements of one batch in one band when asked to, even though they ran one after another", () => {
    const element = (id: number, index: number, from: number, to: number): InstanceNode =>
      node({
        instanceId: String(id),
        stateId: `s${id}`,
        childKey: "work",
        element: index,
        startedAt: from,
        endedAt: to,
        address: [{ childKey: "work", occurrence: 0, element: index }],
      });
    const parent = node({ instanceId: "1", stateId: "plan", startedAt: 0, children: [element(2, 0, 0, 10), element(3, 1, 10, 20), element(4, 2, 20, 30)] });
    const refs = [ref(2, "A", 0, 10), ref(3, "B", 10, 20), ref(4, "C", 20, 30)];
    // Stacked, the default: three sequential pieces are three bands down the page.
    expect(shape(bandsOf(piecesOf(parent, refs)))).toEqual([[["A", 1]], [["B", 1]], [["C", 1]]]);
    expect(shape(bandsOf(piecesOf(parent, refs), { batches: "stacked" }))).toEqual([[["A", 1]], [["B", 1]], [["C", 1]]]);
    // A band: the batch is one band across, siblings rather than passes.
    expect(shape(bandsOf(piecesOf(parent, refs), { batches: "band" }))).toEqual([
      [
        ["A", 1],
        ["B", 1],
        ["C", 1],
      ],
    ]);
  });

  it("keeps a later pass of the same mount out of an earlier batch's band, and a plain sequence stacked", () => {
    const at = (id: number, occurrence: number, index: number | undefined, from: number, to: number): InstanceNode =>
      node({
        instanceId: String(id),
        stateId: `s${id}`,
        childKey: "work",
        ...(index !== undefined ? { element: index } : {}),
        startedAt: from,
        endedAt: to,
        address: [{ childKey: "work", occurrence, ...(index !== undefined ? { element: index } : {}) }],
      });
    const parent = node({ instanceId: "1", stateId: "plan", startedAt: 0, children: [at(2, 0, 0, 0, 10), at(3, 0, 1, 10, 20), at(4, 1, 0, 20, 30), at(5, 1, 1, 30, 40)] });
    const refs = [ref(2, "A", 0, 10), ref(3, "B", 10, 20), ref(4, "C", 20, 30), ref(5, "D", 30, 40)];
    expect(shape(bandsOf(piecesOf(parent, refs), { batches: "band" }))).toEqual([
      [
        ["A", 1],
        ["B", 1],
      ],
      [
        ["C", 1],
        ["D", 1],
      ],
    ]);
    const plain = node({ instanceId: "1", stateId: "plan", startedAt: 0, children: [at(2, 0, undefined, 0, 10), at(3, 1, undefined, 10, 20)] });
    expect(shape(bandsOf(piecesOf(plain, [ref(2, "A", 0, 10), ref(3, "B", 10, 20)]), { batches: "band" }))).toEqual([[["A", 1]], [["B", 1]]]);
  });

  it("does not call a concurrent session paused — it never stopped", () => {
    const parent = tree([
      { id: 2, from: 0, to: 30 },
      { id: 3, from: 5, to: 10 },
    ]);
    const bands = bandsOf(piecesOf(parent, [ref(2, "A", 0, 30), ref(3, "B", 5, 10)]));
    expect(bands).toHaveLength(1);
    expect(bands[0]!.segments.every((s) => !s.paused && !s.resumed)).toBe(true);
  });

  it("treats a handoff at the same millisecond as sequential, not concurrent", () => {
    const parent = tree([
      { id: 2, from: 0, to: 10 },
      { id: 3, from: 10, to: 20 },
    ]);
    const bands = bandsOf(piecesOf(parent, [ref(2, "A", 0, 10), ref(3, "B", 10, 20)]));
    expect(shape(bands)).toEqual([[["A", 1]], [["B", 1]]]);
  });

  it("marks every cut of a session that is interrupted twice", () => {
    const parent = tree([
      { id: 2, from: 0, to: 10 },
      { id: 3, from: 11, to: 20 },
      { id: 4, from: 21, to: 30 },
      { id: 5, from: 31, to: 40 },
      { id: 6, from: 41, to: 50 },
    ]);
    const bands = bandsOf(
      piecesOf(
        parent,
        [ref(2, "A", 0, 10), ref(3, "B", 11, 20), ref(4, "A", 21, 30), ref(5, "C", 31, 40), ref(6, "A", 41, 50)],
      ),
    );
    const a = bands.flatMap((b) => b.segments).filter((s) => s.sessionId === "A");
    expect(a.map((s) => [s.resumed, s.paused])).toEqual([
      [false, true],
      [true, true],
      [true, false],
    ]);
  });

  it("never marks a piece that ran in no conversation — there is nothing to interrupt", () => {
    const parent = tree([
      { id: 2, from: 0, to: 10 },
      { id: 3, from: 11, to: 20 },
      { id: 4, from: 21, to: 30 },
    ]);
    // #2 and #4 are function ops. They are separate threads, not one session split around #3.
    const bands = bandsOf(piecesOf(parent, [ref(3, "B", 11, 20)]));
    expect(bands.flatMap((b) => b.segments).every((s) => !s.paused && !s.resumed)).toBe(true);
    expect(shape(bands)).toEqual([[["#2", 1]], [["B", 1]], [["#4", 1]]]);
  });

  it("lets a call still running overlap whatever starts after it", () => {
    const parent = node({
      instanceId: "1",
      stateId: "plan",
      children: [
        node({ instanceId: "2", stateId: "s2", startedAt: 0, status: "running" }),
        node({ instanceId: "3", stateId: "s3", startedAt: 5, endedAt: 9 }),
      ],
    });
    const bands = bandsOf(piecesOf(parent, [ref(3, "B", 5, 9)]));
    expect(bands).toHaveLength(1);
    expect(bands[0]!.segments).toHaveLength(2);
  });
});

describe("piecesOf over a continued task", () => {
  /**
   * What the projection hands over after a stop and its resume: ONE tree, the same durable ids,
   * with the continuation's calls landing on the instances they continue (Identity and Resume �05).
   */
  const folded = (): InstanceNode =>
    node({
      instanceId: "1",
      stateId: "product",
      address: [],
      children: [
        node({
          instanceId: "5",
          stateId: "product/draft",
          childKey: "draft",
          address: [{ childKey: "draft", occurrence: 0 }],
          startedAt: 100,
          endedAt: 200,
        }),
      ],
    });
  const original = (): SessionRef =>
    ({ instanceId: "5", stateId: "product/draft", sessionId: "conv-1", seq: 0, startedAt: 5, at: 9 }) as SessionRef;

  it("finds the call the stopped run made, on the instance that continues it", () => {
    const pieces = piecesOf(folded(), [original()]);
    const draft = pieces.find((p) => p.node.stateId === "product/draft")!;
    expect(draft.sessionId).toBe("conv-1");
    expect(draft.instanceId).toBe("5");
  });

  it("does not draw the same call twice — once on the node, once synthesised beside it", () => {
    const pieces = piecesOf(folded(), [original()]);
    expect(pieces.filter((p) => p.node.stateId === "product/draft")).toHaveLength(1);
  });

  it("keeps the fallback for a state that genuinely ran no call", () => {
    // A function op is silent, and the sentence saying so is an answer.
    const pieces = piecesOf(folded(), []);
    const draft = pieces.find((p) => p.node.stateId === "product/draft")!;
    expect(draft.sessionId).toBeUndefined();
  });
});

describe("instancesOf", () => {
  it("names every transcript the panels will need, once each", () => {
    const parent = tree([
      { id: 2, from: 0, to: 10 },
      { id: 3, from: 11, to: 20 },
    ]);
    const bands = bandsOf(piecesOf(parent, [ref(2, "A", 0, 10), ref(3, "A", 11, 20)]));
    // By instance id — durable, and the one key a transcript is fetched and cached under.
    expect(instancesOf(bands).map((one) => one.instanceId).sort()).toEqual(["2", "3"]);
  });

  it("counts an off-tree record's instance apart, so a chat child is its own transcript", () => {
    const parent = tree([{ id: 2, from: 0, to: 10 }]);
    const stray = { ...ref(9, "OLD", 0, 10) } as SessionRef;
    const needed = instancesOf(bandsOf(piecesOf(parent, [stray, ref(2, "A", 0, 10)])));
    expect(needed).toHaveLength(2);
  });
});

/**
 * The failures that no panel can hold.
 *
 * The bug this closes: a run whose child was blocked before it could run, or whose composite gave up
 * because one of its children failed, showed NOTHING about either. Both are journal facts about a
 * state that never opened a conversation, and the view filtered journal facts by matching a panel's
 * state — so the only states whose errors could reach the screen were the ones that had not merely
 * failed to start.
 */
const turn = (patch: Partial<ConversationTurn> & Pick<ConversationTurn, "seq" | "kind">): ConversationTurn => ({
  at: patch.seq * 10,
  ...patch,
});

describe("notesOf", () => {
  const bandsFor = (kids: Array<{ id: number; from: number; to: number }>, refs: SessionRef[]) =>
    bandsOf(piecesOf(tree(kids), refs));

  it("keeps the failure of a state that never opened a conversation", () => {
    const notes = notesOf([
      turn({ seq: 1, kind: "blocked", stateId: "plan/draft", path: "draft", text: "plan/draft: input 'framing' is not wired", ok: false }),
      turn({ seq: 2, kind: "terminated", instanceId: "1", stateId: "plan", path: "", text: "child 'draft' terminated with error", ok: false }),
    ]);
    expect(notes.map((n) => [n.kind, n.path, n.text])).toEqual([
      // The state id the engine prefixed the reason with is dropped: the note carries it beside the
      // sentence, and saying it twice is one subject too many.
      ["blocked", "draft", "input 'framing' is not wired"],
      ["failure", "", "child 'draft' terminated with error"],
    ]);
  });

  it("addresses a row by its MOUNT, not by the state file it runs", () => {
    // `explore` is one definition mounted under all six phases. The id says which FILE; only the
    // mount says which of the six could not be entered.
    const notes = notesOf([
      turn({ seq: 1, kind: "blocked", stateId: "explore", path: "product/explore", text: "nope", ok: false }),
    ]);
    expect(notes.map((n) => [n.stateId, n.path])).toEqual([["explore", "product/explore"]]);
  });

  /**
   * The rule, from both sides: a failure is drawn here if and only if its instance ran NO operation.
   *
   * This used to go the other way — a failed call was written twice, once as a grey note and once in
   * its own panel — and the note was the worse of the two homes: the reason with none of its context,
   * no retry, and no relation to the call that produced it.
   */
  it("drops a failure whose instance ran an operation — that panel is already saying it", () => {
    const ran = node({
      instanceId: "2",
      stateId: "s2",
      operation: { kind: "prompt", status: "failed", reason: "the call failed" },
    });
    const notes = notesOf(
      [turn({ seq: 1, kind: "failure", instanceId: "2", stateId: "s2", path: "a", text: "the call failed", ok: false })],
      node({ instanceId: "1", stateId: "plan", children: [ran] }),
    );
    expect(notes).toEqual([]);
  });

  it("keeps a failure whose instance ran nothing — there is no panel and there never will be", () => {
    // A composite giving up because a child did. It has children and no operation of its own, so the
    // grey is the only account of it there can be.
    const notes = notesOf(
      [turn({ seq: 1, kind: "terminated", instanceId: "1", stateId: "plan", path: "", text: "child 'draft' failed", ok: false })],
      node({ instanceId: "1", stateId: "plan", children: [node({ instanceId: "2", stateId: "s2" })] }),
    );
    expect(notes.map((n) => [n.kind, n.text])).toEqual([["failure", "child 'draft' failed"]]);
  });

  it("keeps a BLOCKED child whatever the tree says, because it names no instance at all", () => {
    // The absence of an instance id is the fact rather than a sentinel: blocked means it never
    // became one, so there is nothing to look up and nothing that could claim it.
    const notes = notesOf(
      [turn({ seq: 1, kind: "blocked", stateId: "plan/draft", path: "draft", text: "not wired", ok: false })],
      node({ instanceId: "1", stateId: "plan", operation: { kind: "prompt", status: "completed" } }),
    );
    expect(notes.map((n) => [n.kind, n.text])).toEqual([["blocked", "not wired"]]);
  });

  it("claims nothing when there is no tree to ask", () => {
    // A projection that has not landed yet. Hiding a run's only error while the panel that would
    // have shown it does not exist either is the one failure mode worth refusing.
    const notes = notesOf([turn({ seq: 1, kind: "failure", instanceId: "2", stateId: "s2", path: "a", text: "boom", ok: false })]);
    expect(notes.map((n) => n.text)).toEqual(["boom"]);
  });

  it("draws a state being ENTERED as a step in the path", () => {
    // The case that makes this worth having: a sequence walking down its spine takes no transitions
    // at all, so a canvas drawn from `transition.taken` alone would be blank for the run somebody
    // opens to ask how far it got.
    const notes = notesOf([turn({ seq: 1, kind: "entered", instanceId: "2", stateId: "feature/product", path: "product" })]);
    // The INSTANCE travels with it, which is what the rail keys a lane on: `explore` running twice is
    // two lanes with one colour, and a lane keyed on the state would draw the second pass as a
    // continuation of the first.
    expect(notes).toEqual([
      { seq: 1, at: 10, kind: "entered", stateId: "feature/product", instanceId: "2", path: "product", text: "" },
    ]);
  });

  it("does not draw the ROOT entering itself — everything in the run is inside it", () => {
    const notes = notesOf([
      turn({ seq: 1, kind: "entered", instanceId: "1", stateId: "feature", path: "" }),
      turn({ seq: 2, kind: "entered", instanceId: "2", stateId: "feature/product", path: "product" }),
    ]);
    expect(notes.map((n) => n.path)).toEqual(["product"]);
  });

  it("does not read a call, or a termination, as a state being entered", () => {
    // These three were ONE kind, told apart by matching `text` against the literal "entered" and by
    // whether `ok` was present. They are three kinds now, so the question is answered by the type
    // rather than by a string — and a state whose label happens to be "entered" can no longer be
    // mistaken for the machine walking into it.
    const notes = notesOf([
      turn({ seq: 1, kind: "started", instanceId: "2", stateId: "plan/draft", path: "draft", text: "prompt" }),
      turn({ seq: 2, kind: "terminated", instanceId: "2", stateId: "plan/draft", path: "draft", text: "entered", ok: true }),
    ]);
    expect(notes).toEqual([]);
  });

  it("draws a TRANSITION as its own kind of note, carrying the target it went to", () => {
    // A transition GOES somewhere, so the row is addressed by where it ARRIVES: the taking state's
    // path with the target as one more step.
    const notes = notesOf([turn({ seq: 1, kind: "transition", stateId: "feature/product", path: "product", text: "explore" })]);
    expect(notes).toEqual([
      { seq: 1, at: 10, kind: "transition", stateId: "feature/product", path: "product/explore", text: "explore" },
    ]);
  });

  it("says a repeated FAILURE once, and a repeated TRANSITION every time", () => {
    // A loop that went back to `draft` three times went back three times — that IS the path. The
    // same block reported three times is one fact reported three times.
    const notes = notesOf([
      turn({ seq: 1, kind: "transition", stateId: "plan", path: "", text: "draft" }),
      turn({ seq: 2, kind: "terminated", instanceId: "1", stateId: "plan", path: "", text: "success", ok: true }),
      turn({ seq: 3, kind: "failure", stateId: "plan/draft", path: "draft", text: "not wired", ok: false }),
      turn({ seq: 4, kind: "failure", stateId: "plan/draft", path: "draft", text: "not wired", ok: false }),
      turn({ seq: 5, kind: "transition", stateId: "plan", path: "", text: "draft" }),
    ]);
    expect(notes.map((n) => [n.kind, n.text])).toEqual([
      ["transition", "draft"],
      ["failure", "not wired"],
      ["transition", "draft"],
    ]);
  });

  it("ignores the turns that are neither — a successful termination is not news on the grey", () => {
    const notes = notesOf([
      turn({ seq: 1, kind: "terminated", instanceId: "1", stateId: "plan", path: "", text: "success", ok: true }),
      turn({ seq: 2, kind: "output", instanceId: "1", stateId: "plan", path: "", ok: true }),
    ]);
    expect(notes).toEqual([]);
  });
});

describe("pathFrom", () => {
  it("draws a mount path as the run going one step further in", () => {
    expect(pathFrom("product/explore", "")).toBe("product → explore");
  });

  it("trims the module already being looked at", () => {
    // Walked into `product`: the page already says `product`, so a row repeating it wastes the
    // column that the part which varies needs.
    expect(pathFrom("product/explore", "product")).toBe("explore");
  });

  it("has nothing to draw for the module itself", () => {
    expect(pathFrom("product", "product")).toBe("");
    expect(pathFrom("", "")).toBe("");
  });

  it("leaves a path that is not inside the module alone", () => {
    expect(pathFrom("other/thing", "product")).toBe("other → thing");
  });
});

describe("mountPathOf", () => {
  const node = (instanceId: string, childKey: string | undefined, children: InstanceNode[] = []): InstanceNode =>
    ({
      instanceId,
      stateId: `s${instanceId}`,
      status: "completed",
      index: 0,
      superseded: false,
      startedAt: 0,
      children,
      ...(childKey !== undefined ? { childKey } : {}),
    }) as InstanceNode;

  const forest = [node("1", undefined, [node("2", "product", [node("3", "context"), node("4", "explore")])])];

  it("is the chain of CHILD KEYS from the root", () => {
    expect(mountPathOf(forest, "4")).toBe("product/explore");
  });

  it("is empty for the root — which is how the view spells you are looking at it", () => {
    expect(mountPathOf(forest, "1")).toBe("");
  });

  it("is empty for an instance the tree does not have", () => {
    expect(mountPathOf(forest, "99")).toBe("");
  });
});

describe("placeNotes", () => {
  it("puts each note above the band it precedes, and the rest at the end", () => {
    const bands = bandsOf(piecesOf(tree([
      { id: 2, from: 10, to: 20 },
      { id: 3, from: 30, to: 40 },
    ]), [ref(2, "A", 10, 20), ref(3, "B", 30, 40)]));
    const notes: BandNote[] = [
      { seq: 1, at: 5, kind: "failure", path: "", text: "before anything ran" },
      { seq: 2, at: 25, kind: "failure", path: "", text: "between the two" },
      { seq: 3, at: 99, kind: "failure", path: "", text: "how it ended" },
    ];
    expect(placeNotes(notes, bands).map((bucket) => bucket.map((n) => n.text))).toEqual([
      ["before anything ran"],
      ["between the two"],
      ["how it ended"],
    ]);
  });

  it("puts a note ABOVE a band that starts at the very same instant", () => {
    // The tie is the ordinary case, not an edge: a band starts at the `operation.started` of its
    // first call, and the state ENTERING is the journal event immediately before it — the one that
    // opened the conversation. They land in the same millisecond routinely, and on `<=` the step
    // drew underneath the panel it had just opened.
    const bands = bandsOf(piecesOf(tree([{ id: 2, from: 1_787_686_049_384, to: 1_787_686_062_189 }]), [ref(2, "A", 1_787_686_049_384, 1_787_686_062_189)]));
    const step: BandNote = { seq: 43, at: 1_787_686_049_384, kind: "entered", path: "product/context", text: "" };
    const later: BandNote = { seq: 47, at: 1_787_686_062_191, kind: "blocked", path: "product/explore", text: "not wired" };
    expect(placeNotes([step, later], bands).map((bucket) => bucket.map((n) => n.path))).toEqual([
      ["product/context"],
      ["product/explore"],
    ]);
  });

  it("gives every note the last bucket when there are no bands at all", () => {
    const only: BandNote = { seq: 1, at: 5, kind: "failure", path: "", text: "blocked" };
    expect(placeNotes([only], [])).toEqual([[only]]);
  });
});

describe("startersOf", () => {
  it("names the run that OPENED each session, not the one that resumed it", () => {
    const parent = tree([
      { id: 2, from: 0, to: 10 },
      { id: 3, from: 11, to: 20 },
      { id: 4, from: 21, to: 30 },
    ]);
    // "A" runs, is interrupted by "B", and comes back — so it has two panels and one starter.
    const bands = bandsOf(piecesOf(parent, [ref(2, "A", 0, 10), ref(3, "B", 11, 20), ref(4, "A", 21, 30)]));
    expect(startersOf(bands).get("A")?.node.instanceId).toBe("2");
    expect(startersOf(bands).get("B")?.node.instanceId).toBe("3");
  });
});

describe("forksOf", () => {
  /** A retried state: the attempt that claimed the position, and the branch that had to leave it. */
  const retried = (): SessionRef[] => [
    { instanceId: "2", stateId: "implement", sessionId: "default", seq: 6, startedAt: 10, at: 20, status: "error" },
    {
      instanceId: "3",
      stateId: "implement",
      sessionId: "b7c1e4",
      seq: 6,
      startedAt: 30,
      at: 40,
      status: "success",
      branch: { parent: "default", at: 6 },
    },
  ];

  it("pairs a branch back up with the record it left, and reports both sides to both", () => {
    // The two arrive as ordinary pieces with unrelated session ids — which is exactly how a retry
    // used to read on screen. The lineage is what says they are one division seen twice.
    const forks = forksOf(
      piecesOf(
        tree([
          { id: 2, from: 10, to: 20 },
          { id: 3, from: 30, to: 40 },
        ]),
        retried(),
      ),
    );
    expect([...forks.keys()].sort()).toEqual(["b7c1e4@6", "default@6"]);
    // One array, shared: `indexOf` is how a panel answers "which of these am I".
    expect(forks.get("default@6")).toBe(forks.get("b7c1e4@6"));
  });

  it("puts the sides in the order they ran, which is what makes '2 of 2' true", () => {
    const forks = forksOf(
      piecesOf(
        tree([
          { id: 2, from: 10, to: 20 },
          { id: 3, from: 30, to: 40 },
        ]),
        retried(),
      ),
    );
    // The attempt that failed is attempt one however the pieces happened to be walked.
    expect(forks.get("default@6")?.map((side) => side.sessionId)).toEqual(["default", "b7c1e4"]);
  });

  it("reports nothing where only one side is on the page", () => {
    // A branch whose parent's record is not drawn cannot offer the side it came from, and a mark
    // reading "1 of 1" would claim a division over something that never divided.
    const [, branch] = retried();
    expect(forksOf(piecesOf(tree([{ id: 3, from: 30, to: 40 }]), [branch!])).size).toBe(0);
  });

  it("says nothing about a run that never forked, which is nearly all of them", () => {
    const bands = bandsOf(piecesOf(tree([{ id: 2, from: 0, to: 10 }]), [ref(2, "A", 0, 10)]));
    expect(forksOf(bands.flatMap((band) => band.segments.flatMap((segment) => segment.pieces))).size).toBe(0);
  });
});
