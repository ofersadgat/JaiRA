/**
 * A signed-out agent, in the real app (2026-11-12). The CLI signed out overnight; a chat's opening
 * message failed in 4 ms with "model "claude-cli/default" must be route-prefixed", and the conversation
 * drew nothing at all. The person: "1. fix the misleading error 2. the default route shouldnt change if it
 * becomes unavailable, it should stay but turn red with an on hover error message ... disable the send
 * message button. 3. if you somehow start sending a message anyways, there should be an error in the
 * session view that shows that you're logged out".
 *
 * A stand-in `claude` (no tokens spent, nothing real signed out): it answers `--version`, and `auth
 * status --json` says signed out, as the real one does with an empty credential file. The project points
 * the CLI agent at it and turns the other agents off, so nothing else could answer in its place.
 *
 *   1. The start page's composer: the model chip still names claude-cli, drawn red with the alert icon,
 *      its title saying why; a line over the box says it with Sign in and Check again; send says why it
 *      cannot, and a message typed and Entered starts nothing.
 *   2. A message started anyway (by IPC, as a second window or a phone could): the conversation draws the
 *      message and, under it, that Claude (cli) is signed out, with Sign in; nothing about a route prefix
 *      anywhere. (The signed-out route refuses its own call, so the failed turn lands in the conversation;
 *      a call that fails before it lands is `ChatThreadView.unsent`, unit-tested.)
 *
 *   npm --workspace @jaira/app run build
 *   npx tsx packages/app/shots/agent-signed-out.mts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { App } from "./driver.mjs";
import { drawn, says, settle } from "./parityWorld.mjs";
import { buildWorld } from "./world.mjs";

const OUT = join(import.meta.dirname, "out", "agent-signed-out");
const WORLD = join(import.meta.dirname, ".world-agent-signed-out");
const MESSAGE = "Mock sixteen layouts for the sidebar, please.";
const WHY = "Claude (cli) is signed out. Sign in to it (Settings → Connections → Agents), then send again.";

/** What the composer's model chip and send button say, and whether the line over the box is there. */
interface ComposerSeen {
  chip: string | null;
  send: { title: string | null } | null;
  line: string | null;
}
const COMPOSER = `(() => {
  const chip = [...document.querySelectorAll('[title^="Model: "]')].map((e) => e.getAttribute('title'))[0] ?? null;
  const sendEl = [...document.querySelectorAll('[title]')].find((e) => /^(Enter to send|Cannot send)/.test(e.getAttribute('title') ?? ''));
  const send = sendEl === undefined ? null : { title: sendEl.getAttribute('title') };
  const line = [...document.querySelectorAll('[role="alert"]')].map((e) => e.innerText).find((t) => t.includes('signed out')) ?? null;
  return { chip, send, line };
})()`;

async function main(): Promise<void> {
  const world = buildWorld(WORLD);
  // The stand-in: a node script, which the program resolver runs through node as it does an npm shim's entry.
  const bin = join(WORLD, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "fake-claude.cjs"),
    [
      "const args = process.argv.slice(2);",
      "if (args[0] === '--version') { console.log('2.1.287 (Claude Code)'); process.exit(0); }",
      "if (args[0] === 'auth' && args[1] === 'status') { console.log(JSON.stringify({ loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' })); process.exit(1); }",
      "console.error('Not logged in · Please run /login'); process.exit(1);",
    ].join("\n"),
  );
  const command = join(bin, "fake-claude.cjs");
  mkdirSync(join(world.project, ".jaira"), { recursive: true });
  writeFileSync(
    join(world.project, ".jaira", "settings.json"),
    JSON.stringify({ agents: { claudeCli: { command }, claudeCode: { enabled: false }, codex: { enabled: false } } }, null, 2),
  );

  const app = await App.launch(world, { out: OUT, port: 9271 });
  const failures: string[] = [];
  const check = (ok: boolean, what: string): void => {
    console.log(`agent-signed-out: ${ok ? "PASS" : "FAIL"} ${what}`);
    if (!ok) failures.push(what);
  };
  try {
    await app.until(drawn, "the window to draw");
    await app.resize(1180, 820);
    // The startup check has to have seen the stand-in before anything can be drawn red.
    for (let i = 0; ; i++) {
      const availability = await app.ipc<{ executors: Array<{ name: string; status: string }> }>("availability:read", undefined);
      const cli = availability.executors.find((e) => e.name === "claude-cli");
      if (cli?.status === "needs-sign-in") break;
      if (i > 60) throw new Error(`the check never saw claude-cli signed out: ${JSON.stringify(availability.executors)}`);
      await settle(500);
    }

    // 1. The start page.
    await app.clickText("Chat");
    await app.until(says("signed out"), "the composer to say the route is down", 120);
    await settle(800);
    await app.shot("1-start-page");
    const start = await app.evaluate<ComposerSeen>(COMPOSER);
    console.log(`agent-signed-out: composer ${JSON.stringify(start)}`);
    check(start.chip !== null && start.chip.includes("claude-cli"), `the model chip still names claude-cli (${start.chip})`);
    check(start.chip !== null && start.chip.includes(WHY), "the chip's title says why");
    check(start.line !== null && start.line.includes(WHY) && start.line.includes("Sign in") && start.line.includes("Check again"), `the line over the box says why, with Sign in and Check again (${JSON.stringify(start.line)})`);
    check(start.send !== null && start.send.title === `Cannot send: ${WHY}`, `send says why it cannot (${JSON.stringify(start.send)})`);
    // Typed and Entered: nothing starts.
    const before = (await app.ipc<unknown[]>("task:list", undefined)).length;
    await app.evaluate("document.querySelector('textarea').focus()");
    await app.type("hello");
    await app.press("Enter", 13);
    await settle(1500);
    const after = (await app.ipc<unknown[]>("task:list", undefined)).length;
    check(after === before, `Enter starts nothing (${before} tasks before, ${after} after)`);
    await app.shot("1b-typed");

    // 2. Sent anyway.
    const made = await app.ipc<{ taskId: string }>("task:create", { title: "Sent anyway", workflow: "chat/session", conversation: true, inputs: { message: MESSAGE } });
    await app.ipc("task:start", { taskId: made.taskId, overrides: { model: "claude-cli/default" } });
    await app.until(says("Sent anyway"), "the conversation to be listed", 200);
    await app.clickText("Sent anyway");
    // The refusal is the signed-out route's own, so its call lands in the conversation as a failed turn:
    // the message, then why, drawn by the thread (and over the box, with Sign in).
    await app.until(says(MESSAGE), "the message to be drawn", 120);
    await settle(1500);
    await app.shot("2-sent-anyway");
    const page = await app.evaluate<string>("document.body.innerText");
    const thread = await app.ipc<{ session: { turns: unknown[] }; unsent?: unknown[] }>("chat:thread", { taskId: made.taskId });
    check(page.includes(MESSAGE), "the message is drawn in the conversation");
    // Once in the conversation, once in the line over the box.
    check(page.split(WHY).length - 1 >= 2, "under it, in the conversation: signed out, and why");
    check(!/route-prefixed/.test(page) && !/route-prefixed/.test(JSON.stringify(thread)), "nothing says the model must be route-prefixed");
    check(thread.unsent === undefined, "said once — the failed turn landed, so nothing is left unsent to say again");
    const fixes = await app.evaluate<string | null>(`[...document.querySelectorAll('[role="alert"]')].map((e) => e.innerText).find((t) => t.includes('signed out')) ?? null`);
    check(fixes !== null && fixes.includes("Sign in"), `Sign in is offered (${JSON.stringify(fixes)})`);
  } finally {
    await app.close();
  }
  if (failures.length > 0) {
    console.log(`agent-signed-out: ${failures.length} failed:\n  ${failures.join("\n  ")}`);
    process.exit(1);
  }
  console.log("agent-signed-out: all passed");
}

void main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
