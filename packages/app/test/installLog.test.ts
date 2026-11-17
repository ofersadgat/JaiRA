/**
 * What an install printed, as Connections keeps and draws it (`installLog.ts`): the service sends the
 * installer's output raw, and the box shows what a terminal would be left showing — colours gone, a
 * progress bar redrawn as its last drawing — with the end kept when there is too much.
 */
import { describe, expect, it } from "vitest";
import { INSTALL_LOG_KEEP, appendInstallLog, installLogHeadOf, installLogKey, installLogsOf, terminalText, type InstallLog } from "../src/renderer/installLog";

const running: InstallLog = { text: "", running: true, update: false };

describe("what the box shows of an installer's output", () => {
  it("drops colours, cursor moves and a window title", () => {
    expect(terminalText("\u001b[34m==>\u001b[0m \u001b[1mPouring gh--2.83.0\u001b[0m\n")).toBe("==> Pouring gh--2.83.0");
    expect(terminalText("\u001b]0;brew\u0007\u001b[?25lnpm warn\u001b[K\n")).toBe("npm warn");
  });

  it("shows a progress bar redrawn on its line as its last drawing", () => {
    expect(terminalText("$ brew install gh\n#####   20%\r##########  40%\r################ 100%\n==> Done\n")).toBe("$ brew install gh\n################ 100%\n==> Done");
    // A shorter drawing replaces the line: the escape that would have erased the rest is gone.
    expect(terminalText("Downloading 100%\rDone\n")).toBe("Done");
  });

  it("keeps the line as it was while the redraw after a carriage return has not come yet", () => {
    expect(terminalText("fetching 40%\r")).toBe("fetching 40%");
    // …and a \r\n split across two chunks is one newline once both are in.
    expect(terminalText("one\r" + "\ntwo\n")).toBe("one\ntwo");
  });

  it("follows a spinner that draws each frame over an erased line, and ends by erasing it", () => {
    // npm's: \r ESC[K before each frame, and once more at the end.
    const npm = "\r\u001b[K⠙ idealTree\r\u001b[K⠹ reify:@google/gemini-cli\r\u001b[K\u001b[?25h\nadded 412 packages in 4s\n";
    expect(terminalText(npm)).toBe("\nadded 412 packages in 4s");
    // Midway, the frame being shown.
    expect(terminalText("\r\u001b[K⠙ idealTree\r\u001b[K⠹ reify")).toBe("⠹ reify");
    // ESC[2K and a move to the first column do the same.
    expect(terminalText("old frame\u001b[2K\u001b[1Gnew frame\n")).toBe("new frame");
  });

  it("takes back a character for a backspace, and leaves a cleared line empty", () => {
    expect(terminalText("ab\bc\n")).toBe("ac");
    expect(terminalText("spinning |\r          \rnext\n")).toBe("next");
    expect(terminalText("spinning |\r          \r")).toBe("");
  });
});

describe("an install's log", () => {
  it("keeps the end of the output when there is more than it holds", () => {
    const full = appendInstallLog(running, "x".repeat(INSTALL_LOG_KEEP - 2));
    const over = appendInstallLog(full, "tail!");
    expect(over.text.length).toBe(INSTALL_LOG_KEEP);
    expect(over.text.endsWith("tail!")).toBe(true);
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
  });
});
