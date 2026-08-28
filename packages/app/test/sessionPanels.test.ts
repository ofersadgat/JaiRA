/**
 * What the session panels actually DRAW.
 *
 * `sessionBands.test.ts` covers the model — which sessions band together, and where a conversation
 * was cut. This covers the half that only exists on screen: that a cut is rendered as a torn edge
 * naming the session on BOTH sides, that a lone conversation gets no layout control it could only be
 * wrong about, and that a band of two lays out as columns while a band of three falls back to tabs.
 *
 * Rendered to static markup rather than through a DOM harness. The claims here are structural — what
 * is on the page and what it says — and that is exactly what a server render answers, without the
 * repo taking on jsdom and a testing library to ask it.
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { InstanceNode, SessionRef } from "@jaira/shared/browser";
import { bandsOf, piecesOf, type BandNote, type SessionPiece } from "../src/renderer/sessionBands";
import { SessionBandsView, ZigDefs } from "../src/renderer/sessionPanels";

const node = (patch: Partial<InstanceNode> & Pick<InstanceNode, "instanceId" | "stateId">): InstanceNode => ({
  status: "completed",
  index: 0,
  superseded: false,
  startedAt: 0,
  children: [],
  ...patch,
});

const ref = (instanceId: number, sessionId: string, startedAt: number, at: number): SessionRef =>
  ({ runId: 1, instanceId, stateId: `s${instanceId}`, sessionId, seq: 0, startedAt, at }) as SessionRef;

/**
 * A composite over leaves that each ran a PROMPT.
 *
 * The operation is on the fixture rather than left off, because it is what makes these children
 * conversations: a leaf with no operation is a state that computed its outputs and never spoke, and
 * `Sheet` gives that one a surface instead of a panel (see `stateSurface.tsx`). Every test in this
 * file is about the panel, so every child in it has to be something that could have one.
 */
const parentOf = (kids: Array<{ id: number; from: number; to: number }>): InstanceNode =>
  node({
    instanceId: 1,
    stateId: "plan",
    children: kids.map((kid) =>
      node({
        instanceId: kid.id,
        stateId: `s${kid.id}`,
        childKey: `k${kid.id}`,
        startedAt: kid.from,
        endedAt: kid.to,
        operation: { kind: "prompt", status: "completed" },
      }),
    ),
  });

/** The markup for a run, with each state's transcript stubbed to a recognisable line. */
const draw = (parent: InstanceNode, refs: SessionRef[]): string =>
  renderToStaticMarkup(
    createElement(SessionBandsView, {
      bands: bandsOf(piecesOf(parent, refs, 1)),
      render: (piece) => createElement("p", null, `said by #${piece.node.instanceId}`),
    }),
  );

describe("what a conversation draws", () => {
  it("gives each session its own sheet, and every state's words a place in one", () => {
    const html = draw(parentOf([
      { id: 2, from: 0, to: 10 },
      { id: 3, from: 11, to: 20 },
    ]), [ref(2, "planning", 0, 10), ref(3, "review", 11, 20)]);
    expect(html.match(/sb-sheet/g)).toHaveLength(2);
    expect(html).toContain("said by #2");
    expect(html).toContain("said by #3");
  });

  it("names a conversation in the grey above it, not in a bar across the top of it", () => {
    const html = draw(parentOf([{ id: 2, from: 0, to: 10 }]), [ref(2, "planning", 0, 10)]);
    // The name is outside the sheet, so it comes BEFORE the border it labels.
    expect(html.indexOf("planning")).toBeLessThan(html.indexOf("sb-sheet"));
    expect(html).toContain("sb-gutter");
    // Nothing counts the states for you — the cards below are the count.
    expect(html).not.toMatch(/\d+ states?</);
  });

  it("names the interruption on both sides of it", () => {
    const html = draw(parentOf([
      { id: 2, from: 0, to: 10 },
      { id: 3, from: 11, to: 20 },
      { id: 4, from: 21, to: 30 },
    ]), [ref(2, "planning", 0, 10), ref(3, "review", 11, 20), ref(4, "planning", 21, 30)]);
    // Named on both edges, because the two halves have to be findable from each other — a bar
    // reading only "paused" leaves you counting panels to work out which thread came back.
    expect(html).toContain('paused session <span class="mono">planning</span>');
    expect(html).toContain('resumed session <span class="mono">planning</span>');
    // The session that ran in the gap is a whole panel, not an edge.
    expect(html).not.toContain("session <span class=\"mono\">review</span>");
    // Cut edges are squared, so the halves read as halves — see `.sb-sheet.paused`.
    expect(html).toContain("sb-sheet paused");
    expect(html).toContain("sb-sheet resumed");
  });

  it("draws no bar at all when nothing interrupted the conversation", () => {
    const html = draw(parentOf([
      { id: 2, from: 0, to: 10 },
      { id: 3, from: 11, to: 20 },
    ]), [ref(2, "planning", 0, 10), ref(3, "planning", 11, 20)]);
    expect(html).not.toContain("sb-tear");
    expect(html.match(/sb-sheet/g)).toHaveLength(1);
  });

  /**
   * Walking into a leaf shows what it SAID, not a card containing what it said.
   *
   * The card is a boundary marker, and a view with one operation in it has no boundary to mark — so
   * the fold, the status dot and the call signature were chrome around the only thing on the page,
   * and read as a child state rather than as the run being looked at.
   */
  it("drops the run card when the whole view is one operation, and keeps it when there are two", () => {
    const alone = draw(parentOf([{ id: 2, from: 0, to: 10 }]), [ref(2, "planning", 0, 10)]);
    expect(alone).not.toContain("ts-card");
    expect(alone).toContain("said by #2");
    // The gutter stays: which conversation this is remains a fact worth having.
    expect(alone).toContain("planning");

    const two = draw(parentOf([
      { id: 2, from: 0, to: 10 },
      { id: 3, from: 11, to: 20 },
    ]), [ref(2, "planning", 0, 10), ref(3, "planning", 11, 20)]);
    expect(two.match(/class="lh"/g)).toHaveLength(2);
  });

  it("offers no layout control over a band with one conversation in it", () => {
    const html = draw(parentOf([{ id: 2, from: 0, to: 10 }]), [ref(2, "planning", 0, 10)]);
    expect(html).not.toContain("sb-layout");
  });

  it("lays two concurrent sessions out side by side, both named and both visible", () => {
    const html = draw(parentOf([
      { id: 2, from: 0, to: 20 },
      { id: 3, from: 5, to: 25 },
    ]), [ref(2, "planning", 0, 20), ref(3, "review", 5, 25)]);
    expect(html).toContain("sb-columns");
    expect(html).toContain("said by #2");
    expect(html).toContain("said by #3");
    // Each column carries its own name, since one gutter above the band could only label one of them.
    expect(html.match(/sb-gutter/g)).toHaveLength(2);
    expect(html).toContain("planning");
    expect(html).toContain("review");
  });

  it("falls back to tabs at three, showing one and filing the rest", () => {
    const html = draw(parentOf([
      { id: 2, from: 0, to: 30 },
      { id: 3, from: 5, to: 25 },
      { id: 4, from: 8, to: 22 },
    ]), [ref(2, "a", 0, 30), ref(3, "b", 5, 25), ref(4, "c", 8, 22)]);
    expect(html).toContain("sb-tabs");
    expect(html).not.toContain("sb-columns");
    expect(html).toContain("said by #2");
    expect(html).not.toContain("said by #3");
    // The tab already names the panel under it; a gutter repeating it would say nothing.
    expect(html).not.toContain("sb-gutter");
  });

  it("says so rather than going blank when a call has not written its position yet", () => {
    // A prompt that is in flight, or one whose position never landed. It IS a conversation — it just
    // has no id yet — so it keeps the panel and the gutter says what is missing.
    const html = draw(parentOf([{ id: 2, from: 0, to: 10 }]), []);
    expect(html).toContain("no conversation");
    expect(html).toContain("sb-sheet");
    expect(html).toContain("said by #2");
    expect(html).not.toContain("sb-tear");
  });

  /**
   * A state that was never going to speak keeps its letterhead and loses its gutter.
   *
   * The two halves of one rule. "One state means no letterhead" holds because the gutter above it is
   * already saying the same three things; a surface has no session to be named or timed by, so the
   * gutter would be saying nothing — and the letterhead is the only header it can have.
   */
  it("gives a surface a letterhead and no gutter", () => {
    const parent = node({
      instanceId: 1,
      stateId: "plan",
      children: [node({ instanceId: 2, stateId: "confidence", childKey: "confidence", startedAt: 0, endedAt: 5 })],
    });
    const html = draw(parent, []);
    expect(html).toContain("said by #2");
    expect(html).toContain('class="lh-kind">computed<');
    expect(html).not.toContain("sb-gutter");
    // Least obvious and most important: the old sentence is gone rather than relocated. The kind word
    // says what the state IS, and "no conversation" beside it would answer a question nobody asked of
    // a state that never had one — and then repeat its timing as if it were a session's.
    expect(html).not.toContain("no conversation");
  });

  it("drops the letterhead when a conversation is alone in its sheet", () => {
    // The gutter names the session, names the state that opened it, and times it. A letterhead under
    // that is the same three facts a second time.
    const html = draw(parentOf([{ id: 2, from: 0, to: 10 }]), [ref(2, "planning", 0, 10)]);
    expect(html).toContain("said by #2");
    expect(html).toContain("sb-gutter solo");
    expect(html).not.toContain('class="lh"');
  });

  it("keeps a letterhead per state once a session holds more than one", () => {
    const html = draw(parentOf([{ id: 2, from: 0, to: 10 }, { id: 3, from: 11, to: 20 }]), [
      ref(2, "planning", 0, 10),
      ref(3, "planning", 11, 20),
    ]);
    expect(html.match(/class="lh"/g)).toHaveLength(2);
    expect(html).not.toContain("sb-gutter solo");
  });

  it("times the SESSION in the gutter — the envelope of its states, not the sum of them", () => {
    // A conversation interrupted and resumed spent the gap doing nothing. Summing the two calls
    // would report 2 ms of talking across a span of twenty.
    const html = draw(parentOf([{ id: 2, from: 0, to: 1 }, { id: 3, from: 19, to: 20 }]), [
      ref(2, "planning", 0, 1),
      ref(3, "planning", 19, 20),
    ]);
    expect(html).toContain('class="sb-span">');
    expect(html).toContain("20 ms");
  });

  it("offers collapse-all only where there are letterheads to fold", () => {
    // On a solo panel the gutter's own chevron is already the control, and on a surface there is no
    // gutter at all — so a button in either place would be a second way to do one thing.
    const many = draw(parentOf([{ id: 2, from: 0, to: 10 }, { id: 3, from: 11, to: 20 }]), [
      ref(2, "planning", 0, 10),
      ref(3, "planning", 11, 20),
    ]);
    expect(many).toContain("sb-foldall");
    const one = draw(parentOf([{ id: 2, from: 0, to: 10 }]), [ref(2, "planning", 0, 10)]);
    expect(one).not.toContain("sb-foldall");
  });

  it("keeps the sheet when a session-less piece shares its panel with a conversation", () => {
    // The guard `Sheet` makes: a surface replaces a panel only when it IS the panel. A segment with
    // two pieces in it is a shared conversation, and it keeps its sheet whatever the first piece is.
    const parent = parentOf([{ id: 2, from: 0, to: 10 }, { id: 3, from: 11, to: 20 }]);
    const html = draw(parent, [ref(2, "planning", 0, 10), ref(3, "planning", 11, 20)]);
    expect(html).toContain("sb-sheet");
    expect(html).toContain("said by #2");
    expect(html).toContain("said by #3");
  });

  it("shows a composite that only orchestrates its children, and nothing of its own", () => {
    const parent = parentOf([
      { id: 2, from: 0, to: 10 },
      { id: 3, from: 11, to: 20 },
    ]);
    const html = draw(parent, [ref(2, "planning", 0, 10), ref(3, "planning", 11, 20)]);
    expect(html).not.toContain("said by #1");
  });
});

/**
 * The errors that belong to no conversation, and the way out to the workflow behind one.
 *
 * Both are about the GREY between the sheets. A failure in a state that never opened a session has
 * no panel to be a line of, and the session id a panel is named by says nothing about what the
 * conversation is — so the background carries the one and the gutter carries the other.
 */
/** A note. `kind` defaults to `failure`, which is what most of these are about. */
const note = (patch: Partial<BandNote> & Pick<BandNote, "seq" | "at" | "text">): BandNote => ({ kind: "failure", path: "", ...patch });

const drawWith = (
  parent: InstanceNode | undefined,
  refs: SessionRef[],
  extra: { notes?: BandNote[]; root?: string; onOpenWorkflow?: (piece: SessionPiece) => void },
): string =>
  renderToStaticMarkup(
    createElement(SessionBandsView, {
      bands: bandsOf(piecesOf(parent, refs, 1)),
      render: (piece) => createElement("p", null, `said by #${piece.node.instanceId}`),
      ...extra,
    }),
  );

describe("a failure with no panel to appear in", () => {
  it("writes it on the background, between the conversations, where it happened", () => {
    const html = drawWith(
      parentOf([
        { id: 2, from: 10, to: 20 },
        { id: 3, from: 30, to: 40 },
      ]),
      [ref(2, "planning", 10, 20), ref(3, "review", 30, 40)],
      { notes: [note({ seq: 1, at: 25, stateId: "plan/draft", text: "input 'framing' is not wired" })] },
    );
    expect(html).toContain("sb-note");
    expect(html).toContain("input &#x27;framing&#x27; is not wired");
    // Between the two sheets, not inside either: the state it names never said a word.
    const [first, second] = [html.indexOf("said by #2"), html.indexOf("said by #3")];
    const at = html.indexOf("sb-note");
    expect(at).toBeGreaterThan(first);
    expect(at).toBeLessThan(second);
  });

  it("is the whole answer when a run failed before it opened any conversation at all", () => {
    // The case that read as "nothing happened yet": nothing ever became an instance, so there is no
    // band to hang anything on — and the reason is the only thing there is to show.
    const html = drawWith(undefined, [], {
      notes: [note({ seq: 1, at: 5, stateId: "plan", text: "child 'draft' terminated with error" })],
    });
    expect(html).toContain("sb-note");
    expect(html).not.toContain("has not said anything yet");
  });

  it("still says nothing happened when nothing did", () => {
    expect(drawWith(undefined, [], {})).toContain("has not said anything yet");
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
  const step = (patch: Partial<BandNote> & Pick<BandNote, "seq" | "at" | "text">): BandNote => ({
    ...note(patch),
    kind: "transition",
  });

  it("writes the mount path, one arrow per step further in", () => {
    const html = drawWith(undefined, [], {
      notes: [step({ seq: 1, at: 5, stateId: "explore", path: "product/explore", text: "explore" })],
    });
    // The MOUNT, not the state file. `explore` is one definition mounted under all six phases, and
    // its id alone does not say which of them is running it.
    expect(html).toContain("product → explore");
    expect(html).toContain("entered");
  });

  it("trims the module already being looked at", () => {
    const html = drawWith(undefined, [], {
      notes: [step({ seq: 1, at: 5, path: "product/explore", text: "explore" })],
      root: "product",
    });
    expect(html).toContain("explore");
    expect(html).not.toContain("product → explore");
  });

  it("says a block is a state that could NOT be entered, not a bare reason beside a name", () => {
    const html = drawWith(undefined, [], {
      notes: [
        note({ seq: 1, at: 5, kind: "blocked", path: "product/explore", text: "input 'prior_findings': child 'critique' has not run" }),
      ],
    });
    expect(html).toContain("could not enter");
    expect(html).toContain("product → explore");
  });

  it("is not drawn as a failure — no alert, and not the failure colour", () => {
    const moved = drawWith(undefined, [], { notes: [step({ seq: 1, at: 5, path: "draft", text: "draft" })] });
    const broke = drawWith(undefined, [], { notes: [note({ seq: 1, at: 5, path: "draft", text: "blocked" })] });
    expect(moved).toContain("sb-note step");
    expect(broke).toContain('class="sb-note"');
    expect(broke).not.toContain("sb-note step");
  });

  it("fills the canvas that used to say a run had not entered a child yet", () => {
    const html = drawWith(undefined, [], {
      notes: [
        note({ seq: 1, at: 5, kind: "entered", path: "product", text: "" }),
        step({ seq: 2, at: 6, path: "product/context", text: "context" }),
      ],
    });
    expect(html).not.toContain("has not said anything yet");
    expect(html.indexOf("product")).toBeLessThan(html.indexOf("context"));
  });
});

describe("the workflow behind a conversation", () => {
  it("names the state that OPENED the session beside its id, as somewhere to go", () => {
    const html = drawWith(parentOf([{ id: 2, from: 0, to: 10 }]), [ref(2, "planning", 0, 10)], {
      onOpenWorkflow: () => undefined,
    });
    expect(html).toContain("sb-workflow");
    expect(html).toContain("planning");
    expect(html).toContain("s2");
  });

  it("offers no link where the host has no panel to describe one in", () => {
    const html = drawWith(parentOf([{ id: 2, from: 0, to: 10 }]), [ref(2, "planning", 0, 10)], {});
    expect(html).not.toContain("sb-workflow");
  });
});

describe("a panel that is one side of a fork", () => {
  /** A retried state: the attempt that took the position, and the branch that had to leave it. */
  const RETRY: SessionRef[] = [
    { runId: 1, instanceId: 2, stateId: "implement", sessionId: "default", seq: 6, startedAt: 0, at: 10, status: "error" },
    {
      runId: 1,
      instanceId: 3,
      stateId: "implement",
      sessionId: "b7c1e4",
      seq: 6,
      startedAt: 11,
      at: 20,
      status: "success",
      branch: { parent: "default", at: 6 },
    },
  ];
  const html = (): string =>
    draw(
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
    expect(html()).toContain("fork-chip");
    expect(html()).toContain("fork:");
  });

  it("marks BOTH sides, and counts each as the one it is", () => {
    // A fork is a fact about the division, not about the branch: the attempt that was left behind is
    // as much a side of it as the one that replaced it, and it is the side a reader is most likely
    // to arrive at first.
    expect(html()).toContain("1 of 2");
    expect(html()).toContain("2 of 2");
  });

  it("tears nothing, because nothing here was cut in two", () => {
    // Two attempts are two conversations, not one conversation divided — so the panel carries the
    // chip alone. A torn edge would claim a continuity between the sheets that does not exist.
    const marks = html().match(/fork-mark/g) ?? [];
    expect(marks).toHaveLength(2);
    expect(html()).not.toContain("fork-torn");
  });

  it("leaves an ordinary run unmarked", () => {
    // Nothing is paid for until a conversation actually divides, on screen as in the record.
    expect(draw(parentOf([{ id: 2, from: 0, to: 10 }]), [ref(2, "planning", 0, 10)])).not.toContain("fork-chip");
  });
});

describe("the zigzag tile", () => {
  it("takes its colour from the stylesheet, not from whoever references it", () => {
    // The bug this guards: the stroke was `var(--zig)`, a property set on `.sb-tear` — and a paint
    // server resolves custom properties against its OWN place in the tree, not the referencing
    // element's. This `<defs>` sits outside every element that set it, so the stroke was an
    // unresolved variable, which is to say none: no torn edge in the app had ever drawn its teeth,
    // in the whole time the vocabulary has been the one two views use to mean "cut here".
    expect(renderToStaticMarkup(createElement(ZigDefs))).not.toContain("var(--");
  });
});

/**
 * Folding — remembered, not held by the panel.
 *
 * A fold is a statement about what you are done reading, and navigating away is not a retraction of
 * it. So the set arrives as a prop (`JairaUiState.shut`, under `SHUT.runStates`) and the sheet only
 * decides what to do with it — which is also what makes it testable without a DOM.
 */
describe("what a fold does", () => {
  const twoStates = (shut: ReadonlySet<string>): string =>
    renderToStaticMarkup(
      createElement(SessionBandsView, {
        bands: bandsOf(
          piecesOf(parentOf([{ id: 2, from: 0, to: 10 }, { id: 3, from: 11, to: 20 }]), [
            ref(2, "planning", 0, 10),
            ref(3, "planning", 11, 20),
          ], 1),
        ),
        shut,
        scope: "t-1",
        render: (piece) => createElement("p", null, `said by #${piece.node.instanceId}`),
      }),
    );

  it("opens everything when nothing is remembered", () => {
    const html = twoStates(new Set());
    expect(html).toContain("said by #2");
    expect(html).toContain("said by #3");
    expect(html).not.toContain("lh shut");
  });

  it("hides the body of a folded state and keeps its letterhead", () => {
    // The letterhead has to stay: it is the only thing left to click, and folded it carries the
    // summary of what is behind it. A fold that removed the row would be a delete.
    const html = twoStates(new Set(["t-1::2:0"]));
    expect(html).not.toContain("said by #2");
    expect(html).toContain("said by #3");
    expect(html).toContain("lh shut");
  });

  it("keys a fold by TASK, run and instance, so nothing folds another task's states", () => {
    // Instance ids are minted per run, so `#i2` names a different state in every one of them — and a
    // single-run projection stamps no run at all, which is why the task has to be in the key too.
    expect(twoStates(new Set(["t-2::2:0"]))).toContain("said by #2");
    expect(twoStates(new Set(["t-1:9:2:0"]))).toContain("said by #2");
  });

  it("says `expand all` once every state in the sheet is folded", () => {
    // The control has one meaning — fold what is in this session — so its label is a statement about
    // what pressing it will do rather than about what it is called.
    expect(twoStates(new Set())).toContain('aria-label="Collapse all"');
    expect(twoStates(new Set(["t-1::2:0", "t-1::3:0"]))).toContain('aria-label="Expand all"');
  });
});
