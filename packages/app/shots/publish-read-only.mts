/**
 * Publishing under the read-only sets, with a real agent (2026-11-05, task t-elvj5dhzoy: a design asked
 * for under read-only-scratch could not be drawn — the agent could write only its own folder, and the
 * publish read only from the workspace, the artifact folder and the temporary folder).
 *
 *  A. `$/permission-sets/read-only`: asked for a design, the agent sends the canvas's files' text in the
 *     call — it can write nowhere — and a canvas with its entry artboard is published.
 *  B. `$/permission-sets/read-only-scratch`: the agent writes a page into its own folder and publishes it
 *     from there — a file it may read, so the publish is not refused.
 *
 * Passes when both are published and nobody is asked. A real agent (claude-cli/haiku): this rig spends a
 * little.
 *
 *   npm --workspace @jaira/app run build
 *   npx tsx packages/app/shots/publish-read-only.mts
 */
import { rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { App } from "./driver.mjs";
import { drawn, says, settle } from "./parityWorld.mjs";
import { buildWorld } from "./world.mjs";

const MODEL = process.env["RIG_MODEL"] ?? "claude-cli/haiku";
const OUT = join(import.meta.dirname, "out", "publish-read-only");
const WORLD = join(import.meta.dirname, ".world-publish-read-only");

/** Claude Code's folder for a working directory — as `@declarative-ai/agents-api` spells it. */
const agentFolder = (cwd: string): string =>
  join(process.env["CLAUDE_CONFIG_DIR"] ?? join(homedir(), ".claude"), "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));

interface Published {
  id: string;
  kind: string;
  version: number;
  title?: string;
}

async function main(): Promise<void> {
  const world = buildWorld(WORLD);
  const folder = agentFolder(world.project);
  const page = join(folder, "scratch", "page.html");
  rmSync(join(folder, "scratch"), { recursive: true, force: true });

  const app = await App.launch(world, { out: OUT, port: 9269 });
  const failures: string[] = [];
  const check = (ok: boolean, what: string): void => {
    console.log(`publish-read-only: ${ok ? "PASS" : "FAIL"} ${what}`);
    if (!ok) failures.push(what);
  };
  let asked = 0;

  /** Start a conversation and wait until `done` says its artifacts are what was asked for, refusing any ask. */
  const converse = async (title: string, set: string, message: string, done: (published: Published[], files: (id: string) => Promise<Record<string, string>>) => Promise<boolean>, shot: string): Promise<boolean> => {
    const made = await app.ipc<{ taskId: string }>("task:create", { title, workflow: "chat/session", conversation: true, inputs: { message } });
    await app.ipc("task:start", { taskId: made.taskId, overrides: { model: MODEL, permissionSet: { layers: [set] } } });
    await app.clickText("Chat");
    await app.until(says(title), "the conversation in the Chat room", 200);
    await app.clickText(title);
    const files = async (id: string): Promise<Record<string, string>> => (await app.ipc<{ files: Record<string, string> }>("artifact:files", { taskId: made.taskId, artifact: id })).files;
    for (let i = 0; i < 600; i++) {
      const pending = (await app.ipc<Array<{ requestId: string; taskId?: string; command?: string }>>("approval:pending", undefined)).filter((p) => p.taskId === made.taskId);
      for (const p of pending) {
        asked++;
        console.log(`publish-read-only: asked ${JSON.stringify(p.command)} — refusing`);
        await app.ipc("approval:submit", { requestId: p.requestId, decision: "deny", scope: "once" });
      }
      const published = await app.ipc<Published[]>("artifact:published", { taskId: made.taskId });
      if (await done(published, files)) {
        await settle(3000);
        await app.shot(shot);
        return true;
      }
      await settle(500);
    }
    await app.shot(shot);
    const text = await app.evaluate<string>("document.body.innerText");
    console.log(`publish-read-only: ${title} never published; the page ends ${JSON.stringify(text.slice(-900))}`);
    return false;
  };

  try {
    await app.until(drawn, "the window to draw");
    await app.resize(1280, 860);

    const canvas = await converse(
      "Read-only design",
      "$/permission-sets/read-only",
      "Make me a design mock-up: one small artboard (360×200) showing a single red button labelled Go. Keep it minimal, and don't ask me anything.",
      async (published, files) => {
        const made = published.find((p) => p.kind === "canvas");
        if (made === undefined || made.version < 2) return false;
        const held = await files(made.id);
        return held["project/canvas.json"] !== undefined && Object.keys(held).some((p) => p.endsWith(".dc.html") && /Go/.test(held[p]!));
      },
      "1-read-only-design",
    );
    check(canvas, "under read-only, a canvas is published with an artboard showing Go — its text sent in the call");

    const fromScratch = await converse(
      "Scratch page",
      "$/permission-sets/read-only-scratch",
      [
        `With your Write tool, create the file ${page} holding a small HTML page whose <title> is "Scratch page" and whose body says hello.`,
        `Then publish that file with show_artifact, giving file_path: ${page}. Do not send its content in the call.`,
      ].join("\n"),
      async (published) => published.some((p) => p.kind === "page" && p.title === "Scratch page"),
      "2-scratch-page",
    );
    check(fromScratch, "under read-only-scratch, a page written in the agent's own folder is published from there");
    check(asked === 0, `nobody is asked (asked ${asked})`);
  } finally {
    await app.close();
    rmSync(join(folder, "scratch"), { recursive: true, force: true });
  }
  if (failures.length > 0) {
    console.log(`publish-read-only: ${failures.length} failed:\n  ${failures.join("\n  ")}`);
    process.exit(1);
  }
  console.log("publish-read-only: all passed");
}

void main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
