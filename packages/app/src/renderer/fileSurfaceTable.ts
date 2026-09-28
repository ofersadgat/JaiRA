/**
 * The surface TABLE: which renderers each type has, in order — `fileSurfaces.tsx`'s registrations,
 * moved out unchanged (decision 0015) so the desktop and the universal copy resolve a file to the same
 * renderer. A row names its surface by a key; each shell supplies the components
 * ({@link registerSurfaceTable}): the desktop its DOM surfaces, the universal tree its native copies.
 * Ids, order, `writes`, `themed` and `look` — everything resolution reads — are said once, here.
 */
import { CONFIG_JSON, WORKFLOW_DESCRIPTION, WORKFLOW_JSON, WORKFLOW_YAML } from "@jaira/shared/browser";
import { newSurfaceRegistry, registerFileSurface, type FileRenderer, type FileSurface, type RenderKind, type SurfaceRegistry } from "./fileTypes";

/** The components a table row can name. */
export const SURFACE_KEYS = ["TextEdit", "CodeSourceView", "MarkdownFileEdit", "JsonEdit", "ConfigEdit", "JsonView", "JsonFormView", "YamlView", "DelimitedView", "ConfigEffectiveView", "WorkflowEdit", "MarkdownView", "WorkflowSyncPanel", "RenderedFileView", "PatchFileSurface", "PatchSideBySide", "WorkflowRunView"] as const;
export type SurfaceKey = (typeof SURFACE_KEYS)[number];

/** One registration: a renderer, with its component named rather than given. */
export interface SurfaceRow {
  mime: string;
  kind: RenderKind;
  renderer: Omit<FileRenderer, "surface"> & { surface: SurfaceKey | null };
}

const TABLE: SurfaceRow[] = [];
const row = (mime: string, kind: RenderKind, renderer: SurfaceRow["renderer"]): void => void TABLE.push({ mime, kind, renderer });

/** Every row, in registration order — the order is the meaning (the first leads). */
export function surfaceTable(): readonly SurfaceRow[] {
  return TABLE;
}

/**
 * Register the whole table with these components — into the app's registry, or into one of a shell's
 * own (`newSurfaceRegistry`), which is how the universal copy resolves without the DOM surfaces.
 */
export function registerSurfaceTable(surfaces: Record<SurfaceKey, FileSurface>, into?: SurfaceRegistry): SurfaceRegistry | undefined {
  for (const { mime, kind, renderer } of TABLE) {
    registerFileSurface(mime, kind, { ...renderer, surface: renderer.surface === null ? null : surfaces[renderer.surface] }, into);
  }
  return into;
}
export { newSurfaceRegistry };

/**
 * "Draw nothing at all" — a renderer, offered under `preview` wherever there is a rendering to
 * decline.
 *
 * It is not the absence of a registration and must not be confused with one. An unregistered kind
 * falls through the chain to a vaguer type; THIS stops the walk, and the answer is that this type
 * has no view of that kind at all — which is exactly what somebody means when they say they would
 * rather just see the source.
 *
 * What a SURFACE does with that is the surface's business: one drawing both views gets its space
 * back, one drawing a single view has nothing to draw. This says what the type has, never where it
 * goes.
 */
const NOTHING = { id: "none", label: "Nothing", note: "no view of this kind — a surface that would show one shows none" };

/**
 * The two renderers every text type has, under the names the value viewer already uses for them.
 *
 * Registered at the floor of the chain, so a `.ts`, a `.py`, a `.rs` and a `.toml` all reach them
 * with nothing to write per type. A type that wants an editor of its own — markdown's live preview,
 * JSON's schema-aware editor — registers its own list and states these two again after it, because a
 * more specific list REPLACES rather than extends (see `fileRenderers`): a config file inheriting the
 * plain JSON editor would be a way to save an unvalidated settings file, and that is the one thing
 * this chain must not quietly hand out.
 */
const MONACO = { id: "monaco", label: "Monaco", note: "a real editor — typing, a caret, its own selection", writes: true, themed: true, look: "code" as const, surface: "TextEdit" as const };
const CODEVIEW = { id: "codeview", label: "Code view", note: "coloured, but not an editor — a selection can be dragged through it", themed: true, look: "code" as const, surface: "CodeSourceView" as const };

// --- text: the characters as they are on disk ---------------------------------

row("text/plain", "text", MONACO);
row("text/plain", "text", CODEVIEW);

// Markdown, edited in the live preview by default: the marks are drawn as what they mean, which is
// the better surface for prose and the worse one for a document you are treating as source — a table
// you are aligning by hand, front matter you are rewriting. Neither is right for everybody, so both
// are here, and the plain pair follows because a `.md` file is still text.
row("text/markdown", "text", { id: "live", label: "Live preview", note: "CodeMirror, marks drawn as what they mean", writes: true, themed: true, look: "markdown" as const, surface: "MarkdownFileEdit" });
row("text/markdown", "text", MONACO);
row("text/markdown", "text", CODEVIEW);

// The schema-aware editor, not the plain one: a `.json` file is the one place a picker of known
// document shapes has something to offer. It is a TEXT renderer — it draws the characters, with
// completion and validation over them — which is what the data tree beside it is not.
row("application/json", "text", { id: "schema", label: "Schema-aware", note: "completion and validation against a known shape", writes: true, themed: true, look: "json" as const, surface: "JsonEdit" });
row("application/json", "text", MONACO);
row("application/json", "text", CODEVIEW);

// YAML gets the same editor for the same reason, now that there are YAML files with a known shape — a
// Compose file, a GitLab pipeline, a state written as YAML. Validation, the field reference, the hints
// at the ends of lines and "Add missing fields" work as they do for JSON; completion at the cursor
// does not yet, because it reads JSON's syntax. First, as JSON's is: a file whose schema is detected
// should open held to it, and one with none is still a coloured editor.
row("application/yaml", "text", { id: "schema", label: "Schema-aware", note: "validation and a field reference against a known shape", writes: true, themed: true, look: "json" as const, surface: "JsonEdit" });
row("application/yaml", "text", MONACO);
row("application/yaml", "text", CODEVIEW);

// ONE text renderer, and deliberately no second: this editor writes through `config:write`, which
// parses and validates the document, and every alternative writes bytes. Offering another here would
// be offering a way to save a settings file that stops the app from opening.
row(CONFIG_JSON, "text", { id: "validated", label: "Validated", note: "parsed and checked before it is written", writes: true, themed: true, look: "json" as const, surface: "ConfigEdit" });

// --- data: the value the document denotes -------------------------------------

row("application/json", "data", { id: "tree", label: "Data", note: "the value, as a tree", surface: "JsonView" });
// The same value, as the fields its schema declares — see {@link JsonFormView}. Second rather than
// first, because it is the reading that can decline to draw: a document answering to no schema this
// app knows has no fields, and a default that renders nothing for most `.json` files on disk would
// be a worse default than a tree that always works.
row("application/json", "data", { id: "form", label: "Form", note: "the fields the document's schema declares, in the order it declares them", surface: "JsonFormView" });
row("application/json", "data", { ...NOTHING, surface: null });
row("application/yaml", "data", { id: "tree", label: "Data", note: "the value, as a tree", surface: "YamlView" });
row("application/yaml", "data", { id: "form", label: "Form", note: "the fields the document's schema declares, in the order it declares them", surface: "JsonFormView" });
row("application/yaml", "data", { ...NOTHING, surface: null });
row("text/csv", "data", { id: "table", label: "Table", note: "rows and columns, rather than the delimiters", surface: "DelimitedView" });
row("text/csv", "data", { ...NOTHING, surface: null });
row("text/tab-separated-values", "data", { id: "table", label: "Table", note: "rows and columns, rather than the delimiters", surface: "DelimitedView" });
row("text/tab-separated-values", "data", { ...NOTHING, surface: null });

row(CONFIG_JSON, "data", { id: "effective", label: "Effective", note: "both layers, merged as a run would read them", surface: "ConfigEffectiveView" });
row(CONFIG_JSON, "data", { ...NOTHING, surface: null });

// The authoring form is a data renderer that WRITES, which is what puts it in the panel's lower half
// rather than its upper one — a state's fields are where the state is written, not a reading of it.
// Choosing `Nothing` here is how you ask for the source instead: the panel falls through to the text
// renderer, which for a JSON state is the schema-aware editor and validates against the same shape.
//
// Registered for JSON states only. A YAML state inherits YAML's data renderers and edits as text —
// the form serialises JSON, and offering it for a document it would rewrite in another syntax is
// worse than offering an editor.
row(WORKFLOW_JSON, "data", { id: "form", label: "Authoring form", note: "fields, with the JSON behind a tab", writes: true, surface: "WorkflowEdit" });
row(WORKFLOW_JSON, "data", { ...NOTHING, surface: null });

// --- preview: what the document means, rendered -------------------------------

// Markdown reads above the editor that changes it. It used to have no viewer at all, on the argument
// that the live-preview editor IS the rendering, so a second one would be two renderings of one
// document that could disagree. That was true while both were the same thing: markdown turned into
// styled text. It stopped being true when a fenced block became a READING rather than a coloured
// quotation — the viewer draws a ```yaml block as the value viewer, with its toggle, its table for a
// CSV and its diff for a patch, and an editor structurally cannot: those are components, and
// CodeMirror's document is text with decorations over it rather than a place to mount one.
row("text/markdown", "preview", { id: "rendered", label: "Rendered", surface: "MarkdownView" });
row("text/markdown", "preview", { ...NOTHING, surface: null });

// Any markdown under `workflows/` — each describes the workflow it is named for, and `workflow.md`
// describes the whole layer. Its preview is the sync panel, which keeps the markdown rendering behind
// a toggle; the plain rendering is offered beside it for somebody who writes descriptions far more
// often than they reconcile them. The TEXT renderers come from `text/markdown` through the chain,
// because a description is edited exactly like any other document.
row(WORKFLOW_DESCRIPTION, "preview", { id: "sync", label: "Sync panel", note: "which side has moved, and what to do about it", surface: "WorkflowSyncPanel" });
row(WORKFLOW_DESCRIPTION, "preview", { id: "rendered", label: "Rendered", surface: "MarkdownView" });
row(WORKFLOW_DESCRIPTION, "preview", { ...NOTHING, surface: null });

// A page and a drawing both have a rendering, and neither had a viewer — an `.html` in a layer root
// fell all the way to the plain text editor, which is the one surface that cannot show what it is.
row("text/html", "preview", { id: "rendered", label: "Rendered", surface: "RenderedFileView" });
row("text/html", "preview", { ...NOTHING, surface: null });
row("image/svg+xml", "preview", { id: "drawn", label: "Drawn", surface: "RenderedFileView" });
row("image/svg+xml", "preview", { ...NOTHING, surface: null });

row("text/x-diff", "preview", { id: "changes", label: "Changes", note: "the edit it describes, not the columns it describes it in", surface: "PatchFileSurface" });
row("text/x-diff", "preview", { id: "sidebyside", label: "Side by side", note: "the two revisions it is between, in the panes a review uses", themed: true, look: "diff", surface: "PatchSideBySide" });
row("text/x-diff", "preview", { ...NOTHING, surface: null });

row(WORKFLOW_JSON, "preview", { id: "board", label: "Board", note: "what this state is doing right now", surface: "WorkflowRunView" });
row(WORKFLOW_JSON, "preview", { ...NOTHING, surface: null });
row(WORKFLOW_YAML, "preview", { id: "board", label: "Board", note: "what this state is doing right now", surface: "WorkflowRunView" });
row(WORKFLOW_YAML, "preview", { ...NOTHING, surface: null });

