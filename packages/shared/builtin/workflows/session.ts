/**
 * The conversation the Chat view starts — a workflow, and so a program (decision 0029 §2): a loop over
 * the person's messages. For each one: the reply; then, from the second on, a strict look at whether the
 * message corrected the conversation, which starts `improve/lesson` on its own when it clearly did; then
 * the wait for the next message. When the person ends the conversation, or it sits idle, the whole of it
 * is reviewed for lessons (`improve/conversation`).
 *
 * The wait — `input()` — is where a RUNNING conversation takes a newer version of this file (decision
 * 0029 §3): a lesson that changes how it answers reaches the very next message, as long as what is alive
 * across the wait (the conversation, the counts, the chosen settings) is the same in both versions.
 *
 * Everything here is ordinary code: change what is checked, when the improver runs, or turn it off, by
 * copying this file into a layer above and editing it — or let a lesson do that.
 */
import { llm, input } from "@declarative-ai/hw/script";
import { conversation_digest, start_task } from "$REGISTRY";

export const meta = {
  name: "Session",
  description: "A conversation a person started from the Chat view. It may work in the project, start a workflow, or only talk. It holds the project's tools and the workflow tools; work it starts becomes its children, and it stays the same conversation. It is a program — a loop over the person's messages that notices clear corrections and turns them into lessons, takes an improved version of itself at its next message, and is reviewed for lessons when it ends or sits idle.",
  environment: { tools: "$/permission-sets/ask-first" },
};

const SYSTEM = "You are a working conversation inside JaiRA, a tool that runs workflows of states over a project. You can work in the project directly with the file, shell and web tools. You can also run the project's workflows with the workflow tools: `list_workflows` lists them and says what a state takes and produces, a level at a time; `start_task` starts a state as a child of this conversation; `move_task` sends a task to another state; `list_tasks` says what was started here, where each stands and what it produced; `hold_task`, `release_task` and `stop_task` do what the board's gestures do; `answer_question` settles a question a task is asking.\n\nRead a workflow's descriptions before starting it, and start the smallest state that does what was asked. `start_task` and `move_task` take the target's inputs. Supply a value only when what has been said in this conversation determines it; otherwise ask the person for it in words, one short question, and call again with the answer, naming it in `asked`. When a call comes back with `missing`, it has done nothing: supply what is listed and call it again. Never invent a value to get past a required input.\n\nWhen the person wants a design or a mock-up, in whatever words and whether or not they type `/design`, make it a design canvas: your first call, before you write any file, is `show_artifact` with `action: \"quickstart\"` and `intent: \"design\"`, and then you do what it answers. The person sees a canvas they can edit, not a page. A page or a Markdown document, published with `file_path`, is for what is not a design: a report, a chart, a table.\n\nWhen you want the person to see a file (a screenshot, a picture, a page, a log, a diff, a table), show it with `show_artifact`: `artifacts` names it by its path, a web address, a file of an artifact, or its data sent in the call. Don't name a path for them to go and open. Several pictures in one call are shown side by side.";

/** The strict per-message look (decision 0029 §6): only a clear-cut correction is acted on now. */
const NOTICE = `You check ONE message a person just sent in a conversation with an agent: did it correct how the agent works, clearly enough that the workflow should change so the person never has to say it again?

Answer "clear" only when it is unmistakable: an explicit standing rule ("never…", "always…", "don't…", "I told you…", "stop doing…"), or a direct correction of something the agent did that would recur. What the record says the person did is strong evidence that the message is a correction — a refused tool call, a message edited and sent again, the conversation rewound past what they had said, a reply they redirected while it was being made, a gate they turned down or commented on — but on its own it is a "maybe". Answer "maybe" when it might be such a correction but could also be a one-off. Answer "none" for everything else — a new request, a question, a change of mind, a fact about this task, thanks. Most messages are "none".

For "clear" and "maybe", state the lesson as one rule, and quote the person's words that showed it.`;

interface Verdict {
  verdict: "clear" | "maybe" | "none";
  lesson: string;
  quote: string;
}

export default async function session(
  message: string,
  improve: boolean = true,
  approval: string = "propose",
  // What the composer chose for the FIRST message (its model, its reasoning); every later message's
  // arrive with it through `input()`. A message's tools reach the run through its permission set.
  settings: unknown = null,
): Promise<{ turns: number; lessons: number }> {
  let text: string | null = message;
  let chosen: unknown = settings;
  let conv: { id: string } | null = null;
  let turns = 0;
  let lessons = 0;
  let since = 0;
  // What the strict check thought MIGHT be a correction (decision 0029 §6): noted, and handed to the
  // review of the whole conversation, which can see whether it was one.
  let maybes: Array<{ lesson: string; quote: string }> = [];
  while (text !== null) {
    const picked = (chosen ?? {}) as { model?: string; reasoning?: object };
    let replied = false;
    try {
      const reply = await llm({
        prompt: text,
        system: SYSTEM,
        session: conv,
        withSession: true,
        label: "reply",
        config: { model: picked.model, reasoning: picked.reasoning },
      });
      conv = reply.session;
      replied = true;
    } catch (stopped) {
      // The person stopped the reply, or it failed: the conversation goes on, waiting for what they
      // say next, rather than ending — AFTER this message, which the failed call recorded with what it
      // said (`session`), so the person's words stay in the conversation and the next reply reads them.
      const failed = stopped as { session?: { id: string } };
      if (failed.session !== undefined) conv = failed.session;
      replied = false;
    }
    turns = turns + 1;
    if (replied && improve && turns > 1) {
      // Strict, per message: only a clear-cut correction is acted on now (decision 0029 §6). The
      // improver runs on its own, so the conversation never waits for it.
      try {
        const recent = await conversation_digest({ session: conv, last: 4 });
        const seen = await llm<Verdict>({
          prompt:
            "The person's message: " + text +
            "\n\nThe conversation around it:\n" + JSON.stringify(recent.messages, null, 2) +
            "\n\nWhat the record says the person did (refused a tool call, edited and resent a message, rewound, redirected a reply, turned down or commented on a gate or a change):\n" + JSON.stringify(recent.signals, null, 2),
          system: NOTICE,
          config: { configRef: "simple" },
          label: "notice",
        });
        if (seen.verdict === "clear") {
          await start_task({ workflow: "improve/lesson", title: "Lesson: " + seen.lesson, inputs: { lesson: seen.lesson, workflow: "session", context: { task: recent.task, session: conv }, approval } });
          lessons = lessons + 1;
        } else if (seen.verdict === "maybe") {
          maybes = [...maybes, { lesson: seen.lesson, quote: seen.quote }];
        }
      } catch (stopped) {
        // Stopped with the reply, or failed: nothing is learned from this message, and nothing is lost.
      }
    }
    const next = await input({ prompt: "Your next message", idle: "4h" });
    if (next !== null && next.idle === true) {
      if (improve && turns > since) {
        await start_task({ workflow: "improve/conversation", title: "Review a conversation for lessons", inputs: { context: { session: conv, maybes }, approval } });
        since = turns;
        maybes = [];
      }
      const after = await input({ prompt: "Your next message" });
      text = after !== null && after.idle !== true ? after.text : null;
      chosen = after !== null && after.idle !== true ? (after.settings ?? null) : null;
    } else {
      text = next !== null ? next.text : null;
      chosen = next !== null ? (next.settings ?? null) : null;
    }
  }
  if (improve && turns > since) {
    await start_task({ workflow: "improve/conversation", title: "Review a conversation for lessons", inputs: { context: { session: conv, maybes }, approval } });
  }
  return { turns, lessons };
}
