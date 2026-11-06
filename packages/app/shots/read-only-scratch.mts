/**
 * `chat/read-only-scratch` with a real agent (2026-11-05: "read only, but it provides the llm scratch
 * space in its agent workspace").
 *
 * A real agent (claude-cli/haiku — this rig spends a little) under the shipped set, told to write a note
 * in its own folder (`~/.claude/projects/<its working directory, encoded>`), edit it, and then write a
 * file in the project. Passes when the note is written and edited, the project file is not, and nobody
 * is asked: the folder is allowed and everywhere else refused, neither a question.
 *
 *   npm --workspace @jaira/app run build
 *   npx tsx packages/app/shots/read-only-scratch.mts
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { App } from "./driver.mjs";
import { drawn, says, settle } from "./parityWorld.mjs";
import { buildWorld } from "./world.mjs";

const TITLE = "Scratch";
const MODEL = "claude-cli/haiku";
const OUT = join(import.meta.dirname, "out", "read-only-scratch");
const WORLD = join(import.meta.dirname, ".world-read-only-scratch");
const SET = { layers: ["$/permission-sets/chat/read-only-scratch"] };

/** Claude Code's folder for a working directory — as `@declarative-ai/agents-api` spells it. */
const agentFolder = (cwd: string): string =>
  join(process.env["CLAUDE_CONFIG_DIR"] ?? join(homedir(), ".claude"), "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));

async function main(): Promise<void> {
  const world = buildWorld(WORLD);
  writeFileSync(join(world.project, "README.md"), "# A project\n\nNothing to see.\n");
  const folder = agentFolder(world.project);
  const note = join(folder, "scratch", "note.md");
  const intruder = join(world.project, "intruder.md");
  rmSync(join(folder, "scratch"), { recursive: true, force: true });
  rmSync(intruder, { force: true });

  const app = await App.launch(world, { out: OUT, port: 9268 });
  const failures: string[] = [];
  const check = (ok: boolean, what: string): void => {
    console.log(`read-only-scratch: ${ok ? "PASS" : "FAIL"} ${what}`);
    if (!ok) failures.push(what);
  };
  let asked = 0;
  try {
    await app.until(drawn, "the window to draw");
    await app.resize(1180, 820);
    const message = [
      "Do these three steps in order, one tool call at a time, and do not stop if one is refused.",
      `1. With your Write tool, create the file ${note} containing exactly: first draft`,
      `2. With your Edit tool, in that same file replace "first draft" with "second draft".`,
      `3. With your Write tool, create the file ${intruder} containing exactly: should not exist`,
      "Then reply with one line per step: the step's number, then OK or REFUSED.",
    ].join("\n");
    const made = await app.ipc<{ taskId: string }>("task:create", { title: TITLE, workflow: "chat/session", conversation: true, inputs: { message } });
    await app.ipc("task:start", { taskId: made.taskId, overrides: { model: MODEL, permissionSet: SET } });
    await app.clickText("Chat");
    await app.until(says(TITLE), "the conversation in the Chat room", 200);
    await app.clickText(TITLE);

    // The answer names step 3; while waiting, count any approval the turn asks for (there should be none).
    for (let i = 0; ; i++) {
      const pending = (await app.ipc<Array<{ requestId: string; taskId?: string; command?: string }>>("approval:pending", undefined)).filter((p) => p.taskId === made.taskId);
      for (const p of pending) {
        asked++;
        console.log(`read-only-scratch: asked ${JSON.stringify(p.command)} — refusing`);
        await app.ipc("approval:submit", { requestId: p.requestId, decision: "deny", scope: "once" });
      }
      const text = await app.evaluate<string>("document.body.innerText");
      // The answer's list draws its number and its word on two lines: `3. \nREFUSED`.
      if (/\b3\.\s*(OK|REFUSED)\b/.test(text)) break;
      if (i > 360) throw new Error(`no answer in three minutes; the page ends: ${JSON.stringify(text.slice(-800))}`);
      await settle(500);
    }
    await settle(2000);
    await app.shot("1-answered");
    const page = await app.evaluate<string>("document.body.innerText");
    console.log(`read-only-scratch: the page ends ${JSON.stringify(page.slice(-700))}`);

    check(existsSync(note), `the note is written in the agent's folder (${note})`);
    check(existsSync(note) && readFileSync(note, "utf8").trim() === "second draft", `the note is edited (${existsSync(note) ? JSON.stringify(readFileSync(note, "utf8")) : "absent"})`);
    check(!existsSync(intruder), "the project file is not written");
    check(asked === 0, `nobody is asked (asked ${asked})`);
  } finally {
    await app.close();
    rmSync(join(folder, "scratch"), { recursive: true, force: true });
    rmSync(intruder, { force: true });
  }
  if (failures.length > 0) {
    console.log(`read-only-scratch: ${failures.length} failed:\n  ${failures.join("\n  ")}`);
    process.exit(1);
  }
  console.log("read-only-scratch: all passed");
}

void main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
