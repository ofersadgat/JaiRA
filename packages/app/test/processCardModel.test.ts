/**
 * The process card's words (decision 0032, "The view", ruling 1): its status after its name, its ports
 * as links, why one with no terminal shows what it shows, "Tell Claude when it prints…", and when the
 * status drops under the name.
 */
import { describe, expect, it } from "vitest";
import type { ProcessSummary } from "@jaira/shared";
import { NARROW_CARD, notOursOf, outputNoteOf, portLinksOf, processStatusOf, statusBelow, tellOf } from "../src/renderer/processCardModel";

const NOW = 10_000_000;

function p(over: Partial<ProcessSummary> = {}): ProcessSummary {
  return { key: "84456@1", processTaskId: "t-p84456-1", taskId: "t-parent0001", machine: "win-desk", pid: 84456, startedAt: NOW - 4 * 60_000, command: "npx one dev --port 8145", name: "one dev", origin: "background", startedBy: "session", state: "listening", states: [], ports: [8145], load: [], output: { source: "spawned" }, ...over };
}

describe("the card's status", () => {
  it("says how a live one runs, by where it came from", () => {
    expect(processStatusOf(p(), NOW)).toEqual({ text: "running in background · 4m", tone: "accent" });
    expect(processStatusOf(p({ origin: "left" }), NOW)).toEqual({ text: "left running · 4m", tone: "dim" });
    expect(processStatusOf(p({ origin: "escaped" }), NOW)).toEqual({ text: "escaped · 4m", tone: "warn" });
    expect(processStatusOf(p({ origin: "watched", output: { source: "file", path: "/var/log/pg.log" } }), NOW).text).toBe("following the log · 4m");
    expect(processStatusOf(p({ origin: "this-turn", state: "running", startedAt: NOW - 12_400 }), NOW).text).toBe("running · 12s");
    expect(processStatusOf(p({ state: "waiting" }), NOW)).toEqual({ text: "waiting for input · 4m", tone: "warn" });
  });

  it("says how an ended one ended, and after how long", () => {
    const ended = { endedAt: NOW - 60_000, startedAt: NOW - 60_000 - 192_000 };
    expect(processStatusOf(p({ ...ended, state: "failed", exitCode: 1 }), NOW)).toEqual({ text: "exit 1 after 3m 12s", tone: "bad" });
    expect(processStatusOf(p({ ...ended, state: "exited", exitCode: 0 }), NOW)).toEqual({ text: "exited 0 · 3m 12s", tone: "ok" });
    expect(processStatusOf(p({ ...ended, state: "stopped", exitCode: null }), NOW)).toEqual({ text: "stopped · 3m 12s", tone: "dim" });
    expect(processStatusOf(p({ ...ended, state: "failed", exitCode: null, signal: "SIGSEGV" }), NOW).text).toBe("ended by SIGSEGV after 3m 12s");
  });
});

describe("the card's other words", () => {
  it("links the first port, chips them all", () => {
    expect(portLinksOf([8145, 24678])).toEqual([
      { port: 8145, url: "http://localhost:8145/", link: true },
      { port: 24678, url: "http://localhost:24678/", link: false },
    ]);
    expect(portLinksOf([])).toEqual([]);
  });

  it("says why one with no terminal shows what it shows", () => {
    expect(outputNoteOf(p({ origin: "escaped", why: "started outside JaiRA by `pwsh -File restart-dev.ps1`", output: { source: "file", path: "C:/one/dev-8144.log" } }))).toBe(
      "started outside JaiRA by `pwsh -File restart-dev.ps1` · its log file dev-8144.log: history, then followed",
    );
    expect(outputNoteOf(p({ origin: "left", output: { source: "console" } }))).toBe("it has a console of its own: followed from when you opened it");
    expect(outputNoteOf(p({ origin: "native", output: { source: "unreadable", why: "a pipe another program holds" } }))).toBe("output not kept: a pipe another program holds");
    expect(notOursOf(p({ origin: "watched", output: { source: "file" } }))).toMatch(/^Not JaiRA's: its log file/);
    expect(notOursOf(p())).toBeUndefined();
  });

  it("offers Tell Claude for a conversation's live process, and says armed and told", () => {
    expect(tellOf(p())).toEqual({ offered: true });
    expect(tellOf(p({ tellWhen: { pattern: "ready", armedAt: 1 } }))).toEqual({ offered: true, armed: "ready" });
    expect(tellOf(p({ toldWhen: { pattern: "error", line: "error: boom", at: 2 } }))).toEqual({ offered: true, told: { pattern: "error", line: "error: boom", at: 2 } });
    expect(tellOf(p({ taskId: undefined, origin: "watched" })).offered).toBe(false);
    expect(tellOf(p({ state: "exited" })).offered).toBe(false);
    expect(tellOf(p({ origin: "this-turn" }))).toMatchObject({ offered: false, why: expect.stringContaining("this turn") });
  });

  it("drops the status under the name when the card is narrow or opened in a row", () => {
    expect(statusBelow(undefined, false)).toBe(false);
    expect(statusBelow(NARROW_CARD - 1, false)).toBe(true);
    expect(statusBelow(NARROW_CARD + 200, false)).toBe(false);
    expect(statusBelow(900, true)).toBe(true);
  });
});
