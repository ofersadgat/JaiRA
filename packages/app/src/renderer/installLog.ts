/**
 * What an install printed, as Settings → Connections shows it under the row that started it — an
 * agent's, or a git program's. The service sends the installer's output raw (`install:output`), and says
 * where each command starts; this is what it is kept as: a block a command, each drawn as a terminal
 * draws it (`TermScreen`, the agents' terminal's), so colours stay and a progress bar redrawn is its last
 * drawing.
 */
import type { InstallCommandShown, InstallTarget, InstallWay } from "@jaira/shared/browser";

/** One command an install ran, and what it printed — raw, escapes and carriage returns as they came. */
export interface InstallBlock {
  /** What it ran (`brew install gh`); absent for what was said before the first command. */
  command?: string;
  /** Of an install that takes several steps, which this is: `Step 2 of 3: Node.js (fnm)`. */
  step?: string;
  text: string;
}

/** One install's output, from the press of Install until the person hides it. */
export interface InstallLog {
  /** What it ran, a block a command — the end of it, {@link INSTALL_LOG_KEEP} characters at most. */
  blocks: InstallBlock[];
  /** The installer, or the check after it, has not answered yet. */
  running: boolean;
  /** Was it an update — no way named — rather than an install. */
  update: boolean;
  /** The way it was asked for, so one that failed can be tried again the same way. */
  way?: InstallWay | undefined;
  /** Once it answered: whether it worked, and if not, why — "the install was cancelled" for a Cancel. */
  outcome?: { ok: true } | { ok: false; reason: string } | undefined;
}

/** How much of an install's output is kept: the end of it, which is where an installer says how it went. */
export const INSTALL_LOG_KEEP = 64 * 1024;

/** An install just pressed: nothing printed yet. */
export function startedInstallLog(way: InstallWay | undefined): InstallLog {
  return { blocks: [], running: true, update: way === undefined, ...(way !== undefined ? { way } : {}) };
}

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

/**
 * The log with more output on its end — or, with `command`, a new block for the command that starts —
 * the oldest text dropped past {@link INSTALL_LOG_KEEP}, a block whose text is all gone with it (its
 * command too, but the last).
 */
export function appendInstallLog(log: InstallLog, text: string, command?: InstallCommandShown): InstallLog {
  const blocks = log.blocks.map((block) => ({ ...block }));
  if (command !== undefined) blocks.push({ command: command.display, ...(command.step !== undefined ? { step: command.step } : {}), text: "" });
  if (text.length > 0) {
    if (blocks.length === 0) blocks.push({ text: "" });
    blocks[blocks.length - 1]!.text += text;
  }
  let over = blocks.reduce((sum, block) => sum + block.text.length, 0) - INSTALL_LOG_KEEP;
  while (over > 0 && blocks.length > 0) {
    const first = blocks[0]!;
    const cut = Math.min(over, first.text.length);
    first.text = first.text.slice(cut);
    over -= cut;
    if (first.text.length === 0 && blocks.length > 1) blocks.shift();
  }
  return { ...log, blocks };
}

/** The whole log as text, as Copy takes it: each command after `$ `, then what it printed, as raw. */
export function installLogPlain(log: InstallLog, plainOf: (raw: string) => string): string {
  return log.blocks.map((block) => [...(block.step !== undefined ? [`── ${block.step}`] : []), ...(block.command !== undefined ? [`$ ${block.command}`] : []), plainOf(block.text)].join("\n").replace(/\n+$/, "")).join("\n\n");
}

/** The words at the head of the box: what it is doing, or how it went. */
export function installLogHeadOf(log: InstallLog): { tone: "running" | "ok" | "failed" | "cancelled"; words: string } {
  if (log.running) return { tone: "running", words: log.update ? "updating…" : "installing…" };
  const outcome = log.outcome;
  if (outcome === undefined || outcome.ok) return { tone: "ok", words: log.update ? "updated" : "installed" };
  if (/cancelled$/.test(outcome.reason)) return { tone: "cancelled", words: log.update ? "update cancelled" : "install cancelled" };
  // An installer that exited with an error said why in the output under the head: the head says where.
  const exited = /^(?:(step \d+ of \d+), ([^:]+): )?'[^']*' exited (\S+?):?(?: |$)/.exec(outcome.reason);
  if (exited !== null && log.blocks.some((block) => block.text.length > 0)) {
    const [, step, title, code] = exited;
    return { tone: "failed", words: `${log.update ? "update" : "install"} failed${step !== undefined ? ` at ${step}, ${title}` : ""} — exited ${code}` };
  }
  return { tone: "failed", words: outcome.reason };
}
