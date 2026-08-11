/**
 * The transcript model: two records folded into one time-ordered list.
 *
 * The bug this exists to close is the one that made a state's panel look like it was showing every
 * session at once — the journal projection is per TASK, and rendering it unfiltered under a single
 * state's conversation put the whole run's events beneath one state's words.
 */
import { describe, expect, it } from "vitest";
import type { ConversationTurn, InstanceNode, SessionView } from "@jaira/shared/browser";
import { entriesOf, journalFor, messagePartsOf, previewOf, signatureOf, type ToolEntry } from "../src/renderer/transcript";

const session = (turns: SessionView["turns"]): SessionView =>
  ({ taskId: "t", runId: 1, instanceId: 2, stateId: "plan/goals", sessionId: "#i2", seq: 0, turns }) as SessionView;

/** The tool entries of a whole conversation, which is where a call and its result finally meet. */
const toolsOf = (turns: unknown[]): ToolEntry[] =>
  entriesOf(session(turns as never)).filter((e): e is ToolEntry => e.kind === "tool");

describe("pairing tool calls with their results", () => {
  const parts = [
    { type: "text", text: "reading" },
    { type: "tool-call", toolCallId: "c1", toolName: "read_file", args: { path: "src/spans.ts" } },
    { type: "tool-result", toolCallId: "c1", result: { bytes: 412 } },
    { type: "tool-call", toolCallId: "c2", toolName: "bash", args: { command: "npm test" } },
    { type: "tool-result", toolCallId: "c2", result: { error: "exit 1" } },
  ];

  it("pairs each call with the result carrying its id", () => {
    const tools = toolsOf([{ role: "assistant", text: "reading", parts }]);
    expect(tools.map((t) => t.name)).toEqual(["read_file", "bash"]);
    expect(tools[0]).toMatchObject({ summary: "src/spans.ts", ok: true, result: { bytes: 412 } });
    expect(tools[1]).toMatchObject({ summary: "npm test", ok: false });
  });

  it("pairs ACROSS turns, which is where Anthropic puts them", () => {
    // `tool_use` on the assistant turn, `tool_result` on the user turn after it — the shape a Claude
    // CLI session records, and the one the old per-turn pairing could not see at all.
    const tools = toolsOf([
      {
        role: "assistant",
        parts: [
          { type: "thinking", thinking: "check the file first" },
          { type: "tool_use", id: "tu1", name: "Read", input: { file_path: "src/spans.ts" } },
        ],
      },
      { role: "user", parts: [{ type: "tool_result", tool_use_id: "tu1", content: "412 bytes" }] },
    ]);
    expect(tools).toHaveLength(1);
    // The arguments SURVIVE the result arriving. Showing one or the other is what printed `null`
    // under half the lines in an agent's transcript.
    expect(tools[0]).toMatchObject({
      name: "Read",
      summary: "src/spans.ts",
      args: { file_path: "src/spans.ts" },
      result: "412 bytes",
      ok: true,
    });
  });

  it("reads a thinking block as thinking, not as a tool with no arguments", () => {
    const entries = entriesOf(
      session([{ role: "assistant", text: "done", parts: [{ type: "thinking", thinking: "two ways to do this" }] }] as never),
    );
    // Before the answer: it is what the model worked through on the way to it.
    expect(entries.map((e) => e.kind)).toEqual(["thought", "message"]);
    expect(entries[0]).toMatchObject({ kind: "thought", text: "two ways to do this" });
  });

  it("says a redacted block was withheld rather than dropping it", () => {
    const [thought] = messagePartsOf([{ type: "redacted_thinking", data: "…" }] as never);
    expect(thought).toMatchObject({ kind: "thought", text: "(withheld by the provider)" });
  });

  it("leaves a call with no result yet undecided, rather than calling it a failure", () => {
    const [tool] = toolsOf([
      { role: "assistant", parts: [{ type: "tool-call", toolCallId: "c9", toolName: "bash", args: { command: "x" } }] },
    ]);
    expect(tool!.ok).toBeUndefined();
    expect(tool!.result).toBeUndefined();
  });

  it("reads an error result as a failure however the provider spells it", () => {
    const tools = toolsOf([
      { role: "assistant", parts: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } }] },
      { role: "user", parts: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "exit 1" }] },
    ]);
    expect(tools[0]!.ok).toBe(false);
  });

  it("ignores text, stream bookkeeping, and anything that is not an array", () => {
    expect(messagePartsOf([{ type: "text", text: "hi" }] as never)).toEqual([]);
    expect(messagePartsOf([{ type: "step-start" }, { type: "step-finish" }] as never)).toEqual([]);
    expect(messagePartsOf(undefined)).toEqual([]);
    expect(messagePartsOf("nope" as never)).toEqual([]);
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
