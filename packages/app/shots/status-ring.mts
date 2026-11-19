/**
 * The ring round a project's tile and a conversation's row (`ringModel.ts`, `StatusRing.tsx`; the
 * activity mockups, round 3, board 11), in the real app. Nothing is spent:
 *
 *   - a `run_command` state that takes a while (`ping`) is WORKING — its segment breathes;
 *   - a `choose_option` gate parks a task on the person — its segment is amber, its age in the middle;
 *   - three conversations: one failed, one finished and unread (a ✓ in its row's ring), one read (an
 *     empty ring and its time at the row's end).
 *
 *   npm --workspace @jaira/app run build
 *   npx tsx packages/app/shots/status-ring.mts
 *
 * A fake conversation neither keeps answering nor asks, so a ROW asking while it works (`▶ 1:30` at its
 * end) is not drawn here: `ringModel.test.ts` holds it.
 */
import { join } from "node:path";
import { writeWorkflowFiles } from "@jaira/runtime";
import { App } from "./driver.mjs";
import { drawn, says, settle } from "./parityWorld.mjs";
import { buildWorld } from "./world.mjs";

const OUT = join(import.meta.dirname, "out", "status-ring");
const WORLD = join(import.meta.dirname, ".world-status-ring");

async function main(): Promise<void> {
  const world = buildWorld(WORLD);
  writeWorkflowFiles(join(world.project, ".jaira", "workflows"), {
    slow: {
      label: "Slow",
      outputs: { stdout: { schema: { type: "string" }, binding: ".operation.output.stdout" } },
      operation: { kind: "function", function: "run_command", args: { command: "ping -n 120 127.0.0.1" }, output: { stdout: { schema: { type: "string" } } } },
    },
    gated: {
      label: "Gated",
      outputs: { decision: { schema: { type: "string" } } },
      operation: { kind: "function", function: "choose_option", args: { prompt: "which way?", options: ["left", "right"] } },
    },
  });
  const app = await App.launch(world, { out: OUT, port: 9261 });
  try {
    await app.until(drawn, "the window to draw");
    await app.resize(1200, 800);
    const projects = await app.ipc<Array<{ project: string; kind: string }>>("project:list", {});
    const project = projects.find((p) => p.kind === "user")!.project;
    const talk = async (title: string, fake: unknown): Promise<void> => {
      const made = await app.ipc<{ taskId: string }>("task:create", { title, workflow: "session", inputs: { message: title }, project, conversation: true });
      await app.ipc("task:start", { taskId: made.taskId, project, fake });
      await app.until(says(title), `"${title}" to be listed`);
    };
    await talk("Refactor pill model", [{ output: "Done." }]);
    await settle(1000);
    await app.clickText("Refactor pill model");
    await settle(1500);
    await talk("Migrate permission sets", [{ error: "tsc: 3 errors in permissionSetsMove.ts" }]);
    await talk("Picture size rig", [{ output: "Rig 10/10." }]);

    const slow = await app.ipc<{ taskId: string }>("task:create", { title: "Build the release notes", workflow: "slow", project });
    await app.ipc("task:start", { taskId: slow.taskId, project });
    const gated = await app.ipc<{ taskId: string }>("task:create", { title: "Choose a layout", workflow: "gated", project });
    await app.ipc("task:start", { taskId: gated.taskId, project });
    // The line the built-ins ask about is answered, so the slow run is WORKING rather than waiting on us.
    for (let i = 0; i < 20; i++) {
      const pending = await app.ipc<Array<{ requestId: string; taskId?: string }>>("approval:pending", undefined);
      for (const p of pending.filter((p) => p.taskId === slow.taskId)) await app.ipc("approval:submit", { requestId: p.requestId, decision: "allow" });
      await settle(250);
    }
    await app.clickText("Chat");
    await settle(2500);
    await app.shot("1-rail-and-rows", undefined, false);
    // The working segment breathes: a second picture a little under half a breath later.
    await settle(800);
    await app.shot("2-breath", undefined, false);
    const rings = await app.evaluate<string[]>(`[...document.querySelectorAll('[title]')].map((e) => e.getAttribute('title')).filter((t) => /^(failed|done|working|asks you) /.test(t))`);
    console.log("ring titles:", rings);
    const breathing = await app.evaluate<number>(`document.querySelectorAll('.jaira-breathe').length`);
    console.log("breathing layers:", breathing);
  } finally {
    await app.close();
  }
}

await main();
