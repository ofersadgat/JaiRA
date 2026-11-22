/**
 * A message that never reached its conversation (`ChatThreadView.unsent`).
 *
 * 2026-11-12: a chat's opening message went to a signed-out CLI, the call failed before it landed in the
 * conversation, and the thread — which is only the records that landed — drew nothing: no message, no
 * failure. The person: "i sent a message and no error showed up on screen".
 */
import { describe, expect, it } from "vitest";
import type { RecordedCall } from "@jaira/persistence";
import { AppService } from "@jaira/service";
import { unsentText } from "../src/renderer/chatThreadModel";

const prompt = (id: string, status: string, user: string, extra: Partial<RecordedCall> = {}): RecordedCall => ({
  recordId: id,
  status,
  request: { kind: "prompt", user, config: { model: "claude-cli/default" } },
  ...extra,
});
const WHY = "Claude (cli) is signed out. Sign in to it (Settings → Connections → Agents), then send again.";

describe("the messages that never reached a conversation", () => {
  it("is the opening message whose call failed before anything landed, with why", () => {
    const records = [prompt("a", "failed", "make 16 mockups", { error: { classification: "permanent", reason: WHY }, endedAt: 5 })];
    expect(AppService.unsentOf(records, new Set())).toEqual([{ message: "make 16 mockups", reason: WHY, model: "claude-cli/default", at: 5 }]);
  });

  it("is only what failed AFTER the last message that landed — one answered since is history the thread tells", () => {
    const records = [
      prompt("a", "failed", "first try", { error: { reason: WHY } }),
      prompt("b", "succeeded", "first try"),
      prompt("c", "failed", "and then", { error: { reason: WHY } }),
    ];
    expect(AppService.unsentOf(records, new Set(["b"])).map((u) => u.message)).toEqual(["and then"]);
  });

  it("leaves out what is not a message: a gate, an empty prompt, a call that is still going or was stopped", () => {
    const records: RecordedCall[] = [
      { recordId: "g", status: "failed", request: { kind: "gate" } },
      prompt("e", "failed", "  "),
      prompt("r", "running", "still going"),
      prompt("s", "interrupted", "stopped"),
      // Interrupted while it ran (decision 0033 §6): it reached the agent, which was stopped.
      prompt("i", "failed", "left: both", { error: { classification: "canceled", reason: "interrupted", interrupted: {} } }),
    ];
    expect(AppService.unsentOf(records, new Set())).toEqual([]);
  });

  it("says something even when the failure gave no reason", () => {
    expect(AppService.unsentOf([prompt("a", "failed", "hello")], new Set())[0]!.reason).toBe("the call failed before it reached the agent");
  });

  it("is said under the thread as not sent, with the reason", () => {
    expect(unsentText(WHY)).toBe(`Not sent — ${WHY}`);
  });
});
