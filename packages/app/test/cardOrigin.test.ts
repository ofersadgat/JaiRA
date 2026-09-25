/**
 * A card's origin line (decision 0010 §4, the rulings of 2026-09-25): a task the events task started
 * says so — "started by events · push_main · git.push a1b2c3d on main" — small, under its meta line,
 * and a click on it opens the events task AT the automation that started it, rather than selecting the
 * card. Two sources, one line: a CHILD carries it in its provenance (`origin.kind: "started"`), a task
 * started on its own in `startedBy`. Rendered to static markup: the claims are structural.
 */
import { describe, expect, it } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { BoardCard, TaskOrigin } from "@jaira/shared/browser";
import { Card, OriginLine, originLineOf } from "../src/renderer/board";

const card = (patch: Partial<BoardCard> = {}): BoardCard => ({
  taskId: "t1",
  title: "Review",
  status: "running",
  workflow: "feature/review",
  activePath: [],
  hasSubBoard: false,
  updatedAt: 0,
  ...patch,
});

const STATE = "system/events/push_main";
/** Started on its own (`top_level: true`). */
const onItsOwn = card({
  startedBy: { by: "events", fromTask: "ev1", state: { key: "push_main", path: "push_main", stateId: STATE, occurrence: 0, call: 0 }, event: "git.push", summary: "git.push a1b2c3d on main" },
});
/** Started as the automation's child — the default. */
const child = card({
  origin: { kind: "started", taskId: "ev1", key: "push_main", index: 0, event: "git.push a1b2c3d on main", stateId: STATE, at: 0, boundary: 0, boundaryAt: 0, label: "started by events · push_main · git.push a1b2c3d on main" } satisfies TaskOrigin,
});
const draw = (c: BoardCard): string => renderToStaticMarkup(createElement(Card, { card: c, selected: false, onSelect: () => undefined }));

describe("the origin line", () => {
  it("draws one line under the meta, in its voice, saying which automation started the task and why — for a child and for one on its own", () => {
    for (const c of [onItsOwn, child]) {
      const html = draw(c);
      expect(html).toContain('class="card-origin');
      expect(html).toContain("started by events · push_main · git.push a1b2c3d on main");
      // Under the meta line, not in it.
      expect(html.indexOf("card-meta")).toBeLessThan(html.indexOf("card-origin"));
    }
  });

  it("is not drawn for a task a person started, nor for a fan-out's element", () => {
    expect(draw(card())).not.toContain("card-origin");
    expect(originLineOf(card())).toBeUndefined();
    expect(originLineOf(card({ origin: { kind: "task", taskId: "p", key: "work", index: 0, at: 0, boundary: 0, boundaryAt: 0, label: "element 1 of work" } }))).toBeUndefined();
  });

  it("says what it knows: no automation recorded (a task started before it was), no event handed", () => {
    expect(originLineOf(card({ startedBy: { by: "events", fromTask: "ev1", event: "", summary: "" } }))).toEqual({ words: "started by events", taskId: "ev1" });
    expect(originLineOf(card({ startedBy: { by: "events", fromTask: "ev1", event: "git.push", summary: "git.push a1b2c3d on main" } }))?.words).toBe("started by events · git.push a1b2c3d on main");
  });

  it("opens the events task AT the automation when clicked — and only that, the card under it is not selected on the way", () => {
    for (const c of [onItsOwn, child]) {
      const went: Array<[string, string | undefined]> = [];
      let stopped = false;
      const line = OriginLine({ card: c, onGo: (taskId, _e, stateId) => went.push([taskId, stateId]) }) as ReactElement<{ onClick: (e: unknown) => void; className: string }>;
      expect(line.props.className).toContain("card-origin-link");
      line.props.onClick({ stopPropagation: () => (stopped = true) });
      expect(went).toEqual([["ev1", STATE]]);
      expect(stopped).toBe(true);
    }
  });
});
