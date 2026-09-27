/**
 * A record's subagent conversations are filed under the CALL that spawned them — what a transcript row
 * looks a subagent up by — both while the record streams (the marker's `id` is the call) and after a
 * Claude session file is folded in at close (the `id` is the agent's, the call is `parentToolUseId`).
 * Filed by `id`, every closed record's subagent went back to being a plain tool call (the person,
 * 2026-09-26).
 */
import { describe, expect, it } from "vitest";
import type { JsonValue } from "@declarative-ai/json";
import { sidechainsOf } from "../src/main/service";

const record = (marker: Record<string, string>): JsonValue => ({
  value: {
    entries: [
      { kind: "message", role: "assistant", content: [{ type: "tool_use", id: "toolu_01X", name: "Task", input: { description: "look" } }] },
      { kind: "message", role: "user", content: "look around", sidechain: marker },
      { kind: "message", role: "assistant", content: "found it", sidechain: marker },
      { kind: "event", sidechain: marker, event: { type: "sidechain" } },
    ],
  },
});

describe("sidechainsOf", () => {
  it("files a streamed subagent under its call", () => {
    expect(Object.keys(sidechainsOf(record({ id: "toolu_01X", parentToolUseId: "toolu_01X" })) ?? {})).toEqual(["toolu_01X"]);
  });

  it("files a captured subagent under its call, not its agent id", () => {
    const chains = sidechainsOf(record({ id: "abc123", parentToolUseId: "toolu_01X" }));
    expect(Object.keys(chains ?? {})).toEqual(["toolu_01X"]);
    expect(chains?.["toolu_01X"]).toHaveLength(2);
  });
});
