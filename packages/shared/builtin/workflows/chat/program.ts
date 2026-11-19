/**
 * A conversation as a PROGRAM (decision 0029 §2): a loop over `input()`, each message one call of
 * `chat/turn` — the reply, and a strict look at whether the person just corrected the conversation. That
 * call is the boundary a running conversation takes a newer `chat/turn` at (decision 0029 §3), so a
 * lesson about how it answers reaches the very next message. When the person ends the conversation, or
 * it sits idle, `improve/conversation` reads the whole of it.
 *
 * Everything here is ordinary code: change what is checked, when the improver runs, or turn it off,
 * by copying this file (or `chat/turn`) into a layer above and editing it — or let a lesson do that.
 */
import { input } from "@declarative-ai/hw/script";
import { start_task } from "$REGISTRY";
import turn from "./turn";

export const meta = {
  name: "Program session",
  description: "A conversation that is a program: a loop over the person's messages that also notices clear corrections and turns them into lessons, takes an improved chat/turn at its next message, and reviews the whole conversation for lessons when it ends.",
};

export default async function program(
  message: string,
  improve: boolean = true,
  approval: string = "propose",
  // What the composer chose for the FIRST message (its model, its reasoning); every later message's
  // arrive with it through `input()`.
  settings: unknown = null,
): Promise<{ turns: number; lessons: number }> {
  let text: string | null = message;
  let chosen: unknown = settings;
  let conv: { id: string } | null = null;
  let turns = 0;
  let lessons = 0;
  let since = 0;
  while (text !== null) {
    const done = await turn(text, conv, improve && turns > 0, approval, chosen);
    conv = done.conv as { id: string } | null;
    turns = turns + 1;
    lessons = lessons + done.lessons;
    const next = await input({ prompt: "Your next message", idle: "4h" });
    if (next !== null && next.idle === true) {
      if (improve && turns > since) {
        await start_task({ workflow: "improve/conversation", title: "Review a conversation for lessons", inputs: { context: { session: conv }, approval } });
        since = turns;
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
    await start_task({ workflow: "improve/conversation", title: "Review a conversation for lessons", inputs: { context: { session: conv }, approval } });
  }
  return { turns, lessons };
}
