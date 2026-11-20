/**
 * What an install printed, as Connections keeps and draws it (`installLog.ts`): the service sends the
 * installer's output raw, saying where each command starts; it is kept a block a command, each drawn
 * as the agents' terminal draws it (`TermScreen`) — colours kept, a progress bar redrawn as its last
 * drawing — with the end kept when there is too much.
 */
import { describe, expect, it } from "vitest";
import { INSTALL_LOG_KEEP, appendInstallLog, installLogHeadOf, installLogKey, installLogPlain, installLogsOf, startedInstallLog, type InstallLog } from "../src/renderer/installLog";
import { TermScreen } from "../src/renderer/terminalModel";

const running: InstallLog = startedInstallLog(["npm"]);

/** What a block's screen is left showing, as text. */
function drawn(raw: string): string {
  const screen = new TermScreen();
  screen.write(raw);
  return screen.plain().replace(/\n$/, "");
}

describe("a block a command", () => {
  it("starts a block where the service says a command starts, and adds what follows to it", () => {
    let log = appendInstallLog(running, "", { display: "curl -fsSL https://fnm.vercel.app/install | bash", step: "Step 1 of 3: fnm (the native installer)" });
    log = appendInstallLog(log, "Installing fnm…\n");
    log = appendInstallLog(log, "", { display: "fnm install --lts", step: "Step 2 of 3: Node.js (fnm)" });
    log = appendInstallLog(log, "Installing Node v24.11.1\n");
    expect(log.blocks).toEqual([
      { command: "curl -fsSL https://fnm.vercel.app/install | bash", step: "Step 1 of 3: fnm (the native installer)", text: "Installing fnm…\n" },
      { command: "fnm install --lts", step: "Step 2 of 3: Node.js (fnm)", text: "Installing Node v24.11.1\n" },
    ]);
    expect(installLogPlain(log, drawn)).toBe("── Step 1 of 3: fnm (the native installer)\n$ curl -fsSL https://fnm.vercel.app/install | bash\nInstalling fnm…\n\n── Step 2 of 3: Node.js (fnm)\n$ fnm install --lts\nInstalling Node v24.11.1");
    // What is said before any command is a block of its own, with no command.
    expect(appendInstallLog(running, "looking…\n").blocks).toEqual([{ text: "looking…\n" }]);
  });

  it("is drawn as a terminal draws it: a progress bar's last drawing, a spinner's last frame, its colours kept", () => {
    expect(drawn("#####   20%\r##########  40%\r################ 100%\n==> Pouring gh\n")).toBe("################ 100%\n==> Pouring gh");
    expect(drawn("\r\u001b[K⠙ idealTree\r\u001b[K⠹ reify")).toBe("⠹ reify");
    const screen = new TermScreen();
    screen.write("\u001b[34m==>\u001b[0m Pouring\n");
    expect(screen.lines()[0]?.[0]).toMatchObject({ text: "==>", fg: expect.any(String) });
  });

  it("remembers the way it was asked for, to try again the same way", () => {
    expect(startedInstallLog(["npm", "fnm"])).toEqual({ blocks: [], running: true, update: false, way: ["npm", "fnm"] });
    expect(startedInstallLog(undefined)).toEqual({ blocks: [], running: true, update: true });
  });
});

describe("an install's log", () => {
  it("keeps the end of the output when there is more than it holds, a block whose text is all gone with it", () => {
    let log = appendInstallLog(running, "", { display: "first" });
    log = appendInstallLog(log, "x".repeat(INSTALL_LOG_KEEP - 2));
    log = appendInstallLog(log, "", { display: "second" });
    log = appendInstallLog(log, "tail!");
    expect(log.blocks.map((block) => [block.command, block.text.length])).toEqual([
      ["first", INSTALL_LOG_KEEP - 5],
      ["second", 5],
    ]);
    const over = appendInstallLog(log, "y".repeat(INSTALL_LOG_KEEP));
    expect(over.blocks.map((block) => block.command)).toEqual(["second"]);
    expect(over.blocks[0]!.text.length).toBe(INSTALL_LOG_KEEP);
    expect(over.running).toBe(true);
  });

  it("is kept by kind and name, and handed to each section by name", () => {
    expect(installLogKey({ kind: "gitCli", name: "gh" })).toBe("gitCli:gh");
    const logs = { "gitCli:gh": running, "agent:claude-cli": running, "agent:git": running };
    expect(Object.keys(installLogsOf(logs, "gitCli"))).toEqual(["gh"]);
    // An agent called `git` is not the git program.
    expect(Object.keys(installLogsOf(logs, "agent"))).toEqual(["claude-cli", "git"]);
  });

  it("says at its head what it is doing, then how it went", () => {
    expect(installLogHeadOf(running)).toEqual({ tone: "running", words: "installing…" });
    expect(installLogHeadOf({ ...running, update: true })).toEqual({ tone: "running", words: "updating…" });
    expect(installLogHeadOf({ ...running, running: false, outcome: { ok: true } })).toEqual({ tone: "ok", words: "installed" });
    expect(installLogHeadOf({ ...running, running: false, outcome: { ok: false, reason: "the install was cancelled" } })).toEqual({ tone: "cancelled", words: "install cancelled" });
    expect(installLogHeadOf({ ...running, running: false, outcome: { ok: false, reason: "'brew install gh' exited 1: Error: no bottle" } })).toEqual({
      tone: "failed",
      words: "'brew install gh' exited 1: Error: no bottle",
    });
    // The installer's own words are in the output under it: the head says where it failed.
    const said = appendInstallLog(appendInstallLog(running, "", { display: "fnm install --lts" }), "error: Access is denied.\n");
    expect(installLogHeadOf({ ...said, running: false, outcome: { ok: false, reason: "step 2 of 3, Node.js: 'fnm install --lts' exited 1: error: Access is denied." } })).toEqual({ tone: "failed", words: "install failed at step 2 of 3, Node.js — exited 1" });
    expect(installLogHeadOf({ ...said, running: false, outcome: { ok: false, reason: "'brew install gh' exited 1: Error: no bottle" } })).toEqual({ tone: "failed", words: "install failed — exited 1" });
    // A reason the output does not hold is said whole.
    expect(installLogHeadOf({ ...said, running: false, outcome: { ok: false, reason: "fnm could not be found to install Node.js after fnm was installed — check again, or install it by hand" } }).words).toMatch(/^fnm could not be found/);
  });
});
