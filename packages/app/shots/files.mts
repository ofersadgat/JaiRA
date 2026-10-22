/**
 * A project whose every concern is kept in files too (decision 0018 §11): the database is the truth
 * while JaiRA runs, the files its export, and what the files say is brought in at open when they
 * moved since JaiRA last had them.
 *
 *   kept       a conversation in a project with `storage: file` everywhere: answered, and its files written
 *   restart    the app quit and started again: the same conversation, from the database
 *   rebuilt    the database deleted and the app started again: the conversation, from its files
 *
 *   npm --workspace @jaira/app run build
 *   npx tsx packages/app/shots/files.mts
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject } from "@jaira/persistence";
import { jairaBasePaths } from "@jaira/shared";
import { App } from "./driver.mjs";
import { drawn, says, settle } from "./parityWorld.mjs";
import type { World } from "./world.mjs";

const OUT = join(import.meta.dirname, "out", "files");
const WORLD = join(tmpdir(), "jaira-shots-files");
const SAID = { title: "Survey the untested handlers", answer: "Eleven handlers have no test." };

async function open(world: World, port: number): Promise<App> {
  const app = await App.launch(world, { out: OUT, port });
  await app.until(drawn, "the window to draw");
  await app.resize(1180, 820);
  return app;
}

/** Stand on the project, open its Chat list and the conversation in it. */
async function conversation(app: App, label: string, what: string): Promise<void> {
  await app.clickText(label);
  await settle(800);
  await app.clickText("Chat");
  await app.until(says(SAID.title), `the conversation in the project's list, ${what}`, 60);
  await app.clickText(SAID.title);
  await app.until(says(SAID.answer), `the conversation's answer, ${what}`, 60);
}

async function main(): Promise<void> {
  rmSync(WORLD, { recursive: true, force: true });
  const world: World = { home: join(WORLD, "home"), project: join(WORLD, "kept-in-files"), userData: join(WORLD, "user-data") };
  initProject(world.project, world.home);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: world.project, stdio: "ignore" });
  writeFileSync(join(world.project, ".jaira", "settings.json"), JSON.stringify({ storage: { journal: "file", conversations: "file", tasks: "file", artifacts: "file" } }), "utf8");
  const system = join(world.project, ".jaira", "system");

  let app = await open(world, 9261);
  try {
    const project = (await app.ipc<Array<{ project: string; kind: string; label: string }>>("project:list", {})).find((p) => p.kind === "user")!;
    const made = await app.ipc<{ taskId: string }>("task:create", { title: SAID.title, workflow: "chat/session", inputs: { message: SAID.title }, project: project.project });
    await app.ipc("task:start", { taskId: made.taskId, project: project.project, fake: [{ output: SAID.answer }] });
    await conversation(app, project.label, "as made");
    await app.shot("kept");
    for (const kept of ["journal", "conversations", "taskRows"]) {
      const where = join(system, kept);
      if (!existsSync(where) || readdirSync(where).length === 0) throw new Error(`nothing was written to ${where}`);
    }

    await app.close();
    app = await open(world, 9262);
    await conversation(app, project.label, "after a restart");
    await app.shot("restart");

    // The database gone — a clone, or a machine set up again — and the files bring the conversation back.
    await app.close();
    const db = jairaBasePaths(world.home).dbFile;
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${db}${suffix}`, { force: true });
    app = await open(world, 9263);
    await conversation(app, project.label, "from its files, the database deleted");
    await app.shot("rebuilt");
    if (app.complaints.length > 0) throw new Error(`the window complained:\n${app.complaints.join("\n")}`);
    console.log("files: the conversation stood after a restart, from the database, and with the database deleted, from its files");
  } catch (e) {
    await app.shot("failed").catch(() => undefined);
    throw e;
  } finally {
    await app.close();
  }
}

await main();
