/**
 * Installing and updating an agent from Settings → Connections → Agents, in the real app (2026-11-16).
 * The person: "in the settings/connections/agents section, the claude (cli) detects if its installed
 * ... and offers to install it if it isnt installed. if it can, it should also offer to upgrade it using
 * the correct method" — and the same for codex; then "also add in gemini cli, muse code, and opencode", and
 * "also add antigravity cli".
 *
 * The app is started with the PATH a Mac app gets from the Finder, plus a stand-in npm prefix: nothing
 * real is installed or upgraded. The stand-in `npm install -g @anthropic-ai/claude-code` writes a
 * stand-in `claude` into that prefix (it answers `--version`, and `auth status` says signed out); each
 * run after the first bumps its version, as `@latest` would. Codex is whatever this machine has.
 *
 *   1. Claude (cli) not installed: a tile on the shelf under the Agents card, saying what Install uses; its
 *      ▾ lists the ways — the native installer first, npm among them — each with the command it runs.
 *      Gemini (cli), Antigravity (cli), Muse Code and OpenCode are tiles of their own, each offering its
 *      vendor's installers (none is installed on the machine this ran on). Since 2026-11-16 (the person:
 *      "I like 2, but the rows should be able to expand as well") no agent that is not here is a row.
 *   2. Install with npm pressed: the tile says it is installing, with Cancel.
 *   3. Installed: the tile is gone and Claude (cli) is a row of the card, offering Sign in (the stand-in
 *      is signed out); opened, it has its version, "npm" and Update.
 *   4. Update pressed: the stand-in's version goes up — the update went through the npm that installed it.
 *
 * Only the stand-in npm is ever pressed: the native installer, Homebrew and any Reinstall would act on
 * this machine.
 *
 *   npm --workspace @jaira/app run build
 *   npx tsx packages/app/shots/agent-install.mts
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { App } from "./driver.mjs";
import { drawn, settle } from "./parityWorld.mjs";
import { buildWorld } from "./world.mjs";

const OUT = join(import.meta.dirname, "out", "agent-install");
const WORLD = join(import.meta.dirname, ".world-agent-install");

/** The stand-in npm: `install -g` of claude's package writes a stand-in claude into this prefix. */
const FAKE_NPM = `#!/bin/sh
prefix="$(cd "$(dirname "$0")/.." && pwd)"
echo "$*" >> "$prefix/npm-calls.log"
case "$3" in
  @anthropic-ai/claude-code|@anthropic-ai/claude-code@latest) ;;
  *) echo "npm error 404 '$3' is not in this registry" >&2; exit 1 ;;
esac
dir="$prefix/lib/node_modules/@anthropic-ai/claude-code"
mkdir -p "$dir"
n=900; [ -f "$dir/n" ] && n=$(( $(cat "$dir/n") + 1 )); echo "$n" > "$dir/n"
sleep 3
cat > "$dir/cli.js" <<EOF
#!/bin/sh
case "\\$1" in
  --version) echo "2.1.$n (Claude Code)"; exit 0 ;;
  auth) echo '{"loggedIn": false, "authMethod": "none", "apiProvider": "firstParty"}'; exit 1 ;;
esac
echo "a stand-in" >&2; exit 1
EOF
chmod +x "$dir/cli.js"
ln -sf ../lib/node_modules/@anthropic-ai/claude-code/cli.js "$prefix/bin/claude"
echo "added 1 package in 3s"
`;

interface Probe {
  name: string;
  status: string;
  version?: string;
  install?: { path?: string; method?: string; broken?: boolean; update?: { display: string }; install?: Array<{ method: string; display: string }> };
}

async function main(): Promise<void> {
  const world = buildWorld(WORLD);
  const prefix = join(WORLD, "npm-prefix");
  mkdirSync(join(prefix, "bin"), { recursive: true });
  writeFileSync(join(prefix, "bin", "npm"), FAKE_NPM);
  chmodSync(join(prefix, "bin", "npm"), 0o755);
  // The PATH launchd gives a Mac app opened from the Finder, and the stand-in prefix before it.
  process.env["PATH"] = [join(prefix, "bin"), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");

  const app = await App.launch(world, { out: OUT, port: 9273 });
  const failures: string[] = [];
  const check = (ok: boolean, what: string): void => {
    console.log(`agent-install: ${ok ? "PASS" : "FAIL"} ${what}`);
    if (!ok) failures.push(what);
  };
  const probes = async (): Promise<Probe[]> => (await app.ipc<{ executors: Probe[] }>("availability:read", undefined)).executors;
  const claude = async (): Promise<Probe | undefined> => (await probes()).find((probe) => probe.name === "claude-cli");
  try {
    await app.until(drawn, "the window to draw");
    // Tall enough for the whole Agents card: the settings pane scrolls itself, so what is below the fold is not painted.
    await app.resize(1180, 2300);
    for (let i = 0; ; i++) {
      if ((await claude())?.install !== undefined) break;
      if (i > 60) throw new Error(`the check never looked for claude's install: ${JSON.stringify(await probes())}`);
      await settle(500);
    }
    const before = await probes();
    console.log(`agent-install: probes ${JSON.stringify(before.map((p) => ({ name: p.name, status: p.status, install: p.install })))}`);

    // 1. Not installed: a tile on the shelf under the card, its ways under its ▾.
    await app.clickText("Settings");
    await app.until(`document.body.innerText.includes("More agents") && !!document.querySelector('[aria-label="ways to install Claude (cli)"]')`, "Claude (cli)'s tile on the shelf", 60);
    await settle(600);
    await app.shot("1-not-installed");
    const page = await app.evaluate<string>("document.body.innerText");
    check(page.includes("installs with the native installer"), "the tile says what Install uses");
    check(!page.includes("curl -fsSL https://claude.ai/install.sh | bash"), "no command is drawn until the ways are asked for");
    for (const [name, command] of [
      ["gemini-cli", "npm install -g @google/gemini-cli"],
      ["antigravity-cli", "curl -fsSL https://antigravity.google/cli/install.sh | bash"],
      ["muse-code", "curl -fsSL https://dev.meta.ai/install.sh | bash"],
      ["opencode", "curl -fsSL https://opencode.ai/v2/install | bash"],
    ] as const) {
      const probe = before.find((p) => p.name === name);
      check(probe?.install?.install?.some((one) => one.display === command) === true, `${name} offers ${command} (${JSON.stringify(probe?.install)})`);
    }
    check(["Gemini (cli)", "Antigravity (cli)", "Muse Code", "OpenCode"].every((title) => page.includes(title)), "the four are tiles, titled");
    check(["Gemini (cli)", "Antigravity (cli)", "Muse Code", "OpenCode"].every((title) => !page.includes(`not working — '${title}`)), "none of them is a failing row");
    const codex = before.find((p) => p.name === "codex-cli");
    console.log(`agent-install: codex here is ${JSON.stringify(codex?.install)}`);

    // The ways, each with the command it runs.
    await app.evaluate(`document.querySelector('[aria-label="ways to install Claude (cli)"]').click()`);
    await app.until(`[...document.querySelectorAll("[role=menu]")].some((m) => (m.textContent ?? "").includes("npm install -g @anthropic-ai/claude-code"))`, "the ways to install Claude (cli)");
    await settle(400);
    const menu = await app.evaluate<string>(`[...document.querySelectorAll("[role=menu]")].map((m) => m.innerText).join("\\n")`);
    check(menu.includes("curl -fsSL https://claude.ai/install.sh | bash") && menu.includes("recommended"), "the native installer is offered first, with its command");
    check(menu.includes("npm install -g @anthropic-ai/claude-code"), "npm is offered, with its command");
    // Within the viewport: a capture beyond it resizes the page, and a menu closes when the window does.
    await app.shot("1-ways", undefined, false);

    // 2. Install with npm — the way found by its command.
    const pressed = await app.evaluate<boolean>(`(() => {
      const way = [...document.querySelectorAll("[role=menuitem]")].find((e) => (e.textContent ?? "").includes("npm install -g @anthropic-ai/claude-code"));
      if (!way) return false;
      way.click();
      return true;
    })()`);
    check(pressed, "the npm way is there to press");
    await settle(900);
    await app.shot("2-installing");
    check((await app.evaluate<string>("document.body.innerText")).includes("installing"), "the tile says it is installing");

    // 3. Installed: a row of its own in the card; its tile is gone.
    for (let i = 0; ; i++) {
      const now = await claude();
      if (now?.version !== undefined) break;
      if (i > 60) throw new Error(`claude never came up after the install: ${JSON.stringify(now)}`);
      await settle(500);
    }
    await app.until(`!document.querySelector('[aria-label="ways to install Claude (cli)"]') && !!document.querySelector('[aria-label="open Claude (cli)"]')`, "Claude (cli) to move from the shelf to a row", 30);
    await settle(800);
    await app.shot("3-installed");
    const installed = await claude();
    check(installed?.version === "2.1.900 (Claude Code)", `the stand-in answers (${installed?.version})`);
    check(installed?.install?.method === "npm" && installed.install.update?.display === "npm install -g @anthropic-ai/claude-code@latest", `it reads as installed with npm (${JSON.stringify(installed?.install)})`);
    // The stand-in is signed out: the closed row's one button signs it in.
    check(await app.evaluate<boolean>(`[...document.querySelectorAll("[title='opens the sign-in page']")].some((e) => (e.textContent ?? "").trim() === "Sign in")`), "the closed row offers Sign in");

    // Opened: the version line, how it was installed, and Update; who it runs as; the folded settings.
    await app.evaluate(`document.querySelector('[aria-label="open Claude (cli)"]').click()`);
    await app.until(`document.body.innerText.includes("Runs as")`, "Claude (cli)'s row to open");
    await settle(600);
    await app.shot("3-opened");
    const opened = await app.evaluate<string>("document.body.innerText");
    check(opened.includes("2.1.900 (Claude Code)") && /\bnpm\b/.test(opened), "the opened row has its version and npm");
    check(opened.includes("Settings"), "its settings are folded in it");

    // 4. Update.
    const updated = await app.evaluate<boolean>(`(() => {
      // The title is on the button's own element or the one around it, whichever the control draws.
      const titled = [...document.querySelectorAll("[title]")].find((e) => (e.getAttribute("title") ?? "").includes("@anthropic-ai/claude-code@latest") && (e.textContent ?? "").trim() === "Update");
      const button = titled && (titled.closest("button, [role=button]") ?? titled.querySelector("button, [role=button]") ?? titled);
      if (!button) return false;
      button.click();
      return true;
    })()`);
    check(updated, "Update is there to press, saying what it runs");
    await settle(900);
    await app.shot("4-updating");
    for (let i = 0; ; i++) {
      const now = await claude();
      if (now?.version === "2.1.901 (Claude Code)") break;
      if (i > 60) throw new Error(`the update never landed: ${JSON.stringify(now)}`);
      await settle(500);
    }
    await settle(800);
    await app.shot("5-updated");
    const calls = readFileSync(join(prefix, "npm-calls.log"), "utf8").trim().split("\n");
    check(calls.length === 2 && calls[0] === "install -g @anthropic-ai/claude-code" && calls[1] === "install -g @anthropic-ai/claude-code@latest", `npm was asked to install, then to update (${JSON.stringify(calls)})`);
  } finally {
    await app.close();
  }
  if (failures.length > 0) {
    console.log(`agent-install: ${failures.length} failed:\n  ${failures.join("\n  ")}`);
    process.exit(1);
  }
  console.log("agent-install: all passed");
}

void main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
