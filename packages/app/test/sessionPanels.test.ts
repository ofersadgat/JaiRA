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
import type { InstanceNode, MadeTask, SessionRef } from "@jaira/shared/browser";
import { bandsOf, piecesOf, sameAddress, type BandNote, type SessionPiece } from "../src/renderer/sessionBands";
import { SessionBandsView, ZigDefs, stepOfNote } from "../src/renderer/sessionPanels";
import { keyOfNode, paletteOfRun } from "../src/renderer/runIndex";

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
 * `Sheet` gives that one a surface instead of a panel (see `stateSurface.tsx`). Every test in this
 * file is about the panel, so every child in it has to be something that could have one.
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

/** The markup for a run, with each state's transcript stubbed to a recognisable line. */
const draw = (parent: InstanceNode, refs: SessionRef[]): string =>
  renderToStaticMarkup(
    createElement(SessionBandsView, {
      bands: bandsOf(piecesOf(parent, refs)),
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
      instanceId: "1",
      stateId: "plan",
      children: [node({ instanceId: "2", stateId: "confidence", childKey: "confidence", startedAt: 0, endedAt: 5 })],
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
      bands: bandsOf(piecesOf(parent, refs)),
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

  it("keeps the link on a SURFACE, which has no gutter to carry it", () => {
    /*
     * A state that ran no conversation gets no gutter — its three facts (the session, the state that
     * opened it, the span) are all about a conversation it does not have. The workflow link is a
     * fourth fact, about the STATE, and the letterhead has no control for it: dropping the row to
     * avoid saying "no conversation" took the only route from a computed state to the file that
     * computed it with it. So the row comes back holding only that.
     */
    const parent = node({
      instanceId: "1",
      stateId: "plan",
      children: [node({ instanceId: "9", stateId: "plan/confidence", childKey: "confidence", startedAt: 0, endedAt: 5 })],
    });
    const html = drawWith(parent, [], { onOpenWorkflow: () => undefined });
    expect(html).toContain("sb-gutter bare");
    expect(html).toContain("plan/confidence");
    // …and none of the conversation facts it does not have.
    expect(html).not.toContain("no conversation");
    expect(html).not.toContain("sb-span");
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
  const scene = (element: number | undefined): string => {
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
    return drawWith(parent, [ref(2, "planning", 0, 10)], {
      notes: [
        note({ seq: 1, at: 0, kind: "entered", path: segment, text: "", instanceId: "2", stateId: "feature/build" }),
        note({ seq: 2, at: 9, kind: "transition", path: `${segment}/next`, text: "next", stateId: "feature/build" }),
      ],
    });
  };
  const turns = (html: string): number => html.split("rail-turn").length - 1;

  it("takes exactly the turns a plain mount takes — no lane closed and reopened around the panel", () => {
    expect(turns(scene(0))).toBe(turns(scene(undefined)));
    expect(scene(0)).toContain("said by #2");
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
          ]),
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
    const html = twoStates(new Set(["t-1:2:0"]));
    expect(html).not.toContain("said by #2");
    expect(html).toContain("said by #3");
    expect(html).toContain("lh shut");
  });

  it("keys a fold by TASK, run and instance, so nothing folds another task's states", () => {
    // Instance ids are minted per run, so `#i2` names a different state in every one of them — and a
    // single-run projection stamps no run at all, which is why the task has to be in the key too.
    expect(twoStates(new Set(["t-2:2:0"]))).toContain("said by #2");
    expect(twoStates(new Set(["t-1:9:0"]))).toContain("said by #2");
  });

  it("draws a folded SOLO sheet as its gutter alone — no empty sheet under the row", () => {
    const solo = (shut: ReadonlySet<string>): string =>
      renderToStaticMarkup(
        createElement(SessionBandsView, {
          bands: bandsOf(piecesOf(parentOf([{ id: 2, from: 0, to: 10 }]), [ref(2, "planning", 0, 10)])),
          shut,
          scope: "t-1",
          render: (piece) => createElement("p", null, `said by #${piece.node.instanceId}`),
        }),
      );
    expect(solo(new Set())).toContain("said by #2");
    expect(solo(new Set())).not.toContain("sb-sheet shut");
    const folded = solo(new Set(["t-1:2:0"]));
    expect(folded).not.toContain("said by #2");
    // The section is still in the markup for its tear bars, and hidden by its class.
    expect(folded).toContain("sb-sheet shut");
  });

  it("says `expand all` once every state in the sheet is folded", () => {
    // The control has one meaning — fold what is in this session — so its label is a statement about
    // what pressing it will do rather than about what it is called.
    expect(twoStates(new Set())).toContain('aria-label="Collapse all"');
    expect(twoStates(new Set(["t-1:2:0", "t-1:3:0"]))).toContain('aria-label="Expand all"');
  });
});

/**
 * Where a bookmark from the Instances index LANDS — see `runIndex.tsx` and the `focus` prop.
 *
 * The scroll itself needs a browser and is not tested here. What is tested is the half that was
 * actually missing when the bookmark did nothing: whether there is anything in the document to
 * scroll TO. A jump that finds no target fails silently, so an absent stamp is invisible until
 * somebody presses the row and nothing happens.
 */
describe("what a bookmark can land on", () => {
  const landings = (html: string): string[] => [...html.matchAll(/data-instance="([^"]+)"/g)].map((m) => m[1]!);

  it("stamps every state's letterhead with the instance the index names it by", () => {
    const html = renderToStaticMarkup(
      createElement(SessionBandsView, {
        bands: bandsOf(
          piecesOf(parentOf([{ id: 2, from: 0, to: 10 }, { id: 3, from: 11, to: 20 }]), [
            ref(2, "planning", 0, 10),
            ref(3, "planning", 11, 20),
          ]),
        ),
        render: (piece) => createElement("p", null, `said by #${piece.node.instanceId}`),
      }),
    );
    /*
     * Asserted against `keyOfNode` rather than against a literal, because the property that matters
     * is that the two AGREE — the index names a row by that key and the conversation stamps its
     * landing with the same one. A literal would keep passing if both sides drifted together.
     */
    const kids = parentOf([{ id: 2, from: 0, to: 10 }, { id: 3, from: 11, to: 20 }]).children;
    expect(landings(html)).toEqual(kids.map(keyOfNode));
  });

  it("stamps a SOLO sheet, which has no letterhead to stamp", () => {
    /*
     * One state in the view is drawn bare: the gutter above it already names the session, times it
     * and says which state opened it, so the letterhead is dropped. That is the panel a reader is
     * most likely to jump to — a leaf run is the whole page — and it was the one the bookmark could
     * not reach, because the stamp lived on the header that is not there.
     */
    const html = renderToStaticMarkup(
      createElement(SessionBandsView, {
        bands: bandsOf(piecesOf(parentOf([{ id: 2, from: 0, to: 10 }]), [ref(2, "planning", 0, 10)])),
        render: () => createElement("p", null, "the whole page"),
      }),
    );
    expect(html).toContain("sb-bare");
    expect(landings(html)).toEqual(parentOf([{ id: 2, from: 0, to: 10 }]).children.map(keyOfNode));
  });
});

/**
 * Rewind and fork on the grey — see `cut.ts` and `CutOffer`.
 *
 * The entered row is the handle: every state has exactly one, which a letterhead (absent on a
 * one-state sheet) and a gutter (absent on a question) cannot say. Arming a rewind is drawn on the
 * rail — the knot rings, what follows fades under one counted line — and a fork's origin is a seam
 * placed by the clock among the rows the copy inherited.
 */
describe("rewind and fork on the grey", () => {
  const entered = (seq: number, at: number, id: number, key: string): BandNote =>
    note({ seq, at, kind: "entered", stateId: `s${id}`, instanceId: String(id), path: key, text: "" });
  const twoStates = (): { parent: InstanceNode; refs: SessionRef[]; notes: BandNote[] } => ({
    parent: parentOf([
      { id: 2, from: 10, to: 20 },
      { id: 3, from: 30, to: 40 },
    ]),
    refs: [ref(2, "planning", 10, 20), ref(3, "review", 30, 40)],
    notes: [entered(5, 9, 2, "k2"), entered(15, 29, 3, "k3")],
  });

  it("offers the two verbs on an entered row only when a host has them to offer", () => {
    const { parent, refs, notes } = twoStates();
    const quiet = drawWith(parent, refs, { notes });
    expect(quiet).not.toContain("Rewind to before");
    const offered = drawWith(parent, refs, { notes, onCut: { rewind: () => undefined, fork: () => undefined } } as never);
    expect(offered).toContain('aria-label="Rewind to before k3"');
    expect(offered).toContain('aria-label="Fork before k3"');
    // Once per entered row — the handle is the row, and a failure note is not one.
    expect(offered.match(/aria-label="Rewind to before/g)).toHaveLength(2);
  });

  it("draws an armed rewind as a ring on the knot, a counted line, and everything after it faded", () => {
    const { parent, refs, notes } = twoStates();
    const html = drawWith(parent, refs, { notes, armed: { seq: 15, at: 29 } } as never);
    expect(html).toContain("1 state below this line will be deleted");
    // The entry's own row keeps its words and takes the ring; the sheet it opened is what fades.
    expect(html).toContain("rail-halo cut");
    expect(html.match(/rail-row doomed/g)?.length ?? 0).toBeGreaterThanOrEqual(1);
    const cut = html.indexOf("sb-cut");
    expect(cut).toBeGreaterThan(html.indexOf("said by #2"));
    expect(cut).toBeLessThan(html.indexOf("said by #3"));
    // Nothing before the cut is touched.
    expect(html.indexOf("rail-row doomed")).toBeGreaterThan(html.indexOf("said by #2"));
  });

  it("places a fork's origin seam after the rows the copy inherited", () => {
    const { parent, refs, notes } = twoStates();
    const html = drawWith(parent, refs, {
      notes,
      origin: { taskId: "t-parent", title: "The parent", at: 40, boundary: 12, boundaryAt: 25, label: "before k3" },
    } as never);
    expect(html).toContain("forked from:");
    expect(html).toContain("The parent, before k3");
    const seam = html.indexOf("origin-mark");
    expect(seam).toBeGreaterThan(html.indexOf("said by #2"));
    expect(seam).toBeLessThan(html.indexOf("said by #3"));
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
  const gamma = run("t-gamma00000", "Gamma", { element: 2, status: "running" });

  it("is a line naming every OTHER run and its standing — not a panel, not a lane, and never itself", () => {
    const html = drawWith(parent, refs, { notes: [made("split", [alpha, beta, gamma])] });
    expect(html).toContain("split off");
    expect(html).toContain("Beta");
    expect(html).toContain("· queued");
    expect(html).toContain("Gamma");
    expect(html).toContain("· running");
    expect(html).not.toContain("Alpha");
    expect(html).toContain('data-made="t-beta000000 t-gamma00000"');
    expect(html).not.toContain("said by #t-beta000000");
    const step = stepOfNote(made("split", [alpha, beta]), "");
    expect(step.opens).toBe(false);
    expect(step.at).toEqual([]);
  });

  it("marks the run this task waits for, says what a run is holding for, and uses the mount verb for a task mount", () => {
    const html = drawWith(parent, refs, { notes: [made("task", [run("t-beta000000", "Beta", { holding: 2, waitsFor: true })])] });
    expect(html).toContain(">made<");
    expect(html).toContain("waiting for 2 tasks");
    expect(html).toContain("sb-made-waits");
    expect(html).toContain(">waits for<");
  });

  it("links a title only when a host can open a task, and never offers to nest one", () => {
    const bare = drawWith(parent, refs, { notes: [made("split", [alpha, beta])] });
    expect(bare).not.toContain("aria-expanded");
    expect(bare).not.toContain('class="sb-made-link ellip" title=');
    const hosted = drawWith(parent, refs, { notes: [made("split", [alpha, beta])], onSelectTask: () => undefined } as never);
    expect(hosted).toContain('title="open Beta (t-beta000000)"');
    expect(hosted).not.toContain("aria-expanded");
  });

});
