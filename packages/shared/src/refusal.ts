/**
 * Declining, and saying so — the one shape a refusal takes anywhere in JaiRA.
 *
 * The log's two levels answer different questions. `error` means the code is malfunctioning;
 * `warn` means something went wrong and the code responded appropriately. Only the site that raised
 * a failure knows which of those it is — "unknown task 't-1'" is the task store working exactly as
 * designed, and a boundary catching it sees the same shape it would see for a genuine bug. So the
 * classification stops happening at boundaries: a site decides, writes its own line at its own
 * level, and marks the error so nothing downstream files it a second time as something else.
 *
 * ## Why it returns the error instead of throwing it
 *
 * So the call site keeps `throw`. That is not a style preference: a helper that threw would still be
 * an ordinary call as far as the compiler is concerned, so every `if (row === undefined) …` guard
 * would stop narrowing the moment its throw moved inside one, and the diff would grow a trail of `!`
 * to compensate. `throw refusal(log, …)` reads as what it is and costs nothing.
 */
import type { Logger } from "@declarative-ai/log";

/**
 * An error raised ON PURPOSE, whose own site has already logged it.
 *
 * Nothing about it changes what a caller sees — it is an `Error`, it carries the same message, and a
 * renderer displaying it cannot tell the difference. What it changes is what the LOG says happened:
 * `AppService.recordIpcFailure` leaves a `Refusal` alone rather than re-filing the service working
 * correctly under "the code is malfunctioning".
 */
export class Refusal extends Error {}

/**
 * Log a refusal at `warn`, and hand back the error for the site to throw.
 *
 * `fields` is the structured context a reader would want and the message cannot hold — the task, the
 * run, the path. It rides on the record rather than being interpolated, so a sink can index it.
 */
export function refusal(log: Logger, message: string, fields?: Record<string, unknown>): Refusal {
  log.warn(message, fields);
  return new Refusal(message);
}

/**
 * One js/ts module file a workflow reaches that nobody has agreed to run (SPEC §7.5.5).
 *
 * Structurally hw's `PendingApproval`, restated here because `@jaira/shared` does not depend on hw
 * and the renderer has to be able to name what a prompt is showing. The fields are the ones a person
 * needs in order to answer: the file, what it currently says, and — only when there was a previous
 * approval — the hash that was agreed to before.
 */
export interface ModuleApproval {
  /** Absolute, forward-slashed — the spelling an approval, a hash and a require path agree on. */
  file: string;
  /** The hash of the file as it stands now. */
  hash: string;
  /** The source as it stands now. A prompt that hides this is a rubber stamp. */
  source: string;
  /**
   * The hash previously approved, when there was one.
   *
   * Its presence is the difference between the two questions being asked. Absent is "should this run
   * at all"; present is "here is what CHANGED", and only the second can be answered by a diff.
   */
  previousHash?: string;
  /**
   * The symbols the workflow actually calls out of this file, where they are known.
   *
   * Empty for a file reached only as an IMPORT of another module — nothing names it directly, and
   * saying so is more honest than inventing a call site for it.
   */
  symbols?: readonly string[];
}

/**
 * A refusal that a person can answer, rather than one they can only read.
 *
 * Thrown before a run starts when the workflow reaches unapproved module files. It stays a
 * {@link Refusal} — every boundary that already handles one keeps working, and the message alone is
 * a complete explanation for a host with nobody attached — but a host with a human in front of it
 * can narrow to this and ASK, then approve and start again.
 */
export class ApprovalRequired extends Refusal {
  constructor(
    message: string,
    /** Every file awaiting a decision, sorted, never just the first one that failed. */
    readonly pending: readonly ModuleApproval[],
  ) {
    super(message);
  }
}

/**
 * What a refusal SAYS about unapproved modules — one line per file, in one voice.
 *
 * Shared between the run gate and the lint surface because the two report the same fact from
 * different sides, and a person who saw it in `workflow lint` should recognise it at task start
 * rather than having to work out that it is the same problem.
 */
export function approvalRefusalMessage(pending: readonly ModuleApproval[]): string {
  const lines = pending.map((entry) => {
    const called = entry.symbols !== undefined && entry.symbols.length > 0
      ? ` (calls ${entry.symbols.join(", ")})`
      : " (reached as an import)";
    const why = entry.previousHash !== undefined ? "changed since it was approved" : "never approved";
    return `  ${entry.file}${called} — ${why}`;
  });
  return `this workflow calls js/ts functions that have not been approved on this machine:\n${lines.join("\n")}`;
}

/** The exact `jaira` invocation that answers an {@link ApprovalRequired}, for a message that refuses. */
export function approveCommandFor(pending: readonly ModuleApproval[]): string {
  return `jaira functions approve ${pending.map((p) => quoteIfNeeded(p.file)).join(" ")}`;
}

function quoteIfNeeded(file: string): string {
  return /\s/.test(file) ? `"${file}"` : file;
}
