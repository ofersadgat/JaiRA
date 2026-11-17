/**
 * What an install printed, as Settings → Connections shows it under the row that started it — an
 * agent's, or a git program's. The service sends the installer's output raw (`install:output`); this is
 * what it is kept as, and what the box draws of it.
 */
import type { InstallTarget } from "@jaira/shared/browser";

/** One install's output, from the press of Install until the person hides it. */
export interface InstallLog {
  /** What was printed, raw — escapes and carriage returns as they came — its last {@link INSTALL_LOG_KEEP} characters. */
  text: string;
  /** The installer, or the check after it, has not answered yet. */
  running: boolean;
  /** Was it an update — no way named — rather than an install. */
  update: boolean;
  /** Once it answered: whether it worked, and if not, why — "the install was cancelled" for a Cancel. */
  outcome?: { ok: true } | { ok: false; reason: string } | undefined;
}

/** How much of an install's output is kept: the end of it, which is where an installer says how it went. */
export const INSTALL_LOG_KEEP = 64 * 1024;

/** The store's key for an install: `agent:claude-cli`, `gitCli:gh` — an agent may be called `git`. */
export function installLogKey(target: InstallTarget): string {
  return `${target.kind}:${target.name}`;
}

/** One kind's logs out of the store's, by name: `{ gh: … }` from `{ "gitCli:gh": …, "agent:claude-cli": … }`. */
export function installLogsOf(logs: Readonly<Record<string, InstallLog>>, kind: InstallTarget["kind"]): Record<string, InstallLog> {
  const prefix = `${kind}:`;
  const out: Record<string, InstallLog> = {};
  for (const [key, log] of Object.entries(logs)) if (key.startsWith(prefix)) out[key.slice(prefix.length)] = log;
  return out;
}

/** The log with more output on its end, its start dropped past {@link INSTALL_LOG_KEEP}. */
export function appendInstallLog(log: InstallLog, text: string): InstallLog {
  const all = log.text + text;
  return { ...log, text: all.length > INSTALL_LOG_KEEP ? all.slice(all.length - INSTALL_LOG_KEEP) : all };
}

/**
 * Raw installer output as the lines a terminal would be left showing: escape sequences (colours, the
 * cursor moves of a spinner, a window title) gone, and a carriage return starting its line again — so
 * a progress bar redrawn a hundred times is its last drawing, not a hundred lines. The new drawing
 * replaces the line whole rather than overwriting it from the left: the escape that would have erased
 * the rest of it is gone, and `Downloading 100%\rDone` should read `Done`. A carriage return with
 * nothing after it yet (the chunk ended there) leaves the line as it was.
 */
export function terminalText(raw: string): string {
  const plain = raw
    // OSC (a title, a hyperlink): ESC ] … BEL or ESC \.
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    // The erases that empty a line — the whole of it, or all of it from its start — and the move to its
    // first column: what a spinner (npm's) draws each frame with, and ends by. CLEAR is that the line
    // was emptied, which a bare carriage return does not say.
    .replace(/\u001b\[2K/g, `\r${CLEAR}`)
    .replace(/\r\u001b\[0?K/g, `\r${CLEAR}`)
    .replace(/\u001b\[[01]?G/g, "\r")
    // CSI: colours, the other erases, cursor moves.
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    // Any other two-character escape, and a lone ESC cut off at the end of a chunk.
    .replace(/\u001b[@-_]?/g, "")
    .replace(/\r\n/g, "\n");
  const lines: string[] = [];
  for (const line of plain.split("\n")) {
    if (!line.includes("\r") && !line.includes("\b") && !line.includes(CLEAR)) {
      lines.push(line);
      continue;
    }
    // The last drawing: a carriage return with nothing after it yet draws nothing, one after an erase
    // draws an empty line.
    let drawn = "";
    for (const drawing of line.split("\r")) {
      if (drawing.length === 0) continue;
      drawn = drawing.startsWith(CLEAR) ? drawing.slice(CLEAR.length) : drawing;
    }
    // A backspace takes back the character before it.
    const cells: string[] = [];
    for (const ch of drawn.replaceAll(CLEAR, "")) {
      if (ch === "\b") cells.pop();
      else cells.push(ch);
    }
    // A spinner that ends by clearing its line with spaces leaves it all spaces.
    lines.push(cells.join("").trimEnd());
  }
  // The newline that ends the output opens no line of its own.
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}

/** Stands in {@link terminalText} for an erase that emptied a line: a character no installer prints. */
const CLEAR = "\u0000";

/** The words at the head of the box: what it is doing, or how it went. */
export function installLogHeadOf(log: InstallLog): { tone: "running" | "ok" | "failed" | "cancelled"; words: string } {
  if (log.running) return { tone: "running", words: log.update ? "updating…" : "installing…" };
  const outcome = log.outcome;
  if (outcome === undefined || outcome.ok) return { tone: "ok", words: log.update ? "updated" : "installed" };
  if (/cancelled$/.test(outcome.reason)) return { tone: "cancelled", words: log.update ? "update cancelled" : "install cancelled" };
  return { tone: "failed", words: outcome.reason };
}
