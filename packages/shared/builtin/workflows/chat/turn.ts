/**
 * ONE MESSAGE of a conversation that is a program (decision 0029 §2–§3): the reply, then — when asked —
 * a strict look at whether the person's message corrected the conversation, and on a clear correction
 * the improver started on its own. `chat/program` calls this once per message, and that call is where a
 * running conversation takes a newer version of it: a lesson that changes how a conversation answers
 * changes THIS file, and the next message runs it.
 */
import { llm } from "@declarative-ai/hw/script";
import { conversation_digest, start_task } from "$REGISTRY";

export const meta = {
  name: "One message",
  description: "One message of a program conversation: the reply, and a strict check of whether the person's message clearly corrected the conversation, which starts improve/lesson when it did.",
  environment: { tools: "$/permission-sets/ask-first" },
};

const SYSTEM = "You are a working conversation inside JaiRA, a tool that runs workflows of states over a project. You can work in the project directly with the file, shell and web tools. You can also run the project's workflows with the workflow tools: `list_workflows` lists them and says what a state takes and produces, a level at a time; `start_task` starts a state as a child of this conversation; `move_task` sends a task to another state; `list_tasks` says what was started here, where each stands and what it produced; `hold_task`, `release_task` and `stop_task` do what the board's gestures do; `answer_question` settles a question a task is asking.\n\nRead a workflow's descriptions before starting it, and start the smallest state that does what was asked. `start_task` and `move_task` take the target's inputs. Supply a value only when what has been said in this conversation determines it; otherwise ask the person for it in words, one short question, and call again with the answer, naming it in `asked`. When a call comes back with `missing`, it has done nothing: supply what is listed and call it again. Never invent a value to get past a required input.\n\nWhen the person wants a design or a mock-up, in whatever words and whether or not they type `/design`, make it a design canvas: your first call, before you write any file, is `show_artifact` with `action: \"quickstart\"` and `intent: \"design\"`, and then you do what it answers. The person sees a canvas they can edit, not a page. A page or a Markdown document, published with `file_path`, is for what is not a design: a report, a chart, a table.\n\nWhen you want the person to see a file (a screenshot, a picture, a page, a log, a diff, a table), show it with `show_artifact`: `artifacts` names it by its path, a web address, a file of an artifact, or its data sent in the call. Don't name a path for them to go and open. Several pictures in one call are shown side by side.";

/** The strict per-message look (decision 0029 §6): only a clear-cut correction is acted on now. */
const NOTICE = `You check ONE message a person just sent in a conversation with an agent: did it correct how the agent works, clearly enough that the workflow should change so the person never has to say it again?

Answer "clear" only when it is unmistakable: an explicit standing rule ("never…", "always…", "don't…", "I told you…", "stop doing…"), or a direct correction of something the agent did that would recur. A refused tool call or an edited-and-resent message is strong evidence that the message is a correction; on its own it is a "maybe". Answer "maybe" when it might be such a correction but could also be a one-off. Answer "none" for everything else — a new request, a question, a change of mind, a fact about this task, thanks. Most messages are "none".

For "clear" and "maybe", state the lesson as one rule, and quote the person's words that showed it.`;

interface Verdict {
  verdict: "clear" | "maybe" | "none";
  lesson: string;
  quote: string;
}

// `conv` is the session ref the last message ended at, or null before the first. Typed `unknown` at this
// boundary because the wiring checker does not reason about unions yet (hw SCRIPTS.md §6.2).
// `settings` is what the composer chose for this message — its model and reasoning are used, and one it
// leaves out falls back to the defaults. Optional, so a conversation running an older chat/program, which
// hands no settings, can still take this version (decision 0029 §3: the same inputs).
export default async function turn(
  text: string,
  conv: unknown,
  notice: boolean,
  approval: string,
  settings: unknown = null,
): Promise<{ conv: unknown; lessons: number }> {
  const chosen = (settings ?? {}) as { model?: string; reasoning?: object };
  const reply = await llm({
    prompt: text,
    system: SYSTEM,
    session: conv as { id: string } | null,
    withSession: true,
    label: "reply",
    config: { model: chosen.model, reasoning: chosen.reasoning },
  });
  let lessons = 0;
  if (notice) {
    // The improver runs on its own, so the conversation never waits for it.
    const recent = await conversation_digest({ session: reply.session, last: 4 });
    const seen = await llm<Verdict>({
      prompt:
        "The person's message: " + text +
        "\n\nThe conversation around it:\n" + JSON.stringify(recent.messages, null, 2) +
        "\n\nWhat the record says the person did (refused a tool call, edited and resent a message):\n" + JSON.stringify(recent.signals, null, 2),
      system: NOTICE,
      config: { configRef: "simple" },
      label: "notice",
    });
    if (seen.verdict === "clear") {
      await start_task({ workflow: "improve/lesson", title: "Lesson: " + seen.lesson, inputs: { lesson: seen.lesson, workflow: "chat/turn", context: { task: recent.task, session: reply.session }, approval } });
      lessons = 1;
    }
  }
  return { conv: reply.session, lessons };
}
