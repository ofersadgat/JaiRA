/**
 * Chromium's own log, read back into records (`src/main/chromiumLog.ts`): the head parsed, a record
 * that spans lines held together, and the file followed as it grows.
 */
import { appendFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { app as App } from "electron";
import { ChromiumLogReader, enableChromiumLog, tailChromiumLog, type ChromiumRecord } from "../src/main/chromiumLog";

const MOVE = "[132144:0927/154526.446:ERROR:net\\disk_cache\\cache_util_win.cc:25] Unable to move the cache: Access is denied. (0x5)";
const GPU = "[132144:0927/154528.373:ERROR:gpu\\ipc\\host\\gpu_disk_cache.cc:737] Gpu Cache Creation failed: -2";

describe("ChromiumLogReader", () => {
  it("parses the head into level, message and where it was said", () => {
    const reader = new ChromiumLogReader();
    expect(reader.push(`${MOVE}\n${GPU}\n`)).toEqual([
      { level: "error", message: "Unable to move the cache: Access is denied. (0x5)", detail: { pid: 132144, at: "0927/154526.446", where: "net\\disk_cache\\cache_util_win.cc:25" } },
    ]);
    // The last one is held: the next line might still belong to it.
    expect(reader.idle().map((r) => r.message)).toEqual(["Gpu Cache Creation failed: -2"]);
  });

  it("maps Chromium's levels onto the log's", () => {
    const reader = new ChromiumLogReader();
    const text = ["FATAL", "ERROR", "WARNING", "INFO", "VERBOSE1"].map((l) => `[1:0927/000000.000:${l}:x.cc(1)] m`).join("\n");
    expect([...reader.push(`${text}\n`), ...reader.flush()].map((r) => r.level)).toEqual(["error", "error", "warn", "info", "debug"]);
  });

  it("keeps a record that spans lines together, CRLF or not", () => {
    const reader = new ChromiumLogReader();
    const records = [...reader.push(`[7:0927/000000.000:WARNING:CONSOLE:2] "first\r\n  second\r\nthird"\r\n${GPU}\r\n`), ...reader.flush()];
    expect(records.map((r) => r.message)).toEqual(['"first\n  second\nthird"', "Gpu Cache Creation failed: -2"]);
  });

  it("joins a line split across two reads", () => {
    const reader = new ChromiumLogReader();
    expect(reader.push(MOVE.slice(0, 30))).toEqual([]);
    // Half a line unread: going quiet does not close the record off.
    expect(reader.idle()).toEqual([]);
    reader.push(`${MOVE.slice(30)}\n`);
    expect(reader.idle().map((r) => r.detail.where)).toEqual(["net\\disk_cache\\cache_util_win.cc:25"]);
  });

  it("gives the unfinished last line up at the end", () => {
    const reader = new ChromiumLogReader();
    reader.push(MOVE);
    expect(reader.flush().map((r) => r.level)).toEqual(["error"]);
  });
});

describe("enableChromiumLog + tailChromiumLog", () => {
  let userData: string;
  const switches: [string, string?][] = [];
  const electron = { commandLine: { appendSwitch: (name: string, value?: string) => void switches.push([name, value]) } } as unknown as typeof App;

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), "jaira-chromium-log-"));
    switches.length = 0;
  });
  afterEach(() => rmSync(userData, { recursive: true, force: true }));

  it("points Chromium at a file per profile, emptied of the last launch's lines", () => {
    const file = join(userData, "logs", "chromium-2.log");
    enableChromiumLog(electron, userData, 0);
    writeFileSync(file, "yesterday\n");
    enableChromiumLog(electron, userData, 2);
    expect(existsSync(file)).toBe(false);
    expect(switches.slice(-3)).toEqual([
      ["enable-logging", "file"],
      ["log-file", file],
      ["log-level", "1"],
    ]);
  });

  it("follows the file as Chromium writes it, including a file that did not exist yet", async () => {
    enableChromiumLog(electron, userData, 1);
    const file = join(userData, "logs", "chromium-1.log");
    const seen: ChromiumRecord[] = [];
    const stop = tailChromiumLog((r) => seen.push(r), 20);
    await new Promise((r) => setTimeout(r, 60));
    appendFileSync(file, `${MOVE}\n`);
    await new Promise((r) => setTimeout(r, 100));
    expect(seen.map((r) => r.message)).toEqual(["Unable to move the cache: Access is denied. (0x5)"]);
    appendFileSync(file, GPU);
    stop();
    expect(seen.map((r) => r.message)).toEqual(["Unable to move the cache: Access is denied. (0x5)", "Gpu Cache Creation failed: -2"]);
  });
});
