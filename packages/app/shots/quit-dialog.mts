/**
 * Quitting with work going, in the real app (the person, 2026-11-12: "if I try and close JaiRA, I want
 * you to pop up a dialog if there are still running workflows/sessions asking me what I want to do: wait
 * for it to finish and then exit, exit immediately, or cancel").
 *
 * Nothing is spent: one task runs a `run_command` state that takes a while (`ping`), another parks on a
 * gate (`choose_option`). Closing the window (the page's `window.close()`, which is the window's close)
 * then:
 *
 *   1. raises the dialog, listing the working run first and the gated one as waiting on you;
 *   2. Wait shows the strip "Quitting when 1 running finishes…"; Don't quit takes it away;
 *   3. closing again asks again; Cancel leaves the app as it was;
 *   4. closing again and Quit now ends the process.
 *
 *   npm --workspace @jaira/app run build
 *   npx tsx packages/app/shots/quit-dialog.mts
 */
import { join } from "node:path";
import { writeWorkflowFiles } from "@jaira/runtime";
import { App } from "./driver.mjs";
import { drawn, says, settle } from "./parityWorld.mjs";
import { buildWorld } from "./world.mjs";

const OUT = join(import.meta.dirname, "out", "quit-dialog");
const WORLD = join(import.meta.dirname, ".world-quit-dialog");

const DIALOG = `!!document.querySelector('[data-testid="quit-dialog"]')`;
const STRIP = `!!document.querySelector('[data-testid="quit-waiting"]')`;

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

  const app = await App.launch(world, { out: OUT, port: 9281 });
  const failures: string[] = [];
  const check = (ok: boolean, what: string): void => {
    console.log(`quit-dialog: ${ok ? "PASS" : "FAIL"} ${what}`);
    if (!ok) failures.push(what);
  };
  let exited = false;
  try {
    await app.until(drawn, "the window to draw");
    await app.resize(1180, 820);
    const slow = await app.ipc<{ taskId: string }>("task:create", { title: "Build the release notes", workflow: "slow" });
    await app.ipc("task:start", { taskId: slow.taskId });
    const gated = await app.ipc<{ taskId: string }>("task:create", { title: "Choose a layout", workflow: "gated" });
    await app.ipc("task:start", { taskId: gated.taskId });
    // A line the built-ins ask about is answered, so the slow run is WORKING rather than waiting on us.
    for (let i = 0; i < 20; i++) {
      const pending = await app.ipc<Array<{ requestId: string; taskId?: string }>>("approval:pending", undefined);
      for (const p of pending.filter((p) => p.taskId === slow.taskId)) await app.ipc("approval:submit", { requestId: p.requestId, decision: "allow" });
      await settle(250);
    }

    // 1. The question.
    await app.evaluate("window.close()");
    await app.until(DIALOG, "the quit dialog", 80);
    await settle(600);
    await app.shot("1-dialog");
    const text = await app.evaluate<string>(`document.querySelector('[data-testid="quit-dialog"]').innerText`);
    console.log(`quit-dialog: the dialog says\n${text}`);
    check(text.includes("Quit JaiRA?"), "the dialog asks");
    check(text.indexOf("Build the release notes") >= 0 && text.indexOf("Build the release notes") < text.indexOf("Choose a layout"), "the working run first, the gated one after");
    check(/Choose a layout[\s\S]*waiting on you/.test(text), "the gated task is marked waiting on you");
    check(text.includes("Wait for it to finish, then quit") && text.includes("Quit now") && text.includes("Cancel"), "the three choices");
    const laid = await app.evaluate<{ inView: boolean; oneRow: boolean; clipped: string[] }>(`(() => {
      const box = document.querySelector('[data-testid="quit-dialog"]').getBoundingClientRect();
      const buttons = ['quit-wait', 'quit-now', 'quit-cancel'].map((id) => document.querySelector('[data-testid="' + id + '"]').getBoundingClientRect());
      const clipped = [...document.querySelectorAll('[data-testid="quit-dialog"] *')].filter((e) => e.children.length === 0 && e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent);
      return {
        inView: box.top >= 0 && box.left >= 0 && box.bottom <= innerHeight && box.right <= innerWidth,
        oneRow: buttons.every((b) => Math.abs(b.top - buttons[0].top) < 2 && b.right <= box.right),
        clipped,
      };
    })()`);
    check(laid.inView, "the dialog is inside the window");
    check(laid.oneRow, "the three buttons stand in one row inside it");
    check(laid.clipped.length === 0, `no words are cut (${JSON.stringify(laid.clipped)})`);

    // 2. Wait, then Don't quit.
    await app.clickText("Wait for it to finish, then quit");
    await app.until(STRIP, "the waiting strip", 40);
    await settle(400);
    await app.shot("2-waiting");
    const strip = await app.evaluate<string>(`document.querySelector('[data-testid="quit-waiting"]').innerText`);
    check(strip.includes("Quitting when 1 running finishes"), `the strip counts what is working (${JSON.stringify(strip)})`);
    const over = await app.evaluate<string[]>(`(() => {
      const s = document.querySelector('[data-testid="quit-waiting"]').getBoundingClientRect();
      const meets = (r) => r.width > 0 && !(r.right <= s.left || r.left >= s.right || r.bottom <= s.top || r.top >= s.bottom);
      return [...document.querySelectorAll('textarea, button, [role="button"]')].filter((e) => !e.closest('[data-testid="quit-waiting"]') && meets(e.getBoundingClientRect())).map((e) => e.getAttribute('aria-label') || e.textContent || e.tagName);
    })()`);
    check(over.length === 0, `the strip covers no control (${JSON.stringify(over)})`);
    // A second close while waiting draws no second dialog.
    await app.evaluate("window.close()");
    await settle(800);
    check(!(await app.evaluate<boolean>(DIALOG)), "a close while waiting stacks no dialog");
    await app.clickText("Don't quit");
    await settle(600);
    check(!(await app.evaluate<boolean>(STRIP)), "Don't quit takes the strip away");

    // 3. Asked again; Cancel.
    await app.evaluate("window.close()");
    await app.until(DIALOG, "the quit dialog again", 80);
    await app.clickText("Cancel");
    await settle(600);
    check(!(await app.evaluate<boolean>(DIALOG)), "Cancel closes the dialog");
    check((await app.evaluate<string>("document.visibilityState")) === "visible", "and the app stays");

    // 4. Quit now.
    await app.evaluate("window.close()");
    await app.until(DIALOG, "the quit dialog a third time", 80);
    await app.clickText("Quit now");
    for (let i = 0; i < 60 && !exited; i++) {
      await settle(500);
      // The page no longer answers once the process has gone.
      const answered = await Promise.race([app.evaluate<number>("1").then(() => true, () => false), settle(1500).then(() => false)]);
      exited = !answered;
    }
    check(exited, "Quit now ends the app");
  } catch (e) {
    failures.push(String(e));
    console.error(e);
  } finally {
    await app.close().catch(() => undefined);
  }
  if (failures.length > 0) {
    console.log(`quit-dialog: ${failures.length} failed:\n  ${failures.join("\n  ")}`);
    process.exit(1);
  }
  console.log("quit-dialog: all passed");
}

void main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
