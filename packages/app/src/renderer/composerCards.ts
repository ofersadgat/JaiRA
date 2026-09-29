/**
 * What the composer's CARDS compute — the route → model cascade, the words beside a thinking level and
 * a tool, where a value came from, and a mentioned or attached file — moved unchanged out of
 * `composer.tsx`, so the desktop's cards and the universal ones (decision 0015,
 * `packages/universal/src/components/chat/ComposerCards.tsx`) draw them from one reading.
 */
import { ROUTE_BORROWS } from "./composerModel";

/** What each thinking level buys, so the word is not the only thing to go on. */
export const EFFORT_HINTS: Record<string, string> = {
  none: "no reasoning at all",
  minimal: "barely any",
  low: "quickest, least deliberation",
  medium: "a balance",
  high: "works the problem",
  xhigh: "deeper — slower and dearer",
  max: "as deep as the model goes",
  ultra: "max, and hands parts off",
};

/** What granting each tool actually lets the model do. */
export const TOOL_HINTS: Record<string, string> = {
  bash: "run shell commands, under the policy",
  read_file: "read files in the workspace",
  write_file: "create and change files",
};

/** A model as the picker sees it — the id, and what it can be given and produce. */
export interface PickModel {
  id: string;
  input: string[];
  output: string[];
  /** An agent's own row: its reasoning levels in a few words (`low–max`). */
  levels?: string;
}

/** Whose models an agent route borrows, as a person names them — the divider's words. */
export const VENDOR_NAMES: Record<string, string> = { anthropic: "Anthropic", openai: "OpenAI" };

/**
 * The tier between route and model, when a route HAS one.
 *
 * `openrouter/openai/gpt-5` names a route, then whose model it is, then the model — three parts, so
 * three columns. `anthropic/claude-sonnet-5` has two. The picker follows the id rather than a list of
 * special cases: a route whose ids carry a second slash grows a middle column, and one whose ids do
 * not goes straight to models. Local and any other aggregating route get it for free.
 */
export function tierOf(id: string): { route: string; group?: string; leaf: string } {
  const parts = id.split("/");
  const route = parts[0] ?? "";
  if (parts.length >= 3) return { route, group: parts[1]!, leaf: parts.slice(2).join("/") };
  return { route, leaf: parts.slice(1).join("/") };
}

/** Every modality any known model mentions, so the filters are the real vocabulary and not a guess. */
export function modalitiesOf(models: readonly PickModel[], side: "input" | "output"): string[] {
  return [...new Set(models.flatMap((m) => m[side]))].sort();
}

/**
 * The glyph for one modality.
 *
 * Icons rather than words because these are the least interesting thing on the row and the most
 * repeated: four words twice over crowds out the columns, which are what the menu is for.
 */
export function modalityIcon(mode: string): "read" | "web" | "note" | "think" {
  if (mode === "image") return "read";
  if (mode === "audio") return "web";
  if (mode === "text") return "note";
  return "think";
}

/**
 * Re-point an id at another route, keeping the model it named — when that route actually has it.
 *
 * "The same model somewhere else" is the common move — one subscription runs out, a provider is
 * down — and retyping the model to make it would be the tax on the thing people do most.
 *
 * But it is a LOOKUP, not string surgery. Routes do not share an id shape: `openrouter` ids carry a
 * vendor tier and `anthropic` ids do not, so splicing a prefix turned `openrouter/openai/gpt-5` into
 * `anthropic/openai/gpt-5` — an id no route serves, offered by a picker whose whole job is to only
 * offer things that exist. Matching on the LEAF instead means a re-point either lands on a real row
 * or reports that it cannot, and the caller drills in rather than inventing one.
 */
export function repoint(route: string, model: string, models: readonly PickModel[]): string | undefined {
  const leaf = tierOf(model).leaf;
  if (leaf === "") return undefined;
  // The borrowed catalog when the route has one, so moving to `claude-cli` finds Anthropic's rows.
  const from = ROUTE_BORROWS[route] ?? route;
  const found = models.find((m) => tierOf(m.id).route === from && tierOf(m.id).leaf === leaf);
  if (found === undefined) return undefined;
  return ROUTE_BORROWS[route] === undefined ? found.id : `${route}/${found.id.slice(from.length + 1)}`;
}

/**
 * What the cascade's columns hold for the route and group under the pointer, filtered by what the
 * modality filters ask for (AND across ticks: a model has to do everything asked for).
 */
export function cascadeOf(
  routes: readonly string[],
  models: readonly PickModel[],
  route: string,
  group: string | undefined,
  needs: { input: readonly string[]; output: readonly string[] },
): {
  /** Every route the machine can reach, plus any a known model names. */
  columns: string[];
  /** The route's middle tier, when its ids have one. */
  groups: string[];
  /** The group whose models the last column shows: the hovered one, or the first. */
  shown: string | undefined;
  /** The route whose catalog this one borrows (an agent's). */
  borrows: string | undefined;
  /** An agent's own `default` row, which only lends the default button its levels. */
  ownDefault: PickModel | undefined;
  /** An agent's own menu — what the binary said it runs — first. */
  own: PickModel[];
  /** The provider's list, less what the agent's own menu already names. */
  borrowed: PickModel[];
  /** Every model the last column could show (a route with none picks its own). */
  leaves: PickModel[];
} {
  const matching = models.filter((m) => needs.input.every((mode) => m.input.includes(mode)) && needs.output.every((mode) => m.output.includes(mode)));
  const borrows = ROUTE_BORROWS[route];
  const inRoute = matching
    .filter((m) => tierOf(m.id).route === (borrows ?? route))
    // Re-prefixed, so picking one names the ROUTE the reader chose rather than the one it was
    // borrowed from — `claude-cli/claude-sonnet-5`, not `anthropic/claude-sonnet-5`.
    .map((m) => (borrows === undefined ? m : { ...m, id: `${route}/${m.id.slice(borrows.length + 1)}` }));
  const groups = [...new Set(inRoute.map((m) => tierOf(m.id).group).filter((g): g is string => g !== undefined))].sort();
  // The hovered group, or the first — so the third column has something in it the moment the second
  // appears. Requiring a second hover to see any model made the column read as broken rather than as
  // waiting, which is exactly how it was reported.
  const shown = group !== undefined && groups.includes(group) ? group : groups[0];
  // A route with groups shows that one's models; a route without goes straight to models.
  const leaves = groups.length === 0 ? inRoute : inRoute.filter((m) => tierOf(m.id).group === shown);
  // An AGENT's own menu — what the binary said it runs (decision 0009) — first, each with its levels;
  // its `default` row only lends the default button its levels. The provider's list stays below: the
  // binary runs any of its vendor's models by id, not only the ones its menu names.
  const ownRows = borrows === undefined ? [] : matching.filter((m) => tierOf(m.id).route === route);
  const ownDefault = ownRows.find((m) => tierOf(m.id).leaf === "default");
  const own = ownRows.filter((m) => m !== ownDefault);
  const ownIds = new Set(own.map((m) => m.id));
  const borrowed = leaves.filter((m) => !ownIds.has(m.id));
  // Every route the machine can reach, plus any a known model names. A route with no catalog rows —
  // an agent that picks its own weights — still belongs here, because choosing it IS the choice.
  const columns = [...new Set([...routes, ...matching.map((m) => tierOf(m.id).route)])].filter((r) => r !== "").sort();
  return { columns, groups, shown, borrows, ownDefault, own, borrowed, leaves };
}

/** Where a value came from — what a chip's card says under its title (`Origin`). */
export function originWordsOf(origin: "override" | "unset" | "inherited" | string, from?: string): { text: string; tone: "own" | "unset" | "plain" } {
  if (origin === "override") return { text: "your choice for this message", tone: "own" };
  if (origin === "unset") return { text: "nothing here sets it", tone: "unset" };
  return { text: from === undefined ? "inherited" : `inherited from ${from}`, tone: "plain" };
}

/** Where a kept permission set goes, as the form words it. */
export const KEEP_WHERE: Readonly<Record<"project" | "base", string>> = { project: "in this project", base: "for all projects" };

/** The Permissions card's sentence under its rows. */
export function permissionsHintOf(rows: number, matched: boolean, tools: number, bucket: string): string {
  return rows === 0
    ? `No permission sets in ${bucket} yet. + keeps the tools and modes under Tools as the first.`
    : !matched && tools > 0
      ? `These tools and modes match no permission set in ${bucket} — + keeps them as a new one.`
      : "A permission set: which tools are offered, and what happens when each is called. Change any of it under Tools and this becomes custom.";
}

/**
 * A file going with the message — dropped on the composer, picked from its clip, or `@`-mentioned.
 *
 * `text` is the file's content when it could be read as text, `note` is why it could not. Both are
 * absent from a file that is empty, which is a fact worth sending rather than an error.
 */
export interface ComposerFile {
  /** What it is called — a bare filename from a drop, a project-relative path from a mention. */
  name: string;
  text?: string;
  /** Why this file is a name and not a content — "3.4 MB, too large to inline", "not text". */
  note?: string;
}

/** As big a file as goes in a message. Past it the name and the size are the honest content. */
export const FILE_MAX = 200_000;

/**
 * One file's bytes, read: named, not decoded, when it is too large or not text.
 *
 * Binary files are named, not decoded. `File.text()` on a PNG succeeds and produces replacement
 * characters, and sending sixty kilobytes of those to a model is worse than saying "it is a PNG".
 */
export function fileFromText(name: string, size: number, type: string, text: string | undefined): ComposerFile {
  if (size > FILE_MAX || text === undefined) return { name, note: `${Math.round(size / 1024)} KB — too large to include` };
  // A NUL byte is the oldest and most reliable "this is not text" test there is, and it costs one
  // scan of a file we have already read.
  if (text.includes("\u0000")) return { name, note: `${type || "binary"} — not text` };
  return { name, text };
}

/**
 * The message as it is actually sent: what was typed, then each file under a heading.
 *
 * Fenced, with the name on the fence, because the alternative is a model guessing where a pasted
 * file starts and stops. The typed text comes FIRST — it is the instruction, and burying it under
 * four attachments is how an instruction gets skimmed past.
 */
export function withFiles(text: string, files: readonly ComposerFile[]): string {
  if (files.length === 0) return text;
  const blocks = files.map((file) => (file.text === undefined ? `Attached: ${file.name} (${file.note ?? "not included"})` : `Attached: ${file.name}\n\`\`\`\n${file.text}\n\`\`\``));
  return [text, ...blocks].filter((part) => part !== "").join("\n\n");
}

/**
 * Where an `@` completion stands, or `null`: only an `@` at the start of a WORD opens the picker, so
 * an email address in a pasted paragraph does not — and only while the run of characters after it has
 * no space in it, which is what makes the list close by itself when the person carries on writing.
 */
export function mentionAt(text: string, caret: number): { at: number; query: string } | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf("@");
  const opens = at === 0 || (at > 0 && /\s/.test(before[at - 1] ?? ""));
  const query = before.slice(at + 1);
  if (at === -1 || !opens || /\s/.test(query)) return null;
  return { at, query };
}

/** The draft with a picked path put where the `@` was. */
export function withMention(draft: string, mention: { at: number; query: string }, path: string): string {
  return `${draft.slice(0, mention.at)}@${path} ${draft.slice(mention.at + 1 + mention.query.length)}`;
}
