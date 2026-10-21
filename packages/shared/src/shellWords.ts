/**
 * What `shellCommand.ts` and `powershellCommand.ts` hand each other while a line is taken apart —
 * the words of one command, and what a walk found. Internal to the two: nothing outside them reads it.
 */
import type { ShellRequest } from "./shellCommand";

/** One token of a line, with where it was written. */
export interface ShellToken {
  type: "word" | "op" | "redir";
  value: string;
  /** Original-line offsets. */
  start: number;
  end: number;
  /** Original-line offset of each character of `value`, so a payload can be re-parsed in place. */
  map: number[];
  dynamic?: boolean;
  /** A PowerShell script block (`{ … }`) — already taken apart where it was written. */
  code?: boolean;
  /** A PowerShell array element after the first (`a, b`): the same argument as the word before it. */
  element?: boolean;
  /** The value a PowerShell parameter was given with a colon (`-Path:x`): its parameter's, never positional. */
  bound?: boolean;
}

/** What taking one text apart found. */
export interface ShellWalk {
  requests: ShellRequest[];
  unparsed?: string;
}
