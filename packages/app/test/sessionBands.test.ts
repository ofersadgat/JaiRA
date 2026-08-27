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
  placeRunForks,
  runForkAt,
  runForksOf,
  startersOf,
  type BandNote,
  type SessionPiece,
} from "../src/renderer/sessionBands";

const node = (patch: Partial<InstanceNode> & Pick<InstanceNode, "instanceId" | "stateId">): InstanceNode => ({
  status: "completed",
  iteration: 0,
  superseded: false,
  startedAt: 0,
  children: [],
  ...patch,
});

/** A session row: `ref(instance, session, from, to)`. */
const ref = (instanceId: number, sessionId: string, startedAt: number, at: number): SessionRef =>
  ({ runId: 1, instanceId, stateId: `s${instanceId}`, sessionId, seq: 0, startedAt, at }) as SessionRef;

/** A composite parent over leaves that ran between the given times. */
const tree = (kids: Array<{ id: number; from: number; to: number }>): InstanceNode =>
  node({
    instanceId: 1,
    stateId: "plan",
    startedAt: 0,
    children: kids.map((kid) =>
      node({ instanceId: kid.id, stateId: `s${kid.id}`, childKey: `k${kid.id}`, startedAt: kid.from, endedAt: kid.to }),
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
    const pieces = piecesOf(parent, [ref(2, "A", 0, 10), ref(3, "A", 11, 20)], 1);
    expect(pieces.map((p) => p.node.instanceId)).toEqual([2, 3]);
    expect(pieces.some((p) => p.node.instanceId === 1)).toBe(false);
  });

  it("includes the run's OWN operation when it has one", () => {
    const parent = tree([{ id: 2, from: 5, to: 10 }]);
    const pieces = piecesOf(parent, [ref(1, "A", 0, 20), ref(2, "B", 5, 10)], 1);
    expect(pieces.map((p) => [p.node.instanceId, p.sessionId])).toEqual([
      [1, "A"],
      [2, "B"],
    ]);
  });

  it("flattens the whole subtree, so a grandchild lands in the session it continued", () => {
    const parent = node({
      instanceId: 1,
      stateId: "plan",
      children: [
        node({
          instanceId: 2,
          stateId: "plan/mid",
          startedAt: 0,
          endedAt: 30,
          children: [node({ instanceId: 3, stateId: "plan/mid/leaf", startedAt: 5, endedAt: 25 })],
        }),
      ],
    });
    const pieces = piecesOf(parent, [ref(3, "A", 5, 25)], 1);
    expect(pieces.map((p) => p.node.instanceId)).toEqual([3]);
  });

  it("keeps a leaf that ran no model call — it happened, and a function op has no session", () => {
    const parent = tree([{ id: 2, from: 0, to: 10 }]);
    const [piece] = piecesOf(parent, [], 1);
    expect(piece?.node.instanceId).toBe(2);
    expect(piece?.sessionId).toBeUndefined();
  });

  it("joins on the RUN and the instance, never the instance alone", () => {
    // Instance ids restart every run, so `#2` names a different state in each. Joining on it alone
    // hung an older run's conversation off this run's node — a panel drawn with someone else's words
    // in it, and nothing on screen to say so.
    const parent = tree([{ id: 2, from: 0, to: 10 }]);
    const older = { ...ref(2, "OLD", 0, 10), runId: 0 } as SessionRef;
    const mine = piecesOf(parent, [older, ref(2, "A", 0, 10)], 1).filter((p) => p.node.runId === undefined);
    expect(mine.map((p) => p.sessionId)).toEqual(["A"]);
  });

  it("draws the older run's call as its OWN piece rather than hiding it", () => {
    // The conversation is the TASK's. A run scoped away was the reason a resumed task's replayed
    // states came out as panels reading "this state ran no model call" — and it is why a run-scale
    // fork used to have sides with nothing under them.
    const parent = tree([{ id: 2, from: 0, to: 10 }]);
    const older = { ...ref(2, "OLD", 0, 10), runId: 0 } as SessionRef;
    const pieces = piecesOf(parent, [older, ref(2, "A", 0, 10)], 1);
    expect(pieces.map((p) => p.sessionId).sort()).toEqual(["A", "OLD"]);
    // …and it is the older RUN's, not a second reading of this one's node.
    expect(pieces.find((p) => p.sessionId === "OLD")?.node.runId).toBe(0);
  });

  it("keeps a pass a sequence reset superseded — the branch still happened", () => {
    // These used to be dropped, and the loop is where that hurt: re-entering a child key supersedes
    // the previous instance under it, so looping back to `explore` deleted the entire previous
    // iteration from the transcript — panels that had been read, and the answers the next pass is a
    // response to. `superseded` governs expression resolution, not history; the projection keeps the
    // history in as many words, and every other reader already shows it.
    const parent = node({
      instanceId: 1,
      stateId: "plan",
      children: [
        node({ instanceId: 2, stateId: "s2", startedAt: 0, endedAt: 10, superseded: true }),
        node({ instanceId: 3, stateId: "s3", startedAt: 11, endedAt: 20 }),
      ],
    });
    const pieces = piecesOf(parent, [ref(2, "A", 0, 10), ref(3, "A", 11, 20)], 1);
    // In time order, so the superseded pass reads as the earlier one it is.
    expect(pieces.map((p) => p.node.instanceId)).toEqual([2, 3]);
  });

  it("keeps the whole subtree under a superseded pass, not only its root", () => {
    // The walk used to stop descending, so a superseded COMPOSITE took every conversation beneath it
    // off the page — which is exactly the shape a loop over a module produces.
    const parent = node({
      instanceId: 1,
      stateId: "plan",
      children: [
        node({
          instanceId: 2,
          stateId: "explore",
          startedAt: 0,
          endedAt: 10,
          superseded: true,
          children: [node({ instanceId: 4, stateId: "explore/brief", startedAt: 1, endedAt: 9 })],
        }),
        node({ instanceId: 3, stateId: "explore", startedAt: 11, endedAt: 20 }),
      ],
    });
    const pieces = piecesOf(parent, [ref(4, "A", 1, 9), ref(3, "B", 11, 20)], 1);
    expect(pieces.map((p) => p.node.instanceId)).toEqual([4, 3]);
  });

  it("prefers the operation's start over the instance's — they differ by a whole subtree", () => {
    const parent = tree([{ id: 2, from: 0, to: 100 }]);
    const [piece] = piecesOf(parent, [ref(2, "A", 90, 100)], 1);
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
    const bands = bandsOf(piecesOf(parent, [ref(2, "A", 0, 10), ref(3, "A", 11, 20), ref(4, "A", 21, 30)], 1));
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
    const bands = bandsOf(piecesOf(parent, [ref(2, "A", 0, 10), ref(3, "B", 11, 20), ref(4, "A", 21, 30)], 1));
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
    const bands = bandsOf(piecesOf(parent, [ref(2, "A", 0, 20), ref(3, "B", 5, 25)], 1));
    expect(shape(bands)).toEqual([
      [
        ["A", 1],
        ["B", 1],
      ],
    ]);
  });

  it("does not call a concurrent session paused — it never stopped", () => {
    const parent = tree([
      { id: 2, from: 0, to: 30 },
      { id: 3, from: 5, to: 10 },
    ]);
    const bands = bandsOf(piecesOf(parent, [ref(2, "A", 0, 30), ref(3, "B", 5, 10)], 1));
    expect(bands).toHaveLength(1);
    expect(bands[0]!.segments.every((s) => !s.paused && !s.resumed)).toBe(true);
  });

  it("treats a handoff at the same millisecond as sequential, not concurrent", () => {
    const parent = tree([
      { id: 2, from: 0, to: 10 },
      { id: 3, from: 10, to: 20 },
    ]);
    const bands = bandsOf(piecesOf(parent, [ref(2, "A", 0, 10), ref(3, "B", 10, 20)], 1));
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
        1,
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
    const bands = bandsOf(piecesOf(parent, [ref(3, "B", 11, 20)], 1));
    expect(bands.flatMap((b) => b.segments).every((s) => !s.paused && !s.resumed)).toBe(true);
    expect(shape(bands)).toEqual([[["#2", 1]], [["B", 1]], [["#4", 1]]]);
  });

  it("lets a call still running overlap whatever starts after it", () => {
    const parent = node({
      instanceId: 1,
      stateId: "plan",
      children: [
        node({ instanceId: 2, stateId: "s2", startedAt: 0, status: "running" }),
        node({ instanceId: 3, stateId: "s3", startedAt: 5, endedAt: 9 }),
      ],
    });
    const bands = bandsOf(piecesOf(parent, [ref(3, "B", 5, 9)], 1));
    expect(bands).toHaveLength(1);
    expect(bands[0]!.segments).toHaveLength(2);
  });
});

describe("instancesOf", () => {
  it("names every transcript the panels will need, once each", () => {
    const parent = tree([
      { id: 2, from: 0, to: 10 },
      { id: 3, from: 11, to: 20 },
    ]);
    const bands = bandsOf(piecesOf(parent, [ref(2, "A", 0, 10), ref(3, "A", 11, 20)], 1));
    // By RUN and instance, because that is what a transcript is fetched under: an id minted per walk
    // names a different state in every run, and asking for it alone brings back whichever run wrote
    // it last. A single-run tree stamps no run, and then the id alone is the whole key.
    expect(instancesOf(bands).map((one) => one.instanceId).sort()).toEqual([2, 3]);
    expect(instancesOf(bands).every((one) => one.runId === undefined)).toBe(true);
  });

  it("counts a folded task's runs apart, so two runs of one instance are two transcripts", () => {
    const parent = tree([{ id: 2, from: 0, to: 10 }]);
    const older = { ...ref(2, "OLD", 0, 10), runId: 0 } as SessionRef;
    const needed = instancesOf(bandsOf(piecesOf(parent, [older, ref(2, "A", 0, 10)], 1)));
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
    bandsOf(piecesOf(tree(kids), refs, 1));

  it("keeps the failure of a state that never opened a conversation", () => {
    const notes = notesOf([
      turn({ seq: 1, kind: "blocked", stateId: "plan/draft", path: "draft", text: "plan/draft: input 'framing' is not wired", ok: false }),
      turn({ seq: 2, kind: "terminated", instanceId: 1, stateId: "plan", path: "", text: "child 'draft' terminated with error", ok: false }),
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
      instanceId: 2,
      stateId: "s2",
      operation: { kind: "prompt", status: "failed", reason: "the call failed" },
    });
    const notes = notesOf(
      [turn({ seq: 1, kind: "failure", instanceId: 2, stateId: "s2", path: "a", text: "the call failed", ok: false })],
      node({ instanceId: 1, stateId: "plan", children: [ran] }),
    );
    expect(notes).toEqual([]);
  });

  it("keeps a failure whose instance ran nothing — there is no panel and there never will be", () => {
    // A composite giving up because a child did. It has children and no operation of its own, so the
    // grey is the only account of it there can be.
    const notes = notesOf(
      [turn({ seq: 1, kind: "terminated", instanceId: 1, stateId: "plan", path: "", text: "child 'draft' failed", ok: false })],
      node({ instanceId: 1, stateId: "plan", children: [node({ instanceId: 2, stateId: "s2" })] }),
    );
    expect(notes.map((n) => [n.kind, n.text])).toEqual([["failure", "child 'draft' failed"]]);
  });

  it("keeps a BLOCKED child whatever the tree says, because it names no instance at all", () => {
    // The absence of an instance id is the fact rather than a sentinel: blocked means it never
    // became one, so there is nothing to look up and nothing that could claim it.
    const notes = notesOf(
      [turn({ seq: 1, kind: "blocked", stateId: "plan/draft", path: "draft", text: "not wired", ok: false })],
      node({ instanceId: 1, stateId: "plan", operation: { kind: "prompt", status: "completed" } }),
    );
    expect(notes.map((n) => [n.kind, n.text])).toEqual([["blocked", "not wired"]]);
  });

  it("claims nothing when there is no tree to ask", () => {
    // A projection that has not landed yet. Hiding a run's only error while the panel that would
    // have shown it does not exist either is the one failure mode worth refusing.
    const notes = notesOf([turn({ seq: 1, kind: "failure", instanceId: 2, stateId: "s2", path: "a", text: "boom", ok: false })]);
    expect(notes.map((n) => n.text)).toEqual(["boom"]);
  });

  it("draws a state being ENTERED as a step in the path", () => {
    // The case that makes this worth having: a sequence walking down its spine takes no transitions
    // at all, so a canvas drawn from `transition.taken` alone would be blank for the run somebody
    // opens to ask how far it got.
    const notes = notesOf([turn({ seq: 1, kind: "entered", instanceId: 2, stateId: "feature/product", path: "product" })]);
    // The INSTANCE travels with it, which is what the rail keys a lane on: `explore` running twice is
    // two lanes with one colour, and a lane keyed on the state would draw the second pass as a
    // continuation of the first.
    expect(notes).toEqual([
      { seq: 1, at: 10, kind: "entered", stateId: "feature/product", instanceId: 2, path: "product", text: "" },
    ]);
  });

  it("does not draw the ROOT entering itself — everything in the run is inside it", () => {
    const notes = notesOf([
      turn({ seq: 1, kind: "entered", instanceId: 1, stateId: "feature", path: "" }),
      turn({ seq: 2, kind: "entered", instanceId: 2, stateId: "feature/product", path: "product" }),
    ]);
    expect(notes.map((n) => n.path)).toEqual(["product"]);
  });

  it("does not read a call, or a termination, as a state being entered", () => {
    // These three were ONE kind, told apart by matching `text` against the literal "entered" and by
    // whether `ok` was present. They are three kinds now, so the question is answered by the type
    // rather than by a string — and a state whose label happens to be "entered" can no longer be
    // mistaken for the machine walking into it.
    const notes = notesOf([
      turn({ seq: 1, kind: "started", instanceId: 2, stateId: "plan/draft", path: "draft", text: "prompt" }),
      turn({ seq: 2, kind: "terminated", instanceId: 2, stateId: "plan/draft", path: "draft", text: "entered", ok: true }),
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
      turn({ seq: 2, kind: "terminated", instanceId: 1, stateId: "plan", path: "", text: "success", ok: true }),
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
      turn({ seq: 1, kind: "terminated", instanceId: 1, stateId: "plan", path: "", text: "success", ok: true }),
      turn({ seq: 2, kind: "output", instanceId: 1, stateId: "plan", path: "", ok: true }),
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
  const node = (instanceId: number, childKey: string | undefined, children: InstanceNode[] = []): InstanceNode =>
    ({
      instanceId,
      stateId: `s${instanceId}`,
      status: "completed",
      iteration: 0,
      superseded: false,
      startedAt: 0,
      children,
      ...(childKey !== undefined ? { childKey } : {}),
    }) as InstanceNode;

  const forest = [node(1, undefined, [node(2, "product", [node(3, "context"), node(4, "explore")])])];

  it("is the chain of CHILD KEYS from the root", () => {
    expect(mountPathOf(forest, 4)).toBe("product/explore");
  });

  it("is empty for the root — which is how the view spells you are looking at it", () => {
    expect(mountPathOf(forest, 1)).toBe("");
  });

  it("is empty for an instance the tree does not have", () => {
    expect(mountPathOf(forest, 99)).toBe("");
  });
});

describe("placeNotes", () => {
  it("puts each note above the band it precedes, and the rest at the end", () => {
    const bands = bandsOf(piecesOf(tree([
      { id: 2, from: 10, to: 20 },
      { id: 3, from: 30, to: 40 },
    ]), [ref(2, "A", 10, 20), ref(3, "B", 30, 40)], 1));
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
    const bands = bandsOf(piecesOf(tree([{ id: 2, from: 1_787_686_049_384, to: 1_787_686_062_189 }]), [ref(2, "A", 1_787_686_049_384, 1_787_686_062_189)], 1));
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
    const bands = bandsOf(piecesOf(parent, [ref(2, "A", 0, 10), ref(3, "B", 11, 20), ref(4, "A", 21, 30)], 1));
    expect(startersOf(bands).get("A")?.node.instanceId).toBe(2);
    expect(startersOf(bands).get("B")?.node.instanceId).toBe(3);
  });
});

describe("forksOf", () => {
  /** A retried state: the attempt that claimed the position, and the branch that had to leave it. */
  const retried = (): SessionRef[] => [
    { runId: 1, instanceId: 2, stateId: "implement", sessionId: "default", seq: 6, startedAt: 10, at: 20, status: "error" },
    {
      runId: 1,
      instanceId: 3,
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
        1,
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
        1,
      ),
    );
    // The attempt that failed is attempt one however the pieces happened to be walked.
    expect(forks.get("default@6")?.map((side) => side.sessionId)).toEqual(["default", "b7c1e4"]);
  });

  it("reports nothing where only one side is on the page", () => {
    // A branch whose parent's record is not drawn cannot offer the side it came from, and a mark
    // reading "1 of 1" would claim a division over something that never divided.
    const [, branch] = retried();
    expect(forksOf(piecesOf(tree([{ id: 3, from: 30, to: 40 }]), [branch!], 1)).size).toBe(0);
  });

  it("says nothing about a run that never forked, which is nearly all of them", () => {
    const bands = bandsOf(piecesOf(tree([{ id: 2, from: 0, to: 10 }]), [ref(2, "A", 0, 10)], 1));
    expect(forksOf(bands.flatMap((band) => band.segments.flatMap((segment) => segment.pieces))).size).toBe(0);
  });
});

describe("runForksOf", () => {
  /** One state, run by two runs — a retry, which is what every restart of a failed task is. */
  const twice = (): SessionPiece[] => {
    const at = [{ childKey: "implement", occurrence: 0 }];
    const make = (runId: number, startedAt: number): SessionPiece => ({
      node: {
        instanceId: 3,
        stateId: "implement",
        childKey: "implement",
        status: "completed",
        iteration: 0,
        superseded: false,
        startedAt,
        runId,
        address: at,
        children: [],
      },
      sessionId: `s${runId}`,
      seq: 0,
      startedAt,
    });
    return [make(1, 0), make(2, 10)];
  };

  it("makes a mark of the runs that did their own work at one address", () => {
    // Not of runs that share a fork POINT: run 1 started at the root and run 2 resumed into
    // `implement`, and they are still the two sides of one division — the one at `implement`.
    const forks = runForksOf(twice());
    expect(forks).toHaveLength(1);
    expect(forks[0]!.at).toEqual([{ childKey: "implement", occurrence: 0 }]);
    expect(forks[0]!.sides.map((s) => s.runId)).toEqual([1, 2]);
  });

  it("says nothing about an address only one run ran", () => {
    // Which is nearly every address in nearly every task. A mark over one side would be furniture
    // claiming a choice nobody has.
    expect(runForksOf(twice().slice(0, 1))).toEqual([]);
  });

  it("leaves a run that REPLAYED an address out of its sides", () => {
    // A replayed operation dispatches nothing and so has no piece — correctly, because a side of a
    // mark has to be a side you can read, and that run produced nothing here to choose.
    const forks = runForksOf(twice());
    expect(forks[0]!.sides.some((s) => s.runId === 3)).toBe(false);
  });

  it("orders the sides by when they ran, so the count reads as the attempt number", () => {
    const forks = runForksOf([...twice()].reverse());
    expect(forks[0]!.sides.map((s) => s.runId)).toEqual([1, 2]);
  });
});

describe("where a run-scale mark goes", () => {
  /** Two states on ONE conversation — `environment.session` — one of them run twice. */
  const shared = (): SessionPiece[] => {
    const make = (stateId: string, runId: number, startedAt: number, seq: number): SessionPiece => ({
      node: {
        instanceId: seq + 2,
        stateId,
        childKey: stateId,
        status: "completed",
        iteration: 0,
        superseded: false,
        startedAt,
        runId,
        address: [{ childKey: stateId, occurrence: 0 }],
        children: [],
      },
      sessionId: "thread",
      seq,
      startedAt,
      endedAt: startedAt + 1,
    });
    return [make("plan", 1, 0, 0), make("implement", 1, 2, 1), make("implement", 2, 4, 1)];
  };

  it("keeps a fork that DIVIDES a panel out of the gap above it", () => {
    // The gap above the sheet would put `plan` below the line — and `plan` is work both runs share.
    // The one thing the mark claims is that everything above it is common to both sides.
    const bands = bandsOf(shared());
    const forks = runForksOf(bands.flatMap((b) => b.segments.flatMap((s) => s.pieces)));
    expect(forks).toHaveLength(1);
    expect(placeRunForks(forks, bands).every((bucket) => bucket.length === 0)).toBe(true);
  });

  it("hands it to the panel instead, keyed on the card it opens", () => {
    const bands = bandsOf(shared());
    const pieces = bands.flatMap((b) => b.segments.flatMap((s) => s.pieces));
    const forks = runForksOf(pieces);
    const at = runForkAt(forks);
    // The FIRST attempt's card is where the division starts — not `plan`, which is above it.
    expect(at.get(pieces.find((p) => p.node.stateId === "implement")!)).toBe(forks[0]);
    expect(at.get(pieces.find((p) => p.node.stateId === "plan")!)).toBeUndefined();
  });

  it("still uses the gap when the divided work opens a panel of its own", () => {
    // The ordinary case: states get their own conversation, so the divergence starts a new sheet and
    // the mark belongs on the grey in front of it.
    const own = shared().map((piece) =>
      piece.node.stateId === "plan" ? piece : { ...piece, sessionId: "second", seq: 0 },
    );
    const bands = bandsOf(own);
    const forks = runForksOf(bands.flatMap((b) => b.segments.flatMap((s) => s.pieces)));
    expect(placeRunForks(forks, bands).flat()).toHaveLength(1);
  });
});
