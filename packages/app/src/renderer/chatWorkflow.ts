/**
 * What a conversation IS, as a workflow — the two states the Chat view starts its tasks from.
 *
 * A conversation in this app is not a fourth kind of thing beside states, runs and tasks. It is a
 * task whose workflow happens to be one leaf that says what you typed, and every mechanism the rest
 * of the app already has then applies to it unchanged: the message is journaled, the reply is a
 * session record, the tool calls go through the policy, an approval parks in the same strip, the
 * transcript is read by the same viewer, and the whole thing is on the board and in the history
 * beside the runs. Nothing here is privileged, which is also why these are ordinary files installed
 * through `workflow:write` — the same route `debugWorkflow.ts` takes, for the same reason: a
 * conversation you can open, read and edit in the Files tree is one you can trust the description of.
 *
 * ## The first message is the run; the rest are chat turns
 *
 * The prompt is `{{.inputs.message}}` and the task is created with that input, so starting the task
 * IS sending the first message. Every message after it goes through `chat:send`, which continues the
 * same conversation as a child of that instance (`chatTurn.ts`). This is the whole reason the state
 * is a leaf with no children and no outputs: nothing binds to what is said here, so there is nothing
 * for the state machine to do after the first turn, and a conversation that ran the machine again
 * per message would be fifty runs of a workflow rather than one conversation.
 *
 * ## Two states, and only one of them is offered
 *
 * The difference between them is whether the conversation can TOUCH ANYTHING:
 *
 *  - {@link CHAT_ASSISTANT} declares no tools. It is a conversation with a model: it reads what you
 *    paste and writes what it says, and cannot run a command or open a file on its own.
 *  - {@link CHAT_AGENT} declares JaiRA's three, a `full` profile and an `ask` default, so the same
 *    conversation works in the project — the reading, editing, command-running loop, with each call
 *    gated by the project policy exactly as a workflow's would be, and every one of them stopping to
 *    ask until somebody says otherwise.
 *
 * The Chat view starts every new conversation as the AGENT one. Asking first was asking a permission
 * question in the shape of an identity question, before the person had typed the thing that would
 * answer it — and the answer costs nothing either way, because a granted tool that is never invoked
 * is indistinguishable from an absent one. `chat/assistant` stays installed and readable: it is what
 * conversations already started as one continue to run, and the composer can still strip the tools
 * off any single message.
 *
 * Neither names a `model`. A state that pinned one would be a conversation that ignores the machine
 * it is running on — and on a machine set up with an agent CLI and no API key, one of the two would
 * simply not run.
 *
 * ## Why the agent state is not `kind: "function"`
 *
 * A delegated agent reached as a function op would be one call with its own loop inside it, which is
 * a fine way to run a state and a poor way to have a conversation: the composer, the steering, the
 * position chain and the edit-and-resend below all address a PROMPT op's session. A prompt state
 * whose route is an agent CLI is the same agent, in a conversation this app can continue.
 */
import type { JsonValue } from "@declarative-ai/json";

/** The plain conversation: a model, and nothing of this machine. */
export const CHAT_ASSISTANT = "chat/assistant";
/** The working conversation: the same thread, with the project's tools under the project's policy. */
export const CHAT_AGENT = "chat/agent";

/** Every state the Chat view installs, in the order its "new conversation" menu lists them. */
export const CHAT_STATES = [CHAT_ASSISTANT, CHAT_AGENT] as const;

/** Which conversation a task is: the workflow it was created from, or `null` for a task that is not one. */
export type ChatKind = (typeof CHAT_STATES)[number];

/** True for a task the Chat view owns — its workflow is one of {@link CHAT_STATES}. */
export function isChatWorkflow(workflow: string | undefined): workflow is ChatKind {
  return workflow !== undefined && (CHAT_STATES as readonly string[]).includes(workflow);
}

/**
 * The state files, keyed by state id — the shape `workflow:write` takes.
 *
 * `conversation.mode` is stated rather than left to default because a conversation is the one kind
 * of call where the whole transcript is the point: the default is a fresh stream per operation, and
 * a chat that forgot everything it had said between messages would be a chat in name only.
 */
export function chatWorkflowFiles(): Record<string, JsonValue> {
  const message = {
    message: {
      schema: { type: "string" },
      description: "What the person typed to start the conversation.",
    },
  };
  return {
    [CHAT_ASSISTANT]: {
      label: "Conversation",
      description:
        "A conversation with a model, started from the Chat view. The first message is this state's prompt; the rest continue it. No tools: it reads what you give it and answers.",
      inputs: message,
      environment: { kind: "prompt" },
      operation: { prompt: "{{.inputs.message}}" },
    },

    [CHAT_AGENT]: {
      label: "Working conversation",
      description:
        "A conversation that works in the project, started from the Chat view. Same thread as the plain conversation, plus JaiRA's tools — so it can read files, write them and run commands, each gated by the project policy.",
      inputs: message,
      environment: {
        kind: "prompt",
        // The GRANT, and then the fence. On a delegated agent route the list does not take the
        // agent's own built-ins away (WORKFLOWS.md §5.1) — the profile is what governs those, and
        // `full` is the honest name for "this conversation may change things", with the project
        // policy and the approval strip deciding each call underneath it.
        tools: ["bash", "read_file", "write_file"],
        // `ask` is STATED rather than left to fall through to it. It is the same mode either way —
        // an unset default ends at `ask` in the ledger — but this is the file somebody opens to find
        // out what a conversation is allowed to do, and "every call stops and asks" is the answer,
        // not something to be inferred from the absence of a line. It is also what makes this the
        // only kind of conversation the view needs to offer: the tools are here, and nothing uses
        // one without being told to.
        permissions: { profile: "full", default: "ask" },
      },
      operation: { prompt: "{{.inputs.message}}" },
    },
  };
}

/**
 * A conversation's name, from the words it opened with.
 *
 * The same rule every chat client uses, and for the same reason: a list of conversations all called
 * "Conversation" is a list you have to open to read. The first line beats the first N characters —
 * a pasted stack trace names itself by its first line, and cutting mid-word through paragraph two
 * names it by nothing.
 */
export function titleOf(message: string): string {
  const line = message.trim().split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
  if (line === "") return "New conversation";
  return line.length <= 60 ? line : `${line.slice(0, 57).trimEnd()}…`;
}
