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
import { useEffect, useMemo, useState, type JSX } from "react";
import { parse as parseYaml } from "yaml";
import {
  CONFIG_JSON,
  WORKFLOW_DESCRIPTION,
  WORKFLOW_JSON,
  WORKFLOW_YAML,
  type WorkflowSource,
} from "@jaira/shared/browser";
import { Badge } from "./board";
import { CompositeView } from "./runViews";
import { entriesOf, journalFor } from "./transcript";
import { Paper, Transcript } from "./transcriptView";
import { docKey, useDraftBox } from "./drafts";
import { EditorActions } from "./editorChrome";
import { registerFileSurface, type FileSurfaceProps } from "./fileTypes";
import { MarkdownView } from "./markdown";
import { SchemaJsonEditor, schemaReferenceProps } from "./schemaEditor";
import { WorkflowEditor } from "./stateEditor";
import { WorkflowSyncPanel } from "./syncPanel";

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
export function TextEdit({ doc, busy, onSave, context }: FileSurfaceProps): JSX.Element {
  const draft = useDraftBox(context.drafts, context.onDraft, docKey(doc.layer, doc.path), doc.text);

  return (
    <div className="file-edit">
      <textarea
        className="code-editor"
        spellCheck={false}
        value={draft.text}
        onChange={(e) => draft.set(e.target.value)}
      />
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
    </div>
  );
}

// --- structured data ---------------------------------------------------------

/** One node of a parsed document. Objects and arrays nest; everything else is a leaf. */
function Node({ name, value }: { name: string | null; value: unknown }): JSX.Element {
  const label = name === null ? null : <span className="doc-key">{name}</span>;

  if (value !== null && typeof value === "object") {
    const entries: Array<[string, unknown]> = Array.isArray(value)
      ? value.map((entry, i) => [String(i), entry])
      : Object.entries(value as Record<string, unknown>);
    return (
      <li>
        {label}
        <span className="sub">
          {Array.isArray(value) ? `[${entries.length}]` : `{${entries.length}}`}
        </span>
        {entries.length > 0 ? (
          <ul className="doc-tree">
            {entries.map(([key, entry]) => (
              <Node key={key} name={key} value={entry} />
            ))}
          </ul>
        ) : null}
      </li>
    );
  }

  return (
    <li>
      {label}
      <code className={`doc-value doc-${value === null ? "null" : typeof value}`}>{JSON.stringify(value)}</code>
    </li>
  );
}

/**
 * A structured document, read rather than edited.
 *
 * The value of a viewer over a text editor for JSON is small but real: nesting you can follow, and
 * a parse error stated once at the top instead of discovered on save. `parse` is passed in because
 * JSON and YAML differ in exactly one function and in nothing else about how they should be read.
 */
function StructuredView({ text, parse }: { text: string; parse: (text: string) => unknown }): JSX.Element {
  if (text.trim().length === 0) return <p className="empty">This file is empty.</p>;
  let parsed: unknown;
  try {
    parsed = parse(text);
  } catch (e) {
    return <div className="notice bad">does not parse: {(e as Error).message}</div>;
  }
  return (
    <ul className="doc-tree doc-root">
      <Node name={null} value={parsed} />
    </ul>
  );
}

export function JsonView({ doc }: FileSurfaceProps): JSX.Element {
  return <StructuredView text={doc.text} parse={(text) => JSON.parse(text) as unknown} />;
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
  const chosen = context.schemaChoice[key];

  /**
   * Fill the picker from the document the first time this file is opened.
   *
   * Only when nothing has been decided — `chosen` absent, not `""`. The result is RECORDED as the
   * choice, including a miss (`""`), so this asks once per file rather than on every keystroke, and
   * so editing the document afterwards cannot pull the picker out from under the author.
   *
   * Detection reads `doc.text`, the file as it is on disk, rather than the draft: what schema a file
   * IS should not change while it is half-typed.
   */
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

  return (
    <SchemaJsonEditor
      text={draft.text}
      busy={busy}
      dirty={draft.dirty}
      onChange={draft.set}
      onSave={() => onSave(draft.text)}
      onRevert={draft.revert}
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
  return <StructuredView text={doc.text} parse={(text) => parseYaml(text) as unknown} />;
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
  const entries = useMemo(
    () => entriesOf(session, journalFor(conversation?.turns ?? [], state?.stateId), liveTurn?.text ?? null),
    [session, conversation, state?.stateId, liveTurn],
  );
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
            <span className="grow ellip">{card.title}</span>
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
                <span className="grow ellip">{card.title}</span>
              </div>
            ))}
          </>
        ) : null}
      </div>
      <div className="leaf-convo scroll">
        <Paper>
          <Transcript
            session={session}
            entries={entries}
            empty={selected === null ? "Select a run to see what it said." : undefined}
          />
        </Paper>
        {waiting ? (
          // Pinned rather than in the flow: it is the one turn that is not history, and scrolling
          // away from the thing blocking the run is exactly the wrong behaviour.
          <div className="waiting-on">
            <Badge status="waiting_for_user" />
            <span className="grow">Waiting on you — {waiting.component}</span>
            {onAnswer ? <button onClick={onAnswer}>Answer</button> : null}
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
  if (doc.stateId === undefined) return <p className="empty">This file does not name a state.</p>;
  const source: WorkflowSource = {
    stateId: doc.stateId,
    layer: doc.layer,
    file: doc.file,
    text: doc.text,
    exists: doc.exists,
  };
  return (
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
        ? { tab: context.editorTab?.[key] ?? "form", onTab: (next: "form" | "json") => context.onEditorTab?.(key, next) }
        : {})}
      onSave={(_stateId, _layer, text) => onSave(text)}
    />
  );
}

// --- configuration -----------------------------------------------------------

/**
 * `config.json`, seen as what it actually decides.
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
      <ul className="doc-tree doc-root">
        <Node name={null} value={context.config.effective} />
      </ul>
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
    context.onSaveConfig(doc.layer, parsed);
  };

  return (
    <div className="file-edit">
      <textarea
        className="code-editor"
        spellCheck={false}
        value={draft.text}
        onChange={(e) => {
          draft.set(e.target.value);
          setParseError(null);
        }}
      />
      {parseError ? <div className="reason">not valid JSON: {parseError}</div> : null}
      <EditorActions
        dirty={draft.dirty}
        busy={busy}
        onSave={save}
        onRevert={() => {
          draft.revert();
          setParseError(null);
        }}
      />
    </div>
  );
}

// --- the table ---------------------------------------------------------------

registerFileSurface("text/plain", "edit", TextEdit);

registerFileSurface("text/markdown", "view", MarkdownView);
registerFileSurface("text/markdown", "edit", TextEdit);

// Any markdown under `workflows/` — each describes the workflow it is named for, and `workflow.md`
// describes the whole layer. The viewer is the sync panel, which keeps the markdown preview behind a
// toggle; the editor comes from `text/markdown` through the fallback chain, because the description
// is edited exactly like any other document — which is what makes a proposed rewrite something you
// can retype before saving.
registerFileSurface(WORKFLOW_DESCRIPTION, "view", WorkflowSyncPanel);

registerFileSurface("application/json", "view", JsonView);
// The schema-aware editor, not the plain one: a `.json` file is the one place a picker of known
// document shapes has something to offer. Everything else still reaches TextEdit through the chain.
registerFileSurface("application/json", "edit", JsonEdit);

registerFileSurface("application/yaml", "view", YamlView);
registerFileSurface("application/yaml", "edit", TextEdit);

registerFileSurface(WORKFLOW_JSON, "view", WorkflowRunView);
registerFileSurface(WORKFLOW_JSON, "edit", WorkflowEdit);

// The board on top, and — through the `+yaml` fallback — the YAML editor below. See {@link WorkflowEdit}.
registerFileSurface(WORKFLOW_YAML, "view", WorkflowRunView);

registerFileSurface(CONFIG_JSON, "view", ConfigEffectiveView);
registerFileSurface(CONFIG_JSON, "edit", ConfigEdit);
