/**
 * A conversation as a PROGRAM (decision 0029 §2): a loop over `input()`, each message one pass —
 * the reply, then a strict look at whether the person just corrected the conversation, then the next
 * message. A clear correction starts `improve/lesson` on its own, so the reply never waits for it; and
 * when the person ends the conversation (or it sits idle), `improve/conversation` reads the whole of it.
 *
 * Everything here is ordinary code: change what is checked, when the improver runs, or turn it off,
 * by copying this file into a layer above and editing it — or let a lesson do that.
 */
import { llm, input } from "@declarative-ai/hw/script";
import { conversation_digest, start_task } from "$REGISTRY";

export const meta = {
  name: "Program session",
  description: "A conversation that is a program: a loop over the person's messages that also notices clear corrections and turns them into lessons, and reviews the whole conversation for lessons when it ends.",
  environment: { tools: "$/permission-sets/ask-first" },
};

const SYSTEM = "You are a working conversation inside JaiRA, a tool that runs workflows of states over a project. You can work in the project directly with the file, shell and web tools. You can also run the project's workflows with the workflow tools: `list_workflows` lists them and says what a state takes and produces, a level at a time; `start_task` starts a state as a child of this conversation; `move_task` sends a task to another state; `list_tasks` says what was started here, where each stands and what it produced; `hold_task`, `release_task` and `stop_task` do what the board's gestures do; `answer_question` settles a question a task is asking.\n\nRead a workflow's descriptions before starting it, and start the smallest state that does what was asked. `start_task` and `move_task` take the target's inputs. Supply a value only when what has been said in this conversation determines it; otherwise ask the person for it in words, one short question, and call again with the answer, naming it in `asked`. When a call comes back with `missing`, it has done nothing: supply what is listed and call it again. Never invent a value to get past a required input.\n\nWhen the person wants a design or a mock-up, in whatever words and whether or not they type `/design`, make it a design canvas: your first call, before you write any file, is `show_artifact` with `action: \"quickstart\"` and `intent: \"design\"`, and then you do what it answers. The person sees a canvas they can edit, not a page. A page or a Markdown document, published with `file_path`, is for what is not a design: a report, a chart, a table.\n\nWhen you want the person to see a file (a screenshot, a picture, a page, a log, a diff, a table), show it with `show_artifact`: `artifacts` names it by its path, a web address, a file of an artifact, or its data sent in the call. Don't name a path for them to go and open. Several pictures in one call are shown side by side.";

/** The strict per-message look (decision 0029 §6): only a clear-cut correction is acted on now. */
const NOTICE = `You check ONE message a person just sent in a conversation with an agent: did it correct how the agent works, clearly enough that the workflow should change so the person never has to say it again?

Answer "clear" only when it is unmistakable: an explicit standing rule ("never…", "always…", "don't…", "I told you…", "stop doing…"), or a direct correction of something the agent did that would recur. Answer "maybe" when it might be such a correction but could also be a one-off. Answer "none" for everything else — a new request, a question, a change of mind, a fact about this task, thanks. Most messages are "none".

For "clear" and "maybe", state the lesson as one rule, and quote the person's words that showed it.`;

interface Verdict {
  verdict: "clear" | "maybe" | "none";
  lesson: string;
  quote: string;
}

export default async function program(
  message: string,
  improve: boolean = true,
  approval: string = "propose",
): Promise<{ turns: number; lessons: number }> {
  let text: string | null = message;
  let conv: { id: string } | null = null;
  let turns = 0;
  let lessons = 0;
  let since = 0;
  while (text !== null) {
    const reply = await llm({ prompt: text, system: SYSTEM, session: conv, withSession: true, label: "reply" });
    conv = reply.session;
    turns = turns + 1;
    if (improve && turns > 1) {
      // Strict, per message: only a clear-cut correction is acted on now (decision 0029 §6). The
      // improver runs on its own, so the conversation never waits for it.
      const recent = await conversation_digest({ session: conv, last: 4 });
      const seen = await llm<Verdict>({ prompt: "The person's message: " + text + "\n\nThe conversation around it:\n" + JSON.stringify(recent.messages, null, 2), system: NOTICE, config: { configRef: "simple" }, label: "notice" });
      if (seen.verdict === "clear") {
        await start_task({ workflow: "improve/lesson", title: "Lesson: " + seen.lesson, inputs: { lesson: seen.lesson, workflow: recent.workflow, context: { task: recent.task, session: conv }, approval } });
        lessons = lessons + 1;
      }
    }
    const next = await input({ prompt: "Your next message", idle: "4h" });
    if (next !== null && next.idle === true) {
      if (improve && turns > since) {
        await start_task({ workflow: "improve/conversation", title: "Review a conversation for lessons", inputs: { context: { session: conv }, approval } });
        since = turns;
      }
      const after = await input({ prompt: "Your next message" });
      text = after !== null && after.idle !== true ? after.text : null;
    } else {
      text = next !== null ? next.text : null;
    }
  }
  if (improve && turns > since) {
    await start_task({ workflow: "improve/conversation", title: "Review a conversation for lessons", inputs: { context: { session: conv }, approval } });
  }
  return { turns, lessons };
}
