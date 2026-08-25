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
import { SessionBandsView } from "../src/renderer/sessionPanels";

const node = (patch: Partial<InstanceNode> & Pick<InstanceNode, "instanceId" | "stateId">): InstanceNode => ({
  status: "completed",
  iteration: 0,
  superseded: false,
  startedAt: 0,
  children: [],
  ...patch,
});

const ref = (instanceId: number, sessionId: string, startedAt: number, at: number): SessionRef =>
  ({ runId: 1, instanceId, stateId: `s${instanceId}`, sessionId, seq: 0, startedAt, at }) as SessionRef;

const parentOf = (kids: Array<{ id: number; from: number; to: number }>): InstanceNode =>
  node({
    instanceId: 1,
    stateId: "plan",
    children: kids.map((kid) =>
      node({ instanceId: kid.id, stateId: `s${kid.id}`, childKey: `k${kid.id}`, startedAt: kid.from, endedAt: kid.to }),
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
    expect(two.match(/ts-card-head/g)).toHaveLength(2);
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

  it("says so rather than going blank when a state ran in no conversation", () => {
    const html = draw(parentOf([{ id: 2, from: 0, to: 10 }]), []);
    expect(html).toContain("no conversation");
    expect(html).toContain("said by #2");
    expect(html).not.toContain("sb-tear");
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
const note = (patch: Partial<BandNote> & Pick<BandNote, "seq" | "at" | "text">): BandNote => patch;

const drawWith = (
  parent: InstanceNode | undefined,
  refs: SessionRef[],
  extra: { notes?: BandNote[]; onOpenWorkflow?: (piece: SessionPiece) => void },
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
