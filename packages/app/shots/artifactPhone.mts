/**
 * A published canvas on a phone's layout (decision 0020 §3; the person, 2026-11-06: "why does the iphone not
 * have a 'show artifact in main view' button? also, why does opening the artifact in the sidebar using the
 * eye icon yield an artifact that renders the canvas upside down?").
 *
 * The desktop app at a phone's width draws the phone's frame (`isPhoneWidth`). It reopens the world
 * `artifactViews.mts` left (a conversation with a canvas in it), with no agent turn. Passes when:
 *   - in Tasks, the conversation in the panel's sheet offers ⇤; pressed, the board stands over the room,
 *     tall and right side up, the sheet lowered to its head; back takes it away;
 *   - the eye puts it on the sheet's stack, right side up (a board drawn 0 tall before the column was
 *     measured fitted a negative zoom: the board turned over);
 *   - in the Chat room, ⇤ from the thread stands the board over it, right side up.
 *
 *   npm run app:build
 *   npx tsx packages/app/shots/artifactViews.mts       (once, to make the world)
 *   npx tsx packages/app/shots/artifactPhone.mts
 */
import { join } from "node:path";
import { App } from "./driver.mjs";
import { drawn, settle } from "./parityWorld.mjs";

const TITLE = "Mock up a settings screen";
const OUT = join(import.meta.dirname, "out", "artifact-phone");
const WORLD = join(import.meta.dirname, ".world-artifact-views");
const TO_MAIN = "Show this artifact in the main view";
const TO_PANEL = "Open it on its own, in the side panel";
const OUT_OF_MAIN = "Back out of this artifact";
const PHONE = { width: 400, height: 860 };

async function main(): Promise<void> {
  const world = { home: join(WORLD, "home"), project: join(WORLD, "project"), userData: join(WORLD, "user-data") };
  const app = await App.launch(world, { out: OUT, port: 9276 });
  /** A button by its label (RN-web's Pressable answers a DOM click), or fails the rig. */
  const press = async (label: string, within = "", which: "first" | "last" = "first"): Promise<void> => {
    const hit = await app.evaluate<boolean>(
      `(() => { const all = [...document.querySelectorAll(${JSON.stringify(`${within} [aria-label="${label}"]`.trim())})]; const el = all[${which === "first" ? "0" : "all.length - 1"}]; if (!el) return false; el.click(); return true; })()`,
    );
    if (!hit) {
      await app.shot(`no-${label.slice(0, 12).replace(/\W/g, "-")}`);
      throw new Error(`no button "${label}"`);
    }
    await settle(2500);
  };
  const count = (selector: string): Promise<number> => app.evaluate<number>(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
  /**
   * Every canvas board drawn: how tall, whether in the panel's sheet, and its zoom (the layer's scale) -
   * read in the page, or in the island's frame where it is one.
   */
  const boards = (): Promise<Array<{ height: number; inPanel: boolean; scale: number | null }>> =>
    app.evaluate(`[...document.querySelectorAll('[data-island="canvas"]')].map((el) => {
      const docs = [el, ...[...el.querySelectorAll("iframe")].map((f) => { try { return f.contentDocument; } catch { return null; } }), ...(el.tagName === "IFRAME" ? [(() => { try { return el.contentDocument; } catch { return null; } })()] : [])].filter(Boolean);
      let scale = null;
      for (const d of docs) {
        const layer = [...d.querySelectorAll("div")].find((x) => x.style.transform.startsWith("translate"));
        const m = layer ? /scale\\(([-\\d.e]+)\\)/.exec(layer.style.transform) : null;
        if (m) { scale = Number(m[1]); break; }
      }
      return { height: el.getBoundingClientRect().height, inPanel: !!el.closest('[role="complementary"]') || !!el.closest('[aria-label="Drag the panel"]')?.parentElement, scale };
    })`);

  try {
    await app.until(drawn, "the window to draw");
    await app.resize(1500, 980);
    // A reopened window restores the room it was in, and is still reading its settings for a while.
    await settle(12_000);

    // Tasks: the conversation is the panel's, a sheet over the board on a phone.
    await app.clickText("Tasks");
    await settle(1500);
    await app.clickText(TITLE);
    await settle(3000);
    await app.resize(PHONE.width, PHONE.height);
    await settle(3000);
    await app.shot("tasks-phone");
    if ((await count('[aria-label="Drag the panel"]')) === 0) throw new Error("no panel sheet: not the phone's layout");
    const offered = await count(`[aria-label="${TO_MAIN}"]`);
    console.log(`tasks: ⇤ offered ${String(offered)} times`);
    if (offered === 0) throw new Error("the phone offers no ⇤ on the artifact");
    await press(TO_MAIN);
    await app.shot("tasks-in-main");
    const over = (await boards()).filter((b) => !b.inPanel);
    console.log(`tasks: over the room ${JSON.stringify(over)}`);
    const main = over.find((b) => b.height > 400);
    if (main === undefined) throw new Error(`⇤ drew no tall board over the room: ${JSON.stringify(await boards())}`);
    if (!(main.scale !== null && main.scale > 0)) throw new Error(`the board over the room is not right side up (scale ${String(main.scale)})`);
    await press(OUT_OF_MAIN);
    if ((await count(`[aria-label="${OUT_OF_MAIN}"]`)) !== 0) throw new Error("back left the artifact over the room");
    console.log("tasks: back took it away");

    // The eye: on the sheet's stack, the board right side up. The sheet is at its head (⇤ lowered it), so
    // the board is first drawn 0 tall, as on the iPhone; raised by its handle, it must fit right side up.
    await press(TO_PANEL);
    const handle = await app.evaluate<{ x: number; y: number }>(`(() => { const r = document.querySelector('[aria-label="Drag the panel"]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    // A finger (the sheet's responder takes touches), to half and a little over: past full is "into the main view".
    const before = await boards();
    await app.cdp("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 2 });
    await app.cdp("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [handle] });
    for (let i = 1; i <= 14; i++) {
      await app.cdp("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: handle.x, y: handle.y + ((260 - handle.y) * i) / 14 }] });
      await settle(20);
    }
    await app.cdp("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await settle(2500);
    await app.shot("tasks-on-its-own");
    const all = await boards();
    console.log(`eye: before the sheet rose ${JSON.stringify(before)}; after ${JSON.stringify(all)}`);
    // The board the eye added: the one that was 0 tall at the sheet's head.
    const added = before.findIndex((b) => b.height < 40);
    const own = added < 0 ? undefined : all[added];
    if (own === undefined || own.height < 200) throw new Error(`the eye's board is not drawn tall once the sheet is up: ${JSON.stringify(all)}`);
    if (!(own.scale !== null && own.scale > 0)) throw new Error(`the board on its own is not right side up (scale ${String(own.scale)})`);

    // Chat: the thread is the main view.
    await app.resize(1500, 980);
    await settle(1500);
    await app.clickText("Chat");
    await settle(1500);
    await app.clickText(TITLE);
    await settle(3000);
    await app.resize(PHONE.width, PHONE.height);
    await settle(3000);
    await press(TO_MAIN);
    await app.shot("chat-in-main");
    const chat = (await boards()).sort((a, b) => b.height - a.height)[0];
    console.log(`chat: ${JSON.stringify(chat)}`);
    if (chat === undefined || chat.height < 400) throw new Error(`in the Chat room ⇤ drew no tall board: ${JSON.stringify(chat)}`);
    if (!(chat.scale !== null && chat.scale > 0)) throw new Error(`the Chat room's board is not right side up (scale ${String(chat.scale)})`);
    await press(OUT_OF_MAIN);
    console.log("PASS");
  } finally {
    await app.close();
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
