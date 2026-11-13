/**
 * A conversation's NAME, asked of a small model once the person has said what it is about.
 *
 * A conversation is born named after its first line (`openingTitleOf`), which is the best guess
 * available before anything else happens and a poor name for a list: "look at the failing test" names
 * half of them, and a long first sentence is cut off mid-thought. The window used to wait for the
 * agent's own name — an `ai-title` line Claude Code wrote into its session file — but a headless run
 * (`claude -p`, which is how JaiRA runs Claude) writes none, so no conversation JaiRA started was ever
 * renamed (2026-11-13: none of the 14 Claude sessions in the shared database carried one). The engine
 * asks for the name itself now, with one bare call: no session, no tools, no gate.
 *
 * Pure: the call and the reading of its answer. The service decides when (`titleConversation`).
 */
import { promptOp, type ExecServices, type InlineFamily, type PromptOp } from "@declarative-ai/exec";
import type { JsonValue } from "@declarative-ai/json";
import { SchemaValidator } from "@declarative-ai/validate";
import type { FakeRule } from "./fakeExecutor";

/**
 * The model the name is asked of: the `simple` preset (built-in settings), the same fast, cheap pick
 * the `smart` permission judge defaults to — a name is a few words, and the person is waiting for
 * nothing but the list to read better.
 */
export const CONVERSATION_TITLE_MODEL = "simple";

/** The longest name kept — the birth name's own limit, so a list reads the same before and after. */
const MAX_TITLE = 60;

/** How much of the opening the model reads: a name needs the gist, not a pasted log in full. */
const MAX_OPENING = 4000;

const TITLE_OUTPUT_SCHEMA = {
  type: "object",
  required: ["title"],
  additionalProperties: false,
  properties: {
    title: { type: "string", description: "Three to six words naming what the conversation is about." },
  },
} as const;

/** The whole of what the namer is told it is — on the Claude CLI, IN PLACE of the agent's own preset. */
const TITLE_SYSTEM = "You name conversations for a list of conversations. You answer with the name and nothing else.";

/**
 * The one call: the opening message in, a short name out.
 *
 * On the Claude CLI it runs bare, and each part of that is measured, not tidiness (2026-11-13, Haiku,
 * "Say ok"): with only the tools off it read 166,081 input tokens — the agent's preset, the person's
 * CLAUDE.md and memory, every plugin's skills — and the first call, writing all that to the cache,
 * cost $0.36; with its own system prompt (`systemPrompt`) and no settings loaded (`settingSources: []`)
 * it read 690 and cost $0.0009.
 *
 *  - tools off (`toolChoice: "none"`): a name needs none.
 *  - its own system prompt and no setting sources: see above.
 *  - no session kept (`--no-session-persistence`): this call is bookkeeping about a conversation, and
 *    a session file of its own would be one more "conversation" in every list that reads
 *    `~/.claude/projects`.
 */
export function conversationTitleOperation(opening: string): PromptOp<InlineFamily> {
  const text = opening.length <= MAX_OPENING ? opening : `${opening.slice(0, MAX_OPENING)}\n[…]`;
  const user = [
    "Name this conversation for a list of conversations. It opened with the message below.",
    "",
    "Answer with `title`: three to six words saying what it is about, in sentence case, with no quotes and no closing punctuation. Name the subject (\"Side panel for artifacts\"), not the request (\"User wants a side panel\"). Write it in the language the message is written in.",
    "",
    "## The opening message",
    "",
    "<message>",
    text,
    "</message>",
  ].join("\n");
  return promptOp({
    user,
    config: {
      model: CONVERSATION_TITLE_MODEL,
      toolChoice: "none",
      providerOptions: {
        claudeCode: { systemPrompt: TITLE_SYSTEM, settingSources: [], extraArgs: { "no-session-persistence": null } },
      },
    },
    output: { name: "title", schema: TITLE_OUTPUT_SCHEMA as never },
  });
}

/**
 * The name out of the model's answer, or `undefined` when it gave none worth keeping.
 *
 * Takes `{ title }` and, for a route that answered in plain text, the text itself. One line, its
 * wrapping quotes and closing full stop gone, cut to the birth name's limit.
 */
export function conversationTitleFrom(value: JsonValue | undefined): string | undefined {
  const raw =
    typeof value === "string"
      ? value
      : value !== null && typeof value === "object" && !Array.isArray(value) && typeof value["title"] === "string"
        ? value["title"]
        : undefined;
  if (raw === undefined) return undefined;
  const line = raw.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
  const bare = line
    .replace(/^["'“‘`]+|["'”’`]+$/g, "")
    .replace(/[.。]+$/, "")
    .trim();
  if (bare === "") return undefined;
  return bare.length <= MAX_TITLE ? bare : `${bare.slice(0, MAX_TITLE - 3).trimEnd()}…`;
}

/**
 * Which of a scripted run's fake rules may answer the title call: only those that name its model.
 *
 * A script written for a run's own calls — a catch-all `{ output: "hi" }` is the common one — would
 * otherwise answer this call too, and every scripted conversation would be renamed "hi" behind the
 * test's back. A script that wants a name says so: `{ model: "simple", output: { title: "…" } }`.
 */
export function titleRulesOf(rules: readonly FakeRule[]): FakeRule[] {
  return rules.filter((rule) => rule.model === CONVERSATION_TITLE_MODEL);
}

/** What the bare call runs under: a validator and nothing else — no session, no tools, no gate. */
export function conversationTitleServices(): ExecServices {
  return { validator: new SchemaValidator() };
}
