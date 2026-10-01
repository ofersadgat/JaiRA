/**
 * How a message in a transcript is READ — what the app says it is, what it is read as, the two menus on
 * its rail that change either, and the clock beside them — `transcriptView.tsx`'s `Message` rules,
 * moved out unchanged so the universal copy (decision 0015) reads a message the same way.
 */
import {
  detectedMime,
  mimeOfSchema,
  OFFERED_TYPES,
  typeNameOf,
  type MessageAuthor,
  viewsFor,
  type ViewHint,
  type ViewId,
} from "@jaira/shared/browser";
import type { JsonValue } from "@declarative-ai/json";
import { familyIcon } from "./iconPaths";
import type { MenuItem } from "./menuTypes";
import type { MessageEntry } from "./transcript";

/**
 * What the app would say this is if nobody had corrected it.
 *
 * The declared type first, because a slot saying `contentMediaType` is a statement and everything
 * under it is a default. Then DETECTION, which now runs on both sides of the conversation — an
 * instruction is markdown about as often as an answer is, and until this ran on user messages the
 * app's answer for one was "text" whatever was in it.
 *
 * The ROLE is the floor under detection rather than a rule over it. An answer with no structural
 * marks is still markdown, because that is what an answer is written as; anything else with no
 * marks is what somebody typed. That is the fact the transcript has relied on since it was written
 * — one side through a markdown renderer, the other through a `<pre>` — said out loud, so the chip
 * has something true to report and `viewsFor` cannot quietly re-decide it.
 */
export function messageReadingOf(entry: MessageEntry, value: JsonValue, override: string | undefined, picked: ViewId | null) {
  const given = detectedMime(value, entry.output?.schema !== undefined ? { schema: entry.output.schema } : {}) ?? (entry.role === "assistant" ? "text/markdown" : "text/plain");
  const mime = override ?? given;
  const named = typeNameOf(mime);
  const hint: ViewHint = {
    mime,
    ...(entry.output?.schema !== undefined ? { schema: entry.output.schema } : {}),
  };
  const views = viewsFor(value, hint);
  // A reading you chose survives a change of type, and stops surviving the moment the new type has
  // no such reading — which is what makes "set it to Markdown" land on the rendering rather than on
  // the source you were trying to get away from.
  const view = picked !== null && views.includes(picked) ? picked : views[0]!;
  return { given, mime, named, hint, views, view };
}

/**
 * The type chip's menu: every offered type (the one in force checked, and where the app's own answer
 * came from said on the row it is true of), then "Use for every message here" and the way back.
 */
export function typeMenuOf({
  entry,
  own,
  override,
  given,
  mime,
  conversation,
  assert,
  clear,
}: {
  entry: MessageEntry;
  /** What THIS message asserts; `override` is that or the conversation's. */
  own: string | undefined;
  override: string | undefined;
  given: string;
  mime: string;
  /** Whether there is a conversation to remember a type for. */
  conversation: boolean;
  assert: (next: string, everywhere?: boolean) => void;
  clear: () => void;
}): MenuItem[] {
  const rows = OFFERED_TYPES.map((candidate) => {
    const name = typeNameOf(candidate);
    // Where the app's own answer came from, said in a word. Only ever on the row it is true of:
    // a column of provenance beside every option would be a column that is blank most of the way
    // down, which reads as data missing rather than as a fact about two of the rows.
    const note =
      candidate === own
        ? "yours"
        : candidate === override
          ? "this thread"
          : candidate === given
            ? (mimeOfSchema(entry.output?.schema) === candidate ? "declared" : "detected")
            : undefined;
    return {
      label: name.label,
      icon: familyIcon(name.family),
      ...(note !== undefined ? { note } : {}),
      checked: candidate === mime,
      onSelect: () => assert(candidate),
    };
  });
  return [
    ...rows,
    ...(!conversation
      ? []
      : [
          {
            label: "Use for every message here",
            separator: true,
            note: "until you say otherwise",
            onSelect: () => assert(mime, true),
          },
        ]),
    ...(override === undefined
      ? []
      : [
          // Named for the layer it clears, because they are different acts: one puts this message
          // back, the other stops the whole conversation being read that way.
          own !== undefined
            ? {
                label: "Back to what JaiRA detected",
                separator: !conversation,
                note: typeNameOf(given).label,
                onSelect: clear,
              }
            : {
                label: "Stop using it for every message",
                separator: false,
                note: `back to ${typeNameOf(given).label}`,
                onSelect: clear,
              },
        ]),
  ];
}

/** What each reading is called in the rail, and what its tooltip says it does. */
/** The badge on a message the person did not type: WHO wrote it, in a word, with the rest on the tooltip. */
export const MESSAGE_SOURCE: Record<MessageAuthor, { label: string; title: string; icon: "send" | "workflow" }> = {
  host: { label: "Written by JaiRA", title: "JaiRA wrote and sent this for you — you did not type it", icon: "send" },
  workflow: { label: "From the workflow", title: "The workflow's words for this call — written by its author, not typed here", icon: "workflow" },
};

/**
 * The badge's tooltip when it names the workflow the words came from — and, where it opens that
 * workflow's definition, says so.
 */
export function workflowSourceTitleOf(workflow: string, opens: boolean): string {
  const title = `Written by the workflow ${workflow} — its author's words, not typed here`;
  return opens ? `${title}. Open its definition beside the conversation.` : title;
}

export const READING: Record<ViewId, { label: string; hint: string }> = {
  markdown: { label: "Rendered", hint: "As markdown, rendered" },
  html: { label: "Rendered", hint: "As HTML, rendered" },
  media: { label: "Preview", hint: "Play or show it" },
  changes: { label: "Files", hint: "The files this changes, as a diff" },
  code: { label: "Code", hint: "Highlighted, in an editor" },
  text: { label: "Source", hint: "The text exactly as it was written" },
  json: { label: "JSON", hint: "Highlighted, with what each key means" },
  data: { label: "Data", hint: "Parsed — the value this document denotes" },
  patch: { label: "Diff", hint: "The change this patch describes" },
  table: { label: "Table", hint: "As rows and columns" },
  form: { label: "Form", hint: "As the fields its schema declares" },
};

/** The reading chip's menu: the readings the type admits, the one in use checked. */
export function readingMenuOf(views: readonly ViewId[], view: ViewId, pick: (id: ViewId) => void): MenuItem[] {
  return views.map((id) => ({
    label: READING[id].label,
    note: READING[id].hint,
    checked: id === view,
    onSelect: () => pick(id),
  }));
}

/** What Copy puts on the clipboard: the words as said, or the value as JSON. */
export function copyTextOf(entry: MessageEntry, value: JsonValue): string {
  return entry.text ?? (typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

/** The rewind and fork buttons' tooltips and names, by which side of the message the cut falls. */
export function cutTitleOf(verb: "rewind" | "fork", cut: "before" | "after"): { title: string; label: string } {
  if (verb === "rewind")
    return cut === "before"
      ? { title: "Rewind to before this message — it and everything after it are deleted", label: "Rewind to before this message" }
      : { title: "Rewind to this reply — everything after it is deleted", label: "Rewind to this reply" };
  return cut === "before"
    ? { title: "Fork before this message — a new conversation that shares everything up to here", label: "Fork before this message" }
    : { title: "Fork after this reply — a new conversation that shares everything up to here", label: "Fork after this reply" };
}

/**
 * The whole moment, for the tooltip behind the clock — every field, in the reader's own format.
 */
export function fullClockOf(at: number | undefined): string | undefined {
  return at === undefined || at === 0 ? undefined : new Date(at).toLocaleString();
}

/**
 * What the rail says about WHEN, which has to be a complete answer on its own.
 *
 * A bare clock is complete only for today. Hovering a message from Tuesday and reading `14:22:31`
 * tells you the minute and leaves the day to be worked out from the floating chip, which is at the
 * top of the scroller and may not even be on screen — so the two devices between them answered the
 * question only if you used both. The date joins the clock the moment the message is not from today,
 * which is exactly when it stops being redundant.
 */
export function stampOf(at: number | undefined): string {
  if (at === undefined || at === 0) return "";
  const when = new Date(at);
  const now = new Date();
  const sameDay =
    when.getFullYear() === now.getFullYear() && when.getMonth() === now.getMonth() && when.getDate() === now.getDate();
  if (sameDay) return when.toLocaleTimeString();
  return `${when.toLocaleDateString(undefined, { day: "numeric", month: "short" })}, ${when.toLocaleTimeString()}`;
}
