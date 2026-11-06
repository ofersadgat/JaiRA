/**
 * Layers and places deciding a real agent's calls (decision 0023), in a real conversation.
 *
 * A real agent (claude-cli/haiku — this rig spends a little) on Windows, whose shell is PowerShell:
 *  a. under the shipped `full`, `npm --workspace @jaira/app run build` runs and nobody is asked
 *     (2026-11-01: it asked under full access);
 *  b. under the stack `ask-first` + `app/build` (a project layer holding
 *     `"npm run build": { "packages": "allow" }`) the same line runs outright — the line names it, in its
 *     workspace's package (§3.6) — while `npm --workspace @jaira/app run check`, which no layer names,
 *     asks: what the script runs drawn under `runner:npm`, each row saying who decided it and where;
 *  c. a row's own panel (design 4D): a Where, `Add to` `app/build`, Allow — the bottom pair turns into
 *     Continue / Cancel — and Continue: the line runs, the layer's file holds the new line at that place,
 *     and the line asked for again does not ask about that row;
 *  d. a fresh line, its row denied `For this run`: refused, the agent told why, and refused again without
 *     an ask;
 *  e. places on a direct tool call: a read outside the project asks under `ask-first` (and under
 *     `read-only`, where a read inside does not); a `.env` in the project asks under `full`
 *     (where another file does not);
 *  f. the composer's stack, a segment's card, the approval and its panel, light and dark.
 *
 *   npm --workspace @jaira/app run build
 *   npx tsx packages/app/shots/runner-approval.mts
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { App } from "./driver.mjs";
import { drawn, says, settle } from "./parityWorld.mjs";
import { buildWorld } from "./world.mjs";

const MODEL = "claude-cli/haiku";
const OUT = join(import.meta.dirname, "out", "runner-approval");
const WORLD = join(import.meta.dirname, ".world-runner-approval");
/** A shipped set as the composer sends it: the stack's bottom layer (decision 0023 §2.6). */
const preset = (name: string): { layers: string[] } => ({ layers: [`$/permission-sets/${name}`] });
const FULL = preset("full");
const ASK_FIRST = preset("ask-first");
const READ_ONLY = preset("read-only");
/** The project layer the rig writes, laid over `ask-first`. */
const STACK = { layers: ["$/permission-sets/ask-first", "$/permission-sets/app/build"] };
const BUILD = "npm --workspace @jaira/app run build";
/** A script of the same package that no layer names: it asks, and what it runs is drawn under the runner. */
const CHECK = "npm --workspace @jaira/app run check";
// Left to itself the agent has passed a `cwd` that walks out of the world and into this repository.
const run = (line: string): string => `Use your shell tool to run exactly this line, once, and nothing else: ${line}\nDo not pass a cwd. Then reply with the last line of its output, or, if it was not run, with the reason you were given, word for word. Do not use any other tool, and do not try again.`;
const read = (...files: string[]): string =>
  `Use your file-reading tool (Read) to read ${files.map((f) => `the file ${f}`).join(", then ")}, one at a time and in that order. Reply with the first line of each, or the reason it could not be read. Do not use any other tool, and do not try again.`;

type Pending = { requestId: string; taskId?: string; tool?: string; command?: string; input?: unknown };

/** The approval drawn last — an answered one stays in the thread above it. */
const LAST = `[...document.querySelectorAll('[data-testid="approval"]')].at(-1)`;

async function main(): Promise<void> {
  const world = buildWorld(WORLD);
  mkdirSync(join(world.project, "packages", "app"), { recursive: true });
  writeFileSync(join(world.project, "package.json"), JSON.stringify({ name: "rig", private: true, workspaces: ["packages/*"] }, null, 2));
  writeFileSync(join(world.project, "packages", "app", "package.json"), JSON.stringify({ name: "@jaira/app", scripts: { build: "git --version && node build.mjs", check: "git --version && node build.mjs" } }, null, 2));
  writeFileSync(join(world.project, "packages", "app", "build.mjs"), `console.log("BUILT-OK");\n`);
  const layerFile = join(world.project, ".jaira", "permission-sets", "app", "build.json");
  mkdirSync(join(layerFile, ".."), { recursive: true });
  writeFileSync(layerFile, `${JSON.stringify({ "npm run build": { packages: "allow" } }, null, 2)}\n`);
  writeFileSync(join(world.project, "notes.txt"), "NOTES-OK\n");
  writeFileSync(join(world.project, ".env"), "TOKEN=rig-secret\n");
  const outside = join(WORLD, "outside");
  mkdirSync(outside, { recursive: true });
  const outsideFile = join(outside, "far.txt");
  writeFileSync(outsideFile, "FAR-OK\n");

  const app = await App.launch(world, { out: OUT, port: 9262 });
  const failures: string[] = [];
  const check = (ok: boolean, what: string): void => {
    console.log(`runner-approval: ${ok ? "PASS" : "FAIL"} ${what}`);
    if (!ok) failures.push(what);
  };
  try {
    await app.until(drawn, "the window to draw");
    await app.resize(1180, 860);

    /** Press what `selector` finds (in the page, or under `within`), with real input: a `Press` answers a pointer, not `.click()`. */
    const press = async (selector: string, within = "document"): Promise<void> => {
      const at = await app.evaluate<{ x: number; y: number } | null>(`(() => { const el = (${within}).querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({ block: "nearest" }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      if (at === null) throw new Error(`nothing to press at ${selector}`);
      await app.pointer(at.x, at.y);
      await settle(200);
      await app.clickAt(at.x, at.y);
      await settle(500);
    };
    /** Press the asking row's pill of the last approval whose row reads `needle`. */
    const pressRow = async (needle: string): Promise<void> => {
      const at = await app.evaluate<{ x: number; y: number } | null>(`(() => {
        const box = ${LAST};
        for (const pill of box ? box.querySelectorAll('[data-testid="approval-row-pill"]') : []) {
          let e = pill;
          while (e && e !== box && !(e.innerText || "").includes(${JSON.stringify(needle)})) e = e.parentElement;
          if (!e || e === box || e.querySelectorAll('[data-testid="approval-row-pill"]').length !== 1) continue;
          pill.scrollIntoView({ block: "center" });
          const r = pill.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }
        return null;
      })()`);
      if (at === null) throw new Error(`no asking row reads ${needle}: ${await rows()}`);
      await app.pointer(at.x, at.y);
      await settle(200);
      await app.clickAt(at.x, at.y);
      await settle(600);
    };

    const open = async (title: string, permissionSet: unknown): Promise<{ title: string; taskId: string; instanceId: string }> => {
      // A conversation as the Chat view starts one (`conversation: true`), so it is drawn there: a task's
      // own run page draws a later turn's approval nowhere (see the report of 2026-11-02).
      const made = await app.ipc<{ taskId: string }>("task:create", { title, workflow: "chat/session", inputs: { message: "Reply with the single word: ready." }, conversation: true });
      // Under the set its turns will use: one picked afresh for a turn is another session of the conversation.
      await app.ipc("task:start", { taskId: made.taskId, overrides: { model: MODEL, permissionSet } });
      await app.clickText("Chat");
      await app.until(says(title), "the conversation to be listed", 200);
      await app.clickText(title);
      await app.until(says("ready"), "the opening answer", 400);
      // By the task's own status: "done" on the page may be another conversation's card on the board.
      for (let i = 0; (await app.ipc<{ status: string } | null>("task:detail", { taskId: made.taskId }))?.status === "running"; i++) {
        if (i > 240) throw new Error(`${title}: the opening run did not end in two minutes`);
        await settle(500);
      }
      await settle(1500);
      const thread = await app.ipc<{ instanceId: string }>("chat:thread", { taskId: made.taskId });
      return { title, taskId: made.taskId, instanceId: thread.instanceId };
    };
    // Not awaited: a send settles when its turn does, and a turn may wait on the ask.
    const send = (chat: { taskId: string; instanceId: string }, message: string, permissionSet: unknown): Promise<unknown> =>
      app.evaluate(`window.__turnEnded = false; window.__sendFailed = null; void window.jaira.invoke("chat:send", ${JSON.stringify({ taskId: chat.taskId, instanceId: chat.instanceId, message, overrides: { model: MODEL, permissionSet } })}).then(() => { window.__turnEnded = true; }, (e) => { window.__sendFailed = String(e); }), true`);
    const pending = async (taskId: string): Promise<Pending[]> => (await app.ipc<Pending[]>("approval:pending", undefined)).filter((p) => p.taskId === taskId);
    const untilAsked = async (taskId: string, what: string): Promise<Pending> => {
      for (let i = 0; ; i++) {
        const [first] = await pending(taskId);
        if (first !== undefined) {
          await settle(2500);
          return first;
        }
        if (i > 240) {
          await app.shot(`no-ask-${what}`);
          throw new Error(`${what}: no ask in two minutes; the page ends: ${JSON.stringify((await app.evaluate<string>("document.body.innerText")).slice(-600))}`);
        }
        await settle(500);
      }
    };
    /** The turn to end; the asks parked on the way. `answer` answers each (by IPC) so the turn can end. */
    const untilTurnEnds = async (taskId: string, what: string, answer?: "allow" | "deny"): Promise<Pending[]> => {
      const seen: Pending[] = [];
      for (let i = 0; !(await app.evaluate<boolean>("window.__turnEnded === true")); i++) {
        const failed = await app.evaluate<string | null>("window.__sendFailed ?? null");
        if (failed !== null) throw new Error(`${what}: the send failed: ${failed}`);
        for (const p of await pending(taskId)) {
          if (seen.some((s) => s.requestId === p.requestId)) continue;
          seen.push(p);
          if (answer !== undefined) await app.ipc("approval:submit", { requestId: p.requestId, decision: answer, scope: "once" }).catch(() => undefined);
        }
        if (i > 360) {
          await app.shot(`no-end-${what}`);
          throw new Error(`${what}: the turn did not end in three minutes`);
        }
        await settle(500);
      }
      await settle(1500);
      return seen;
    };
    const rows = (): Promise<string> => app.evaluate<string>(`(${LAST})?.querySelector('[data-testid="approval-parts"]')?.innerText ?? ""`);
    /** What the page says after the last time it said `sentence` (the message sent): the answer to it. */
    const after = (sentence: string): Promise<string> =>
      app.evaluate<string>(`(() => { const text = document.body.innerText; const at = text.lastIndexOf(${JSON.stringify(sentence.split("\n")[0])}); return at < 0 ? "" : text.slice(at); })()`);
    /** The last approval, framed. */
    const shootApproval = async (name: string): Promise<void> => {
      const found = await app.evaluate<boolean>(`(() => { document.querySelectorAll('[data-rig]').forEach((e) => e.removeAttribute('data-rig')); const box = ${LAST}; if (box) { box.scrollIntoView({ block: "center" }); box.setAttribute('data-rig', 'approval'); } return !!box; })()`);
      await settle(400);
      if (!found) {
        await app.shot(`no-approval-${name}`, undefined, false);
        throw new Error(`${name}: no approval is drawn; the page ends: ${JSON.stringify((await app.evaluate<string>("document.body.innerText")).slice(-900))}`);
      }
      await app.shot(name, '[data-rig="approval"]', false);
    };
    const theme = async (): Promise<string> => await app.theme();
    /** The stack bar, framed, and the `app/build` segment's card over the window. */
    const shootStack = async (suffix: string): Promise<void> => {
      await app.shot(`stack-bar-${suffix}`, '[role="group"][aria-label="Permissions"]', false);
      await press('[aria-label="app/build"]');
      await settle(800);
      await app.shot(`stack-card-${suffix}`, undefined, false);
      // Each program's fold open, and each line's places under it (§4.2): the bare `git` line's places
      // are the group head's, `npm run build`'s are its own row's.
      for (let round = 0; round < 5; round++) {
        const shut = await app.evaluate<Array<{ x: number; y: number; text: string; tag: string }>>(`[...document.querySelectorAll('[aria-expanded="false"]')]
          .filter((e) => /^[›\\s]*(npm|git)\\b/.test(e.innerText || "") && !e.closest('[role="group"][aria-label="Permissions"]') && !e.closest('[data-testid="approval"]'))
          .map((e) => { const r = e.getBoundingClientRect(); return { x: r.left + Math.min(40, r.width / 2), y: r.top + r.height / 2, text: (e.innerText || "").replace(/\\s+/g, " ").slice(0, 40), tag: e.tagName }; })
          .filter((one) => one.y > 0)`);
        // One a round: each opened moves what is under it.
        const [at] = shut;
        if (at === undefined) break;
        console.log(`runner-approval: opening a fold of the card at ${JSON.stringify(at)} (${shut.length} shut)`);
        await app.pointer(at.x, at.y);
        await settle(200);
        await app.clickAt(at.x, at.y);
        await settle(400);
      }
      await settle(400);
      await app.shot(`stack-card-open-${suffix}`, undefined, false);
      const card = await app.evaluate<string>(`document.body.innerText`);
      console.log(`runner-approval: the app/build card reads\n${card.slice(card.indexOf("build.json"), card.indexOf("build.json") + 400)}`);
      check(card.includes("build.json") && /npm/.test(card) && /run build/.test(card), `${suffix}: the app/build segment's card names its file and its line`);
      await app.press("Escape", 27);
      await settle(400);
    };

    // a. Full access: the line runs, and nobody is asked.
    {
      const full = await open("Under full access", FULL);
      const message = run(BUILD);
      await send(full, message, FULL);
      const asked = await untilTurnEnds(full.taskId, "under full access", "allow");
      await app.shot("a-full-access");
      check(asked.length === 0, `a. under full the build ran without an ask (asked ${asked.length})`);
      check((await after(message)).includes("BUILT-OK"), "a. under full the reply says BUILT-OK");
    }

    // b. The stack: the line app/build names runs outright, in its package; a script it does not name
    // asks, what it runs under `runner:npm`, each row saying who decided it.
    const stack = await open("A layer over ask-first", STACK);
    {
      const message = run(BUILD);
      await send(stack, message, STACK);
      const asked = await untilTurnEnds(stack.taskId, "the stacked build", "deny");
      await app.shot(`b-named-line-${await theme()}`);
      check(asked.length === 0, `b. under ask-first + app/build, the line app/build names ran without an ask (asked ${asked.length}: ${JSON.stringify(asked.map((p) => p.command))})`);
      check((await after(message)).includes("BUILT-OK"), "b. the named line ran: the reply says BUILT-OK");
    }
    {
      const message = run(CHECK);
      await send(stack, message, STACK);
      await untilAsked(stack.taskId, "the stacked check");
      await shootApproval(`b-nested-${await theme()}`);
      const said = await rows();
      console.log(`runner-approval: the rows read\n${said}`);
      check(/runner:npm/.test(said), "b. the rows name runner:npm");
      check(/ask-first asks/.test(said), "b. the asking rows say ask-first asks");
      check(/in packages\/app · ask-first asks/.test(said), "b. a row says where it runs, project-relative");
      const stackLine = await app.evaluate<string>(`(${LAST})?.querySelector('[data-testid="approval-stack"]')?.innerText ?? ""`);
      console.log(`runner-approval: the stack line reads ${JSON.stringify(stackLine)}`);
      await shootStack(await theme());

      // c. One row answered on its own: a Where, Add to app/build, Allow; then Continue.
      await pressRow("git");
      const panelUp = await app.evaluate<boolean>(`document.querySelector('[data-testid="approval-row-panel"]') !== null`);
      check(panelUp, "c. the git row's pill opens its panel");
      const where = await app.evaluate<string[]>(`[...document.querySelectorAll('[data-testid="approval-row-where"] [role="radio"]')].map((e) => e.innerText.trim())`);
      console.log(`runner-approval: Where offers ${JSON.stringify(where)}`);
      // The second place, not the narrowest: a folder that holds where it ran, so the file shows a place.
      const placeAt = where.length > 2 ? 2 : 1;
      await press(`[data-testid="approval-row-where"] [role="radio"]:nth-child(${placeAt})`);
      const place = where[placeAt - 1] ?? "";
      await press('[data-testid="approval-row-layer"]');
      const layerItems = await app.evaluate<string[]>(`[...document.querySelectorAll('[data-testid^="approval-row-layer-"]')].map((e) => e.getAttribute('data-testid') + ' = ' + e.innerText.replace(/\\s+/g, ' '))`);
      console.log(`runner-approval: Add to offers ${JSON.stringify(layerItems)}`);
      await app.shot(`c-layer-picker-${await theme()}`, undefined, false);
      await press('[data-testid^="approval-row-layer-app/build"]');
      await app.shot(`c-panel-${await theme()}`, undefined, false);
      const panelText = await app.evaluate<string>(`document.querySelector('[data-testid="approval-row-panel"]')?.innerText ?? ""`);
      console.log(`runner-approval: the panel reads\n${panelText}`);
      check(/build\.json/.test(panelText), "c. Add to names app/build's file and the line it would write");
      await press('[data-testid="approval-row-allow"]');
      const bottom = await app.evaluate<{ go: boolean; cancel: boolean; allow: boolean }>(
        `(() => { const box = ${LAST}; return { go: !!box.querySelector('[data-testid="approval-continue"]'), cancel: !!box.querySelector('[data-testid="approval-cancel"]'), allow: !!box.querySelector('[data-testid="approval-allow"]') }; })()`,
      );
      await shootApproval(`c-answered-${await theme()}`);
      check(bottom.go && bottom.cancel && !bottom.allow, "c. once a row is answered by hand the bottom pair is Continue / Cancel");
      console.log(`runner-approval: the rows read\n${await rows()}`);
      await press('[data-testid="approval-continue"]', LAST);
      const later = await untilTurnEnds(stack.taskId, "after Continue", "allow");
      check(later.length === 0, `c. Continue answered the whole command (${later.length} more asks)`);
      check((await after(message)).includes("BUILT-OK"), "c. the build ran: the reply says BUILT-OK");
      const file = readFileSync(layerFile, "utf8");
      console.log(`runner-approval: ${layerFile} now reads\n${file}`);
      const lines = JSON.parse(file) as Record<string, unknown>;
      const gitLine = Object.entries(lines).find(([subject]) => subject.startsWith("git"));
      const places = gitLine !== undefined && typeof gitLine[1] === "object" && gitLine[1] !== null ? Object.keys(gitLine[1]) : [];
      check(lines["npm run build"] !== undefined && places.length === 1 && places[0] !== "**", `c. app/build's file keeps its line and holds the git line at one place (${JSON.stringify(gitLine)}, chosen "${place}")`);
    }
    {
      // Asked again: the git row is the layer's now.
      const message = run(CHECK);
      await send(stack, message, STACK);
      await untilAsked(stack.taskId, "the build again");
      const said = await rows();
      console.log(`runner-approval: asked again, the rows read\n${said}`);
      await shootApproval(`c-again-${await theme()}`);
      const gitAsks = await app.evaluate<boolean>(`(() => { const box = ${LAST}; return [...box.querySelectorAll('[data-testid="approval-row-pill"]')].some((pill) => { let e = pill; while (e && e !== box && !(e.innerText || "").includes("git")) e = e.parentElement; return e && e !== box && e.querySelectorAll('[data-testid="approval-row-pill"]').length === 1; }); })()`);
      check(!gitAsks, "c. asked again, the git row does not ask");
      await press('[data-testid="approval-allow"]', LAST);
      await untilTurnEnds(stack.taskId, "the build again", "allow");
      check((await after(message)).includes("BUILT-OK"), "c. asked again, the build ran");
    }

    // d. A fresh line, its row denied for this run.
    {
      const line = "hostname";
      const message = run(line);
      await send(stack, message, STACK);
      await untilAsked(stack.taskId, "a fresh line");
      console.log(`runner-approval: the fresh line's rows read\n${await rows()}`);
      await pressRow("hostname");
      if (!(await app.evaluate<boolean>(`document.querySelector('[data-testid="approval-row-panel"]') !== null`))) {
        await app.shot(`d-no-panel-${await theme()}`, undefined, false);
        throw new Error("d. the hostname row's pill opened no panel");
      }
      await press('[data-testid="approval-row-reach-run"]');
      await app.shot(`d-panel-deny-${await theme()}`, undefined, false);
      await press('[data-testid="approval-row-deny"]');
      await shootApproval(`d-denied-${await theme()}`);
      const refuses = await app.evaluate<string>(`(${LAST})?.innerText ?? ""`);
      check(/Continue refuses the command/.test(refuses), "d. a denied row says Continue refuses the command");
      await press('[data-testid="approval-continue"]', LAST);
      const more = await untilTurnEnds(stack.taskId, "the denied line", "deny");
      const reply = await after(message);
      console.log(`runner-approval: the denied line's answer reads\n${reply.slice(0, 900)}`);
      await app.shot(`d-refused-${await theme()}`);
      check(more.length === 0, "d. Continue answered the whole command");
      check(/not run|denied|refused|declined/i.test(reply), "d. the agent was told the line was refused");
      const again = run(line);
      await send(stack, again, STACK);
      const asked = await untilTurnEnds(stack.taskId, "the denied line again", "deny");
      const reply2 = await after(again);
      console.log(`runner-approval: asked again, the answer reads\n${reply2.slice(0, 900)}`);
      await app.shot(`d-refused-again-${await theme()}`);
      check(asked.length === 0, `d. the denied line was refused again without an ask (asked ${asked.length})`);
      check(/not run|denied|refused|declined/i.test(reply2), "d. the agent was told why the second time");
    }

    // e. Places on a direct tool call.
    {
      const askFirst = await open("Reads under ask-first", ASK_FIRST);
      const message = read(outsideFile);
      await send(askFirst, message, ASK_FIRST);
      const asked = await untilTurnEnds(askFirst.taskId, "reading outside under ask-first", "deny");
      console.log(`runner-approval: under ask-first, a read outside asked ${JSON.stringify(asked.map((p) => ({ tool: p.tool, input: p.input })))}`);
      await app.shot(`e-ask-first-outside-${await theme()}`);
      check(asked.length > 0, "e. under ask-first a read outside the project asks");
    }
    {
      const readOnly = await open("Reads under read-only", READ_ONLY);
      const message = read("notes.txt", outsideFile);
      await send(readOnly, message, READ_ONLY);
      const asked = await untilTurnEnds(readOnly.taskId, "reading under read-only", "deny");
      const reply = await after(message);
      console.log(`runner-approval: under read-only, asked ${JSON.stringify(asked.map((p) => ({ tool: p.tool, input: p.input })))}\n${reply.slice(0, 600)}`);
      await app.shot(`e-read-only-${await theme()}`);
      check(reply.includes("NOTES-OK"), "e. under read-only a read in the project ran");
      check(asked.length === 1 && JSON.stringify(asked[0]?.input ?? "").includes("far.txt"), "e. under read-only only the read outside the project asked");
    }
    {
      const full = await open("Reads under full access", FULL);
      const message = read("notes.txt", ".env");
      await send(full, message, FULL);
      const asked = await untilTurnEnds(full.taskId, "reading .env under full", "deny");
      const reply = await after(message);
      console.log(`runner-approval: under full, asked ${JSON.stringify(asked.map((p) => ({ tool: p.tool, input: p.input })))}\n${reply.slice(0, 600)}`);
      await app.shot(`e-full-env-${await theme()}`);
      check(reply.includes("NOTES-OK"), "e. under full a plain project file was read without an ask");
      check(asked.length === 1 && JSON.stringify(asked[0]?.input ?? "").includes(".env"), "e. under full only the .env read asked");
      check(!reply.includes("rig-secret"), "e. the denied .env was not read");
    }

    // f. Dark: the stack conversation again, its stack, a segment's card, an approval and its panel.
    {
      await app.preferTheme("dark");
      await app.navigate(await app.evaluate<string>("location.href"));
      await app.until(drawn, "the window to draw again");
      await settle(1500);
      if (!(await app.evaluate<boolean>(says("A layer over ask-first")))) throw new Error("the conversation is not listed after the reload");
      await app.clickText(stack.title);
      await settle(1500);
      check((await theme()) === "dark", "f. the window opened dark");
      await shootStack(await theme());
      const message = run(CHECK);
      await send(stack, message, STACK);
      await untilAsked(stack.taskId, "the build in the dark");
      await shootApproval(`f-approval-${await theme()}`);
      await pressRow("node");
      await app.shot(`f-panel-${await theme()}`, undefined, false);
      await app.press("Escape", 27);
      await settle(400);
      await press('[data-testid="approval-deny"]', LAST);
      await untilTurnEnds(stack.taskId, "the build in the dark", "deny");
      await app.preferTheme("light");
    }

    // g. A narrow composer: as the room goes, the chips drop to icons and nothing is drawn over anything
    // else — the model chip's glyph stood over the account's figure after it. In this conversation, and on
    // the task's own page, whose room is narrower.
    {
      /** Whether two of the foot's items overlap, or the model chip's glyph stands out of its chip. */
      const footOverlap = (): Promise<string[]> =>
        app.evaluate<string[]>(`(() => {
          const found = [];
          for (const chip of document.querySelectorAll('[aria-label="Model"]')) {
            const wrap = chip.parentElement, foot = wrap && wrap.parentElement;
            if (!foot || chip.getBoundingClientRect().width === 0) continue;
            const items = [...foot.children].map((e) => ({ e, r: e.getBoundingClientRect() })).filter(({ r }) => r.width > 0);
            for (let i = 1; i < items.length; i++) if (items[i].r.left < items[i - 1].r.right - 0.5) found.push((items[i - 1].e.innerText || "?").trim().slice(0, 20) + " over " + (items[i].e.innerText || "?").trim().slice(0, 20));
            const glyph = chip.querySelector("svg");
            if (glyph && glyph.getBoundingClientRect().right > wrap.getBoundingClientRect().right + 0.5) found.push("the model's glyph out of its chip");
          }
          return found;
        })()`);
      for (const width of [1180, 900, 760, 640]) {
        await app.resize(width, 860);
        await settle(900);
        const overlaps = await footOverlap();
        await app.shot(`g-narrow-chat-${width}`, undefined, false);
        check(overlaps.length === 0, `g. the Chat view's composer at ${width}: nothing over anything (${JSON.stringify(overlaps)})`);
      }
      await app.resize(1180, 860);
      await settle(600);
      await app.clickText("Tasks");
      await settle(1200);
      if (await app.evaluate<boolean>(says(stack.title))) {
        await app.clickText(stack.title);
        await settle(1500);
        for (const width of [1180, 900, 760]) {
          await app.resize(width, 860);
          await settle(900);
          const overlaps = await footOverlap();
          await app.shot(`g-narrow-task-${width}`, undefined, false);
          check(overlaps.length === 0, `g. the task page's composer at ${width}: nothing over anything (${JSON.stringify(overlaps)})`);
        }
        await app.resize(1180, 860);
      } else console.log("runner-approval: g. the task is not listed under Tasks — its own page not checked");
    }
  } finally {
    await app.close();
  }
  if (failures.length > 0) {
    console.log(`runner-approval: ${failures.length} failed:\n  ${failures.join("\n  ")}`);
    process.exitCode = 1;
  } else console.log("runner-approval: every check passed");
}

await main();
