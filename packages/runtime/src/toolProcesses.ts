/**
 * A tool call's processes, as terminals (decision 0028, amended 2026-11-21): every child process a tool
 * call other than `shell` starts through {@link NodeExec} — `git_push` running `git push`, a merge
 * request tool running `gh` or `glab`, `start` making a worktree — is a terminal of its own, linked to
 * the call that started it, so a window can watch it run and stop it.
 *
 * The call is ambient rather than passed: a tool reaches its processes through hosts built once per run
 * (`GitToolHost.git(dir)`), long before any call exists, so the call is carried by an
 * `AsyncLocalStorage` that {@link withProcessTerminals} opens around the tool's `run`, and `NodeExec.run`
 * asks {@link toolProcessFor} whether it is inside one. Once the call has answered, anything that still
 * carries its context (a run it started) is no longer its: nothing more is opened under it.
 *
 * `shell` keeps its own terminal (`runInTerminal`), which is interactive; an interactive exec is never
 * one of these. These are not interactive: their stdin is what the tool gave them, so a person can
 * watch and stop them, never type into them.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { Tool } from "@declarative-ai/exec";
import type { ShellCallTerminal, ShellTerminals } from "./tools";

interface ToolCallScope {
  readonly terminals: ShellTerminals;
  readonly tool: string;
  readonly callId: string | undefined;
  /** How many processes it has started — each one's terminal is `<callId>~<n>`. */
  started: number;
  /** The call has answered. */
  done: boolean;
}

const scope = new AsyncLocalStorage<ToolCallScope>();

/** One process of a tool call, as `NodeExec.run` feeds it. */
export interface ToolProcess {
  /** Where the process's output goes, as it arrives. */
  readonly terminal: ShellCallTerminal;
  /** Aborted when a person stops it (Stop or Ctrl-C on its terminal). */
  readonly stop: AbortSignal;
}

/**
 * `tool`, with every process its `run` starts kept as a terminal in `terminals`, linked to the call
 * (`ctx.toolCallId`). The tool's result is what it was.
 */
export function withProcessTerminals(name: string, tool: Tool, terminals: ShellTerminals): Tool {
  const run = tool.run;
  return {
    ...tool,
    run: (input, ctx) => {
      const call: ToolCallScope = { terminals, tool: name, callId: ctx?.toolCallId, started: 0, done: false };
      return scope.run(call, async () => {
        try {
          return await run(input, ctx);
        } finally {
          call.done = true;
        }
      });
    },
  } as Tool;
}

/**
 * The terminal for a process about to start, when a tool call that keeps them is starting it; undefined
 * otherwise, or when nobody keeps its terminals. `command` and `args` are the command as the caller gave
 * it, before any WSL or container wrapping.
 */
export function toolProcessFor(command: string, args: readonly string[], cwd: string | undefined): ToolProcess | undefined {
  const call = scope.getStore();
  if (call === undefined || call.done) return undefined;
  const n = ++call.started;
  const terminal = call.terminals.open({
    callId: `${call.callId ?? call.tool}~${n}`,
    command: commandLineOf(command, args),
    cwd,
    dialect: "posix",
    tool: call.tool,
    ...(call.callId !== undefined ? { call: call.callId } : {}),
  });
  if (terminal === undefined) return undefined;
  const stopper = new AbortController();
  terminal.attach({
    // Its stdin is the tool's: nothing a person types reaches it.
    type: () => false,
    interrupt: () => stopper.abort(),
    stop: () => stopper.abort(),
    endsAt: () => undefined,
  });
  return { terminal, stop: stopper.signal };
}

/**
 * Run `fn` outside any tool call: what it starts is not the call's, even while the call waits on it —
 * a run a workflow tool starts, an agent a tool hands work to.
 */
export function outsideToolCall<T>(fn: () => T): T {
  return scope.exit(fn);
}

/** An argv as one line a person could paste: words with nothing special as they are, the rest quoted. */
export function commandLineOf(command: string, args: readonly string[]): string {
  return [command, ...args].map(wordOf).join(" ");
}

function wordOf(word: string): string {
  if (word.length > 0 && /^[\w@%+=:,./~-]+$/.test(word)) return word;
  return `'${word.replace(/'/g, `'\\''`)}'`;
}
