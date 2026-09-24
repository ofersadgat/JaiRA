/**
 * The built-in surfaces, and the table that connects them to types.
 *
 * Importing this module is what populates the registry — every `registerFileSurface` call is at the
 * bottom, in one block, so "what can this app open?" is a list you read rather than a search. The
 * components above it are ordinary React; nothing here knows about the registry except those lines.
 *
 * The rule the table follows: register the most specific type that changes behaviour, and let the
 * fallback chain cover the rest. `text/markdown` gets a preview because markdown has a rendering;
 * `text/x-typescript` gets nothing, and therefore gets the plain editor with no viewer above it,
 * which is the correct surface for a file whose source *is* its presentation.
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type JSX } from "react";
import {
  CONFIG_JSON,
  WORKFLOW_DESCRIPTION,
  WORKFLOW_JSON,
  WORKFLOW_YAML,
  delimiterOf,
  isWritableLayer,
  hasGrammar,
  mimeOfPath,
  monacoGrammarOf,
  parseDelimited,
  parseStructured,
  parseUnifiedDiff,
  schemaById,
  type FileSource,
  type StructuredFormat,
  type WorkflowSource,
} from "@jaira/shared/browser";
import { Badge } from "./board";
import { TaskName } from "./taskName";
import { CompositeView, SidechainConversation } from "./runViews";
import { entriesOf, journalFor, markAnsweredQuestions } from "./transcript";
import { useStickToBottom } from "./stickToBottom";
import { nodeAt } from "./trail";
import { Paper, Transcript } from "./transcriptView";
import { docKey, useDraftBox } from "./drafts";
import { EditorActions, type EditorTab } from "./editorChrome";
import { isReading, registerFileSurface, type FileSurfaceContext, type FileSurfaceProps } from "./fileTypes";
import { ReadOnlyContext } from "./reading";
import { MarkdownView } from "./fenceRender";
import { CodeDocument, MarkdownDocument } from "./documents";
import type { CodeIntel } from "./monacoDiff";
import { invoke } from "./store";

import { DataView, PatchView, TableView, ValueView } from "./valueView";
import { SchemaJsonEditor, schemaReferenceProps } from "./schemaEditor";
import { WorkflowEditor } from "./stateEditor";
import { WorkflowSyncPanel } from "./syncPanel";

/**
 * Loaded when a form is first drawn, never with the table.
 *
 * The same lazy boundary `valueView.tsx` puts it behind, and for the same reason: the widget set and
 * its presentation rules are a chunk nothing that merely opens a `.ts` file should pay for.
 */
// Megabytes, and only for the one renderer that needs it — the same lazy boundary the reviewer's
// diff sits behind.
const DiffPane = lazy(() => import("./monacoDiff").then((m) => ({ default: m.MonacoDiffPane })));

const SchemaForm = lazy(() => import("./schemaForm/SchemaForm").then((m) => ({ default: m.SchemaForm })));

// --- editing text ------------------------------------------------------------

/**
 * The plain text editor, and the floor of the whole registry.
 *
 * Every text type reaches this one through the fallback chain, which is the property that makes an
 * unregistered file openable instead of dead. The three behaviours it has are the three every editor
 * in this app needs: a draft that survives being unmounted, a reload that never lands on top of
 * unsaved typing, and a Revert that means "throw away what I typed", not "undo the last save".
 *
 * All three come from {@link draftBox} now rather than from local state and a pair of effects. The
 * draft lives in the store, keyed by this file — which is what makes clicking another file in the
 * tree, or spending a minute on the board, something you can do mid-edit.
 */
/**
 * Markdown, edited in place (the live-preview editor).
 *
 * The same draft box, Save and Revert every other editing surface here uses — only the control in
 * the middle differs, which is the point of the registry.
 */
function MarkdownFileEdit({ doc, busy, onSave, context }: FileSurfaceProps): JSX.Element {
  const draft = useDraftBox(context.drafts, context.onDraft, docKey(doc.layer, doc.path), doc.text);
  // The reading of a type is not a place anybody types — see {@link isReading}. Still this surface:
  // the live preview, its decorations and its fences, with the keyboard off.
  const reading = isReading(context);
  return (
    <div className="file-edit">
      {/* Editable, said by supplying somewhere for the change to go. The `Suspense` and the choice
          of renderer are `markdownDocument.tsx`'s business rather than this surface's. */}
      <MarkdownDocument
        // The document rather than the draft: a reading shows what the file says, and the half of the
        // panel holding an hour of unsaved typing is the editor.
        text={reading ? doc.text : draft.text}
        mime={doc.mime}
        {...(reading ? { readOnly: true } : { onChange: draft.set })}
      />
      {reading ? (
        <ReadingNote />
      ) : (
        <EditorActions
          dirty={draft.dirty || !doc.exists}
          busy={busy}
          onSave={() => onSave(draft.text)}
          onRevert={draft.revert}
        >
          {doc.exists ? null : <span className="sub">new file — saving creates it</span>}
        </EditorActions>
      )}
    </div>
  );
}

/**
 * The row a Save button would have been in, saying why there is none.
 *
 * The same move {@link CodeSourceView} makes and for the same reason: a surface that quietly refuses
 * typing reads as broken from the outside, while one that names what is holding it open — and the
 * screen where that is taken back — is a choice somebody made.
 */
function ReadingNote(): JSX.Element {
  return (
    <div className="pane-actions pinned">
      <span className="sub">The reading of this type — not a place to type. Appearance › File types.</span>
    </div>
  );
}

export function TextEdit({ doc, busy, onSave, context }: FileSurfaceProps): JSX.Element {
  const draft = useDraftBox(context.drafts, context.onDraft, docKey(doc.layer, doc.path), doc.text);
  // Mounted as the READING of a type — the same editor, refusing typing. See {@link isReading}.
  const reading = isReading(context);
  /**
   * Coloured when there is a grammar for it, a plain box when there is not.
   *
   * This is the floor of the registry, so it is what a `.ts`, a `.py`, a `.rs` and a `.yaml` all
   * reach — and it was a bare `<textarea>` for every one of them. An app that colours TypeScript in
   * the transcript, in a fenced block and in a diff was editing a TypeScript FILE with no
   * highlighting at all, which is the one place a person spends real time with it.
   *
   * Asked of `hasGrammar` rather than listed here, so this follows `shared/grammars.ts` the way
   * every other question about a type does: name a grammar there and the editor colours it, with
   * nothing to add on this side. A type with none still gets the box, which is the honest surface
   * for text that has no structure to show.
   */
  const coloured = hasGrammar(doc.mime);
  /**
   * The compiler, for the types that have one.
   *
   * TypeScript and JavaScript only, because that is what main can answer about — every other type
   * here would cost a round trip to be told no project covers it. `doc` supplies the address rather
   * than the pane working one out: `file:check` is addressed exactly like the `file:read` that
   * opened this document, which is what keeps the containment check the same one.
   *
   * Rebuilt whenever the file does, and never otherwise: the pane holds it in a ref, so an identity
   * that changed every render would be harmless but a stale ADDRESS would not.
   */
  const grammar = monacoGrammarOf(doc.mime);
  /**
   * Whether this document is a FILE — somewhere on a disk — rather than a sample that looks like one.
   *
   * `FileSource.file` is absolute for everything the tree opens, because that is what resolving a
   * path against a layer root produces. The settings preview builds a document by hand to show what
   * a renderer does to a type, and its `file` is the word "sample": asking the compiler about that
   * would be a refused round trip per keystroke, in a pane whose subject is a colour scheme.
   */
  const located = /^([a-zA-Z]:[\\/]|[\\/])/.test(doc.file);
  const checkable = located && (grammar === "typescript" || grammar === "javascript");
  const address = useCallback(
    () => ({
      layer: doc.layer,
      ...(doc.project === undefined ? {} : { project: doc.project }),
      path: doc.path,
    }),
    [doc.layer, doc.project, doc.path],
  );
  /**
   * Everything this pane can ask about its own text, and what it can do with an answer.
   *
   * `open` is the half Monaco has no way to perform: a standalone editor holds one model, so
   * following a definition OUT of this file is navigation only the window can do. A definition main
   * could not address — one outside the tree it searched — arrives without an `at` and is refused
   * here, which draws nothing rather than going somewhere plausible and wrong.
   */
  const onDefinition = context.onOpenDefinition;
  const intel = useMemo(
    (): CodeIntel => ({
      check: (text) => invoke("file:check", { ...address(), text }),
      definitions: (text, at) => invoke("file:definition", { ...address(), text, ...at }),
      references: (text, at) => invoke("file:references", { ...address(), text, ...at }),
      hover: (text, at) => invoke("file:hover", { ...address(), text, ...at }),
      /**
       * Another file's text, for a peek to preview.
       *
       * `file:source` rather than `file:read`, because a definition is not addressed the way an
       * opened file is: it can resolve outside the tree entirely, and in this repository most of
       * them do — `@declarative-ai/*` goes through a workspace junction into a sibling checkout. A
       * read contained to the project root could preview none of those, which would have made peek
       * work only for the imports that were already the easy case.
       *
       * What bounds it instead is the program: main serves the text only for a file the compiler
       * itself resolved. Failure is answered with nothing, and that result simply loses its preview.
       */
      read: async (to) => {
        const source = await invoke("file:source", { ...address(), file: to.file }).catch(() => undefined);
        return source?.text;
      },
      ...(onDefinition === undefined
        ? {}
        : {
            open: (to) => {
              if (to.at === undefined) return false;
              onDefinition(to.at, { line: to.startLine, column: to.startColumn });
              return true;
            },
          }),
    }),
    [address, onDefinition],
  );
  /**
   * Withdraw the buffer when this surface goes away.
   *
   * The checker holds what is on screen so diagnostics follow typing, and a buffer nobody withdrew
   * would go on shadowing the file on disk for the rest of the session — including for every OTHER
   * file that imports it, which is how an edit abandoned without saving keeps producing errors
   * somewhere else.
   */
  useEffect(() => {
    if (!checkable) return undefined;
    return () => {
      void invoke("file:release", {
        layer: doc.layer,
        ...(doc.project === undefined ? {} : { project: doc.project }),
        path: doc.path,
      }).catch(() => {
        // Closing an editor is not a place to report that a cache could not be cleared.
      });
    };
  }, [checkable, doc.layer, doc.project, doc.path]);

  return (
    <div className="file-edit">
      {coloured ? (
        <CodeDocument
          text={reading ? doc.text : draft.text}
          mime={doc.mime}
          {...(reading ? { readOnly: true } : {})}
          onChange={draft.set}
          // Which half the panel mounted this as, so the editor asks for that view's palette. This
          // surface is the editor of most types and the READING of one whose editor is something
          // else, and only the thing that resolved it knows which — see `FileSurfaceContext.view`.
          view={context.view ?? "write"}
          // The name Monaco parses by — without it a `.tsx` file is read as plain TypeScript and
          // every tag in it is a syntax error.
          {...(located ? { file: doc.file } : {})}
          {...(checkable ? { intel } : {})}
          // Where a definition asked for this file to be opened, if that is why it is open. Matched
          // by PATH: opening some other file afterwards must not land the caret at a position that
          // was about a different document.
          {...(context.revealAt?.path === doc.path
            ? { reveal: { line: context.revealAt.line, column: context.revealAt.column } }
            : {})}
        />
      ) : (
        <textarea
          className="code-editor"
          spellCheck={false}
          readOnly={reading}
          value={reading ? doc.text : draft.text}
          onChange={(e) => draft.set(e.target.value)}
        />
      )}
      {reading ? (
        <ReadingNote />
      ) : (
        <EditorActions
          // `|| !doc.exists`: creating the file IS the pending change, so the note beside the button
          // describes something the button can actually do.
          dirty={draft.dirty || !doc.exists}
          busy={busy}
          onSave={() => onSave(draft.text)}
          onRevert={draft.revert}
        >
          {doc.exists ? null : <span className="sub">new file — saving creates it</span>}
        </EditorActions>
      )}
    </div>
  );
}

// --- structured data ---------------------------------------------------------

/**
 * A structured document, read rather than edited.
 *
 * The value of a viewer over a text editor for JSON is small but real: nesting you can follow, and
 * a parse error stated once at the top instead of discovered on save.
 *
 * A FORMAT rather than a parse function, which is the change that matters here. This used to hold
 * its own pair — `JSON.parse` and `yaml`'s `parse` — and so the Files view disagreed with the rest
 * of the app about what these documents said: a `.jsonc` file with a comment in it "did not parse",
 * a stream of `---` documents threw, and a merge key came back as a key called `<<`. One parse now
 * (`shared/structured.ts`), so a file read here and the same file read as a tool result say the same
 * thing, and a failure names the line instead of gesturing at the file.
 */
function StructuredView({ text, format }: { text: string; format: StructuredFormat }): JSX.Element {
  if (text.trim().length === 0) return <p className="empty">This file is empty.</p>;
  const parsed = parseStructured(text, format);
  if (!parsed.ok) {
    return (
      <div className="notice bad">
        does not parse: {parsed.message}
        {parsed.spot !== undefined ? ` (line ${parsed.spot.line}, column ${parsed.spot.column})` : ""}
      </div>
    );
  }
  // The SAME tree the `data` view draws — see {@link DataView}. It used to be a private copy here,
  // which is how a `.yaml` file in the tree and a ```yaml block in an answer came to be two
  // different readings of one question.
  return <DataView value={parsed.value} />;
}

export function JsonView({ doc }: FileSurfaceProps): JSX.Element {
  return <StructuredView text={doc.text} format="json" />;
}

/**
 * Which schema a document answers to, asking the app once if nobody has decided.
 *
 * Shared by the two surfaces that need the answer — the JSON editor and the form — and that sharing
 * is the point rather than a tidy. The choice used to be filled in by the editor's own effect, which
 * was fine while the editor was the only thing that read it; a form drawn ABOVE an editor the person
 * had swapped for Monaco would then have found nothing chosen and said so, on a file whose schema
 * this app can identify perfectly well. Either surface alone now answers the question.
 *
 * Only when nothing has been decided — `chosen` absent, not `""`. The result is RECORDED as the
 * choice, including a miss (`""`), so this asks once per file rather than on every keystroke, and so
 * editing the document afterwards cannot pull the picker out from under the author.
 *
 * Detection reads `doc.text`, the file as it is on disk, rather than any draft: what schema a file IS
 * should not change while it is half-typed.
 */
function useSchemaChoice(doc: FileSource, context: FileSurfaceContext): string | undefined {
  const key = docKey(doc.layer, doc.path);
  const chosen = context.schemaChoice[key];
  const { detectSchema, onSchemaChoice } = context;
  useEffect(() => {
    if (chosen !== undefined) return;
    let live = true;
    void detectSchema(doc.text).then((found) => {
      if (live && found !== null) onSchemaChoice(key, found.schemaId);
    });
    return () => {
      live = false;
    };
  }, [key, chosen, doc.text, detectSchema, onSchemaChoice]);
  return chosen;
}

/**
 * A JSON document as the fields its schema declares — the FORM, as a data renderer.
 *
 * The third way to read a `.json` file, beside the tree and its own source, and the one the value
 * viewer has always had (`viewsFor` offers `form` for any value that arrives with an object schema).
 * What it adds over the tree is everything the schema knows and the document does not: the order the
 * fields were declared in, their descriptions, which are expected, and a widget per type instead of
 * a string.
 *
 * **A reading, not an editor** — `disabled`, exactly as the value viewer draws it. Two reasons, and
 * the second is the load-bearing one. It keeps the two forms one component rather than two that
 * drift; and a form that wrote would have to serialise the whole document back through
 * `JSON.stringify`, which reorders keys to the schema's declaration order and discards every choice
 * of formatting in the file. The editor below it changes the document — with completion and
 * validation against this same schema — and it does that without rewriting anything nobody touched.
 *
 * A state file is the exception that proves it: its authoring form DOES write, is registered as a
 * writing data renderer, and therefore lands in the panel's lower half instead of this one. That is
 * a workflow-shaped decision about a file the app itself owns, not a general licence to reformat
 * somebody's JSON.
 */
export function JsonFormView({ doc, context }: FileSurfaceProps): JSX.Element {
  const chosen = useSchemaChoice(doc, context);
  const entry = chosen === undefined || chosen === "" ? undefined : schemaById(chosen);
  if (doc.text.trim().length === 0) return <p className="empty">This file is empty.</p>;
  const parsed = parseStructured(doc.text, "json");
  if (!parsed.ok) {
    return (
      <div className="notice bad">
        does not parse: {parsed.message}
        {parsed.spot !== undefined ? ` (line ${parsed.spot.line}, column ${parsed.spot.column})` : ""}
      </div>
    );
  }
  if (entry === undefined) {
    // Not an error and not a failure of this renderer: a form is a rendering OF a schema, and this
    // document answers to none that the app knows. Naming the control that would change that is the
    // useful part — the picker lives in the editor below, when the editor below is the schema-aware
    // one. `detectSchema` has already been asked and came back empty.
    return (
      <p className="empty">
        No schema for this document, so there are no fields to draw. Choose one in the editor’s Schema
        picker, or read it as Data.
      </p>
    );
  }
  return (
    <Suspense fallback={<p className="empty">Loading the form…</p>}>
      <div className="vv-form file-form">
        <SchemaForm
          schema={entry.document as never}
          value={parsed.value}
          onChange={() => undefined}
          // `isSet` answers false for everything, which is not a lie by omission — it is the only
          // true answer here. The tag it drives means "this LAYER states this value", a fact about
          // editing a layered config, and its default (`the key is present`) would put a "set here"
          // chip beside every field of a document nobody is editing at all.
          ctx={{ path: "", disabled: true, reading: true, isSet: () => false }}
        />
      </div>
    </Suspense>
  );
}

/**
 * The JSON editor, with a schema picker.
 *
 * Everything schema-shaped lives in {@link SchemaJsonEditor}; this is the adapter that gives it a
 * draft, a save path and somewhere to remember the choice. The draft rules are {@link TextEdit}'s,
 * for the same reasons — a reload must not land on unsaved typing, and a new file is a new draft.
 */
export function JsonEdit({ doc, busy, onSave, context }: FileSurfaceProps): JSX.Element {
  const key = docKey(doc.layer, doc.path);
  const draft = useDraftBox(context.drafts, context.onDraft, key, doc.text);
  const chosen = useSchemaChoice(doc, context);
  // A reading: the same two layers and the same schema picker, with the box closed and no Save row —
  // `SchemaJsonEditor` draws that row only when it is given somewhere to save to.
  const reading = isReading(context);

  return (
    <SchemaJsonEditor
      text={reading ? doc.text : draft.text}
      // The document's own type, so a palette chosen for a vendor JSON is read under the key it was
      // written to rather than under plain JSON.
      mime={doc.mime}
      busy={busy}
      dirty={draft.dirty}
      readOnly={reading}
      onChange={draft.set}
      {...(reading ? {} : { onSave: () => onSave(draft.text), onRevert: draft.revert })}
      validate={context.validateSchema}
      schemaId={chosen === undefined || chosen === "" ? null : chosen}
      onSchema={(schemaId) => context.onSchemaChoice(key, schemaId)}
      wrap={context.wrapJson}
      onWrap={context.onWrapJson}
      // The field reference is a pane like any other in the window, so it is remembered like one.
      {...schemaReferenceProps(context.ui)}
    />
  );
}

export function YamlView({ doc }: FileSurfaceProps): JSX.Element {
  return <StructuredView text={doc.text} format="yaml" />;
}

/**
 * A delimited file, as the grid it is.
 *
 * `text/csv` had no viewer at all, so a CSV opened as a plain text editor and nothing else — the
 * one file type in the tree whose source is genuinely unreadable and whose rendering is trivial. The
 * table is the same component the transcript draws, for the reason the registry exists: a CSV should
 * not look like two different things depending on whether it arrived as a file or as a tool result.
 */
/**
 * A `.patch` or `.diff`, as the change it describes.
 *
 * The one type Monaco has no grammar for, so before this it opened entirely grey — and it is also
 * the type whose rendering is least like its source. Same component the transcript draws, for the
 * reason the registry exists: a patch should not look like two different things depending on whether
 * it arrived as a file or in a model's answer.
 */
export function PatchFileSurface({ doc }: FileSurfaceProps): JSX.Element {
  const files = useMemo(() => parseUnifiedDiff(doc.text), [doc.text]);
  if (doc.text.trim().length === 0) return <p className="empty">This file is empty.</p>;
  if (files.length === 0) return <div className="notice bad">not a unified diff — the editor below has the text</div>;
  return <PatchView files={files} />;
}

/**
 * A patch as the two revisions it is BETWEEN — the same change, side by side.
 *
 * The unified view above it is the patch as written: one column, markers down the left, every hunk
 * in the order the file has them. This is the other reading, and it is the one for a change big
 * enough that you stop reading the markers and start comparing the two texts — which is what the
 * two-sided panes are for everywhere else in this app (a changeset review, a diff in a transcript).
 *
 * It also gives the diff surface somewhere to LIVE. Its look (`EditorLook`, `diff`) had no file type
 * that resolved to it, so its controls sat in a section of their own outside File types — a surface
 * named in the settings that nothing in the settings could reach. `text/x-diff` is a Changes file
 * and this is a renderer for it, so the controls are where the type is.
 *
 * ## Reconstructing the two sides
 *
 * A unified diff carries both texts, interleaved: a context line belongs to both, a removed line to
 * the left only, an added line to the right only. So the two are a fold over the hunks, and what is
 * lost is only what the patch itself left out — the unchanged stretches between hunks, which is why
 * the panes show the hunks rather than the files. A patch of several files shows the first and says
 * how many others there are, because two panes can hold one comparison.
 */
function PatchSideBySide({ doc }: FileSurfaceProps): JSX.Element {
  const files = useMemo(() => parseUnifiedDiff(doc.text), [doc.text]);
  const sides = useMemo(() => {
    const file = files[0];
    if (file === undefined) return null;
    const before: string[] = [];
    const after: string[] = [];
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.kind !== "add") before.push(line.text);
        if (line.kind !== "del") after.push(line.text);
      }
    }
    return { file, before: before.join("\n"), after: after.join("\n") };
  }, [files]);
  if (doc.text.trim().length === 0) return <p className="empty">This file is empty.</p>;
  if (sides === null) return <div className="notice bad">not a unified diff — the editor below has the text</div>;
  return (
    <div className="file-edit">
      <Suspense fallback={<pre className="vv-source">{doc.text}</pre>}>
        <DiffPane
          original={sides.before}
          modified={sides.after}
          mime={mimeOfPath(sides.file.path)}
          file={sides.file.path}
          readOnly
        />
      </Suspense>
      <div className="pane-actions pinned">
        <span className="sub">
          {sides.file.path}
          {files.length > 1 ? ` — and ${files.length - 1} other ${files.length === 2 ? "file" : "files"} in this patch` : ""}
        </span>
      </div>
    </div>
  );
}

export function DelimitedView({ doc }: FileSurfaceProps): JSX.Element {
  const mime = mimeOfPath(doc.path);
  const rows = useMemo(() => parseDelimited(doc.text, delimiterOf(mime)), [doc.text, mime]);
  if (doc.text.trim().length === 0) return <p className="empty">This file is empty.</p>;
  return <TableView rows={rows} />;
}

// --- workflows ---------------------------------------------------------------

/**
 * A leaf state: the tasks in it, and what the selected one actually said.
 *
 * "Recently" exists because a leaf with nothing running would otherwise be a blank panel, and "who
 * came through here and how did it go" is the question you would ask next anyway.
 *
 * The right half used to be two components stacked — a session viewer over a projection of the
 * journal — and the lower one was scoped to the TASK, not to this state. So opening one state
 * showed its words above every event of the whole run, which read as "it is showing all the
 * sessions". They are one stream now (`transcript.ts`), filtered to this state, and a leaf renders
 * it with no chrome at all: chrome marks a child boundary and a leaf has no children.
 */
function LeafPanel({ context }: FileSurfaceProps): JSX.Element {
  const { state, selected, conversation, waiting, onSelectTask, onAnswer } = context;
  const { session, liveTurn } = context;
  // The whole tail: text, thinking, items — and the sidechains, which are what turns a Task row
  // into a doorway while its subagent is still talking.
  // The host of any doorway in THIS transcript is the instance whose session is on screen — what a
  // sidechain step has to name for the walk to keep resolving. See `TrailStep.sidechain`.
  const host = context.sessionInstance !== null ? nodeAt(context.detail?.instances ?? [], context.sessionInstance) : undefined;
  // An agent question the control conversation answered says so here too — the same marks the run
  // conversation reads (`markAnsweredQuestions`).
  const marks = host?.answeredQuestions;
  const entries = useMemo(
    () => markAnsweredQuestions(entriesOf(session, journalFor(conversation?.turns ?? [], state?.stateId), liveTurn), marks),
    [session, conversation, state?.stateId, liveTurn, marks],
  );
  // Follow the live edge while the reader is standing on it. The selected run is the reset: another
  // task's conversation is another conversation, and is read from its end.
  const follow = useStickToBottom<HTMLDivElement>([entries], [selected]);
  const onWalkIntoSidechain = context.onWalkIntoSidechain;
  // Standing on a sidechain step: the panel is that subagent conversation, exactly as it is for a
  // composite — a leaf's walk is shorter, not different.
  const tail = context.trail?.at(-1);
  if (tail?.sidechain !== undefined) {
    return (
      <div className="composite">
        <SidechainConversation step={tail} context={context} />
      </div>
    );
  }
  if (state === null) return <p className="empty">No state loaded.</p>;
  return (
    <div className="leaf">
      <div className="leaf-list">
        <h3>
          <span>Tasks here</span>
          <span className="count">{state.tasksHere.length}</span>
        </h3>
        {state.tasksHere.map((card) => (
          <div
            key={card.taskId}
            className={`leaf-row${card.taskId === selected ? " sel" : ""}`}
            onClick={() => onSelectTask(card.taskId)}
          >
            <Badge status={card.activeStatus ?? card.status} />
            <TaskName task={card} className="grow ellip" />
          </div>
        ))}
        {state.tasksHere.length === 0 ? <p className="empty">Nothing here right now.</p> : null}

        {state.tasksRecent.length > 0 ? (
          <>
            <h3>Recently</h3>
            {state.tasksRecent.map((card) => (
              <div
                key={card.taskId}
                className={`leaf-row${card.taskId === selected ? " sel" : ""}`}
                onClick={() => onSelectTask(card.taskId)}
              >
                <Badge status={card.status} />
                <TaskName task={card} className="grow ellip" />
              </div>
            ))}
          </>
        ) : null}
      </div>
      <div className="leaf-convo scroll" ref={follow.ref} onScroll={follow.onScroll}>
        <Paper>
          <Transcript
            session={session}
            entries={entries}
            live={liveTurn}
            empty={selected === null ? "Select a run to see what it said." : undefined}
            {...(onWalkIntoSidechain !== undefined && host !== undefined
              ? { onOpenSidechain: (call: string, name: string) => onWalkIntoSidechain(host, call, name) }
              : {})}
          />
        </Paper>
        {waiting ? (
          // Pinned rather than in the flow: it is the one turn that is not history, and scrolling
          // away from the thing blocking the run is exactly the wrong behaviour.
          <div className="waiting-on">
            <Badge status="waiting_for_user" />
            <span className="grow">Waiting on you — {waiting.component}</span>
            {onAnswer ? <button className="primary" onClick={onAnswer}>Answer</button> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * What a state file IS DOING: its board, or its tasks and their conversation.
 *
 * Exactly what the Tasks view would show for the same state, and deliberately so — reaching a state
 * by clicking a file and reaching it by drilling the board should not produce two different pictures
 * of the same thing.
 */
export function WorkflowRunView(props: FileSurfaceProps): JSX.Element {
  const { state } = props.context;
  if (state === null) return <p className="empty">This file does not resolve to a state.</p>;
  // A leaf has no children, so it has no board and nothing to toggle between: it is content.
  if (state.board === null) return <LeafPanel {...props} />;
  return <CompositeView {...props} state={state} />;
}

/**
 * The authoring form, adapted to the registry's props.
 *
 * {@link WorkflowEditor} predates this table and is addressed by state id, because that is what
 * `workflow:write` takes. The adapter is the seam: it rebuilds the {@link WorkflowSource} the editor
 * expects out of the generic document, and it is the reason a state file can be opened by path like
 * everything else while still being saved through the channel that lints it.
 *
 * Registered for JSON states only. A YAML state falls through to the YAML surfaces — the form
 * serialises JSON, and offering it for a document it would rewrite in another syntax is worse than
 * offering a text editor.
 */
export function WorkflowEdit({ doc, busy, onSave, context }: FileSurfaceProps): JSX.Element {
  const key = docKey(doc.layer, doc.path);
  // The one renderer here that is neither text nor a document: a page of controls. Read-only for a
  // FORM is every control refused at once, which a disabled fieldset states in one place — see the
  // wrapper at the end of this function.
  const reading = isReading(context);
  if (doc.stateId === undefined) return <p className="empty">This file does not name a state.</p>;
  const source: WorkflowSource = {
    stateId: doc.stateId,
    layer: doc.layer,
    file: doc.file,
    text: doc.text,
    exists: doc.exists,
    ...(doc.builtIn !== undefined ? { builtIn: doc.builtIn } : {}),
  };
  const form = (
    <WorkflowEditor
      source={source}
      tree={context.tree}
      executors={context.executors}
      busy={busy}
      validateSchema={context.validateSchema}
      loadStateSlots={context.stateSlots}
      wrapJson={context.wrapJson}
      onWrapJson={context.onWrapJson}
      // So the JSON tab's field reference is the same remembered panel the plain JSON editor shows,
      // rather than one that opens shut every time you reach it from a state file.
      ui={context.ui}
      // What the inspector is reporting, and which of it to go to. The editor marks its own controls
      // from the same list the panel beside it is showing, so "3 errors" and three red boxes are one
      // fact rather than two surfaces that can disagree.
      issues={context.state?.issues ?? []}
      reveal={context.revealIssue ?? null}
      // The unsaved document and the tab it was left on, both held per file by the store. This form
      // is a page of controls and its JSON tab is a text box; either can hold an hour's work, and
      // both used to end at the next click in the tree.
      draft={context.drafts?.[key] ?? null}
      {...(context.onDraft ? { onDraft: (text: string | null) => context.onDraft?.(key, text) } : {})}
      {...(context.onEditorTab
        ? {
            // A file never opened before opens on the FORM — composites included, whose graph used
            // to follow them from the last file (the panel rulings, 2026-09-24). A tab chosen on
            // this file is still remembered for it.
            tab: context.editorTab?.[key] ?? "form",
            onTab: (next: EditorTab) => context.onEditorTab?.(key, next),
          }
        : {})}
      // The graph's child boxes lead to the states they mount — the same move the board's columns
      // make, through the same action, so "open that child" means one thing in the app.
      onOpenState={context.onDrill}
      // Reading and writing a state that is not this file: what the graph's side panel shows about a
      // child box — see `statePanel.tsx`.
      {...(context.readState !== undefined ? { readState: context.readState } : {})}
      {...(context.saveState !== undefined ? { saveState: context.saveState } : {})}
      // Reading any file: what a linked property's preview shows — see `linkPreview.tsx`.
      {...(context.readFile !== undefined ? { readFile: context.readFile } : {})}
      // The built-in layer's buttons, bound to THIS state — see `FileSurfaceContext.builtInActions`.
      {...(context.builtInActions !== undefined
        ? {
            layerActions: {
              hasProject: context.builtInActions.hasProject,
              onOverride: (toLayer) => context.builtInActions?.onOverride(source.stateId, toLayer),
              ...(context.builtInActions.onEditCopy !== undefined
                ? { onEditCopy: (text: () => string) => context.builtInActions?.onEditCopy?.(source.stateId, text) }
                : {}),
            },
          }
        : {})}
      onSave={(_stateId, _layer, text) => onSave(text)}
    />
  );
  // The form already knows how to be a reading — it is what the panel beside a finished run shows —
  // and it is told through a context rather than a prop because the flag has to reach a slot row
  // inside a table inside a tab (see `reading.ts`). A provider adds no element, which matters here:
  // the containers this lands in style their direct children.
  return reading ? <ReadOnlyContext.Provider value={true}>{form}</ReadOnlyContext.Provider> : form;
}

// --- rendered documents ------------------------------------------------------

/**
 * A document whose type has a RENDERING of its own — an HTML page, an SVG drawing.
 *
 * Delegated to {@link ValueView} rather than drawing a frame here, and that is the point of adding
 * it: the transcript already shows model-produced HTML that way, and a mockup should not look one
 * way beside the call that made it and another way when opened as a file. One renderer, one sandbox
 * posture, one toggle back to the source.
 *
 * The type comes from the PATH rather than from the tree node, because a surface is handed a
 * document and not the row that was clicked — and `mimeOfPath` is the same classifier the row used,
 * so the two cannot disagree.
 *
 * No editor is registered for either type: both are text, so the fallback chain gives them the plain
 * one, which is the right surface for a file whose source is what you came to change.
 */
export function RenderedFileView({ doc }: FileSurfaceProps): JSX.Element {
  return <ValueView value={doc.text} hint={{ mime: mimeOfPath(doc.path) }} />;
}

// --- configuration -----------------------------------------------------------

/**
 * `settings.json`, seen as what it actually decides.
 *
 * The document alone cannot answer the question anyone opening it has — the shared root supplies
 * every field this file does not, so what runs is the two layers merged with the defaults filled in.
 * That merge is the viewer. It is also why config gets a `view` surface at all when JSON in general
 * gets a tree: here there is something to show that is not in the file.
 */
export function ConfigEffectiveView({ context }: FileSurfaceProps): JSX.Element {
  if (context.config === null) return <p className="empty">Open a project to see the effective configuration.</p>;
  return (
    <div className="config-effective">
      <div className="sub">shared config with this project&apos;s laid over it</div>
      <DataView value={context.config.effective} />
    </div>
  );
}

/**
 * The configuration editor.
 *
 * A JSON text box rather than a generated form, deliberately. Project config is an open, still
 * growing vocabulary — policy rules, artifact destination templates, the search path — and a form
 * that lagged the schema would silently drop the fields it did not know about on every save, which
 * is a far worse failure than having to type a brace.
 *
 * It does not use {@link TextEdit}'s save path: `config:write` takes a parsed document and validates
 * it, so an unparsable draft is refused here rather than written and reported afterwards.
 */
export function ConfigEdit({ doc, busy, context }: FileSurfaceProps): JSX.Element {
  const reading = isReading(context);
  const authored = context.config === null ? null : doc.layer === "base" ? context.config.base : context.config.project;
  // The layer document as text. Preferred over the file's own contents because `config:read` has
  // already parsed it BOM-tolerantly and reprinted it; the raw bytes may differ in ways that would
  // show up as a spurious diff the moment anyone saved.
  const authoredText = useMemo(
    () => (authored == null ? doc.text || "{}" : JSON.stringify(authored, null, 2)),
    [authored, doc.text],
  );

  // Measured against `authoredText`, not `doc.text`, so the draft is a difference from the document
  // this editor actually shows — otherwise reprinting alone would count as an unsaved edit and the
  // file would open dirty.
  const draft = useDraftBox(context.drafts, context.onDraft, docKey(doc.layer, doc.path), authoredText);
  // Not remembered across a file switch, unlike the text: it is a report about the last attempt to
  // save, and a stale one beside a document that has since been fixed would be a lie.
  const [parseError, setParseError] = useState<string | null>(null);

  const save = (): void => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(draft.text);
    } catch (e) {
      setParseError((e as Error).message);
      return;
    }
    setParseError(null);
    // The built-in layer has no settings and takes no writes (decision 0006). Nothing opens this
    // surface on it today — the tree does not draw that root — so this is the type saying what the
    // service would say anyway.
    if (!isWritableLayer(doc.layer)) {
      setParseError("what ships with JaiRA is read-only");
      return;
    }
    context.onSaveConfig(doc.layer, parsed);
  };

  return (
    <div className="file-edit">
      <textarea
        className="code-editor"
        spellCheck={false}
        readOnly={reading}
        value={reading ? authoredText : draft.text}
        onChange={(e) => {
          draft.set(e.target.value);
          setParseError(null);
        }}
      />
      {parseError ? <div className="reason">not valid JSON: {parseError}</div> : null}
      {reading ? (
        <ReadingNote />
      ) : (
        <EditorActions
          dirty={draft.dirty}
          busy={busy}
          onSave={save}
          onRevert={() => {
            draft.revert();
            setParseError(null);
          }}
        />
      )}
    </div>
  );
}


// --- the table ---------------------------------------------------------------

/**
 * Source, coloured and read-only — the code view, as a file surface.
 *
 * The other half of the pair the value viewer has always offered (`RendererId`), which until now was
 * reachable on a fenced block and nowhere else. It is a TEXT renderer like Monaco is: same grammar,
 * same colours, drawn as ordinary DOM by `monaco.editor.colorize` with no editor behind it. What it
 * does not do is write, which is the whole of the difference and why it is a real choice: a file you
 * are only reading cannot be damaged by a stray keystroke, and a selection can be dragged straight
 * through it.
 */
function CodeSourceView({ doc }: FileSurfaceProps): JSX.Element {
  return (
    <div className="file-edit">
      <CodeDocument text={doc.text} mime={doc.mime} />
      {/* Said out loud, in the row the Save button would have been in. A pane that quietly refuses
          typing is a bug from the inside; a pane that says which preference is holding it open in
          this state is a choice, and names the screen where it is taken back. */}
      <div className="pane-actions pinned">
        <span className="sub">Code view — coloured, not an editor. Appearance › File types › text.</span>
      </div>
    </div>
  );
}

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
const MONACO = { id: "monaco", label: "Monaco", note: "a real editor — typing, a caret, its own selection", writes: true, themed: true, look: "code" as const, surface: TextEdit };
const CODEVIEW = { id: "codeview", label: "Code view", note: "coloured, but not an editor — a selection can be dragged through it", themed: true, look: "code" as const, surface: CodeSourceView };

// --- text: the characters as they are on disk ---------------------------------

registerFileSurface("text/plain", "text", MONACO);
registerFileSurface("text/plain", "text", CODEVIEW);

// Markdown, edited in the live preview by default: the marks are drawn as what they mean, which is
// the better surface for prose and the worse one for a document you are treating as source — a table
// you are aligning by hand, front matter you are rewriting. Neither is right for everybody, so both
// are here, and the plain pair follows because a `.md` file is still text.
registerFileSurface("text/markdown", "text", { id: "live", label: "Live preview", note: "CodeMirror, marks drawn as what they mean", writes: true, themed: true, look: "markdown" as const, surface: MarkdownFileEdit });
registerFileSurface("text/markdown", "text", MONACO);
registerFileSurface("text/markdown", "text", CODEVIEW);

// The schema-aware editor, not the plain one: a `.json` file is the one place a picker of known
// document shapes has something to offer. It is a TEXT renderer — it draws the characters, with
// completion and validation over them — which is what the data tree beside it is not.
registerFileSurface("application/json", "text", { id: "schema", label: "Schema-aware", note: "completion and validation against a known shape", writes: true, themed: true, look: "json" as const, surface: JsonEdit });
registerFileSurface("application/json", "text", MONACO);
registerFileSurface("application/json", "text", CODEVIEW);

// ONE text renderer, and deliberately no second: this editor writes through `config:write`, which
// parses and validates the document, and every alternative writes bytes. Offering another here would
// be offering a way to save a settings file that stops the app from opening.
registerFileSurface(CONFIG_JSON, "text", { id: "validated", label: "Validated", note: "parsed and checked before it is written", writes: true, themed: true, look: "json" as const, surface: ConfigEdit });

// --- data: the value the document denotes -------------------------------------

registerFileSurface("application/json", "data", { id: "tree", label: "Data", note: "the value, as a tree", surface: JsonView });
// The same value, as the fields its schema declares — see {@link JsonFormView}. Second rather than
// first, because it is the reading that can decline to draw: a document answering to no schema this
// app knows has no fields, and a default that renders nothing for most `.json` files on disk would
// be a worse default than a tree that always works.
registerFileSurface("application/json", "data", { id: "form", label: "Form", note: "the fields the document's schema declares, in the order it declares them", surface: JsonFormView });
registerFileSurface("application/json", "data", { ...NOTHING, surface: null });
registerFileSurface("application/yaml", "data", { id: "tree", label: "Data", note: "the value, as a tree", surface: YamlView });
registerFileSurface("application/yaml", "data", { ...NOTHING, surface: null });
registerFileSurface("text/csv", "data", { id: "table", label: "Table", note: "rows and columns, rather than the delimiters", surface: DelimitedView });
registerFileSurface("text/csv", "data", { ...NOTHING, surface: null });
registerFileSurface("text/tab-separated-values", "data", { id: "table", label: "Table", note: "rows and columns, rather than the delimiters", surface: DelimitedView });
registerFileSurface("text/tab-separated-values", "data", { ...NOTHING, surface: null });

registerFileSurface(CONFIG_JSON, "data", { id: "effective", label: "Effective", note: "both layers, merged as a run would read them", surface: ConfigEffectiveView });
registerFileSurface(CONFIG_JSON, "data", { ...NOTHING, surface: null });

// The authoring form is a data renderer that WRITES, which is what puts it in the panel's lower half
// rather than its upper one — a state's fields are where the state is written, not a reading of it.
// Choosing `Nothing` here is how you ask for the source instead: the panel falls through to the text
// renderer, which for a JSON state is the schema-aware editor and validates against the same shape.
//
// Registered for JSON states only. A YAML state inherits YAML's data renderers and edits as text —
// the form serialises JSON, and offering it for a document it would rewrite in another syntax is
// worse than offering an editor.
registerFileSurface(WORKFLOW_JSON, "data", { id: "form", label: "Authoring form", note: "fields, with the JSON behind a tab", writes: true, surface: WorkflowEdit });
registerFileSurface(WORKFLOW_JSON, "data", { ...NOTHING, surface: null });

// --- preview: what the document means, rendered -------------------------------

// Markdown reads above the editor that changes it. It used to have no viewer at all, on the argument
// that the live-preview editor IS the rendering, so a second one would be two renderings of one
// document that could disagree. That was true while both were the same thing: markdown turned into
// styled text. It stopped being true when a fenced block became a READING rather than a coloured
// quotation — the viewer draws a ```yaml block as the value viewer, with its toggle, its table for a
// CSV and its diff for a patch, and an editor structurally cannot: those are components, and
// CodeMirror's document is text with decorations over it rather than a place to mount one.
registerFileSurface("text/markdown", "preview", { id: "rendered", label: "Rendered", surface: MarkdownView });
registerFileSurface("text/markdown", "preview", { ...NOTHING, surface: null });

// Any markdown under `workflows/` — each describes the workflow it is named for, and `workflow.md`
// describes the whole layer. Its preview is the sync panel, which keeps the markdown rendering behind
// a toggle; the plain rendering is offered beside it for somebody who writes descriptions far more
// often than they reconcile them. The TEXT renderers come from `text/markdown` through the chain,
// because a description is edited exactly like any other document.
registerFileSurface(WORKFLOW_DESCRIPTION, "preview", { id: "sync", label: "Sync panel", note: "which side has moved, and what to do about it", surface: WorkflowSyncPanel });
registerFileSurface(WORKFLOW_DESCRIPTION, "preview", { id: "rendered", label: "Rendered", surface: MarkdownView });
registerFileSurface(WORKFLOW_DESCRIPTION, "preview", { ...NOTHING, surface: null });

// A page and a drawing both have a rendering, and neither had a viewer — an `.html` in a layer root
// fell all the way to the plain text editor, which is the one surface that cannot show what it is.
registerFileSurface("text/html", "preview", { id: "rendered", label: "Rendered", surface: RenderedFileView });
registerFileSurface("text/html", "preview", { ...NOTHING, surface: null });
registerFileSurface("image/svg+xml", "preview", { id: "drawn", label: "Drawn", surface: RenderedFileView });
registerFileSurface("image/svg+xml", "preview", { ...NOTHING, surface: null });

registerFileSurface("text/x-diff", "preview", { id: "changes", label: "Changes", note: "the edit it describes, not the columns it describes it in", surface: PatchFileSurface });
registerFileSurface("text/x-diff", "preview", { id: "sidebyside", label: "Side by side", note: "the two revisions it is between, in the panes a review uses", themed: true, look: "diff", surface: PatchSideBySide });
registerFileSurface("text/x-diff", "preview", { ...NOTHING, surface: null });

registerFileSurface(WORKFLOW_JSON, "preview", { id: "board", label: "Board", note: "what this state is doing right now", surface: WorkflowRunView });
registerFileSurface(WORKFLOW_JSON, "preview", { ...NOTHING, surface: null });
registerFileSurface(WORKFLOW_YAML, "preview", { id: "board", label: "Board", note: "what this state is doing right now", surface: WorkflowRunView });
registerFileSurface(WORKFLOW_YAML, "preview", { ...NOTHING, surface: null });
