/**
 * A card's origin line (decision 0010 §4): a task the events task started says so — "started by
 * events · git.push a1b2c3d on main" — small, under its meta line, and a click on it selects the events
 * task rather than the card. Rendered to static markup: the claims are structural.
 */
import { describe, expect, it } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { BoardCard } from "@jaira/shared/browser";
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

const started = card({ startedBy: { by: "events", fromTask: "ev1", event: "git.push", summary: "git.push a1b2c3d on main" } });
const draw = (c: BoardCard): string => renderToStaticMarkup(createElement(Card, { card: c, selected: false, onSelect: () => undefined }));

describe("the origin line", () => {
  it("draws one line under the meta, in its voice, saying what started the task", () => {
    const html = draw(started);
    expect(html).toContain('class="card-origin');
    expect(html).toContain("started by events · git.push a1b2c3d on main");
    // Under the meta line, not in it.
    expect(html.indexOf("card-meta")).toBeLessThan(html.indexOf("card-origin"));
  });

  it("is not drawn for a task a person started", () => {
    expect(draw(card())).not.toContain("card-origin");
    expect(originLineOf(card())).toBeUndefined();
  });

  it("says only that events started it when the step was handed no event", () => {
    expect(originLineOf(card({ startedBy: { by: "events", fromTask: "ev1", event: "", summary: "" } }))).toBe("started by events");
  });

  it("selects the events task when clicked — and only that, the card under it is not selected on the way", () => {
    const went: string[] = [];
    let stopped = false;
    const line = OriginLine({ card: started, onGo: (taskId) => went.push(taskId) }) as ReactElement<{ onClick: (e: unknown) => void; className: string }>;
    expect(line.props.className).toContain("card-origin-link");
    line.props.onClick({ stopPropagation: () => (stopped = true) });
    expect(went).toEqual(["ev1"]);
    expect(stopped).toBe(true);
  });
});
