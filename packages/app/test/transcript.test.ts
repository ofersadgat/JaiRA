/**
 * The transcript model: two records folded into one time-ordered list.
 *
 * The bug this exists to close is the one that made a state's panel look like it was showing every
 * session at once — the journal projection is per TASK, and rendering it unfiltered under a single
 * state's conversation put the whole run's events beneath one state's words.
 */
import { describe, expect, it } from "vitest";
import type { ConversationTurn, InstanceNode, SessionView } from "@jaira/shared/browser";
import { entriesOf, journalFor, previewOf, signatureOf, toolPartsOf } from "../src/renderer/transcript";

const session = (turns: SessionView["turns"]): SessionView =>
  ({ taskId: "t", runId: 1, instanceId: 2, stateId: "plan/goals", sessionId: "#i2", seq: 0, turns }) as SessionView;

describe("pairing tool calls with their results", () => {
  const parts = [
    { type: "text", text: "reading" },
    { type: "tool-call", toolCallId: "c1", toolName: "read_file", args: { path: "src/spans.ts" } },
    { type: "tool-result", toolCallId: "c1", result: { bytes: 412 } },
    { type: "tool-call", toolCallId: "c2", toolName: "bash", args: { command: "npm test" } },
    { type: "tool-result", toolCallId: "c2", result: { error: "exit 1" } },
  ];

  it("pairs each call with the result carrying its id", () => {
    const tools = toolPartsOf(parts as never);
    expect(tools.map((t) => t.name)).toEqual(["read_file", "bash"]);
    expect(tools[0]).toMatchObject({ summary: "src/spans.ts", ok: true });
    expect(tools[1]).toMatchObject({ summary: "npm test", ok: false });
  });

  it("leaves a call with no result yet undecided, rather than calling it a failure", () => {
    const [tool] = toolPartsOf([{ type: "tool-call", toolCallId: "c9", toolName: "bash", args: { command: "x" } }] as never);
    expect(tool!.ok).toBeUndefined();
  });

  it("ignores text parts and anything that is not an array", () => {
    expect(toolPartsOf([{ type: "text", text: "hi" }] as never)).toEqual([]);
    expect(toolPartsOf(undefined)).toEqual([]);
    expect(toolPartsOf("nope" as never)).toEqual([]);
  });
});

describe("building the entry list", () => {
  it("drops an empty assistant bubble when the turn was only tool calls", () => {
    const turns = [{ role: "assistant", parts: [{ type: "tool-call", toolCallId: "c", toolName: "ls", args: {} }] }];
    const entries = entriesOf(session(turns as never));
    expect(entries.map((e) => e.kind)).toEqual(["tool"]);
  });

  it("keeps the message when the turn said something as well", () => {
    const turns = [
      { role: "assistant", text: "reading it", parts: [{ type: "tool-call", toolCallId: "c", toolName: "ls", args: {} }] },
    ];
    expect(entriesOf(session(turns as never)).map((e) => e.kind)).toEqual(["message", "tool"]);
  });

  it("keeps the system prompt as the first message rather than hiding it", () => {
    const turns = [{ role: "system", text: "you are a planner" }, { role: "user", text: "go" }];
    const entries = entriesOf(session(turns as never));
    expect(entries.map((e) => (e.kind === "message" ? e.role : e.kind))).toEqual(["system", "user"]);
  });

  it("folds in the journal facts nobody said, and drops the ones the session already tells", () => {
    const journal: ConversationTurn[] = [
      { seq: 1, at: 10, kind: "operation", stateId: "plan/goals", text: "ran" },
      { seq: 2, at: 20, kind: "policy", stateId: "plan/goals", text: "escalated bash" },
      { seq: 3, at: 30, kind: "failure", stateId: "plan/goals", text: "did not validate" },
    ];
    const entries = entriesOf(session([{ role: "user", text: "go" }] as never), journal);
    // `operation` is the model call, told worse — the message above already is that call.
    expect(entries.filter((e) => e.kind === "event").map((e) => (e as { text: string }).text)).toEqual([
      "escalated bash",
      "did not validate",
    ]);
  });

  it("puts the live turn last, because it has not finished happening", () => {
    const entries = entriesOf(session([{ role: "user", text: "go" }] as never), [], "writing…");
    expect(entries.at(-1)).toEqual({ kind: "live", text: "writing…" });
  });

  it("adds nothing for an empty live delta", () => {
    expect(entriesOf(session([] as never), [], "")).toEqual([]);
    expect(entriesOf(null, [], null)).toEqual([]);
  });
});

describe("journalFor", () => {
  const turns: ConversationTurn[] = [
    { seq: 1, at: 1, kind: "policy", stateId: "plan/goals", text: "a" },
    { seq: 2, at: 2, kind: "policy", stateId: "plan/draft", text: "b" },
  ];

  it("keeps only the state being shown — the whole point", () => {
    expect(journalFor(turns, "plan/goals").map((t) => t.text)).toEqual(["a"]);
  });

  it("keeps nothing when no state is named, rather than everything", () => {
    expect(journalFor(turns, undefined)).toEqual([]);
  });
});

describe("previewing a value for a header", () => {
  it("shows the first words of a long document, not its size", () => {
    const preview = previewOf("# Context\nThe parser resolves spans by walking the token stream twice, and…");
    expect(preview.startsWith('"# Context The parser resolves')).toBe(true);
    expect(preview.endsWith('…"')).toBe(true);
  });

  it("shows a short string whole, without truncation marks", () => {
    expect(previewOf("three goals")).toBe('"three goals"');
  });

  it("counts a long list rather than printing it", () => {
    expect(previewOf(["aaaaaaaaaa", "bbbbbbbbbb", "cccccccccc", "dddddddddd", "eeeeeeeeee"])).toBe("5 items");
    expect(previewOf(["a", "b"])).toBe('["a","b"]');
  });

  it("says nothing confidently for an absent value", () => {
    expect(previewOf(undefined)).toBe("—");
  });
});

describe("the signature line", () => {
  const node = (patch: Partial<InstanceNode>): InstanceNode => ({ childKey: "draft", stateId: "plan/draft", ...patch }) as InstanceNode;

  it("uses the child KEY, since one state can be mounted under several", () => {
    expect(signatureOf(node({ inputs: { goals: 3 } })).name).toBe("draft");
  });

  it("drops the parameters once the run has named itself", () => {
    // The label already shows the input that identifies the run; repeating the rest is noise on a
    // line with no room for it.
    const sig = signatureOf(node({ label: "span offsets survive a rewrite", inputs: { description: "span offsets survive a rewrite", n: 2 } }));
    expect(sig).toMatchObject({ label: "span offsets survive a rewrite", params: [] });
  });

  it("lists every parameter when nothing named the run — something has to tell four apart", () => {
    const sig = signatureOf(node({ inputs: { goals: ["a", "b"], context: "short" } }));
    expect(sig.params.map((p) => p.name)).toEqual(["goals", "context"]);
    expect(sig.params[1]!.preview).toBe('"short"');
  });

  it("falls back to the state id for a run entered as a root, which has no key", () => {
    expect(signatureOf({ stateId: "feature/plan", childKey: undefined, label: undefined, inputs: undefined }).name).toBe("plan");
  });
});
