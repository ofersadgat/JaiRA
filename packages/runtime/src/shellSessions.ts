/**
 * Where each task's shell stands (decision 0030): its current directory, the environment the permission
 * check expands a line's paths with, its live shell if it has one, and what the agent is to be told with
 * its next call.
 *
 * One per task, whichever shell runs: a run whose states use different agents shares one current
 * directory, as it shares one workspace. In memory, in the engine; an engine that restarts starts every
 * task at its workspace root again.
 */
import type { ExecServices } from "@declarative-ai/exec";
import { homedir } from "node:os";
import { LiveShell, liveShellKindOf, type LiveShellKind } from "./liveShell";

/** The shell an agent is set to: the emulated shell, or a live zsh, bash or sh at a path. */
export type ShellChoice = { kind: "emulated" } | { kind: "live"; path: string };

export const EMULATED: ShellChoice = { kind: "emulated" };

/** An agent's `shell` setting as a choice: absent, `"emulated"` or anything not a live shell is emulated. */
export function shellChoiceOf(setting: string | undefined): ShellChoice {
  if (setting === undefined || setting === "emulated") return EMULATED;
  return liveShellKindOf(setting) !== undefined ? { kind: "live", path: setting } : EMULATED;
}

export interface ShellSession {
  /** Where the task's shell stands, absolute; undefined is the workspace root. */
  cwd?: string;
  /** A live shell's environment as its last command left it. */
  env?: Record<string, string>;
  /** The live shell, while one runs. */
  live?: LiveShell;
  /** Why the last live shell went — said to the agent when the next one starts. */
  gone?: string;
  /** Said once, with the next call's result. */
  note?: string;
  /** The agent was told its live shell cannot run here; it is not told again. */
  refusalTold?: boolean;
}

export class ShellSessions {
  private readonly byTask = new Map<string, ShellSession>();

  /** A task's session, made the first time it is asked for. */
  of(taskId: string): ShellSession {
    let session = this.byTask.get(taskId);
    if (session === undefined) {
      session = {};
      this.byTask.set(taskId, session);
    }
    return session;
  }

  /** The task's session, if it has one; nothing is made. */
  peek(taskId: string): ShellSession | undefined {
    return this.byTask.get(taskId);
  }

  /** Every live shell, with its task. */
  live(): Array<{ taskId: string; session: ShellSession; shell: LiveShell }> {
    return [...this.byTask.entries()].flatMap(([taskId, session]) => (session.live !== undefined && session.live.alive ? [{ taskId, session, shell: session.live }] : []));
  }

  /** Close a task's live shell, saying why to the agent next time. */
  close(taskId: string, why: string): void {
    const session = this.byTask.get(taskId);
    session?.live?.close(why);
  }

  /** Forget a task (deleted): its live shell is closed. */
  forget(taskId: string): void {
    this.close(taskId, "was closed");
    this.byTask.delete(taskId);
  }

  /** Close every live shell (the engine is going). */
  closeAll(why: string): void {
    for (const { shell } of this.live()) shell.close(why);
  }
}

/** Start a task's live shell, the session told when it goes. */
export async function startLive(session: ShellSession, path: string, cwd: string): Promise<LiveShell> {
  const shell = await LiveShell.start(path, cwd);
  session.live = shell;
  delete session.gone;
  shell.whenGone((why) => {
    if (session.live === shell) {
      delete session.live;
      session.gone = why;
    }
  });
  return shell;
}

/** The name of the agent making a call, as its route wrapper set it (`withCallingAgent`). */
export const CALLING_AGENT = "jairaCallingAgent";

export function withCallingAgent(ctx: ExecServices, agent: string): ExecServices {
  return { ...ctx, [CALLING_AGENT]: agent } as ExecServices;
}

export function callingAgentOf(ctx: unknown): string | undefined {
  const agent = (ctx as Record<string, unknown> | undefined)?.[CALLING_AGENT];
  return typeof agent === "string" ? agent : undefined;
}

/**
 * A word as the shell would expand its `~` and `$NAME` / `${NAME}`, for the permission check (ruling 7):
 * an unset variable is empty, as in the shell. Quoting is not modelled — see the decision.
 */
export function expandShellWord(word: string, valueOf: (name: string) => string | undefined): string {
  if (!word.includes("$") && !word.startsWith("~")) return word;
  let out = word;
  if (out === "~" || out.startsWith("~/")) out = (valueOf("HOME") ?? homedir()) + out.slice(1);
  return out.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, braced: string | undefined, bare: string | undefined) => valueOf((braced ?? bare)!) ?? "");
}

export type { LiveShellKind };
