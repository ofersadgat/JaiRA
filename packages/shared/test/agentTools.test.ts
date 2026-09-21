/**
 * An agent executor's tool declaration — the shape, and the questions asked of one (decision 0007 §3).
 *
 * The declarations themselves sit beside the executors in `@jaira/runtime`; what is pinned here is
 * that the shape answers both directions and keeps "has no standard tool" apart from "was never
 * declared", because those two get different treatment: the first answers to `other`, the second is
 * left alone.
 */
import { describe, expect, it } from "vitest";
import {
  nativesOfStandard,
  primaryNativeOf,
  replacementsOf,
  standardOfNative,
  unmappedNatives,
  type AgentToolDeclaration,
} from "../src/agentTools";

const AGENT: AgentToolDeclaration = {
  channel: "tools",
  natives: { Read: "read_file", Edit: "edit", MultiEdit: "edit", Task: null },
};

describe("an agent's declaration", () => {
  it("maps a built-in to the standard tool a mode is written against", () => {
    expect(standardOfNative(AGENT, "Read")).toBe("read_file");
    expect(standardOfNative(AGENT, "MultiEdit")).toBe("edit");
  });

  it("tells a native with NO standard tool from one nobody declared", () => {
    expect(standardOfNative(AGENT, "Task")).toBeNull();
    expect(standardOfNative(AGENT, "SomethingNobodyModelled")).toBeUndefined();
    // Own entries only — the map is keyed by a name an agent chose.
    expect(standardOfNative(AGENT, "constructor")).toBeUndefined();
    expect(unmappedNatives(AGENT)).toEqual(["Task"]);
  });

  it("lists every native that is one standard tool, the first being the one a person would name", () => {
    expect(nativesOfStandard(AGENT, "edit")).toEqual(["Edit", "MultiEdit"]);
    expect(primaryNativeOf(AGENT, "edit")).toBe("Edit");
    expect(primaryNativeOf(AGENT, "glob")).toBeUndefined();
  });

  it("says what an injected tool of ours displaces — every native doing that job", () => {
    expect(replacementsOf(AGENT)).toEqual({ read_file: ["Read"], edit: ["Edit", "MultiEdit"] });
  });
});
