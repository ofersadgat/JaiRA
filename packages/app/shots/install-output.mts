/**
 * An install pressed in Settings → Connections shows what the installer prints, in the real app
 * (2026-11-17). The person: "installing github cli from jaira settings/connections seems to take a long
 * time with no way of seeing progress. what if we made it so that hitting install moves it up to the git
 * section expanded and you can see the terminal/output of the install command scrolling in a text box?"
 * — "(perhaps do this for other cli installs as well)". The Git section's own run is `git-programs.mts`;
 * this is the agents', which go through the same rows and the same box.
 *
 * The app is started with the PATH a Mac app gets from the Finder, plus a stand-in npm prefix first on
 * it: nothing real is installed. The stand-in `npm install -g @google/gemini-cli` draws npm's spinner (a
 * frame at a time over an erased line, in colour), writes a stand-in `gemini` into the prefix and says
 * how many packages it added; any other package it refuses with npm's 404.
 *
 *   1. Install with npm pressed on Gemini (cli)'s tile: the tile is gone at once and Gemini (cli) is a
 *      row of the Agents card, opened, its output scrolling in a box under "installing…" and Cancel —
 *      `$ npm install -g @google/gemini-cli`, then the spinner's frame being drawn.
 *   2. Installed: "installed" and Hide at the box's head, the spinner gone from it, npm's last line and
 *      "Done — checking what it installed…". Hide puts the box away; the row stays, Gemini is here now.
 *   3. OpenCode by npm, which the stand-in refuses: the row stays, opened, after the install failed — the
 *      reason in the box's head, npm's error in the box, the ways to install it back under it. Hide sends
 *      it back to the shelf.
 *
 * Only the stand-in npm is ever pressed.
 *
 *   npm --workspace @jaira/app run build
 *   npx tsx packages/app/shots/install-output.mts
 */
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { App } from "./driver.mjs";
import { drawn, settle } from "./parityWorld.mjs";
import { buildWorld } from "./world.mjs";

const OUT = join(import.meta.dirname, "out", "install-output");
const WORLD = join(import.meta.dirname, ".world-install-output");

/** The stand-in npm: `install -g @google/gemini-cli` draws a spinner and writes a stand-in gemini; anything else is a 404. */
const FAKE_NPM = `#!/bin/sh
prefix="$(cd "$(dirname "$0")/.." && pwd)"
echo "$*" >> "$prefix/npm-calls.log"
case "$3" in
  @google/gemini-cli|@google/gemini-cli@latest) ;;
  *)
    printf '\\033[31mnpm error\\033[0m code E404\\n' >&2
    printf '\\033[31mnpm error\\033[0m 404 Not Found - GET https://registry.npmjs.org/%s - Not found\\n' "$3" >&2
    exit 1 ;;
esac
printf '\\033[?25l'
for frame in "⠙ idealTree:lib" "⠹ idealTree:@google/gemini-cli" "⠸ reify:@google/genai" "⠼ reify:@google/gemini-cli" "⠴ reify:node_modules/.bin"; do
  printf '\\r\\033[K\\033[90m%s\\033[0m' "$frame"
  sleep 0.7
done
dir="$prefix/lib/node_modules/@google/gemini-cli"
mkdir -p "$dir"
cat > "$dir/cli.js" <<EOF
#!/bin/sh
[ "\\$1" = "--version" ] && { echo "0.31.0"; exit 0; }
echo "a stand-in" >&2; exit 1
EOF
chmod +x "$dir/cli.js"
ln -sf ../lib/node_modules/@google/gemini-cli/cli.js "$prefix/bin/gemini"
printf '\\r\\033[K\\033[?25h'
echo ""
echo "added 412 packages in 4s"
`;

async function main(): Promise<void> {
  rmSync(WORLD, { recursive: true, force: true });
  const world = buildWorld(WORLD);
  const prefix = join(WORLD, "npm-prefix");
  mkdirSync(join(prefix, "bin"), { recursive: true });
  writeFileSync(join(prefix, "bin", "npm"), FAKE_NPM);
  chmodSync(join(prefix, "bin", "npm"), 0o755);
  // The PATH launchd gives a Mac app opened from the Finder, and the stand-in prefix before it.
  process.env["PATH"] = [join(prefix, "bin"), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");

  const app = await App.launch(world, { out: OUT, port: 9275 });
  const failures: string[] = [];
  const check = (ok: boolean, what: string): void => {
    console.log(`install-output: ${ok ? "PASS" : "FAIL"} ${what}`);
    if (!ok) failures.push(what);
  };
  const probes = async (): Promise<Array<{ name: string; status: string; version?: string; install?: unknown }>> => (await app.ipc<{ executors: Array<{ name: string; status: string; version?: string }> }>("availability:read", undefined)).executors;
  const outputOf = (): Promise<string> => app.evaluate<string>(`[...document.querySelectorAll('[aria-label="install output"]')].map((e) => e.innerText).join("\\n----\\n")`);
  /** Press a way under a tile's ▾, found by the command it runs. */
  const pressWay = async (title: string, command: RegExp): Promise<boolean> => {
    await app.evaluate(`document.querySelector('[aria-label="ways to install ${title}"]').click()`);
    await app.until(`[...document.querySelectorAll("[role=menuitem]")].some((e) => ${command}.test(e.textContent ?? ""))`, `the ways to install ${title}`);
    return app.evaluate<boolean>(`(() => {
      const way = [...document.querySelectorAll("[role=menuitem]")].find((e) => ${command}.test(e.textContent ?? ""));
      if (!way) return false;
      way.click();
      return true;
    })()`);
  };
  const hide = (): Promise<unknown> =>
    app.evaluate(`[...document.querySelectorAll('[aria-label="install output"] button, [aria-label="install output"] [role=button]')].find((e) => (e.textContent ?? "").trim() === "Hide")?.click()`);
  const toOutput = async (): Promise<void> => {
    await app.evaluate(`document.querySelector('[aria-label="install output"]')?.scrollIntoView({ block: "center" })`);
    await settle(300);
  };
  try {
    await app.until(drawn, "the window to draw");
    await app.resize(1180, 1400);
    for (let i = 0; ; i++) {
      const gemini = (await probes()).find((p) => p.name === "gemini-cli");
      if (gemini?.install !== undefined) break;
      if (i > 60) throw new Error(`the check never looked for gemini's install: ${JSON.stringify(gemini)}`);
      await settle(500);
    }
    await app.clickText("Settings");
    await app.until(`!!document.querySelector('[aria-label="ways to install Gemini (cli)"]') && !!document.querySelector('[aria-label="ways to install OpenCode"]')`, "Gemini (cli)'s and OpenCode's tiles on the shelf", 60);
    await settle(500);

    // 1. Install with npm: a row at once, opened, with the output.
    check(await pressWay("Gemini (cli)", /npm install -g @google\/gemini-cli/), "the npm way is there to press");
    await app.until(`!document.querySelector('[aria-label="ways to install Gemini (cli)"]') && !!document.querySelector('[aria-label="close Gemini (cli)"]')`, "Gemini (cli) to move from the shelf to an opened row", 10);
    check(true, "the tile is gone at once, and Gemini (cli) is an opened row of the card");
    await app.until(`[...document.querySelectorAll('[aria-label="install output"]')].some((e) => /reify/.test(e.innerText))`, "the spinner to come through", 20);
    await toOutput();
    await app.shot("1-installing", undefined, false);
    const midway = await outputOf();
    console.log(`install-output: midway ${JSON.stringify(midway)}`);
    check(midway.includes("installing…") && midway.includes("Cancel"), "the head says it is installing, with Cancel");
    check(midway.includes("$ npm install -g @google/gemini-cli"), "the output starts with the command it runs");
    check(!/idealTree:lib[\s\S]*reify/.test(midway), "the spinner is the frame being drawn, not one line a frame");
    check(!midway.includes("[90m") && !midway.includes("[K"), "its escapes are dropped");

    // 2. Installed.
    await app.until(`[...document.querySelectorAll('[aria-label="install output"]')].some((e) => e.innerText.includes("Hide"))`, "the install to end", 40);
    await settle(400);
    await toOutput();
    await app.shot("2-installed", undefined, false);
    const after = await outputOf();
    console.log(`install-output: after ${JSON.stringify(after)}`);
    check(/^installed\b/m.test(after), "the head says it is installed");
    check(after.includes("added 412 packages in 4s") && after.includes("Done — checking what it installed…"), "npm's last line, then that the check follows");
    check(!after.includes("⠴") && !after.includes("reify"), "the spinner npm erased is gone");
    const gemini = (await probes()).find((p) => p.name === "gemini-cli");
    check(gemini?.version === "0.31.0", `the stand-in gemini answers (${JSON.stringify(gemini)})`);
    await hide();
    await app.until(`!document.querySelector('[aria-label="install output"]')`, "Hide to put the output away", 10);
    check(await app.evaluate<boolean>(`!!document.querySelector('[aria-label="close Gemini (cli)"]') || !!document.querySelector('[aria-label="open Gemini (cli)"]')`), "Gemini (cli) stays a row once hidden: it is here now");

    // 3. A refused install stays a row, with why.
    check(await pressWay("OpenCode", /npm install -g/), "OpenCode's npm way is there to press");
    await app.until(`[...document.querySelectorAll('[aria-label="install output"]')].some((e) => e.innerText.includes("Hide"))`, "OpenCode's install to fail", 30);
    await settle(400);
    await toOutput();
    await app.shot("3-failed", undefined, false);
    const failed = await outputOf();
    console.log(`install-output: failed ${JSON.stringify(failed)}`);
    check(/exited 1: npm error 404 Not Found/.test(failed), "the head says why, in npm's last words");
    check(failed.includes("npm error code E404"), "the box has the whole error");
    check(await app.evaluate<boolean>(`!!document.querySelector('[aria-label="close OpenCode"]') && !document.querySelector('[aria-label="ways to install OpenCode"]')`), "OpenCode stays an opened row after it failed");
    check((await app.evaluate<string>("document.body.innerText")).includes("curl -fsSL https://opencode.ai/v2/install | bash"), "the ways to install it are back under the output");
    await hide();
    await app.until(`!!document.querySelector('[aria-label="ways to install OpenCode"]')`, "Hide to send OpenCode back to the shelf", 10);
    check(true, "hidden, OpenCode is a tile on the shelf again");

    const calls = readFileSync(join(prefix, "npm-calls.log"), "utf8").trim().split("\n");
    check(calls.length === 2 && calls[0] === "install -g @google/gemini-cli", `npm was asked for gemini, then for OpenCode (${JSON.stringify(calls)})`);
  } finally {
    await app.close();
  }
  if (failures.length > 0) {
    console.log(`install-output: ${failures.length} failed:\n  ${failures.join("\n  ")}`);
    process.exit(1);
  }
  console.log("install-output: all passed");
}

void main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
