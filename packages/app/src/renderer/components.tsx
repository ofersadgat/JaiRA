/**
 * The six built-in UI components (SPEC §8.1, DESIGN §7.1, docs/engineering/contracts/gate-components.md).
 *
 * Each takes a parsed contract (normalized in the main process) plus the state's
 * resolved inputs, and calls `onSubmit` with a result shaped to land on the
 * state's declared outputs. Nothing here decides whether an answer is *valid* —
 * main re-validates every submission, so this layer is free to be purely about
 * presentation.
 */
import { Suspense, useEffect, useRef, useState, type JSX } from "react";
import {
  artifactOf,
  isComponentName,
  choicesOfConfig,
  choicesOfQuestions,
  diffStrategyFor,
  displayText,
  editorKindOf,
  mimeOfPath,
  type ChooseOptionConfig,
  type ComponentConfig,
  type ComponentName,
  type ConfirmActionConfig,
  type EditArtifactConfig,
  type FillFormConfig,
  type FormField,
  type ApprovalScope,
  type PendingApproval,
  type ModuleApproval,
  type PendingInteraction,
  type PendingQuestion,
  type Change,
  type ReviewArtifactConfig,
  type ReviewArtifactsConfig,
  type ReviewNote,
  type ServedArtifact,
  type ValidateSchemaResult,
} from "@jaira/shared/browser";
import { invoke } from "./store";
import { Icon } from "./icons";
import { docKey, useDraftBox, type DraftBox, type Drafts, type SetDraft } from "./drafts";
import { EditorActions } from "./editorChrome";
import { Markdown } from "./markdown";
import { MarkdownEditor } from "./markdownEditor";
import { SchemaJsonEditor } from "./schemaEditor";
import { answerOf, ChoiceList, ChoiceSteps, EMPTY_ANSWER, submitsOnClick, type Answer } from "./choices";
import { mountChangesetReview, rendererServices, type ComponentServices } from "./changesetReview";
import { ValueView } from "./valueView";
import {
  NoteComposer,
  NoteList,
  reselect,
  useAuthor,
  useFlatText,
  useHoveredNote,
  useNoteHighlights,
  useSelectionInside,
} from "./reviewNotes";

export interface ComponentProps<C extends ComponentConfig> {
  config: C;
  inputs: Record<string, unknown>;
  onSubmit: (value: unknown) => void;
}

/**
 * An authored decision, drawn by the same control an agent's question uses (decision 0002).
 *
 * The state's `options` are a declared enum, so `decision` carries the VALUE; `comments` is
 * `alongside` free text, which is what keeps a single-select answering on the click even with a
 * comment typed. See `choices.tsx` for why the role is what decides that.
 */
function ChooseOption({ config, onSubmit }: ComponentProps<ChooseOptionConfig>): JSX.Element {
  const choices = choicesOfConfig(config);
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const only = choices[0]!;
  const answer = answers[only.question] ?? EMPTY_ANSWER;

  const send = (picked: string | string[]): void => {
    const comments = answer.text.trim();
    onSubmit({ decision: picked, ...(comments === "" ? {} : { comments }) });
  };

  return (
    <>
      <ChoiceList
        choices={choices}
        answers={answers}
        onAnswer={(question, next) => setAnswers((prev) => ({ ...prev, [question]: next }))}
        onImmediate={(_question, value) => send(value)}
      />
      {submitsOnClick(choices, answers) ? null : (
        <div className="options">
          <button className="primary" disabled={answer.picked.length === 0} onClick={() => send(answerOf(only, answer)!)}>
            Confirm
          </button>
        </div>
      )}
    </>
  );
}

/**
 * One artifact, decided (decision 0002).
 *
 * The viewer, the editor and the notes all come from {@link ArtifactPane}, which is the same body
 * `edit_artifact` uses — so the two components have ONE view toggle between them rather than two
 * that drift apart. What is left here is the decision: a `choose_option` over the state's options,
 * and the result shaping.
 *
 * `editable` turns the same pane into a writable one. The point is not to duplicate
 * `edit_artifact` — it is that "approve this, but with this word fixed" is one gesture in a review
 * and two round trips without it, and the edited text rides back as `content`.
 */
function ReviewArtifact({
  config,
  inputs,
  onSubmit,
  serve,
  project,
  requestId,
  editor,
}: ComponentProps<ReviewArtifactConfig> & {
  serve?: ((path: string) => Promise<ServedArtifact>) | undefined;
  project?: string | undefined;
  requestId: string;
  editor?: EditorServices | undefined;
}): JSX.Element {
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [notes, setNotes] = useState<ReviewNote[]>([]);
  const author = useAuthor(project);

  const value = inputs[config.artifact];
  const seed = displayText(value);
  const artifact = artifactOf(value);
  const mime = artifact?.mime ?? (artifact?.path === undefined ? undefined : mimeOfPath(artifact.path));
  const draft = useDraftBox(editor?.drafts, editor?.onDraft, docKey("gate", `${requestId}:${config.artifact}`), seed);

  const comments = (answers[config.prompt] ?? EMPTY_ANSWER).text.trim();
  /**
   * The same rule the plural applies across a set, applied to one artifact (decision 0002).
   *
   * A review with anything written on it is not an approval — it is a round going back — and the
   * button has to say so before it is pressed. The VALUE submitted is still the author's option;
   * only the words change, because which of the author's options this is remains their vocabulary
   * and not this component's to reinterpret.
   */
  const speaking = comments !== "" || notes.length > 0;
  const choices = choicesOfConfig(config);
  /**
   * Which option a send-back submits.
   *
   * The first non-destructive one — the affirmative. Sending work back with notes is not a refusal;
   * it is the ordinary outcome of a review that has something to say, and the plural spells it the
   * same way: comments mean the round is not final, and nothing about that is a rejection.
   */
  const affirmative = choices[0]!.options.find((o) => o.tone !== "danger") ?? choices[0]!.options[0]!;

  const send = (decision: string): void => {
    onSubmit({
      decision,
      ...(comments === "" ? {} : { comments }),
      ...(notes.length > 0 ? { notes } : {}),
      // Only when they actually changed it: content equal to what arrived is not an edit.
      ...(draft.dirty ? { content: draft.text } : {}),
    });
  };

  return (
    <>
      {seed.length === 0 ? (
        <div className="artifact-view" data-testid="artifact">
          <span className="empty">({config.artifact} is empty)</span>
        </div>
      ) : (
        <ArtifactPane
          value={value}
          seed={seed}
          mime={mime}
          draft={draft}
          editable={config.editable === true}
          serve={serve}
          notes={notes}
          onNote={(note) => setNotes((prev) => [...prev, note])}
          onRemoveNote={(i) => setNotes((prev) => prev.filter((_, at) => at !== i))}
          onReply={(i, body) =>
            setNotes((prev) =>
              prev.map((note, at) =>
                at === i ? { ...note, replies: [...(note.replies ?? []), { author, body, at: new Date().toISOString() }] } : note,
              ),
            )
          }
          author={author}
          artifactId={config.artifact}
        />
      )}
      {/* The verdict, in the plural's own words: what pressing the button is about to mean. */}
      <div className="review-summary" data-testid="review-verdict">
        {draft.dirty ? <span className="review-count commented">edited</span> : null}
        {notes.length > 0 ? (
          <span className="review-count commented">
            <Icon name="comment" /> {notes.length === 1 ? "1 note" : `${notes.length} notes`}
          </span>
        ) : null}
        <span className="review-verdict">
          {speaking
            ? "comments left — your decision goes back with them"
            : "no comments — your decision stands on its own"}
        </span>
      </div>
      {/* Comments change the SHAPE of the footer, not only its words — exactly as in the plural.
          A review with notes on it has one outcome: it goes back. Offering "reject" beside "send
          back with comments" asks the reviewer to choose between two things that are not
          alternatives, which is what a row of options reads as. The free-text box is drawn by
          `ChoiceList` above, so it is present in both shapes. */}
      {speaking ? (
        <>
          <ChoiceList
            choices={[{ ...choices[0]!, options: [] }]}
            answers={answers}
            onAnswer={(question, next) => setAnswers((prev) => ({ ...prev, [question]: next }))}
          />
          <div className="options">
            <button className="primary" onClick={() => send(affirmative.value)}>
              Send back with comments
            </button>
          </div>
        </>
      ) : (
        <>
          {/* The decision surface is a `choose_option`, which is what the contract has claimed since
              decision 0002 and what this now literally is. */}
          <ChoiceList
            choices={choices}
            answers={answers}
            onAnswer={(question, next) => setAnswers((prev) => ({ ...prev, [question]: next }))}
            onImmediate={(_question, decision) => send(decision)}
          />
          {submitsOnClick(choices, answers) ? null : (
            <div className="options">
              <button
                className="primary"
                disabled={(answers[config.prompt] ?? EMPTY_ANSWER).picked.length === 0}
                onClick={() => send(answerOf(choices[0]!, answers[config.prompt] ?? EMPTY_ANSWER) as string)}
              >
                Confirm
              </button>
            </div>
          )}
        </>
      )}
    </>
  );
}

/**
 * One artifact, read and — where the state allows it — written, with the review's notes on top.
 *
 * The shared body of `review_artifact` and `edit_artifact`, which is what makes their view toggle
 * ONE toggle rather than two that drift. `ValueView` already owns "how do I want to read this"; this
 * adds the two things a gate needs beside it, in the same header row:
 *
 *  - **Edit**, when the state says the artifact is writable. Absent, this is exactly the viewer.
 *  - **Changes**, once anything has been typed — the edit rendered as a DIFF against what the run
 *    produced, through the same `changes` view the changeset reviewer uses. An edit you cannot see
 *    the shape of is an edit you have to re-read the whole document to check.
 *
 * The diff is built here rather than stored: a synthetic {@link Change} whose `before` is what
 * arrived and whose `after` is the draft, hunked by the registry's strategy for the type. So a JSON
 * artifact diffs structurally and a prose one by line, for free and for the same reason the reviewer
 * does.
 */
/**
 * What `edit_artifact` needs from the shell to be the app's editor rather than a textarea.
 *
 * A separate bag from `services` (the changeset gate's §8.2 contract) because these are different
 * capabilities for a different component, and one prop named `services` meaning two unrelated
 * things is how a contract stops being one. Every field optional: a dialog rendered without them
 * still edits, it just keeps its draft locally and offers no schema checking.
 */
export interface EditorServices {
  drafts?: Drafts | undefined;
  onDraft?: SetDraft | undefined;
  /** Check a draft against a registered schema — what turns the JSON editor's picker on. */
  validateSchema?: ((schemaId: string, text: string) => Promise<ValidateSchemaResult | null>) | undefined;
  wrapJson?: boolean | undefined;
  onWrapJson?: ((wrap: boolean) => void) | undefined;
}

/**
 * One artifact: read it, write it, and see what you changed — without ever swapping components.
 *
 * Two controls were removed from here on the way to this shape, for the same reason each time. A
 * Read/Write pair beside `ValueView`'s Rendered/Source pair asked the same person the same kind of
 * question twice; a Document/Changes pair asked about something derivable. What is left is a value
 * viewer that happens to be editable and happens to know what changed.
 */
export function ArtifactPane({
  value,
  seed,
  mime,
  draft,
  editable,
  serve,
  notes,
  onNote,
  onRemoveNote,
  onReply,
  author,
  artifactId,
}: {
  /** What the run produced, as it arrived — what `ValueView` reads and the diff's `before`. */
  value: unknown;
  /** The same thing as text. */
  seed: string;
  mime: string | undefined;
  draft: DraftBox;
  editable: boolean;
  serve?: ((path: string) => Promise<ServedArtifact>) | undefined;
  notes: readonly ReviewNote[];
  /** Absent ⇒ this pane takes no notes (an editor rather than a review). */
  onNote?: ((note: ReviewNote) => void) | undefined;
  onRemoveNote?: ((index: number) => void) | undefined;
  onReply?: ((index: number, body: string) => void) | undefined;
  author: string;
  artifactId: string;
}): JSX.Element {
  const well = useRef<HTMLDivElement>(null);
  const [selection, clearSelection] = useSelectionInside(well);
  const flatText = useFlatText(well);
  /** Lit by the pointer being over the PASSAGE; `hotThread` by it being over the thread. */
  const hovered = useHoveredNote(well, notes);
  const [hotThread, setHotThread] = useState<number | null>(null);
  useNoteHighlights(well, notes, hovered ?? hotThread);

  /**
   * Which reading is on screen — DERIVED, not chosen.
   *
   * There was a Document/Changes pair here, and it was a control for something nobody has an opinion
   * about: having just typed, you want to see what you typed, and having undone it there is nothing
   * to see. Both answers follow from whether an edit exists, so the toggle only ever restated what
   * the document already said.
   */
  const dirty = draft.dirty;
  // Markdown can show a change without leaving the document, so it never switches views at all.
  // Everything else falls back to the changes reading, which is a different component.
  const prose = editorKindOf(mime, seed) === "markdown";

  const change: Change = {
    id: artifactId,
    path: artifactId,
    action: "update",
    before: seed,
    after: draft.text,
    hunks: diffStrategyFor(mime ?? "text/plain").hunks(seed, draft.text),
  };

  // Reverting is the way back to the document, so it is the only control the changes view needs.
  const actions = dirty ? (
    <button className="ghost" title="throw away what you typed" onClick={draft.revert}>
      Revert
    </button>
  ) : undefined;

  return (
    <>
      <div className="artifact-view" data-testid="artifact" ref={well}>
        {/* ONE `ValueView`, whatever the state of the edit.
            It used to swap to a diff viewer the moment `dirty` went true, which re-mounted the
            editor on the first keystroke and took the caret with it — every second character
            landed nowhere. The change is handed DOWN instead: the markdown view draws it over the
            document it is already editing, and nothing about the component tree changes. */}
        {prose ? (
          <ValueView
            value={draft.text}
            hint={mime === undefined ? undefined : { mime }}
            actions={actions}
            serve={serve}
            {...(editable ? { edit: draft.set } : {})}
            {...(dirty ? { diff: { before: seed, after: draft.text, hunks: change.hunks ?? [] } } : {})}
          />
        ) : dirty ? (
          <ValueView value={{ changes: [change] }} actions={actions} />
        ) : (
          <ValueView
            value={value}
            hint={mime === undefined ? undefined : { mime }}
            actions={actions}
            serve={serve}
            {...(editable ? { edit: draft.set } : {})}
          />
        )}
      </div>

      {selection !== null && onNote !== undefined ? (
        <NoteComposer
          selection={selection}
          author={author}
          onCancel={clearSelection}
          onSave={(body) => {
            onNote({
              artifact: artifactId,
              quote: selection.quote,
              range: { start: selection.start, end: selection.end },
              body,
              author,
              at: new Date().toISOString(),
            });
            window.getSelection()?.removeAllRanges();
            clearSelection();
          }}
        />
      ) : null}

      {onRemoveNote !== undefined ? (
        <NoteList
          notes={notes}
          text={flatText}
          author={author}
          hovered={hovered ?? hotThread}
          onHover={setHotThread}
          onReselect={(note) => reselect(well.current, note)}
          onReply={onReply}
          onRemove={onRemoveNote}
        />
      ) : null}
    </>
  );
}

/**
 * A person edits what the run produced (decision 0002).
 *
 * The same {@link ArtifactPane} `review_artifact` shows, permanently in its writable state and with
 * no decision under it — which is the whole difference between the two components. Everything the
 * editor gained by joining the app's stack is here: the type-chosen editor, a draft that survives
 * being unmounted, Revert meaning "throw away what I typed", and a Changes view of what you did.
 */
function EditArtifact({
  config,
  inputs,
  onSubmit,
  serve,
  project,
  requestId,
  editor,
}: ComponentProps<EditArtifactConfig> & {
  serve?: ((path: string) => Promise<ServedArtifact>) | undefined;
  project?: string | undefined;
  /** What keys the draft: the REQUEST, so two gates open at once do not share one buffer. */
  requestId: string;
  editor?: EditorServices | undefined;
}): JSX.Element {
  const value = config.source === undefined ? undefined : inputs[config.source];
  const seed = value === undefined ? "" : displayText(value);
  const artifact = artifactOf(value);
  const mime = artifact?.mime ?? (artifact?.path === undefined ? undefined : mimeOfPath(artifact.path));
  const draft = useDraftBox(editor?.drafts, editor?.onDraft, docKey("gate", `${requestId}:${config.source ?? ""}`), seed);
  const author = useAuthor(project);

  // Nothing to type into: a picture, a sound, a video. Show it and say so, rather than offering a
  // textarea full of base64 — and still submit, because the gate is parked until it gets a value.
  if (editorKindOf(mime, seed) === "readonly") {
    return (
      <>
        <div className="artifact-view" data-testid="artifact">
          <ValueView value={value} serve={serve} />
        </div>
        <p className="reason-note">
          This is {mime ?? "not text"}, so there is nothing here to type into. Submitting hands it back unchanged.
        </p>
        <div className="options">
          <button className="primary" onClick={() => onSubmit({ content: seed })}>
            Done
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <ArtifactPane
        value={value}
        seed={seed}
        mime={mime}
        draft={draft}
        editable
        serve={serve}
        notes={[]}
        author={author}
        artifactId={config.source ?? "content"}
      />
      {/* `dirty || undefined`, deliberately. `EditorActions` disables Save on `dirty === false`,
          which is right for a FILE — there is nothing to write — and wrong for a gate, where
          handing the text back unchanged is a normal answer and the run is parked until one
          arrives. `undefined` is the prop's own spelling of "the host does not track this".

          No `onRevert`: the pane's own header already carries one, beside the thing being reverted.
          Two buttons with the same name and the same effect is one of them being noise. */}
      <EditorActions dirty={draft.dirty || undefined} onSave={() => onSubmit({ content: draft.text })} />
    </>
  );
}

/** Initial value for a field: its authored default, else an empty-ish value. */
function seedValue(field: FormField): unknown {
  if (field.default !== undefined) return field.default;
  switch (field.type) {
    case "boolean":
      return false;
    case "enum":
      return field.enum?.[0] ?? "";
    case "number":
      return "";
    default:
      return "";
  }
}

function FillForm({ config, onSubmit }: ComponentProps<FillFormConfig>): JSX.Element {
  const [values, setValues] = useState<Record<string, unknown>>(() =>
    Object.fromEntries(config.fields.map((f) => [f.name, seedValue(f)])),
  );
  const set = (name: string, value: unknown): void => setValues((v) => ({ ...v, [name]: value }));

  return (
    <>
      {config.fields.map((field) => (
        <label className="field" key={field.name}>
          <span>
            {field.label ?? field.name}
            {field.optional ? " (optional)" : ""}
          </span>
          {field.type === "boolean" ? (
            <input
              type="checkbox"
              checked={values[field.name] === true}
              onChange={(e) => set(field.name, e.target.checked)}
            />
          ) : field.type === "enum" ? (
            <select value={String(values[field.name] ?? "")} onChange={(e) => set(field.name, e.target.value)}>
              {(field.enum ?? []).map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          ) : field.multiline ? (
            <textarea rows={4} value={String(values[field.name] ?? "")} onChange={(e) => set(field.name, e.target.value)} />
          ) : (
            <input
              type={field.type === "number" ? "number" : "text"}
              value={String(values[field.name] ?? "")}
              onChange={(e) => set(field.name, e.target.value)}
            />
          )}
          {field.description ? <small>{field.description}</small> : null}
        </label>
      ))}
      <div className="options">
        <button
          onClick={() => {
            // Coerce number fields once, here: an <input type="number"> hands back a
            // string, and main validates types strictly.
            const payload: Record<string, unknown> = {};
            for (const field of config.fields) {
              const raw = values[field.name];
              if (field.type === "number") {
                if (raw === "" || raw === undefined) continue;
                payload[field.name] = typeof raw === "number" ? raw : Number(raw);
              } else {
                payload[field.name] = raw;
              }
            }
            onSubmit(payload);
          }}
        >
          Submit
        </button>
      </div>
    </>
  );
}

function ConfirmAction({ config, onSubmit }: ComponentProps<ConfirmActionConfig>): JSX.Element {
  return (
    <div className="options">
      <button onClick={() => onSubmit({ confirmed: true })}>{config.confirmLabel}</button>
      <button className="ghost" onClick={() => onSubmit({ confirmed: false })}>
        {config.cancelLabel}
      </button>
    </div>
  );
}

/**
 * Host a component that MOUNTS ITSELF (CHANGESETS.md §8.1). The contract is a mount function, not a
 * React element — the caller owns the node, the component owns everything inside it, and the caller
 * can be a pane, a modal, or a second window without the component knowing. This wrapper is what
 * lets the existing React shell be one such caller.
 *
 * Remounts on `mountKey`, never on the callback's identity: `mount` is an inline closure at every
 * call site, so depending on it would tear the component down on every shell render — a reviewer
 * losing its half-made decisions each time a stream delta arrives. The key names the REQUEST, which
 * is the thing whose change genuinely means "different review".
 */
function MountHost({ mount, mountKey }: { mount: (node: HTMLElement) => () => void; mountKey: string }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const latest = useRef(mount);
  latest.current = mount;
  useEffect(() => {
    const node = ref.current;
    if (node === null) return undefined;
    return latest.current(node);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mountKey]);
  return <div className="mount-host" ref={ref} />;
}

/**
 * The changeset gate as a hostable element — exported because it has TWO hosts (§8.1's point): the
 * gate modal below, and the reviewed task's conversation view. `about` scopes `$WORKTREE` reads to
 * the reviewed task; `project` says which project's anchors every read resolves against (see
 * `PendingInteraction.subjectProject` — a review is parked in JaiRA's own project and is about
 * another's, so the two are different projects and the reads want the second one);
 * `services` lets a host with more reach (the app shell has `drafts` and `openFile`; this module has
 * neither) supply what it can.
 */
export function ChangesetGate({
  config,
  inputs,
  onSubmit,
  about,
  project,
  services,
  mountKey,
}: ComponentProps<ReviewArtifactsConfig> & {
  about?: string | undefined;
  project?: string | undefined;
  services?: Partial<ComponentServices> | undefined;
  /** The request id — what makes this a DIFFERENT review. See {@link MountHost}. */
  mountKey: string;
}): JSX.Element {
  // The identity is resolved HERE and passed in, because §8.2 says a self-mounting component gets
  // its capabilities rather than reaching for the bridge — and because a hook cannot live inside a
  // component that owns its own React root.
  const author = useAuthor(project);
  return (
    <MountHost
      // The author is part of the key: `mount` is captured at mount time, so a name that arrives a
      // render later would never reach the mounted component otherwise. `useAuthor` caches per
      // session, so this costs one remount on the very first review and none after.
      mountKey={`${mountKey}:${author}`}
      mount={(node) =>
        mountChangesetReview(node, {
          config,
          inputs,
          services: {
            ...rendererServices((channel, request) => invoke(channel, request), {
              ...(about !== undefined ? { taskId: about } : {}),
              ...(project !== undefined ? { project } : {}),
            }),
            author,
            ...(services ?? {}),
          },
          onSubmit,
        })
      }
    />
  );
}

/** Fallback for a gate whose function is not one of the built-ins. */
function RawJson({ onSubmit }: { onSubmit: (value: unknown) => void }): JSX.Element {
  const [text, setText] = useState("");
  return (
    <>
      <label className="field">
        <span>Response (JSON)</span>
        <textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
      </label>
      <div className="options">
        <button
          onClick={() => {
            try {
              onSubmit(JSON.parse(text) as unknown);
            } catch {
              onSubmit(text);
            }
          }}
        >
          Submit
        </button>
      </div>
    </>
  );
}

/**
 * A glyph per component, shown beside its NAME in the dialog's sub-line.
 *
 * Beside the name rather than in the heading: the heading is the author's prompt, in their words,
 * and a picture next to a sentence is decoration. The sub-line already says `review_artifact` in
 * wire spelling, which is exactly the kind of label a glyph makes findable at a glance.
 */
const COMPONENT_ICON: Record<ComponentName, Parameters<typeof Icon>[0]["name"]> = {
  choose_option: "choice",
  review_artifact: "read",
  review_artifacts: "files",
  edit_artifact: "pencil",
  fill_form: "form",
  confirm_action: "check",
};

/**
 * The gate dialog: dispatches on the parsed component contract. This modal is the
 * only path by which a human decision enters a run (SPEC §11.4) — it reaches the
 * engine through `interaction:submit`, which nothing inside a workflow can call.
 */
export function InteractionDialog({
  pending,
  error,
  onSubmit,
  services,
  editor,
}: {
  pending: PendingInteraction;
  error?: string | null;
  onSubmit: (value: unknown) => void;
  /** Extra reach for components that mount themselves — see {@link ChangesetGate}. */
  services?: Partial<ComponentServices>;
  /** What `edit_artifact` needs to be the app's editor — see {@link EditorServices}. */
  editor?: EditorServices | undefined;
}): JSX.Element {
  const config = pending.config;
  const inputs = pending.inputs as Record<string, unknown>;
  // The same join `ChangesetGate` makes, for the same reason: a review is parked in one project and
  // is ABOUT a task in another, and a grant is minted against the task that produced the artifact.
  const subject = pending.about ?? pending.taskId;
  const subjectProject = pending.subjectProject ?? pending.project;
  const serve = (path: string): Promise<ServedArtifact> =>
    invoke("artifact:serve", { taskId: subject, path, ...(subjectProject !== undefined ? { project: subjectProject } : {}) });
  const body = ((): JSX.Element => {
    if (pending.configError !== undefined) {
      return (
        <p className="reason">
          This state&apos;s <code>{pending.component}</code> config is invalid: {pending.configError}
        </p>
      );
    }
    switch (config?.component) {
      case "choose_option":
        return <ChooseOption config={config} inputs={inputs} onSubmit={onSubmit} />;
      case "review_artifact":
        return (
          <ReviewArtifact
            config={config}
            inputs={inputs}
            onSubmit={onSubmit}
            serve={serve}
            project={subjectProject}
            requestId={pending.requestId}
            editor={editor}
          />
        );
      case "edit_artifact":
        return (
          <EditArtifact
            config={config}
            inputs={inputs}
            onSubmit={onSubmit}
            serve={serve}
            project={subjectProject}
            requestId={pending.requestId}
            editor={editor}
          />
        );
      case "fill_form":
        return <FillForm config={config} inputs={inputs} onSubmit={onSubmit} />;
      case "confirm_action":
        return <ConfirmAction config={config} inputs={inputs} onSubmit={onSubmit} />;
      case "review_artifacts":
        return (
          <ChangesetGate
            config={config}
            inputs={inputs}
            onSubmit={onSubmit}
            about={pending.about}
            project={pending.subjectProject ?? pending.project}
            services={services}
            mountKey={pending.requestId}
          />
        );
      default:
        return <RawJson onSubmit={onSubmit} />;
    }
  })();

  // A multi-file review is far too big for the gate modal (CHANGESETS.md §11's rejected modal
  // reviewer) — the same host widens for it, which is the caller exercising the room §8.1 gives it.
  const wide =
    config?.component === "review_artifacts" ||
    config?.component === "edit_artifact" ||
    config?.component === "review_artifact";

  return (
    <div className="modal-backdrop">
      <div className={wide ? "modal modal-wide" : "modal"} data-testid="interaction">
        {/* The glyph belongs to the TITLE, and the title is the author's question.
            It used to sit on the line below, beside the component's wire name — which put a picture
            next to `review_artifact`, a string that means nothing to the person answering, and left
            the heading bare. The wire name is gone from here entirely for the same reason: which
            function is running is a fact about the implementation. */}
        <h3>
          {isComponentName(pending.component) ? (
            <Icon name={COMPONENT_ICON[pending.component]} className="gate-icon" />
          ) : null}{" "}
          {config?.prompt ?? pending.component}
        </h3>
        {/* No sub-line at all. It carried the function name (an implementation fact) and then the
            task id (an opaque rowid) — neither is something the person answering the question needs,
            and both sat between the question and its answers. */}
        {body}
        {error ? <p className="reason">{error}</p> : null}
      </div>
    </div>
  );
}

/**
 * The per-command approval dialog (DESIGN §10.2).
 *
 * Distinct from a workflow gate: policy escalated a *tool call*, so what the user
 * judges is a command, and the answer carries a SCOPE — the reason they are not
 * asked the same thing on every call. The scope buttons widen left to right, with
 * deny kept visually separate so the destructive-looking choice is not the easy
 * mis-click.
 */
export function ApprovalDialog({
  pending,
  error,
  onDecide,
}: {
  pending: PendingApproval;
  error?: string | null;
  onDecide: (decision: "allow" | "deny", scope: ApprovalScope) => void;
}): JSX.Element {
  const detail = JSON.stringify(pending.input, null, 2);
  return (
    <div className="modal-backdrop">
      <div className="modal" data-testid="approval">
        <h3>
          <Icon name="shield" className="gate-icon" /> Approve this command?
        </h3>
        <div className="sub">
          {pending.tool}
          {pending.taskId ? ` · ${pending.taskId}` : ""}
        </div>

        {pending.command !== undefined ? (
          <pre className="artifact" data-testid="approval-command">
            {pending.command}
          </pre>
        ) : (
          <pre className="artifact">{detail}</pre>
        )}

        {pending.reason !== undefined ? <p className="reason-note">Policy: {pending.reason}</p> : null}

        <div className="options">
          <button onClick={() => onDecide("allow", "once")}>Allow once</button>
          <button onClick={() => onDecide("allow", "workflow-run")}>Allow for this run</button>
          <button onClick={() => onDecide("allow", "always")}>Always allow</button>
        </div>
        <div className="options">
          <button className="danger" onClick={() => onDecide("deny", "once")}>
            Deny
          </button>
        </div>
        {error ? <p className="reason">{error}</p> : null}
      </div>
    </div>
  );
}

/**
 * The js/ts modules a workflow calls, before it is allowed to call them (SPEC §7.5.5).
 *
 * Not the {@link ApprovalDialog}, and the difference is worth keeping visible. That one authorizes
 * ONE command a model just proposed, mid-run, and its answer expires with the run. This one is asked
 * before anything has started, about source sitting on disk, and its answer is durable — approving
 * writes a machine-local record that outlives the task. So there is no "allow once" here: the
 * question is whether this code may run on this machine, and "yes, but only this time" is not an
 * answer that record can hold.
 *
 * The source is shown in full rather than summarized. A prompt that asks whether to run code without
 * showing it is a rubber stamp, and `previousHash` is what tells the reader which question they are
 * being asked: an unapproved file is "should this run at all", a changed one is "here is what moved
 * since you last said yes".
 */
export function ModuleApprovalDialog({
  files,
  error,
  onApprove,
  onCancel,
}: {
  files: readonly ModuleApproval[];
  error?: string | null;
  onApprove: () => void;
  onCancel: () => void;
}): JSX.Element {
  const changed = files.filter((f) => f.previousHash !== undefined).length;
  return (
    <div className="modal-backdrop">
      <div className="modal modal-wide" data-testid="module-approval">
        <h3>
          <Icon name="shield" className="gate-icon" /> Run this workflow&apos;s TypeScript?
        </h3>
        <div className="sub">
          {files.length === 1 ? "1 file" : `${files.length} files`}
          {changed > 0 ? ` · ${changed} changed since you approved it` : ""} · nothing has run yet
        </div>

        {files.map((file) => (
          <div key={file.file}>
            <div className="sub">
              {file.file} —{" "}
              {file.previousHash !== undefined ? "changed since you approved it" : "never approved"}
              {/* What the workflow actually CALLS out of this file. Absent for a file reached only as
                  an import of another, where there is no call site to name. */}
              {file.symbols !== undefined && file.symbols.length > 0 ? ` · calls ${file.symbols.join(", ")}` : ""}
            </div>
            <pre className="artifact">{file.source}</pre>
          </div>
        ))}

        <div className="options">
          <button onClick={onApprove}>Approve and run</button>
          <button className="danger" onClick={onCancel}>
            Cancel
          </button>
        </div>
        {error ? <p className="reason">{error}</p> : null}
      </div>
    </div>
  );
}

/**
 * A running agent's question (`AskUserQuestion`) — the third dialog, and deliberately NOT the
 * approval one: nothing here is being authorized. The agent asked something and the options are its
 * own; the answer travels back as the tool's input, so the choices are labels, not verdicts.
 *
 * One question with a single choice submits on click — the common case reads as one tap. Multiple
 * questions (or a multi-select, or a typed "other") collect first and submit together, because a
 * batch is one tool call and half an answer is not a thing the wire can carry.
 */
/**
 * A running agent's question — the SAME control as an authored gate, with the answer going
 * somewhere else (decision 0002).
 *
 * Nothing here is being authorized: the options are the agent's own words and the answer travels
 * back as its tool input, so the choices are labels rather than verdicts and a question is answered,
 * never approved.
 *
 * Dismissal is the one affordance a gate does not get. An agent continues either way — told to use
 * its own judgment — where a gate's state has declared outputs that must receive a value.
 */
export function QuestionDialog({
  pending,
  error,
  onSubmit,
}: {
  pending: PendingQuestion;
  error?: string | null;
  /** `undefined` dismisses: the agent is told to use its own judgment and continue. */
  onSubmit: (answers: Record<string, string | string[]> | undefined) => void;
}): JSX.Element {
  const choices = choicesOfQuestions(pending.questions);
  const [answers, setAnswers] = useState<Record<string, Answer>>({});

  const complete = choices.every((c) => answerOf(c, answers[c.question] ?? EMPTY_ANSWER) !== undefined);
  const submit = (): void => {
    const out: Record<string, string | string[]> = {};
    for (const choice of choices) {
      const answer = answerOf(choice, answers[choice.question] ?? EMPTY_ANSWER);
      if (answer !== undefined) out[choice.question] = answer;
    }
    onSubmit(out);
  };
  const immediate = submitsOnClick(choices, answers);
  const dismiss = (
    <button className="danger" onClick={() => onSubmit(undefined)}>
      Let the agent decide
    </button>
  );

  return (
    <div className="modal-backdrop">
      <div className="modal" data-testid="question">
        <h3>
          <Icon name="comment" className="gate-icon" />{" "}
          {choices.length === 1 ? "The agent has a question" : "The agent has questions"}
        </h3>
        {pending.taskId !== undefined ? <div className="sub">{pending.taskId}</div> : null}
        {/* With one question the heading says only that there IS one, so the question itself has to
            be printed. The stepped view prints its own. */}
        {choices.length === 1 ? <p className="question-text">{choices[0]!.question}</p> : null}
        {choices.length > 1 ? (
          <ChoiceSteps
            choices={choices}
            answers={answers}
            onAnswer={(question, next) => setAnswers((prev) => ({ ...prev, [question]: next }))}
            onSubmit={submit}
            extra={dismiss}
          />
        ) : (
          <>
            <ChoiceList
              choices={choices}
              answers={answers}
              onAnswer={(question, next) => setAnswers((prev) => ({ ...prev, [question]: next }))}
              onImmediate={(question, value) => onSubmit({ [question]: value })}
            />
            <div className="options">
              {immediate ? null : (
                <button className="primary" disabled={!complete} onClick={submit}>
                  Answer
                </button>
              )}
              {dismiss}
            </div>
          </>
        )}
        {error ? <p className="reason">{error}</p> : null}
      </div>
    </div>
  );
}
