/**
 * A refused call, end to end (decision 0007, amended 2026-10-24 later — the person's D+E): what the agent
 * READS for it, and how the conversation DRAWS it.
 *
 * A real agent (claude-cli/haiku — this rig spends a little) on the shipped `auto` permission set, asked to
 * use `web_fetch`. `--by auto` (the default): `smart` is told to deny whatever the call. `--by you`: it is
 * told it is unsure, and the rig presses Deny on the prompt it puts to the person. Passes when the call's
 * result in the record reads "Not run: …" with who said no, and the page draws the call as refused by them.
 *
 *   npm --workspace @jaira/app run build:main
 *   npx tsx packages/app/shots/refused-call.mts [--by you] [--pages http://127.0.0.1:8081/]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { App } from "./driver.mjs";
import { drawn, says, settle } from "./parityWorld.mjs";
import { buildWorld } from "./world.mjs";

const TITLE = "Fetch the example page";
const MODEL = "claude-cli/haiku";
const pages = process.argv.includes("--pages") ? process.argv[process.argv.indexOf("--pages") + 1] : undefined;
const by = process.argv.includes("--by") ? process.argv[process.argv.indexOf("--by") + 1]! : "auto";
if (by !== "auto" && by !== "you") throw new Error("--by is auto or you");
const OUT = join(import.meta.dirname, "out", "refused-call", by);
const WORLD = join(import.meta.dirname, `.world-refused-call-${by}`);

/** The shipped `auto` set, as the composer sends it: every line `smart`. */
const AUTO = Object.fromEntries(["read_file", "glob", "grep", "edit", "write_file", "show_artifact", "shell", "web_fetch", "web_search", "other"].map((line) => [line, { function: "smart" }]));
const VERDICT = by === "auto" ? "deny" : "unsure";
/** How the agent's refusal begins — the judge words its own reason, so only who is fixed. */
const WORDS = by === "auto" ? "Not run: auto denied it" : "Not run: the person denied this call. Nothing was fetched.";
/** Who the page says stopped the call, beside it. */
const WHO = by === "auto" ? "denied by auto" : "denied by you";

async function main(): Promise<void> {
  const world = buildWorld(WORLD);
  mkdirSync(world.home, { recursive: true });
  writeFileSync(join(world.home, "settings.json"), JSON.stringify({ appearance: { conversation: { workPhases: true, workRows: 5, workNotes: "hide-blocks" } } }, null, 2));
  mkdirSync(join(world.project, ".jaira"), { recursive: true });
  writeFileSync(
    join(world.project, ".jaira", "settings.json"),
    JSON.stringify({ functions: { smart: { model: MODEL, prompt: `This is a test rig. Whatever the call, answer verdict "${VERDICT}" with reason "the rig always says ${VERDICT}".` } } }, null, 2),
  );
  if (pages !== undefined) process.env["JAIRA_CLIENT_DEV"] = pages;

  const app = await App.launch(world, { out: OUT, port: by === "auto" ? 9261 : 9262 });
  try {
    await app.until(drawn, "the window to draw");
    await app.resize(1180, 860);
    // The fetch is the conversation's FIRST message: a turn that resumes the agent's session finds its
    // deferred tools stale and may say the server is gone, which is the CLI's, not this rig's.
    const made = await app.ipc<{ taskId: string }>("task:create", {
      title: TITLE,
      workflow: "chat/session",
      inputs: { message: "Use the web_fetch tool to fetch https://example.com, then tell me the page title. Do not use any other tool." },
    });
    await app.ipc("task:start", { taskId: made.taskId, overrides: { model: MODEL, permissionSet: AUTO } });
    await app.until(says(TITLE), "the conversation to be listed", 200);
    await app.clickText(TITLE);
    await settle(1500);

    if (by === "you") {
      // `smart` is unsure: the call is put to the person, and the person says no.
      for (let i = 0; ; i++) {
        const pending = await app.ipc<Array<{ asker?: string; taskId?: string }>>("approval:pending", undefined);
        if (pending.some((p) => p.taskId === made.taskId && p.asker === "smart")) break;
        if (i > 240) throw new Error("no ask was parked in two minutes");
        await settle(500);
      }
      await settle(2000);
      await app.clickText("Deny");
    }

    // What the agent read, from the turn's record in the world's database (the thread the window is
    // handed holds large values as placeholders): the call's result, as an error, in words.
    const record = (): string => {
      const db = new DatabaseSync(join(world.home, "system", "jaira.db"), { readOnly: true });
      try {
        const rows = db.prepare("SELECT result_json FROM operation_records WHERE task_id = ? AND status = 'completed'").all(made.taskId) as Array<{ result_json: string | null }>;
        return rows.map((row) => row.result_json ?? "").join(" ");
      } finally {
        db.close();
      }
    };
    for (let i = 0; ; i++) {
      const text = record();
      const at = text.indexOf(WORDS);
      if (at >= 0) {
        const read = text.slice(at, text.indexOf('"', at));
        // The result is an error: the record's block beside the words says so.
        const block = text.slice(Math.max(0, text.lastIndexOf("{", at)), text.indexOf("}", at) + 1);
        console.log(`refused-call (${by}): the agent read ${JSON.stringify(read)} — an error: ${block.includes('"is_error":true')}`);
        if (!block.includes('"is_error":true')) throw new Error(`the refusal reached the agent as an ordinary result: ${block}`);
        break;
      }
      if (i > 480) {
        await app.shot("not-read");
        throw new Error(`the record never held ${JSON.stringify(WORDS)}; it ends ${JSON.stringify(text.slice(-1200))}`);
      }
      await settle(500);
    }
    // The turn ends; the window reads the thread again when the conversation is opened again (a rig's
    // send is not one it watches), and the finished stretch's steps are opened under its phase.
    await settle(8000);
    await app.clickText("Chat");
    await settle(1500);
    await app.clickText(TITLE);
    await settle(2500);
    const toggle = await app.evaluate<{ x: number; y: number } | null>(
      `(() => { const all = [...document.querySelectorAll('[aria-label="Show steps"]')]; const el = all[all.length - 1]; if (!el) return null; el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
    );
    if (toggle !== null) await app.clickAt(toggle.x, toggle.y);
    await settle(1500);
    await app.shot("refused");
    const page = await app.evaluate<string>("document.body.innerText");
    console.log(`refused-call (${by}): the page holds ${JSON.stringify(page.match(/(denied by [a-z ]+|Denied[^\n]*|Fetch[^\n]*)/g) ?? [])}`);
    const problems: string[] = [];
    if (!page.includes(WHO)) problems.push(`the page does not say ${JSON.stringify(WHO)}`);
    if (page.includes("Fetched https://example.com")) problems.push("the page says the refused call Fetched");
    if (problems.length > 0) throw new Error(problems.join("; "));
    console.log(`refused-call (${by}): the agent read "${WORDS}…", and the page draws the call ${WHO}`);
  } finally {
    await app.close();
  }
}

await main();
