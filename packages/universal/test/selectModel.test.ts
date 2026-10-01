import { describe, expect, it } from "vitest";
import { selectKey } from "../src/components/form/selectModel";

/** A closed `<select>`'s keys, as Chromium takes them (`form/selectModel.ts`). */
describe("a closed select's keys", () => {
  const choices = [
    { label: "Models", value: "group", disabled: true },
    { label: "alpha", value: "a" },
    { label: "beta", value: "b" },
    { label: "Bravo", value: "b2" },
    { label: "gamma", value: "g" },
  ];

  it("steps with the arrows and stops at the ends", () => {
    expect(selectKey("ArrowDown", choices, "a")).toBe("b");
    expect(selectKey("ArrowRight", choices, "g")).toBe("g");
    expect(selectKey("ArrowUp", choices, "b")).toBe("a");
    expect(selectKey("ArrowLeft", choices, "a")).toBe("a");
  });

  it("never lands on a choice that is off", () => {
    expect(selectKey("Home", choices, "g")).toBe("a");
    expect(selectKey("ArrowUp", choices, "a")).toBe("a");
  });

  it("goes to the ends with Home, End and the page keys", () => {
    expect(selectKey("End", choices, "a")).toBe("g");
    expect(selectKey("PageDown", choices, "a")).toBe("g");
    expect(selectKey("PageUp", choices, "g")).toBe("a");
  });

  it("starts from the first with a value that is not a choice", () => {
    expect(selectKey("ArrowDown", choices, "")).toBe("a");
    expect(selectKey("ArrowUp", choices, "")).toBe("a");
  });

  it("goes to the next choice that begins with a typed letter, round from the one chosen", () => {
    expect(selectKey("b", choices, "a")).toBe("b");
    expect(selectKey("B", choices, "b")).toBe("b2");
    expect(selectKey("b", choices, "b2")).toBe("b");
    expect(selectKey("z", choices, "a")).toBeUndefined();
  });

  it("leaves every other key alone", () => {
    expect(selectKey("Enter", choices, "a")).toBeUndefined();
    expect(selectKey(" ", choices, "a")).toBeUndefined();
    expect(selectKey("Tab", choices, "a")).toBeUndefined();
    expect(selectKey("ArrowDown", [], "a")).toBeUndefined();
  });
});
