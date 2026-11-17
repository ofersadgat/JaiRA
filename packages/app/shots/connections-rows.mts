/**
 * Settings → Connections with every section closed to a line, in the real app (2026-11-17). The person
 * picked the canvas's "MCP A, Forges B": a tile per server another tool runs, and a forge with no token
 * on a "Not connected" shelf.
 *
 * The world configures two MCP servers that cannot answer — one JaiRA would start from a command that
 * is not there, one at an address nothing listens on — and one turned off; it stores no forge token, so
 * both built-in forges are tiles. What other tools on this machine run is whatever this machine has.
 *
 *   1. Model APIs, Local models, MCP servers and Forges, every row one line.
 *   2. A model API opened: its key under "Key", and its settings folded.
 *   3. "Another server" opened across the MCP shelf: the new server's form.
 *   4. A forge tile's ▾: Sign in with it, Paste a token, its settings; "Paste a token" opens the token's
 *      entry across the shelf. Nothing signs in: that would open the forge's page.
 *
 *   npm --workspace @jaira/app run build
 *   npx tsx packages/app/shots/connections-rows.mts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { App } from "./driver.mjs";
import { drawn, settle } from "./parityWorld.mjs";
import { buildWorld } from "./world.mjs";

const OUT = join(import.meta.dirname, "out", "connections-rows");
const WORLD = join(import.meta.dirname, ".world-connections-rows");

async function main(): Promise<void> {
  const world = buildWorld(WORLD);
  mkdirSync(world.home, { recursive: true });
  writeFileSync(
    join(world.home, "settings.json"),
    JSON.stringify(
      {
        mcp: {
          servers: {
            notes: { command: "jaira-no-such-mcp-server", args: ["--notes", "~/notes"], env: { NOTES_TOKEN: { credential: "NOTES_TOKEN" } } },
            tracker: { url: "http://127.0.0.1:9/mcp" },
            docs: { command: "npx", args: ["-y", "@upstash/context7-mcp"], enabled: false },
          },
        },
      },
      null,
      2,
    ),
  );
  const app = await App.launch(world, { out: OUT, port: 9276 });
  const failures: string[] = [];
  const check = (ok: boolean, what: string): void => {
    console.log(`connections-rows: ${ok ? "PASS" : "FAIL"} ${what}`);
    if (!ok) failures.push(what);
  };
  const text = (): Promise<string> => app.evaluate<string>("document.body.innerText");
  const scrollTo = (words: string): Promise<unknown> =>
    // The last match: the sidebar lists the same section names, and comes first.
    app.evaluate(`[...document.querySelectorAll("*")].filter((e) => e.childElementCount === 0 && (e.textContent ?? "").trim() === ${JSON.stringify(words)}).at(-1)?.scrollIntoView({ block: "start" })`);
  const press = (label: string): Promise<boolean> => app.evaluate<boolean>(`(() => { const b = document.querySelector('[aria-label=${JSON.stringify(label)}]'); if (!b) return false; b.click(); return true; })()`);
  const pressText = (words: string): Promise<boolean> =>
    app.evaluate<boolean>(`(() => {
      const hit = [...document.querySelectorAll("button, [role=button], [role=menuitem]")].find((e) => (e.textContent ?? "").trim() === ${JSON.stringify(words)});
      if (!hit) return false;
      hit.click();
      return true;
    })()`);
  try {
    await app.until(drawn, "the window to draw");
    await app.resize(1180, 1500);
    await app.clickText("Settings");
    await app.until(`document.body.innerText.includes("Not connected") && document.body.innerText.includes("Found on this machine")`, "the Forges and MCP shelves", 60);
    // The MCP servers are asked once the page opens.
    await app.until(`document.body.innerText.includes("jaira-no-such-mcp-server") || document.body.innerText.includes("failed")`, "the MCP servers' answers", 60);
    await settle(800);

    // 1. Every row one line.
    await scrollTo("Model APIs");
    await settle(500);
    await app.shot("1-apis-local-mcp", undefined, false);
    await scrollTo("Git");
    await settle(500);
    await app.shot("1-git-forges", undefined, false);
    const page = await text();
    check(page.includes("Not connected") && page.includes("a review opens as a merge request only where you are signed in"), "the forges with no token are on the Not connected shelf");
    check(!!(await app.evaluate<boolean>(`!!document.querySelector('[aria-label="ways to connect GitHub · github.com"]') && !!document.querySelector('[aria-label="ways to connect GitLab · gitlab.com"]')`)), "both built-in forges are tiles");
    check(!(await app.evaluate<boolean>(`!!document.querySelector('[aria-label="open GitHub · github.com"]')`)), "and neither is a row");
    check(page.includes("Another server") && page.includes("a command or an address"), "the MCP shelf ends with Another server");
    check(/Looked in .* when this page opened\. None is started until it is added\./.test(page), "the MCP shelf says where it looked");
    check(!!(await app.evaluate<boolean>(`!!document.querySelector('[aria-label="open notes"]') && !!document.querySelector('[aria-label="open tracker"]') && !!document.querySelector('[aria-label="open docs"]')`)), "the configured servers are rows");
    check(!page.includes("Servers other tools on this machine already run"), "the old table of places is gone");
    check(page.includes("serves anthropic/…") || page.includes("Add a key"), "a model API's line says what it serves, or its button asks for the key");

    // 2. A model API opened.
    await press("open OpenRouter");
    await app.until(`document.body.innerText.includes("Key") && [...document.querySelectorAll("summary, [role=button]")].some((e) => (e.textContent ?? "").includes("Settings"))`, "OpenRouter opened", 20);
    await scrollTo("OpenRouter");
    await settle(500);
    await app.shot("2-openrouter-opened", undefined, false);

    // 3. Another server.
    check(await pressText("+Another servera command or an address") || (await app.evaluate<boolean>(`(() => { const t = [...document.querySelectorAll("[aria-expanded]")].find((e) => (e.textContent ?? "").includes("Another server")); if (!t) return false; t.click(); return true; })()`)), "Another server is there to press");
    await app.until(`document.body.innerText.includes("A command JaiRA starts (stdio), or a URL it calls (HTTP).")`, "the new server's form across the shelf", 20);
    await scrollTo("Found on this machine");
    await settle(500);
    await app.shot("3-another-server", undefined, false);

    // 4. A forge tile's ways, and Paste a token.
    check(await press("ways to connect GitLab · gitlab.com"), "the GitLab tile has its ways");
    await app.until(`[...document.querySelectorAll("[role=menu]")].some((m) => (m.textContent ?? "").includes("Paste a token"))`, "the ways to connect GitLab", 20);
    const menu = await app.evaluate<string>(`[...document.querySelectorAll("[role=menu]")].map((m) => m.innerText).join("\\n")`);
    check(menu.includes("Sign in with GitLab") && menu.includes("opens gitlab.com with a code to enter"), "Sign in with GitLab, and what it does");
    check(menu.includes("Paste a token") && menu.includes("filed under GITLAB_TOKEN"), "Paste a token, and where it is filed");
    check(menu.includes("Its settings — host, token name, sign-in app…"), "the connection's settings");
    await app.shot("4-forge-ways", undefined, false);
    check(await pressText("Paste a tokenfiled under GITLAB_TOKEN") || (await app.evaluate<boolean>(`(() => { const w = [...document.querySelectorAll("[role=menuitem]")].find((e) => (e.textContent ?? "").includes("Paste a token")); if (!w) return false; w.click(); return true; })()`)), "Paste a token is there to press");
    await app.until(`document.body.innerText.includes("GitLab · gitlab.com — a token") && document.body.innerText.includes("Store the token")`, "the token's entry across the shelf", 20);
    await scrollTo("Not connected");
    await settle(500);
    await app.shot("4-forge-token", undefined, false);
  } finally {
    await app.close();
  }
  if (failures.length > 0) {
    console.log(`connections-rows: ${failures.length} failed:\n  ${failures.join("\n  ")}`);
    process.exit(1);
  }
  console.log("connections-rows: all passed");
}

void main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
