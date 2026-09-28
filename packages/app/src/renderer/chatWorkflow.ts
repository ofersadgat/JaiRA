/**
 * What a conversation IS, as a workflow — the two states the Chat view starts its tasks from.
 *
 * A conversation in this app is not a fourth kind of thing beside states, runs and tasks. It is a
 * task whose workflow happens to be one leaf that says what you typed, and every mechanism the rest
 * of the app already has then applies to it unchanged: the message is journaled, the reply is a
 * session record, the tool calls go through the policy, an approval parks in the same strip, the
 * transcript is read by the same viewer, and the whole thing is on the board and in the history
 * beside the runs. Nothing here is privileged, which is also why these are ordinary state FILES: they
 * ship in the built-in layer (`packages/shared/builtin/workflows/chat/`, decision 0006), where the
 * Files tree lists them like any others — a conversation you can open and read is one you can trust
 * the description of, and one you want changed is a copy of that file in `~/.jaira` or the project.
 * This module used to generate them and the Chat view used to write them into the shared root before
 * its first message. Neither happens now: nothing is installed, so a machine whose shared root is
 * empty, repointed or read-only still starts a conversation.
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
 * ## One state the view starts, and it never asks which
 *
 * The Chat view starts every new conversation as {@link CHAT_SESSION}, holding the project's tools
 * and the workflow tools, every call asking first. There is no "plain" conversation to pick instead:
 * asking would be a permission question in the shape of an identity question, put before the person
 * had typed the thing that would answer it — and the answer costs nothing either way, because a
 * granted tool that is never invoked is indistinguishable from an absent one. The composer can still
 * strip the tools off any single message.
 *
 * Neither state names a `model`. A state that pinned one would be a conversation that ignores the machine
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
// Which tasks are conversations lives in `@jaira/shared` (`task.ts`): the engine archives tasks by themselves
// and leaves conversations alone, so it has to ask the same question the Chat view does.
export { CHAT_CONTROL, CHAT_SESSION, CHAT_STATES, DYNAMIC_WORKFLOW_PREFIX, isChatWorkflow, type ChatKind } from "@jaira/shared/browser";
import { CHAT_STATES, DYNAMIC_WORKFLOW_PREFIX, SHARED_SESSION, isChatWorkflow, type TaskSummary } from "@jaira/shared/browser";

/** What `task:all` is asked for to list every conversation — the states, and the dynamic namespace. */
export const CHAT_LIST_WORKFLOWS: readonly string[] = [...CHAT_STATES, DYNAMIC_WORKFLOW_PREFIX];

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

/**
 * Which project the Chat view reads and writes — the rule, so it can be stated once and tested.
 *
 * **A chat call always names its project.** Left unnamed, main resolves "the focused project", and
 * that answers only while exactly one user project is open: it throws `no project is open` on a
 * window standing on `~/.jaira` — a shared session is not a user one — and `several projects are
 * open, so this call must name one` the moment a second checkout is, which is the arrangement this
 * shell exists for. Every read the view makes went through that resolution: the thread, the artifact
 * list, the plan the composer shows before the first message, and the `@` completion per keystroke.
 *
 * Three answers, in order:
 *
 *  - the OPEN conversation's own project. It is what `openConversation` was already being told and
 *    what nothing was reading, so a thread opened from the root list — which spans every project —
 *    was read out of whichever database main resolved rather than the one holding it.
 *  - the project the address is standing on: where a new conversation goes, and what the composer's
 *    plan is read from.
 *  - the shared root at the root of the address, where there is no project to stand in. The same
 *    rule `runTargetOf` gives base-layer workflows, and the one project that means the same thing in
 *    every window.
 */
export function chatProjectOf(open: string | null, at: string | null): string {
  return open ?? at ?? SHARED_SESSION;
}

/** Which of a project's tasks are conversations — the list the Chat drawer shows. */
export function conversationsOf(tasks: readonly TaskSummary[]): TaskSummary[] {
  return tasks.filter((task) => isChatWorkflow(task.workflow));
}
