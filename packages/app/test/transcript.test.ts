/**
 * The transcript model: two records folded into one time-ordered list.
 *
 * The bug this exists to close is the one that made a state's panel look like it was showing every
 * session at once — the journal projection is per TASK, and rendering it unfiltered under a single
 * state's conversation put the whole run's events beneath one state's words.
 */
import { describe, expect, it } from "vitest";
import type { ConversationTurn, InstanceNode, SessionView } from "@jaira/shared/browser";
import { foldWriting, isStreamBookkeeping, writingPath, type WritingTool } from "@jaira/shared/browser";
import type { JsonValue } from "@declarative-ai/json";
import { producedArtifact, unfoldable } from "../src/renderer/transcriptView";
import {
  agentTitleOf,
  blocksOf,
  entriesOf,
  iconOf,
  journalFor,
  liveStatusOf,
  messagePartsOf,
  previewOf,
  resultValueOf,
  sidechainEntriesOf,
  signatureOf,
  type ToolEntry,
  type TranscriptEntry,
} from "../src/renderer/transcript";

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
      { seq: 1, at: 10, kind: "started", stateId: "plan/goals", text: "prompt" },
      { seq: 2, at: 20, kind: "policy", stateId: "plan/goals", text: "escalated bash" },
      { seq: 3, at: 30, kind: "failure", stateId: "plan/goals", text: "did not validate" },
    ];
    const entries = entriesOf(session([{ role: "user", text: "go" }] as never), journal);
    // `started` is the model call, told worse — the message above already IS that call.
    expect(entries.filter((e) => e.kind === "event").map((e) => (e as { text: string }).text)).toEqual([
      "escalated bash",
      "did not validate",
    ]);
  });

  it("renders live stream items in order — whole turns, tools included, before the text tail", () => {
    // What arrives over `session:turn` while the record is still open (the record persists only at
    // close). A finished turn reads exactly as a stored one would; the text tail comes last.
    const entries = entriesOf(session([{ role: "user", text: "go" }] as never), [], {
      text: "and now…",
      items: [
        {
          kind: "message",
          role: "assistant",
          content: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: { path: "a.txt" } }] },
        },
        { kind: "message", role: "user", content: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ZEPHYR" }] } },
        { kind: "message", role: "assistant", content: { role: "assistant", content: [{ type: "text", text: "found it" }] } },
      ],
    });
    expect(entries.map((e) => e.kind)).toEqual(["message", "tool", "message", "live"]);
    // The live tool_result found its live tool_use: the row has a verdict and a payload.
    const call = entries.find((e): e is ToolEntry => e.kind === "tool");
    expect(call).toMatchObject({ name: "Read", ok: true, result: "ZEPHYR" });
  });

  it("shows the thinking tail as it streams, before the answer's own tail", () => {
    // The order a turn happens in: the model reasons, then answers. Both tails grow live.
    const entries = entriesOf(session([] as never), [], { text: "The plan is…", thinking: "check the goals first" });
    expect(entries.map((e) => e.kind)).toEqual(["thought", "live"]);
    expect(entries[0]).toMatchObject({ text: "check the goals first" });
  });

  it("marks the thinking LIVE while no answer has started — the 'still thinking' state", () => {
    // Thinking with an empty answer tail is the state itself: the row pulses and counts up from
    // `startedAt`, which is the difference between a model working and a model stalled.
    const entries = entriesOf(session([] as never), [], { text: "", thinking: "hm", thinkingStartedAt: 1000 });
    expect(entries).toEqual([{ kind: "thought", text: "hm", live: true, startedAt: 1000 }]);
  });

  it("shows a WITHHELD think as a live row — a started clock is enough, with no text to grow", () => {
    // The provider streams the block and keeps the reasoning: the tail never gains a character, and
    // gating the row on text is what made minutes of thinking render as an empty conversation
    // nobody could tell from a hung run. The clock alone carries the state.
    const entries = entriesOf(session([] as never), [], { text: "", thinking: "", thinkingStartedAt: 1000 });
    expect(entries).toEqual([{ kind: "thought", text: "", live: true, startedAt: 1000 }]);
  });

  it("times a withheld think the same as a written one once the answer begins", () => {
    const entries = entriesOf(session([] as never), [], { text: "Here goes", thinking: "", thinkingStartedAt: 1000, textStartedAt: 4000 });
    expect(entries[0]).toMatchObject({ kind: "thought", text: "", durationMs: 3000 });
    expect((entries[0] as { live?: boolean }).live).toBeUndefined();
  });

  it("stops the pulse and states the duration once the answer begins", () => {
    const entries = entriesOf(session([] as never), [], {
      text: "The plan is…",
      thinking: "hm",
      thinkingStartedAt: 1000,
      textStartedAt: 3500,
    });
    // No longer live — thinking ENDED when the first word arrived — and it took 2.5 s.
    expect(entries[0]).toMatchObject({ kind: "thought", durationMs: 2500 });
    expect((entries[0] as { live?: boolean }).live).toBeUndefined();
  });

  it("says a call was cut off, so a transcript that stops is not read as one that finished", () => {
    const view = { ...session([{ role: "assistant", text: "as far as it got" }] as never), status: "interrupted" as const };
    const entries = entriesOf(view);
    expect(entries.at(-1)).toMatchObject({ kind: "event", tone: "warn", text: expect.stringMatching(/process ended before/) });
  });

  it("says nothing of the kind about a call that is still going", () => {
    // The one that made watching a run unreadable: a live call has no terminal event, which for a
    // while was projected as `interrupted` — so every state a person watched while it was SPEAKING
    // carried its own death notice, under a transcript that was still growing.
    const view = { ...session([{ role: "assistant", text: "as far as it has got" }] as never), status: "running" as const };
    expect(entriesOf(view).some((e) => e.kind === "event")).toBe(false);
  });

  it("keeps the thinking duration when the live turn it was measured on settles", () => {
    // `LiveTurnLog.apply` stamps the finished item with `thoughtMs`, BESIDE the provider's message
    // rather than inside it. Reading only the message lost the number the instant the turn landed:
    // the tail's own thought row went away and what replaced it had never been told how long it
    // took, so "thought for 12 s" appeared while the model reasoned and vanished when it stopped.
    const entries = entriesOf(session([] as never), [], {
      text: "",
      items: [
        {
          kind: "message",
          role: "assistant",
          at: 4000,
          startedAt: 1000,
          thoughtMs: 2500,
          content: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "weighing it up" },
              { type: "text", text: "here is the plan" },
            ],
          },
        },
      ],
    });
    expect(entries[0]).toMatchObject({ kind: "thought", durationMs: 2500, at: 4000 });
    expect(entries[1]).toMatchObject({ kind: "message", at: 4000 });
  });

  it("keeps an untimed entry in the place it was produced rather than sorting it to the front", () => {
    // Turns carry clocks now (`messageTimes`), so treating an absent one as zero would file every
    // tool row, thought and native line above the conversation it belongs to.
    const entries = entriesOf(
      session([
        { role: "user", text: "go", at: 1000 },
        {
          role: "assistant",
          parts: [{ type: "tool_use", id: "c1", name: "Read", input: { path: "a.ts" } }] as never,
          at: 2000,
        },
        { role: "assistant", text: "done", at: 3000 },
      ] as never),
      [],
      { text: "still writing" },
    );
    expect(entries.map((e) => e.kind)).toEqual(["message", "tool", "message", "live"]);
  });

  it("carries a stored turn's time and thought duration onto its rows", () => {
    // The record's `messageTimes` reach the turn (service-side); here they reach the entries — the
    // thought row states the wait, the message row carries the clock.
    const entries = entriesOf(
      session([
        {
          role: "assistant",
          text: "done",
          parts: [{ type: "thinking", thinking: "let me check" }] as never,
          at: 5000,
          thoughtMs: 1200,
        },
      ] as never),
    );
    expect(entries[0]).toMatchObject({ kind: "thought", durationMs: 1200, at: 5000 });
    expect(entries[1]).toMatchObject({ kind: "message", at: 5000 });
  });

  it("drops stream_event delta bookkeeping instead of burying the conversation under it", () => {
    // Tool arguments assemble one fragment per event; their content arrives readable on the
    // finished turn, and the text/thinking deltas already travel as the tails.
    const entries = entriesOf(session([] as never), [], {
      text: "",
      items: [
        { kind: "event", event: { type: "provider_event", payload: { type: "stream_event", event: { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: '{"pa' } } } } },
      ],
    });
    expect(entries).toEqual([]);
  });

  it("withholds a subagent's live turn from the main flow rather than misattributing it", () => {
    const entries = entriesOf(session([] as never), [], {
      text: "",
      items: [
        { kind: "message", role: "assistant", parentToolUseId: "toolu_task", content: { role: "assistant", content: [{ type: "text", text: "subagent says" }] } },
      ],
    });
    expect(entries).toEqual([]);
  });

  it("shows a stream event it does not understand rather than dropping it", () => {
    const entries = entriesOf(session([] as never), [], {
      text: "",
      items: [
        { kind: "event", event: { type: "provider_event", payload: { type: "system", subtype: "compact_boundary" } } },
        { kind: "event", event: { type: "progress", message: "warming up" } },
      ],
    });
    // Named as well as it can be, the whole payload behind the row — a gap in an hour-long run is
    // worse than an unfamiliar name.
    expect(entries[0]).toMatchObject({ kind: "event", text: "context compacted", detail: { type: "system" } });
    expect(entries[1]).toMatchObject({ kind: "event", text: "warming up" });
  });

  it("puts the live turn last, because it has not finished happening", () => {
    const entries = entriesOf(session([{ role: "user", text: "go" }] as never), [], "writing…");
    expect(entries.at(-1)).toEqual({ kind: "live", text: "writing…" });
  });

  it("adds nothing for an empty live delta", () => {
    expect(entriesOf(session([] as never), [], "")).toEqual([]);
    expect(entriesOf(null, [], null)).toEqual([]);
  });

  it("puts a message that has been sent ABOVE the answer it provoked", () => {
    // The seam: everything the record holds, then what was just typed, then what is streaming back.
    // Appended after the tail instead, the question sat under the thinking it had caused until the
    // turn landed and the record put it back in order.
    const entries = entriesOf(
      session([{ role: "user", text: "one" }, { role: "assistant", text: "first answer" }] as never),
      [],
      { text: "still", thinking: "what did they mean" },
      "two",
    );
    expect(entries.map((e) => (e.kind === "message" ? `${e.role}: ${e.text}` : e.kind))).toEqual([
      "user: one",
      "assistant: first answer",
      "user: two",
      "thought",
      "live",
    ]);
  });
});

describe("subagent conversations", () => {
  const view = {
    ...session([
      { role: "assistant", parts: [{ type: "tool_use", id: "toolu_task", name: "Task", input: { prompt: "explore" } }] },
      { role: "user", parts: [{ type: "tool_result", tool_use_id: "toolu_task", content: "the report" }] },
    ] as never),
    sidechains: {
      toolu_task: [
        { role: "assistant", text: "I am the subagent", parts: [{ type: "text", text: "I am the subagent" }] },
        { role: "user", parts: [{ type: "tool_result", tool_use_id: "toolu_sub", content: "sub data" }] },
      ],
    },
  } as never;

  it("marks the spawning call as the doorway, and keeps the subagent out of the main thread", () => {
    const entries = entriesOf(view);
    const task = entries.find((e): e is ToolEntry => e.kind === "tool" && e.name === "Task");
    expect(task?.sidechain).toBe("toolu_task");
    // Nothing the subagent said appears in the main flow.
    expect(JSON.stringify(entries)).not.toContain("I am the subagent");
  });

  it("reads the sidechain as a conversation of its own, pairing and all", () => {
    const sub = sidechainEntriesOf(view, "toolu_task");
    expect(sub.some((e) => e.kind === "message" && (e as { text?: string }).text === "I am the subagent")).toBe(true);
    // An unknown call is an empty conversation, not an error.
    expect(sidechainEntriesOf(view, "toolu_nope")).toEqual([]);
  });

  it("marks a doorway INSIDE a sidechain, so a subagent's subagent can be walked into", () => {
    const nested = {
      ...session([] as never),
      sidechains: {
        toolu_outer: [
          { role: "assistant", parts: [{ type: "tool_use", id: "toolu_inner", name: "Task", input: { prompt: "go deeper" } }] },
        ],
        toolu_inner: [{ role: "assistant", text: "deepest", parts: [{ type: "text", text: "deepest" }] }],
      },
    } as never;
    const sub = sidechainEntriesOf(nested, "toolu_outer");
    const inner = sub.find((e): e is ToolEntry => e.kind === "tool" && e.name === "Task");
    expect(inner?.sidechain).toBe("toolu_inner");
  });

  it("marks a LIVE spawning call as the doorway before any record of the chain exists", () => {
    // While the run is going, the Task call is itself a live item and its chain has only the live
    // tail's turns — the doorway must open the moment the subagent first speaks.
    const entries = entriesOf(session([] as never), [], {
      text: "",
      items: [
        {
          kind: "message",
          role: "assistant",
          content: { role: "assistant", content: [{ type: "tool_use", id: "toolu_live", name: "Task", input: { prompt: "explore" } }] },
        },
      ],
      sidechains: {
        toolu_live: [
          { kind: "message", role: "assistant", parentToolUseId: "toolu_live", content: { role: "assistant", content: [{ type: "text", text: "sub here" }] } },
        ],
      },
    });
    const task = entries.find((e): e is ToolEntry => e.kind === "tool" && e.name === "Task");
    expect(task?.sidechain).toBe("toolu_live");
    // The subagent's words still stay out of the main flow.
    expect(JSON.stringify(entries)).not.toContain("sub here");
  });

  it("renders a chain's live turns inside its own conversation, tools paired and all", () => {
    const live = [
      {
        kind: "message",
        role: "assistant",
        parentToolUseId: "toolu_task",
        content: { role: "assistant", content: [{ type: "tool_use", id: "toolu_sub2", name: "Read", input: { path: "a.txt" } }] },
      },
      {
        kind: "message",
        role: "user",
        parentToolUseId: "toolu_task",
        content: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_sub2", content: "AZIMUTH" }] },
      },
    ];
    // Appended after whatever the record already holds — for an open record that is everything.
    const sub = sidechainEntriesOf(view, "toolu_task", live as never);
    const call = sub.find((e): e is ToolEntry => e.kind === "tool" && e.name === "Read");
    expect(call).toMatchObject({ ok: true, result: "AZIMUTH" });
    // And with no record at all, the live turns alone are the conversation.
    const bare = sidechainEntriesOf(null, "toolu_task", live as never);
    expect(bare.find((e): e is ToolEntry => e.kind === "tool")?.result).toBe("AZIMUTH");
  });

  it("keeps a live turn tagged for ANOTHER chain out of the one being read", () => {
    const stray = [
      { kind: "message", role: "assistant", parentToolUseId: "toolu_other", content: { role: "assistant", content: [{ type: "text", text: "wrong room" }] } },
    ];
    expect(JSON.stringify(sidechainEntriesOf(view, "toolu_task", stray as never))).not.toContain("wrong room");
  });
});

describe("stored provider events", () => {
  it("splices each event where it happened among the turns", () => {
    const view = {
      ...session([
        { role: "user", text: "go" },
        { role: "assistant", text: "done" },
      ] as never),
      providerEvents: [{ index: 1, event: { type: "system", subtype: "compact_boundary" } }],
    } as never;
    const entries = entriesOf(view);
    expect(entries.map((e) => (e.kind === "event" ? e.text : e.kind))).toEqual(["message", "context compacted", "message"]);
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

describe("folding a flat list into messages and the work between them", () => {
  const tool = (name: string): TranscriptEntry => ({ kind: "tool", name, summary: "" });
  const say = (role: string): TranscriptEntry => ({ kind: "message", role, text: role });

  it("gathers a run of calls, thoughts and events into one block", () => {
    const blocks = blocksOf([
      say("user"),
      { kind: "thought", text: "check the file first" },
      tool("Read"),
      { kind: "event", tone: "warn", text: "policy escalated" },
      say("assistant"),
    ]);
    expect(blocks.map((b) => b.kind)).toEqual(["message", "work", "message"]);
    expect(blocks[1]).toMatchObject({ kind: "work", entries: [{ kind: "thought" }, { kind: "tool" }, { kind: "event" }] });
  });

  it("opens with a work block when the run acted before anybody spoke", () => {
    // The common shape for a state whose operation is a bare agent loop, and the one a renderer
    // that assumed "message first" put an empty bubble above.
    expect(blocksOf([tool("Bash"), say("assistant")]).map((b) => b.kind)).toEqual(["work", "message"]);
  });

  it("starts a new block after each message, so a fold cannot span an answer", () => {
    const blocks = blocksOf([tool("a"), say("assistant"), tool("b")]);
    expect(blocks.map((b) => b.kind)).toEqual(["work", "message", "work"]);
  });

  it("leaves the live turn on its own — it is being said, not done", () => {
    expect(blocksOf([tool("a"), { kind: "live", text: "half an answ" }]).map((b) => b.kind)).toEqual(["work", "live"]);
  });
});

describe("weaving the agent's native session lines into the conversation", () => {
  // The shape a real Claude session file leaves for the transcript: the EVENTS. Message envelopes
  // are folded onto the entries they annotate at capture, so nothing here needs pairing — and the
  // agent's structured tool record rides the tool_result block, where the fold put it.
  const withNative = (turns: unknown[], native: Array<{ index: number; line: unknown }>): SessionView =>
    ({ ...session(turns as never), native }) as unknown as SessionView;
  const line = (index: number, line: unknown): { index: number; line: unknown } => ({ index, line });

  const turns = [
    { role: "assistant", parts: [{ type: "tool_use", id: "tu1", name: "Read", input: { file_path: "a.ts" } }] },
    { role: "user", parts: [{ type: "tool_result", tool_use_id: "tu1", content: "ok", data: { stdout: "rich", stderr: "" } }] },
    { role: "assistant", text: "done" },
  ];
  const native = [
    line(0, { type: "queue-operation", operation: "enqueue" }),
    line(1, { type: "attachment", uuid: "a1", attachment: { type: "skill_listing", skills: ["x"] } }),
    line(3, { type: "last-prompt", lastPrompt: "the prompt again" }),
    line(3, { type: "ai-title", aiTitle: "Reading a.ts" }),
  ];

  it("shows the lines the stream never carried, at their place in the conversation", () => {
    const entries = entriesOf(withNative(turns, native));
    // The index is honoured EXACTLY now — it counts the messages that preceded the line, so an
    // event at 1 sits after the first turn. The old weave drained its queue ahead of each turn and
    // put it earlier than the file said, which nothing depended on and nothing checked.
    expect(entries.map((e) => (e.kind === "event" ? e.text : e.kind))).toEqual([
      "queued: enqueue",
      "tool",
      "context: skill_listing",
      "message",
    ]);
    // The attachment opens to the full line.
    const events = entries.filter((e): e is Extract<TranscriptEntry, { kind: "event" }> => e.kind === "event");
    expect(events[1]!.detail).toMatchObject({ attachment: { type: "skill_listing" } });
  });

  it("never renders ai-title — it is the conversation's NAME, and the agent repeats it verbatim", () => {
    const entries = entriesOf(withNative(turns, native));
    expect(entries.some((e) => e.kind === "event" && e.text.includes("Reading a.ts"))).toBe(false);
    // Not lost, though: it is read off the record by the thing that names the conversation.
    expect(agentTitleOf(withNative(turns, native))).toBe("Reading a.ts");
  });

  it("takes the LAST title the agent wrote — it revises, and the newest is what it believes", () => {
    const revised = [...native, line(3, { type: "ai-title", aiTitle: "Reading a.ts" }), line(3, { type: "ai-title", aiTitle: "Fixing a.ts" })];
    expect(agentTitleOf(withNative(turns, revised))).toBe("Fixing a.ts");
    // A record with no native lines at all simply has no title to offer.
    expect(agentTitleOf(session(turns as never))).toBeUndefined();
  });

  it("shows the agent's structured record on the tool line, off the block that carried it", () => {
    const [tool] = entriesOf(withNative(turns, native)).filter((e): e is ToolEntry => e.kind === "tool");
    expect(tool).toMatchObject({ name: "Read", result: "ok", detail: { stdout: "rich" } });
  });

  it("never renders last-prompt — it duplicates the conversation's own first message", () => {
    const entries = entriesOf(withNative(turns, native));
    expect(entries.some((e) => e.kind === "event" && e.text.includes("prompt again"))).toBe(false);
  });

  it("keeps an unknown line type visible rather than filtering it — the vocabulary is the agent's", () => {
    const entries = entriesOf(withNative(turns, [line(0, { type: "file-history-snapshot", snapshot: {} })]));
    expect(entries[0]).toMatchObject({ kind: "event", text: "file-history-snapshot", detail: { type: "file-history-snapshot" } });
  });

  it("shows an event whose index runs past the last turn, at the tail", () => {
    // There is no pairing left to derail: what used to be a queue of envelopes waiting for a turn
    // is now events spliced by index, and one past the end is simply said last.
    const entries = entriesOf(withNative([{ role: "assistant", text: "hi" }], [
      line(9, { type: "queue-operation", operation: "enqueue" }),
    ]));
    expect(entries.map((e) => (e.kind === "event" ? e.text : e.kind))).toEqual(["message", "queued: enqueue"]);
  });

  it("changes nothing when the record kept no native lines", () => {
    expect(entriesOf(session(turns as never)).map((e) => e.kind)).toEqual(["tool", "message"]);
  });

  it("interleaves pinned provider events by their index — init first, compaction where it happened", () => {
    const view = {
      ...session(turns as never),
      providerEvents: [
        { index: 0, event: { type: "system", subtype: "init", model: "opus" } },
        { index: 2, event: { type: "system", subtype: "compact_boundary" } },
        { index: 3, event: { type: "system", subtype: "rate_limit" } },
      ],
    } as unknown as SessionView;
    const entries = entriesOf(view);
    expect(entries.map((e) => (e.kind === "event" ? e.text : e.kind))).toEqual([
      "session started",
      "tool",
      "context compacted",
      "message",
      "system: rate_limit",
    ]);
    // Opaque by contract: the row names what it can, and opens to the whole payload.
    const init = entries.find((e) => e.kind === "event" && e.text === "session started");
    expect(init).toMatchObject({ detail: { model: "opus" } });
  });
});

describe("which glyph a line of work draws with", () => {
  const tool = (name: string) => iconOf({ kind: "tool", name, summary: "" });

  it("reads the family off the tool's name", () => {
    expect(tool("Bash")).toBe("terminal");
    expect(tool("Read")).toBe("read");
    expect(tool("NotebookEdit")).toBe("write");
    expect(tool("Grep")).toBe("search");
    expect(tool("Task")).toBe("agent");
  });

  it("calls a web tool web, though its name also says fetch or search", () => {
    // Order is the whole design: `WebSearch` is a web thing and `Glob` is a search, and only the
    // sequence of the tests tells them apart.
    expect(tool("WebFetch")).toBe("web");
    expect(tool("WebSearch")).toBe("web");
  });

  it("falls back to a plain tool rather than guessing", () => {
    expect(tool("mcp__weather__forecast")).toBe("tool");
  });

  it("marks a thought and tells a fact from a warning", () => {
    expect(iconOf({ kind: "thought", text: "…" })).toBe("think");
    expect(iconOf({ kind: "event", tone: "plain", text: "went to draft" })).toBe("note");
    expect(iconOf({ kind: "event", tone: "bad", text: "failed" })).toBe("alert");
  });
});

describe("the call being written, before it is a call", () => {
  /** One `content_block_delta` carrying tool-argument JSON, in the shape the live stream nests it. */
  const stream = (event: JsonValue): JsonValue => ({ kind: "event", event: { type: "provider_event", payload: { type: "stream_event", event } } });
  const inputDelta = (partial: string, index = 0): JsonValue =>
    stream({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: partial } });
  const blockStart = (name: string, index = 0): JsonValue =>
    stream({ type: "content_block_start", index, content_block: { type: "tool_use", id: "toolu_1", name, input: {} } });

  /** The renderer's own fold, run over a stream — the same one main runs. */
  const foldAll = (items: JsonValue[]): WritingTool | undefined =>
    items.reduce<WritingTool | undefined>((state, item) => foldWriting(state, item), undefined);

  it("names the tool and counts what has arrived, while the arguments are still coming", () => {
    const writing = foldAll([blockStart("show_artifact"), inputDelta('{"path": "mocks/07.html", "content": "<!DOC'), inputDelta("TYPE html>…")]);
    expect(writing).toMatchObject({ name: "show_artifact", index: 0, chars: 54 });
    expect(writingPath(writing!.head)).toBe("mocks/07.html");
  });

  it("says nothing about a path it has only seen half of", () => {
    // The whole point of reading a partial value: a path shown half-typed is worse than no path.
    expect(writingPath('{"path": "mocks/07.ht')).toBeUndefined();
  });

  it("keeps one call's arguments out of another's, when two blocks interleave", () => {
    const writing = foldAll([blockStart("show_artifact", 0), inputDelta('{"path": "a.html"', 0), inputDelta('{"path": "b.html"', 1)]);
    expect(writingPath(writing!.head)).toBe("a.html");
  });

  it("ends the row when the block stops — the call exists now, and has a row of its own", () => {
    const stop = stream({ type: "content_block_stop", index: 0 });
    expect(foldAll([blockStart("show_artifact"), inputDelta('{"path": "a.html"'), stop])).toBeUndefined();
  });

  it("draws it as the last row of the live tail, with the size so far", () => {
    const entries = entriesOf(session([] as never), [], {
      text: "",
      writing: { name: "show_artifact", index: 0, chars: 15805, head: '{"path": "dating-mocks/06-wiki.html", "content": "<!DOC' },
    });
    expect(entries).toEqual([{ kind: "writing", name: "show_artifact", path: "dating-mocks/06-wiki.html", chars: 15805 }]);
  });

  it("is bookkeeping, and so is kept out of the item list it would otherwise fill", () => {
    expect(isStreamBookkeeping(inputDelta("{"))).toBe(true);
    expect(isStreamBookkeeping({ kind: "message", role: "assistant", content: {} })).toBe(false);
  });
});

describe("a page the model made, in the conversation that asked for it", () => {
  /** What `show_artifact` returns when the bytes fit inline — the common case. */
  const envelope = { path: "mocks/07.html", mediaType: "text/html", bytes: 42, uri: "artifact://t/mocks/07.html", content: "<p>hi</p>" };

  it("recognises a result that says what its bytes ARE, whatever tool returned it", () => {
    // Read off the RESULT, not the tool's name: `show_artifact` reaches an agent under several
    // names, and a name test would answer wrongly the first time a transport added another.
    expect(producedArtifact(envelope as never)).toEqual(envelope);
    expect(producedArtifact({ path: "src/a.ts", bytes: 12 } as never)).toBeUndefined();
    expect(producedArtifact({ ok: true, content: "not an artifact" } as never)).toBeUndefined();
  });

  it("leaves an artifact too large to inline where the panel can open it", () => {
    // Above `inlineMaxBytes` the envelope is metadata and a uri; unfolding a fetch into the middle
    // of a conversation unasked is not what the row is for.
    expect(producedArtifact({ path: "mocks/07.html", mediaType: "text/html", bytes: 400_000, uri: "artifact://t/mocks/07.html" } as never)).toBeUndefined();
  });

  it("never folds a produced page away, however far back in the block it is", () => {
    const step = (n: number): TranscriptEntry => ({ kind: "tool", name: "bash", summary: `step ${n}` });
    const drew: TranscriptEntry = { kind: "tool", name: "show_artifact", summary: "mocks/07.html", result: envelope as never };
    const entries = [drew, step(1), step(2), step(3), step(4), step(5), step(6)] as never[];
    const shown = unfoldable(entries, 2);
    // The five recent steps, and the page from before them — the fold hides the older half because
    // the question is "what has it done lately", and that is false of a page you asked for.
    expect(shown.map((r) => r.index)).toEqual([0, 2, 3, 4, 5, 6]);
    expect(unfoldable(entries, 0).map((r) => r.index)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
});

describe("what the model is doing right now, as one line", () => {
  const tail = (over: Partial<Parameters<typeof liveStatusOf>[1] & object>) => ({ text: "", ...over }) as never;

  it("says nothing at all when nothing is running", () => {
    // An unanswered call is not proof of activity: a record that ended mid-flight keeps one forever,
    // and reporting that as a run in progress is a bar that lies about last week.
    const stalled: TranscriptEntry[] = [{ kind: "tool", name: "bash", summary: "npm test" }];
    expect(liveStatusOf(stalled, null, false)).toBeNull();
    expect(liveStatusOf(stalled, null, true)).toMatchObject({ kind: "running", name: "bash", summary: "npm test" });
  });

  it("reads the furthest-along state, because each step ends the one before it", () => {
    // A text tail beside a running thinking clock means the thinking is over; a half-written
    // argument list means the answer is.
    expect(liveStatusOf([], tail({ thinkingStartedAt: 100 }), true)).toMatchObject({ kind: "thinking", since: 100 });
    expect(liveStatusOf([], tail({ text: "Here", textStartedAt: 400, thinkingStartedAt: 100 }), true)).toMatchObject({
      kind: "answering",
      since: 400,
    });
    expect(
      liveStatusOf([], tail({ text: "Here", textStartedAt: 400, writing: { name: "show_artifact", chars: 900, head: '{"path": "a.html"' } }), true),
    ).toMatchObject({ kind: "writing", name: "show_artifact", path: "a.html", chars: 900 });
  });

  it("waits on the NEWEST unanswered call, since parallel ones settle one at a time", () => {
    const entries: TranscriptEntry[] = [
      { kind: "tool", name: "read_file", summary: "a.ts", ok: true, result: {} },
      { kind: "tool", name: "bash", summary: "npm test", at: 900 },
    ];
    expect(liveStatusOf(entries, null, true)).toMatchObject({ kind: "running", name: "bash", since: 900 });
  });

  it("falls back to the honest floor: a turn has started and has said nothing", () => {
    expect(liveStatusOf([], null, true)).toEqual({ kind: "working" });
  });
});

describe("a tool result, out of the envelope the transport put it in", () => {
  /** How MCP actually delivers a return value: serialized, in a text block, in an array. */
  const mcp = (text: string) => [{ type: "text", text }];

  it("recovers the value a tool returned, so its readers see what it sent", () => {
    // OBSERVED, from a stored conversation: `show_artifact` returns an envelope and the record holds
    // this. Every reader downstream was reading the array — which is why the page never rendered.
    const envelope = { path: "mocks/04.html", mediaType: "text/html", bytes: 10951, uri: "artifact://t/mocks/04.html", content: "<!DOCTYPE html>" };
    expect(resultValueOf(mcp(JSON.stringify(envelope)) as never)).toEqual(envelope);
    expect(producedArtifact(resultValueOf(mcp(JSON.stringify(envelope)) as never))).toEqual(envelope);
  });

  it("marks a failed MCP call as failed, which the envelope was hiding", () => {
    const failed = toolsOf([
      { role: "assistant", parts: [{ type: "tool_use", id: "c1", name: "mcp__dai__write_file", input: { path: "a" } }] },
      { role: "user", parts: [{ type: "tool_result", tool_use_id: "c1", content: mcp('{"error":"no path given"}') }] },
    ]);
    expect(failed[0]).toMatchObject({ ok: false });
  });

  it("leaves alone anything that is not purely text blocks, losing nothing", () => {
    const mixed = [{ type: "text", text: "{}" }, { type: "image", source: { data: "…" } }];
    expect(resultValueOf(mixed as never)).toEqual(mixed);
    expect(resultValueOf([] as never)).toEqual([]);
    expect(resultValueOf({ ok: true } as never)).toEqual({ ok: true });
  });

  it("keeps prose as prose — only an object or an array is read as a value", () => {
    // A tool whose whole answer is a word returns that word, and `12` stays the string a text block
    // said it was.
    expect(resultValueOf(mcp("done") as never)).toBe("done");
    expect(resultValueOf(mcp("12") as never)).toBe("12");
    // Truncated output begins like JSON and is not any; showing the text beats showing nothing.
    expect(resultValueOf(mcp('{"path": "a.html", "cont') as never)).toBe('{"path": "a.html", "cont');
  });
});

/**
 * A message that is not prose but the call's structured output, serialized.
 *
 * Main decides WHICH turn that is (see `structuredOutput.test.ts`); this is the other half — the
 * value reaching the entry the viewer draws, at the turn main named and at no other.
 */
describe("a structured output that arrived as text", () => {
  const value = { matched: false, working_set: ["docs/product/index.md"] } as JsonValue;
  const schema = { type: "object" } as JsonValue;
  const withOutput = (outputs: SessionView["outputs"]): TranscriptEntry[] =>
    entriesOf({
      ...session([
        { role: "user", text: "does the catalog cover this?" },
        { role: "assistant", text: JSON.stringify(value) },
      ]),
      ...(outputs !== undefined ? { outputs } : {}),
    });

  const messages = (entries: TranscriptEntry[]) => entries.filter((e) => e.kind === "message");

  it("carries the value and the schema onto the message at that turn", () => {
    const said = messages(withOutput([{ turn: 1, value, schema }]));
    expect(said[1]).toMatchObject({ role: "assistant", output: { value, schema } });
    // The text stays. It is what the model actually wrote, and the `Source` toggle over every
    // assistant message is what a reader gets back to it with.
    expect(said[1]).toMatchObject({ text: JSON.stringify(value) });
  });

  it("leaves every other message alone", () => {
    const said = messages(withOutput([{ turn: 1, value, schema }]));
    expect(said[0]).toMatchObject({ role: "user" });
    expect("output" in said[0]!).toBe(false);
  });

  it("renders as text when main named no output — which is most conversations", () => {
    expect(messages(withOutput(undefined)).every((m) => !("output" in m))).toBe(true);
  });

  it("places it by TURN index, not by position in the entry list", () => {
    // The entries are a weave — thoughts, tool rows and journal facts are in here too — so the two
    // coordinates are different numbers, and an output placed by the wrong one lands on the wrong
    // message. See `MessageEntry.turn`.
    const entries = entriesOf({
      ...session([
        { role: "assistant", parts: [{ type: "thinking", thinking: "checking" }] },
        { role: "user", text: "and now?" },
        { role: "assistant", text: JSON.stringify(value) },
      ]),
      outputs: [{ turn: 2, value }],
    });
    const carried = entries.filter((e) => e.kind === "message" && e.output !== undefined);
    expect(carried).toHaveLength(1);
    expect(carried[0]).toMatchObject({ turn: 2, output: { value } });
  });
});

/**
 * The other delivery route: a tool call whose arguments ARE the output.
 *
 * The row stays — it is a real call with a real id — and the value rides the `shown` slot, the same
 * one a page a call produced does. Attaching by CALL ID rather than by position is what makes that
 * work across a thread: `tool_use` and `tool_result` are on different turns, and records concatenate.
 */
describe("a structured output that arrived through a tool", () => {
  const value = { passed: true, verdict: "it reads as a greeting" } as JsonValue;
  const parts = [
    { type: "tool-call", toolCallId: "c1", toolName: "read_file", args: { path: "a.ts" } },
    { type: "tool-result", toolCallId: "c1", result: { bytes: 4 } },
    { type: "tool-call", toolCallId: "c2", toolName: "StructuredOutput", args: value },
    { type: "tool-result", toolCallId: "c2", result: "Structured output provided successfully" },
  ];
  const built = (): ToolEntry[] =>
    entriesOf({
      ...session([{ role: "assistant", parts }] as never),
      outputs: [{ callId: "c2", value, name: "verdict" }],
    }).filter((e): e is ToolEntry => e.kind === "tool");

  it("lands the value on the call main named, and on no other", () => {
    const [read, delivered] = built();
    expect(read).toMatchObject({ name: "read_file" });
    expect(read!.output).toBeUndefined();
    expect(delivered).toMatchObject({ name: "StructuredOutput", output: { value, name: "verdict" } });
  });

  it("leaves the call's own arguments and result intact", () => {
    // The row is not replaced, so nothing about the call is lost — including the acknowledgement,
    // which is uninformative and is still what the record says came back.
    const delivered = built()[1]!;
    expect(delivered.args).toEqual(value);
    expect(delivered.result).toBe("Structured output provided successfully");
    expect(delivered.ok).toBe(true);
  });

  it("survives the fold, however early in the loop it was called", () => {
    // Agent transports emit it mid-loop and then go on to summarise, so the answer is routinely the
    // oldest interesting row in a long block — exactly what the fold hides. See `unfoldable`.
    const answer: ToolEntry = { kind: "tool", name: "StructuredOutput", summary: "", callId: "c2", output: { value } };
    const noise: ToolEntry[] = Array.from({ length: 9 }, (_, i) => ({ kind: "tool", name: "bash", summary: `step ${i}` }));
    const kept = unfoldable([answer, ...noise], 5).map(({ entry }) => entry);
    expect(kept).toContain(answer);
    expect(kept).toHaveLength(6);
  });
});
