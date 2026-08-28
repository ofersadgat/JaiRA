/**
 * The wire history a record answers with — derived from its conversation, never stored beside it.
 *
 * Its own module because TWO stores need it and neither owns it: `sessionStore` reads it for replay
 * and for what a fork inherits, and `conversationFile` reads it to write the other tool's dialect.
 * Putting it in either would make the other import a store to ask a question about a shape.
 */
import type { JsonValue } from "@declarative-ai/json";

/**
 * A record's messages: upstream's `defaultMessagesOf`, over a stored record rather than a live one.
 *
 * DERIVED from the record's entries — one array holds the conversation and the wire history is a
 * projection of it, never a second copy stored beside it (RECORDS.md). A subagent's turns are left
 * out because they are not the main thread's history.
 *
 * The `partial` entry is left out too, and that exclusion is the load-bearing one: these messages are
 * what a resume sends BACK to the provider, and half an assistant turn is not an exchange that
 * happened. It stays in `entries` for the viewer, which wants to show the words that did arrive.
 */
export function messagesOfRecord(value: JsonValue | undefined): JsonValue[] {
  const entries = (value as { value?: { entries?: JsonValue[] } } | undefined)?.value?.entries;
  if (!Array.isArray(entries)) return [];
  return entries
    .filter((e) => {
      const entry = e as { kind?: unknown; sidechain?: unknown; partial?: unknown } | null;
      return (
        entry !== null &&
        typeof entry === "object" &&
        entry.kind === "message" &&
        entry.sidechain === undefined &&
        entry.partial !== true
      );
    })
    .map((e) => {
      const entry = e as { role?: JsonValue; content?: JsonValue };
      return { role: entry.role, content: entry.content } as JsonValue;
    });
}
