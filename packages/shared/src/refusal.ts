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
