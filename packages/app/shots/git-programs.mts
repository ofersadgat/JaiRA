/**
 * Settings → Connections → Git, in the real app (2026-11-17). The person, asked whether git, glab and
 * gh were looked for: "yes" — git checked, with the ways to install it, as the agents are.
 *
 * The app is started with the PATH a Mac app gets from the Finder, plus a stand-in Homebrew prefix
 * first on it: nothing real is installed. The stand-in `brew install gh` writes a stand-in `gh` into that
 * prefix's Cellar and links it into its bin, as Homebrew does; it answers `--version`. git and glab are
 * whatever this machine has.
 *
 *   1. The Git section: git a row — ready, with its version — whether or not it is here; a forge CLI
 *      found on this machine a row; one not found a tile on the "Forge CLIs" shelf, saying what Install
 *      uses, its ▾ listing the ways with the command each runs.
 *   2. Install pressed on the GitHub CLI's tile (the stand-in brew): the tile is gone at once and the
 *      GitHub CLI is a row of the card, opened, its output scrolling in a box under "installing…" and
 *      Cancel — `$ brew install gh`, then what the stand-in prints, its progress bar as its last drawing.
 *   3. Installed: still a row, opened — ready, its version, "Homebrew", the version line with Update —
 *      the output's head "installed" and Hide; Hide puts the output away.
 *   4. Git's row opened: where it was found.
 *
 * Only the stand-in brew is ever pressed. A real glab found only in /usr/local/bin (a Finder app's PATH
 * does not name it) is reached by the check, which adds that folder to the app's PATH.
 *
 *   npm --workspace @jaira/app run build
 *   npx tsx packages/app/shots/git-programs.mts
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { App } from "./driver.mjs";
import { drawn, settle } from "./parityWorld.mjs";
import { buildWorld } from "./world.mjs";

const OUT = join(import.meta.dirname, "out", "git-programs");
const WORLD = join(import.meta.dirname, ".world-git-programs");

/** The stand-in brew: `install gh` puts a stand-in gh in the Cellar and links it into bin. */
const FAKE_BREW = `#!/bin/sh
prefix="$(cd "$(dirname "$0")/.." && pwd)"
echo "$*" >> "$prefix/brew-calls.log"
case "$1 $2" in
  "install gh"|"upgrade gh") ;;
  *) echo "Error: the stand-in brew installs only gh" >&2; exit 1 ;;
esac
n=104; [ -f "$prefix/n" ] && n=$(( $(cat "$prefix/n") + 1 )); echo "$n" > "$prefix/n"
dir="$prefix/Cellar/gh/2.$n.0/bin"
mkdir -p "$dir"
printf '\\033[34m==>\\033[0m \\033[1mDownloading https://ghcr.io/v2/homebrew/core/gh/manifests/2.%s.0\\033[0m\\n' "$n"
for pct in 10 30 50 70 90 100; do
  printf '\\r######## %s.0%%' "$pct"
  sleep 0.5
done
printf '\\n'
echo "==> Fetching gh" >&2
sleep 3
cat > "$dir/gh" <<EOF
#!/bin/sh
[ "\\$1" = "--version" ] && { echo "gh version 2.$n.0 (2026-11-12)"; echo "https://github.com/cli/cli/releases/tag/v2.$n.0"; exit 0; }
echo "a stand-in" >&2; exit 1
EOF
chmod +x "$dir/gh"
ln -sf "../Cellar/gh/2.$n.0/bin/gh" "$prefix/bin/gh"
echo "==> Pouring gh--2.$n.0"
`;

interface Probe {
  name: string;
  status: string;
  detail: string;
  version?: string;
  install?: { path?: string; method?: string; update?: { display: string }; install?: Array<{ method: string; display: string }> };
}

async function main(): Promise<void> {
  const world = buildWorld(WORLD);
  const prefix = join(WORLD, "brew");
  mkdirSync(join(prefix, "bin"), { recursive: true });
  writeFileSync(join(prefix, "bin", "brew"), FAKE_BREW);
  chmodSync(join(prefix, "bin", "brew"), 0o755);
  // The PATH launchd gives a Mac app opened from the Finder, and the stand-in prefix before it.
  process.env["PATH"] = [join(prefix, "bin"), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");

  const app = await App.launch(world, { out: OUT, port: 9274 });
  const failures: string[] = [];
  const check = (ok: boolean, what: string): void => {
    console.log(`git-programs: ${ok ? "PASS" : "FAIL"} ${what}`);
    if (!ok) failures.push(what);
  };
  const checks = async (): Promise<Probe[]> => (await app.ipc<{ gitClis?: Probe[] }>("availability:read", undefined)).gitClis ?? [];
  const one = async (name: string): Promise<Probe | undefined> => (await checks()).find((probe) => probe.name === name);
  /** Bring the Git section into the window: the settings pane scrolls itself, and paints only what is in view. */
  const toGit = (): Promise<unknown> =>
    app.evaluate(`(() => {
      const head = [...document.querySelectorAll("*")].find((e) => e.childElementCount === 0 && (e.textContent ?? "").trim() === "Forge CLIs")
        ?? [...document.querySelectorAll("[aria-label='open Git']")][0];
      head?.scrollIntoView({ block: "center" });
      return !!head;
    })()`);
  try {
    await app.until(drawn, "the window to draw");
    await app.resize(1180, 1400);
    for (let i = 0; ; i++) {
      if ((await checks()).length === 3) break;
      if (i > 60) throw new Error(`the git programs were never checked: ${JSON.stringify(await checks())}`);
      await settle(500);
    }
    const before = await checks();
    console.log(`git-programs: checks ${JSON.stringify(before)}`);
    const git = before.find((p) => p.name === "git");
    check(git?.status === "ok" && git.version !== undefined, `git is ready, with its version (${JSON.stringify(git)})`);
    const gh = before.find((p) => p.name === "gh");
    check(gh?.status === "failed" && gh.install?.install?.[0]?.display === "brew install gh", `gh is not here, and the stand-in brew installs it (${JSON.stringify(gh?.install)})`);
    const glab = before.find((p) => p.name === "glab");
    if (existsSync("/usr/local/bin/glab")) check(glab?.status === "ok" && /added \/usr\/local\/bin to the PATH/.test(glab.detail), `this machine's glab is reached and ready (${JSON.stringify(glab)})`);

    // 1. The section.
    await app.clickText("Settings");
    await app.until(`document.body.innerText.includes("Forge CLIs") && !!document.querySelector('[aria-label="ways to install GitHub CLI"]')`, "the GitHub CLI's tile on the shelf", 60);
    await toGit();
    await settle(700);
    await app.shot("1-git-section", undefined, false);
    const page = await app.evaluate<string>("document.body.innerText");
    check(page.includes("installs with Homebrew"), "the tile says what Install uses");
    check(!!(await app.evaluate<boolean>(`!!document.querySelector('[aria-label="open Git"]')`)), "git is a row");

    await app.evaluate(`document.querySelector('[aria-label="ways to install GitHub CLI"]').click()`);
    await app.until(`[...document.querySelectorAll("[role=menu]")].some((m) => (m.textContent ?? "").includes("brew install gh"))`, "the ways to install the GitHub CLI");
    await settle(400);
    const menu = await app.evaluate<string>(`[...document.querySelectorAll("[role=menu]")].map((m) => m.innerText).join("\\n")`);
    check(menu.includes("Install GitHub CLI with") && menu.includes("brew install gh"), "the ways list Homebrew with its command");
    check(!menu.includes("set its command"), "a git program's ways have nothing to set");
    await app.shot("1-ways", undefined, false);

    // 2. Install.
    const pressed = await app.evaluate<boolean>(`(() => {
      const way = [...document.querySelectorAll("[role=menuitem]")].find((e) => (e.textContent ?? "").includes("brew install gh"));
      if (!way) return false;
      way.click();
      return true;
    })()`);
    check(pressed, "the Homebrew way is there to press");
    // At once: the tile is gone, and the GitHub CLI is a row of the card, opened, its output under it.
    await app.until(`!document.querySelector('[aria-label="ways to install GitHub CLI"]') && !!document.querySelector('[aria-label="close GitHub CLI"]')`, "the GitHub CLI to move from the shelf to an opened row", 10);
    const outputOf = (): Promise<string> => app.evaluate<string>(`[...document.querySelectorAll('[aria-label="install output"]')].map((e) => e.innerText).join("\\n")`);
    await app.until(`[...document.querySelectorAll('[aria-label="install output"]')].some((e) => e.innerText.includes("######## 50.0%") || e.innerText.includes("######## 70.0%"))`, "the progress bar to come through", 20);
    await app.evaluate(`document.querySelector('[aria-label="install output"]')?.scrollIntoView({ block: "center" })`);
    await settle(200);
    await app.shot("2-installing", undefined, false);
    const midway = await outputOf();
    console.log(`git-programs: output midway ${JSON.stringify(midway)}`);
    check(midway.includes("installing…") && midway.includes("Cancel"), "the output's head says it is installing, with Cancel");
    check(midway.includes("$ brew install gh"), "the output starts with the command it runs");
    check(midway.includes("==> Downloading https://ghcr.io/v2/homebrew/core/gh/manifests/2.104.0") && !midway.includes("\u001b") && !midway.includes("[34m"), "the installer's line comes through, its colours dropped");
    check(!/######## 10\.0%[\s\S]*######## 30\.0%/.test(midway), "the progress bar is its last drawing, not one line a drawing");

    // 3. Installed: still a row, opened, the output saying so.
    for (let i = 0; ; i++) {
      const now = await one("gh");
      if (now?.version !== undefined) break;
      if (i > 60) throw new Error(`gh never came up after the install: ${JSON.stringify(now)}`);
      await settle(500);
    }
    await app.until(`[...document.querySelectorAll('[aria-label="install output"]')].some((e) => e.innerText.includes("installed") && e.innerText.includes("Hide"))`, "the output to say it is installed", 30);
    const after = await outputOf();
    console.log(`git-programs: output after ${JSON.stringify(after)}`);
    check(after.includes("######## 100.0%") && after.includes("==> Fetching gh") && after.includes("==> Pouring gh--2.104.0"), "the whole output is there, stderr's line too");
    check(after.includes("Done — checking what it installed…"), "the output's last line says the check followed");
    await app.evaluate(`document.querySelector('[aria-label="install output"]')?.scrollIntoView({ block: "center" })`);
    await settle(300);
    await app.shot("3-installed-output", undefined, false);
    const installed = await one("gh");
    check(installed?.version === "2.104.0 (2026-11-12)" && installed.install?.method === "homebrew", `the stand-in answers, installed with Homebrew (${JSON.stringify(installed)})`);
    // Hide: the output goes, and the row stays — gh is here now.
    await app.evaluate(`[...document.querySelectorAll('[aria-label="install output"] [role=button], [aria-label="install output"] button')].find((e) => (e.textContent ?? "").trim() === "Hide")?.click()`);
    await app.until(`!document.querySelector('[aria-label="install output"]') && !!document.querySelector('[aria-label="close GitHub CLI"]')`, "Hide to put the output away and leave the row", 10);
    await app.evaluate(`document.querySelector('[aria-label="open Git"]').click()`);
    await settle(700);
    await app.evaluate(`document.querySelector('[aria-label="close Git"]')?.scrollIntoView({ block: "start" })`);
    await settle(400);
    await app.shot("3-installed-opened", undefined, false);
    const opened = await app.evaluate<string>("document.body.innerText");
    check(opened.includes("2.104.0 (2026-11-12)") && opened.includes("Update"), "the opened row has its version and Update");
    check(opened.includes("found at /usr/bin/git"), "git's opened row says where it was found");
    const calls = readFileSync(join(prefix, "brew-calls.log"), "utf8").trim().split("\n");
    check(calls.length === 1 && calls[0] === "install gh", `brew was asked to install gh, once (${JSON.stringify(calls)})`);
  } finally {
    await app.close();
  }
  if (failures.length > 0) {
    console.log(`git-programs: ${failures.length} failed:\n  ${failures.join("\n  ")}`);
    process.exit(1);
  }
  console.log("git-programs: all passed");
}

void main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
