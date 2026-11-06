import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { samePropsBy, sameContent } from "../src/steady";

describe("equal in content", () => {
  it("is plain objects and arrays with equal parts, made again", () => {
    expect(sameContent({ voice: "data", scale: 1, color: "dim" }, { voice: "data", scale: 1, color: "dim" })).toBe(true);
    expect(sameContent([{ kind: "path", d: "M0" }], [{ kind: "path", d: "M0" }])).toBe(true);
    expect(sameContent({ voice: "data", scale: 1 }, { voice: "data", scale: 1.1 })).toBe(false);
    expect(sameContent({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(sameContent([1, 2], [1, 2, 3])).toBe(false);
    expect(sameContent([1], { 0: 1 })).toBe(false);
  });

  it("keeps a function, an element, a Map or a Set equal only to itself", () => {
    expect(sameContent({ on: () => 1 }, { on: () => 1 })).toBe(false);
    expect(sameContent(createElement("b", null, "x"), createElement("b", null, "x"))).toBe(false);
    expect(sameContent(new Map([[1, [2]]]), new Map([[1, [3]]]))).toBe(false);
    expect(sameContent(new Set([1]), new Set([2]))).toBe(false);
    const kept = new Map();
    expect(sameContent({ m: kept }, { m: kept })).toBe(true);
  });

  it("stops looking past a few levels, and calls what lies deeper unequal", () => {
    const deep = (): unknown => ({ a: { b: { c: { d: { e: 1 } } } } });
    expect(sameContent(deep(), deep())).toBe(false);
    expect(sameContent(deep(), deep(), 6)).toBe(true);
  });
});

describe("props equal for a memo", () => {
  const same = samePropsBy(["spec", "style"]);
  it("compares the named props by content and the rest by identity", () => {
    const onPress = (): void => undefined;
    expect(same({ spec: { scale: 1 }, children: "hi", onPress }, { spec: { scale: 1 }, children: "hi", onPress })).toBe(true);
    expect(same({ spec: { scale: 1 }, onPress }, { spec: { scale: 1 }, onPress: () => undefined })).toBe(false);
    expect(same({ box: { m: 1 } }, { box: { m: 1 } })).toBe(false);
    expect(same({ spec: { scale: 1 } }, { spec: { scale: 1 }, ellip: true })).toBe(false);
  });
});
