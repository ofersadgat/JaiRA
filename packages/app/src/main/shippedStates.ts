/**
 * The versions of its built-in states JaiRA has shipped, and the test for "is this file one of them".
 *
 * Until decision 0006 step 2 the chat states and the self-test were WRITTEN into `~/.jaira` — by the
 * Chat view before its first message and by the Debug pane — so every machine that used either has
 * copies there. They still work: a file in the shared root shadows the built-in one, which is what
 * an override is. But these were never meant as overrides, and one left in place pins that machine
 * to the version it was installed at, for ever, without anybody having decided that.
 *
 * So the app OFFERS to delete a copy it can prove nobody changed — never silently, and never one
 * that differs from everything here by so much as a description. What "shipped" means is two lists:
 *
 *  - the CURRENT version, which is not written down here at all. It is whatever the built-in layer
 *    holds, read at the moment of asking, so it cannot drift from the file that actually ships.
 *  - {@link SUPERSEDED}: what earlier builds installed. Kept by hand, because those generators are
 *    gone — each entry is what `chatWorkflowFiles()` / `selfTestFiles()` returned at the commit named.
 *
 * When a built-in file changes, the value it HAD goes in the list below in the same commit. Nothing
 * enforces that, and the cost of forgetting is only that a stale copy stops being offered for
 * deletion — it is never that a person's file is deleted wrongly.
 *
 * Compared as parsed VALUES with object keys in any order: re-indenting a file, or a formatter that
 * sorts keys, is not an edit. Array order is an edit (`sequence` is one).
 */
import type { JsonValue } from "@declarative-ai/json";

const MESSAGE_INPUT = {
  message: {
    schema: { type: "string" },
    description: "What the person typed to start the conversation.",
  },
};

/** What earlier builds wrote, by state id. The current version is read from the layer instead. */
export const SUPERSEDED: Readonly<Record<string, readonly JsonValue[]>> = {
  // As of e808e50 — the two chat states still declared `conversation.mode`; f240a38 removed it.
  "chat/assistant": [
    {
      label: "Conversation",
      description:
        "A conversation with a model, started from the Chat view. The first message is this state's prompt; the rest continue it. No tools: it reads what you give it and answers.",
      inputs: MESSAGE_INPUT,
      environment: { kind: "prompt", conversation: { mode: "full_history" } },
      operation: { prompt: "{{.inputs.message}}" },
    },
  ],
  "chat/agent": [
    {
      label: "Working conversation",
      description:
        "A conversation that works in the project, started from the Chat view. Same thread as the plain conversation, plus JaiRA's tools — so it can read files, write them and run commands, each gated by the project policy.",
      inputs: MESSAGE_INPUT,
      environment: {
        kind: "prompt",
        conversation: { mode: "full_history" },
        tools: ["bash", "read_file", "write_file"],
        permissions: { profile: "full", default: "ask" },
      },
      operation: { prompt: "{{.inputs.message}}" },
    },
    // As of cd92ec6 — the old tools LIST and `permissions` block; decision 0007's removal of that
    // form rewrote it as a toolset map.
    {
      label: "Working conversation",
      description:
        "A conversation that works in the project, started from the Chat view. Same thread as the plain conversation, plus JaiRA's tools — so it can read files, write them and run commands, each gated by the project policy.",
      inputs: MESSAGE_INPUT,
      environment: {
        kind: "prompt",
        tools: ["bash", "read_file", "write_file"],
        permissions: { profile: "full", default: "ask" },
      },
      operation: { prompt: "{{.inputs.message}}" },
    },
  ],
  // As of 586be8a — bindings still read a child's `.outputs.`; de5b5bb made them `.output.`.
  "debug/hello_world": [
    {
      label: "Hello-world self-test",
      description:
        "Two prompt states: one says hello world, the next reads what it said and judges it. Run from the Debug view.",
      environment: { kind: "prompt" },
      outputs: {
        greeting: { schema: { type: "string" }, binding: ".children.say.outputs.greeting" },
        passed: { schema: { type: "boolean" }, binding: ".children.check.outputs.passed" },
        verdict: { schema: { type: "string" }, binding: ".children.check.outputs.verdict" },
      },
      children: {
        say: {},
        check: { inputs: { greeting: ".children.say.outputs.greeting" } },
      },
      sequence: ["say", "check"],
    },
  ],
};

/** One value with every object's keys sorted, so two spellings of the same document print alike. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
  );
}

/** True when two parsed documents are the same VALUE — key order and formatting aside. */
export function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

/**
 * Which shipped version a person's file is identical to, if any.
 *
 * `text` is the person's file; `shippedText` is the built-in layer's file of the same id, or
 * `undefined` when the layer no longer ships one. A file that does not parse is identical to
 * nothing: it is somebody's work in progress, and the last thing to offer to delete.
 */
export function identicalTo(
  stateId: string,
  text: string,
  shippedText: string | undefined,
): "current" | "superseded" | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (shippedText !== undefined) {
    try {
      if (sameValue(value, JSON.parse(shippedText))) return "current";
    } catch {
      // A shipped file that does not parse is a broken build, and says nothing about this copy.
    }
  }
  return (SUPERSEDED[stateId] ?? []).some((old) => sameValue(value, old)) ? "superseded" : undefined;
}
