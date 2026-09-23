/**
 * Who wrote what was said to the model (`MessageAuthor`) — server-rendered to one static page, the
 * real components over the real stylesheet, no Electron.
 *
 * `npx tsx --tsconfig packages/app/tsconfig.json packages/app/shots/message-source-static.mts <out.html> [light|dark|mockup]`
 *
 * The conversation shows what was said TO the model on the right and what the model said on the
 * left. A message the person did not type stays on the right — it was said to the model — and wears
 * a badge naming where it came from. Everything goes through the shipped path: recorded turns, marked
 * as the record store marks them (`by`), through `entriesOf` into the `Transcript`.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SessionTurn, SessionView } from "@jaira/shared/browser";
import { entriesOf } from "../src/renderer/transcript";
import { Transcript } from "../src/renderer/transcriptView";

const out = process.argv[2];
if (out === undefined) throw new Error("usage: message-source-static.mts <out.html> [light|dark]");

const at = Date.parse("2026-09-22T14:02:10Z");
const said = (role: string, text: string, ms: number, by?: SessionTurn["by"]): SessionTurn => ({ role, text, at: at + ms, ...(by !== undefined ? { by } : {}) });

/** A conversation a DROP made to ask for what its target needs — its opening turn is the app's. */
const asked: SessionTurn[] = [
  said(
    "user",
    [
      `"Pause and stop" was moved to lib/costed. lib/costed needs an input that nothing the task produced gives, so the move has not been taken yet:`,
      "- `budget`: The most this may cost, in dollars — schema {\"type\":\"number\"}",
      "",
      "Ask the person for it now, in words: one short message, in plain language drawn from the description, and nothing else yet. When they answer, call `start_task` with state `lib/costed` and the value, naming it in `asked`.",
    ].join("\n"),
    0,
    "host",
  ),
  said("assistant", "Before I cost this out — what is the most it may cost, in dollars?", 4_000),
  said("user", "Keep it under 400.", 62_000),
  said("assistant", "Got it: a budget of $400. Starting **Costed** with that now.", 65_000),
];

/** A state of a run: the workflow's system prompt and its prompt, then the model's answer. */
const state: SessionTurn[] = [
  said("system", "You are the product designer for this project. Write for a reader who has not seen the issue.", 0, "workflow"),
  said("user", "Draft the product brief for: Let a person pause a running task and pick it up later.", 10, "workflow"),
  said("assistant", "## Brief\n\nA person can **pause** a task that is running and **resume** it later, where it stood.", 9_000),
];

const view = (turns: SessionTurn[], stateId: string): SessionView => ({ taskId: "t", instanceId: "i", stateId, sessionId: "s", seq: 1, turns });

const sheet = (turns: SessionTurn[], stateId: string): ReactElement =>
  h(
    "div",
    { className: "sb-panel" },
    h("section", { className: "sb-sheet" }, h("div", { className: "sb-body ts-shown" }, h(Transcript, { entries: entriesOf(view(turns, stateId)), live: null }))),
  );

const section = (title: string, body: ReactElement): ReactElement =>
  h(
    "section",
    { style: { margin: "0 0 26px" } },
    h("h4", { style: { margin: "0 0 8px", font: "600 12px var(--font-app)", color: "var(--dim)" } }, title),
    body,
  );

const page = h(
  "div",
  { style: { width: 760, margin: "24px auto", padding: 16 } },
  section("chat/control opened by a drop — the opening turn is the app's; the person's answer is theirs", sheet(asked, "chat/control")),
  section("a state of a run — its system prompt and its prompt are the workflow's", sheet(state, "feature/product")),
);

const css = pathToFileURL(join(import.meta.dirname, "..", "src", "renderer", "styles.css")).href;
if (process.argv[3] === "mockup") {
  // The catalog's mockup of the state (`docs/ui/assets/message/sent-for-you.html`): the same markup,
  // in the catalog's frame, linking the real stylesheet by its path in the repository.
  const transcript = (turns: SessionTurn[], stateId: string): string =>
    renderToStaticMarkup(h("div", { className: "ts-page" }, h("div", { className: "ts-paper" }, h(Transcript, { entries: entriesOf(view(turns, stateId)), live: null }))));
  writeFileSync(
    out,
    [
      "<!doctype html>",
      '<html lang="en">',
      "<head>",
      '<meta charset="utf-8">',
      '<meta name="doc" content="ui/components/message">',
      '<meta name="state" content="sent-for-you">',
      '<meta name="captured" content="2026-09-22">',
      '<meta name="reflects" content="shipped">',
      "<title>message · sent-for-you</title>",
      '<link rel="stylesheet" href="../../../../packages/app/src/renderer/styles.css">',
      '<link rel="stylesheet" href="../mockup.css">',
      '<script>if (location.hash === "#dark") document.documentElement.dataset.theme = "dark";</script>',
      "</head>",
      '<body class="mockup">',
      '<p class="mockup-caption">ui/components/message · sent-for-you</p>',
      '<div class="mockup-stage" style="width: 760px; background: var(--bg)">',
      `  ${transcript(asked, "chat/control")}`,
      `  ${transcript(state, "feature/product")}`,
      "</div>",
      "</body>",
      "</html>",
      "",
    ].join("\n"),
  );
  console.log(`wrote ${out}`);
} else {
  writeFileSync(
    out,
    `<!doctype html><html data-theme="${process.argv[3] ?? "light"}"><head><meta charset="utf8"><link rel="stylesheet" href="${css}"></head><body style="background: var(--bg)">${renderToStaticMarkup(page)}</body></html>`,
  );
  console.log(`wrote ${out}`);
}
