import { describe, expect, it } from "vitest";
import { ShellHub, ShellReader, type AppModel } from "../src/app/shell";

/** A model as the shell sees one: `state`, the actions, the look. Only the fields a test names. */
const actions = {} as AppModel["actions"];
const appearance = {} as AppModel["appearance"];
const modelOf = (state: Record<string, unknown>): AppModel => ({ state, actions, appearance }) as unknown as AppModel;

/** A region drawn by the hub: its reading, and the model it was handed for the version it compared. */
function region(hub: ShellHub): { reader: ShellReader; draw: () => AppModel } {
  const reader = new ShellReader(hub);
  return { reader, draw: () => reader.draw(reader.snapshot()) };
}

describe("a region drawn from the shell's hub", () => {
  it("is drawn again when a field it read moves, and not for any other", () => {
    const hub = new ShellHub(modelOf({ projects: ["a"], liveTurn: null }));
    const { reader, draw } = region(hub);
    const first = draw();
    expect(first.state.projects).toEqual(["a"]);
    const drawnAt = reader.snapshot();

    // The live tail moves, which this region never read: the same version, the same model.
    hub.set(modelOf({ projects: first.state.projects, liveTurn: { at: 1 } }));
    expect(reader.snapshot()).toBe(drawnAt);
    expect(draw()).toBe(first);

    // The projects move: a new version, and a new state to hand down.
    hub.set(modelOf({ projects: ["a", "b"], liveTurn: { at: 1 } }));
    expect(reader.snapshot()).not.toBe(drawnAt);
    const second = draw();
    expect(second).not.toBe(first);
    expect(second.state.projects).toEqual(["a", "b"]);
  });

  it("reads the newest model whenever it is read, as a handler after the draw does", () => {
    const hub = new ShellHub(modelOf({ selected: "t1", view: "tasks" }));
    const { draw } = region(hub);
    const handed = draw();
    void handed.state.view;
    hub.set(modelOf({ selected: "t2", view: "tasks" }));
    expect(handed.state.selected).toBe("t2");
  });

  it("watches what a child read through the state it was handed, after its own draw", () => {
    const hub = new ShellHub(modelOf({ conversation: "c1", detail: "d1" }));
    const { reader, draw } = region(hub);
    const handed = draw();
    const drawnAt = reader.snapshot();
    // A child drawn later with the parent's state reads `detail`.
    void handed.state.detail;
    hub.set(modelOf({ conversation: "c1", detail: "d2" }));
    expect(reader.snapshot()).not.toBe(drawnAt);
  });

  it("does not miss a move when the field is read again before it is told", () => {
    const hub = new ShellHub(modelOf({ board: "b1" }));
    const { reader, draw } = region(hub);
    const handed = draw();
    void handed.state.board;
    const drawnAt = reader.snapshot();
    hub.set(modelOf({ board: "b2" }));
    // An effect reads it between the commit and the hub telling: it keeps what it was drawn with.
    expect(handed.state.board).toBe("b2");
    expect(reader.snapshot()).not.toBe(drawnAt);
  });

  it("is drawn again when the actions or the look move", () => {
    const hub = new ShellHub(modelOf({ view: "tasks" }));
    const { reader, draw } = region(hub);
    draw();
    const drawnAt = reader.snapshot();
    hub.set({ ...modelOf({ view: "tasks" }), appearance: {} as AppModel["appearance"] });
    expect(reader.snapshot()).not.toBe(drawnAt);
  });

  it("tells its listeners once per model, after the commit", () => {
    const hub = new ShellHub(modelOf({}));
    let told = 0;
    hub.subscribe(() => (told += 1));
    hub.tell();
    expect(told).toBe(0);
    const next = modelOf({ view: "chat" });
    hub.set(next);
    hub.set(next);
    hub.tell();
    hub.tell();
    expect(told).toBe(1);
  });

  it("reports the state's fields to a spread, and watches every one of them", () => {
    const hub = new ShellHub(modelOf({ a: 1, b: 2 }));
    const { reader, draw } = region(hub);
    const spread = { ...draw().state } as unknown as Record<string, unknown>;
    expect(spread).toEqual({ a: 1, b: 2 });
    const drawnAt = reader.snapshot();
    hub.set(modelOf({ a: 1, b: 3 }));
    expect(reader.snapshot()).not.toBe(drawnAt);
  });
});
