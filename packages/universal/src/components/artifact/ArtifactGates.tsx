import { useMemo, useState, type JSX } from "react";
import { View } from "@tamagui/core";
import { choicesOfConfig, editorKindOf, type EditArtifactConfig, type PendingInteraction, type ReviewArtifactConfig, type ReviewArtifactsConfig, type ReviewNote, type ServedArtifact } from "@jaira/shared/browser";
import type { JsonValue } from "@declarative-ai/json";
import { gateServices, type ComponentServices } from "@jaira/ui/changesetReviewModel";
import { invoke } from "@jaira/ui/store";
import { EMPTY_ANSWER, answerOf, answersOfValue, submitsOnClick, type Answer } from "@jaira/ui/choices";
import { docKey, useDraftBox } from "@jaira/ui/drafts";
import { artifactShapeOf, notesCount, recordedDraft, reviewAnswerOf, reviewVerdictOf } from "@jaira/ui/artifactReview";
import { useAuthor } from "@jaira/ui/reviewSelection";
import { Txt } from "../../primitives";
import { useTokens } from "../../tokens";
import { EditorActions } from "../files/EditorActions";
import { ChoiceList } from "../floats/Choices";
import { Icon } from "../panel/Icon";
import { ValueView } from "../panel/ValueView";
import { Button } from "../settings/Button";
import { ArtifactPane, ArtifactWell } from "./ArtifactPane";
import { ChangesetReview } from "./ChangesetReview";

/**
 * `components.tsx`'s `ReviewArtifact` and `EditArtifact`, universal (decision 0015): an artifact shown
 * beside the decision about it, and an artifact handed back edited. The verdict's words, whether a review
 * with something written on it collapses to one "send back" button, and the answer's shape are
 * `artifactReview.ts`'s, the desktop's own. The rules, from `styles.css`:
 *
 *   .review-summary    row, wrapping, baseline, gap 10, 8 above, --dim, the body's 13/12.5
 *   .review-count      inline-flex, centred, gap 5, the glyph 13; `.commented` --warn
 *   .review-verdict    the whole line, italic
 *   .options           row, wrapping, gap 8, 14 above
 *   .reason-note       --warn, app 12/12.5, 10 above
 *
 * `flat`: the host is a flex column (the gallery's wide modal), where no margin collapses — the
 * question block's options keep their 12 inside it.
 *
 * `serve`: how an interactive artifact under review is served to its frame (`serveOfGate`).
 *
 * `settled`: the gate as it was answered (`components.tsx`'s `settled`) — seeded with the value that came
 * back and every control inert: the notes as written, the artifact as edited (`recordedDraft`, so an
 * edit shows as the change it was), the decision lit.
 */
export function ReviewArtifactGate({ config, inputs, onSubmit, requestId, project, flat, settled, serve }: { config: ReviewArtifactConfig; inputs: Record<string, unknown>; onSubmit: (value: unknown) => void; requestId: string; project: string | undefined; flat: boolean; settled?: { value: unknown } | undefined; serve?: ((path: string) => Promise<ServedArtifact>) | undefined }): JSX.Element {
  const t = useTokens();
  const recorded = recordOf(settled?.value);
  const [answers, setAnswers] = useState<Record<string, Answer>>(() => (settled !== undefined ? answersOfValue(choicesOfConfig(config), settled.value as never) : {}));
  const [notes, setNotes] = useState<ReviewNote[]>(() => (Array.isArray(recorded["notes"]) ? (recorded["notes"] as unknown as ReviewNote[]) : []));
  const author = useAuthor(project);
  const value = inputs[config.artifact];
  const { seed, mime } = artifactShapeOf(value);
  const live = useDraftBox(undefined, undefined, docKey("gate", `${requestId}:${config.artifact}`), seed);
  const draft = settled !== undefined ? recordedDraft(seed, recorded["content"] as JsonValue | undefined) : live;
  const comments = (answers[config.prompt] ?? EMPTY_ANSWER).text.trim();
  const choices = choicesOfConfig(config);
  const { collapsed, sendBack, verdict } = reviewVerdictOf(choices[0]!.options, comments, notes.length);
  const send = (decision: string): void => onSubmit(reviewAnswerOf(decision, comments, notes, draft));
  const onAnswer = (question: string, next: Answer): void => setAnswers((prev) => ({ ...prev, [question]: next }));
  const warn = String(t.v("warn"));
  return (
    <>
      {seed.length === 0 ? (
        <ArtifactWell>
          <Txt spec={{ voice: "app", scale: 13 / 12.5, color: "dim" }}>({config.artifact} is empty)</Txt>
        </ArtifactWell>
      ) : (
        <ArtifactPane
          value={value}
          seed={seed}
          mime={mime}
          draft={draft}
          editable={settled === undefined && config.editable === true}
          serve={serve}
          notes={notes}
          {...(settled !== undefined
            ? {}
            : {
                onNote: (note: ReviewNote) => setNotes((prev) => [...prev, note]),
                onRemoveNote: (i: number) => setNotes((prev) => prev.filter((_, at) => at !== i)),
                onReply: (i: number, body: string) => setNotes((prev) => prev.map((note, at) => (at === i ? { ...note, replies: [...(note.replies ?? []), { author, body, at: new Date().toISOString() }] } : note))),
              })}
          author={author}
          artifactId={config.artifact}
        />
      )}
      {/* The verdict, in the plural's own words: what pressing the button is about to mean. */}
      <View flexDirection="row" flexWrap="wrap" alignItems="baseline" gap={10} marginTop={8} testID="review-verdict">
        {draft.dirty ? <Txt spec={{ voice: "app", scale: 13 / 12.5, color: "warn" }}>edited</Txt> : null}
        {notes.length > 0 ? (
          // `.review-count`: inline-flex, the glyph and the words 5 apart.
          <View flexDirection="row" alignItems="center" gap={5}>
            <Icon name="comment" size={13} color={warn} />
            <Txt spec={{ voice: "app", scale: 13 / 12.5, color: "warn" }}>{notesCount(notes.length)}</Txt>
          </View>
        ) : null}
        <Txt spec={{ voice: "app", scale: 13 / 12.5, italic: true, color: "dim" }} flexBasis="100%">
          {verdict}
        </Txt>
      </View>
      {/* Comments change the SHAPE of the footer: a review with notes on it has one outcome — it goes back. */}
      {settled !== undefined ? (
        // As it was decided, in the shape it was decided in: a review sent back with comments showed the
        // comment and one button (drawn lit, `.gate-settled button.primary:disabled`), one decided in
        // silence the row, with the decision lit.
        collapsed && recorded["decision"] === sendBack!.value ? (
          <>
            <ChoiceList choices={[{ ...choices[0]!, options: [] }]} answers={answers} onAnswer={() => undefined} readOnly flat={flat} />
            <View flexDirection="row" flexWrap="wrap" gap={8} marginTop={14}>
              <Button kind="primary">Send back with comments</Button>
            </View>
          </>
        ) : (
          <ChoiceList choices={choices} answers={answers} onAnswer={() => undefined} readOnly flat={flat} />
        )
      ) : collapsed ? (
        <>
          <ChoiceList choices={[{ ...choices[0]!, options: [] }]} answers={answers} onAnswer={onAnswer} flat={flat} />
          <View flexDirection="row" flexWrap="wrap" gap={8} marginTop={14}>
            <Button kind="primary" onPress={() => send(sendBack!.value)}>
              Send back with comments
            </Button>
          </View>
        </>
      ) : (
        <>
          <ChoiceList choices={choices} answers={answers} onAnswer={onAnswer} onImmediate={(_question, decision) => send(decision)} flat={flat} />
          {submitsOnClick(choices, answers) ? null : (
            <View flexDirection="row" flexWrap="wrap" gap={8} marginTop={14}>
              <Button kind="primary" disabled={answerOf(choices[0]!, answers[config.prompt] ?? EMPTY_ANSWER) === undefined} onPress={() => send(answerOf(choices[0]!, answers[config.prompt] ?? EMPTY_ANSWER) as string)}>
                Confirm
              </Button>
            </View>
          )}
        </>
      )}
    </>
  );
}

/**
 * `EditArtifact`: the same pane, permanently writable, and Save — handing the text back unchanged is an
 * answer too, so Save is never held for want of an edit. A picture, a sound or a video has nothing to
 * type into: it is shown, said so, and handed back with Done.
 */
export function EditArtifactGate({ config, inputs, onSubmit, requestId, project, settled, serve }: { config: EditArtifactConfig; inputs: Record<string, unknown>; onSubmit: (value: unknown) => void; requestId: string; project: string | undefined; settled?: { value: unknown } | undefined; serve?: ((path: string) => Promise<ServedArtifact>) | undefined }): JSX.Element {
  const value = config.source === undefined ? undefined : inputs[config.source];
  const { seed, mime } = artifactShapeOf(value);
  const live = useDraftBox(undefined, undefined, docKey("gate", `${requestId}:${config.source ?? ""}`), seed);
  // Settled, the text that came back over what was shown: the pane shows the edit that was made.
  const draft = settled !== undefined ? recordedDraft(seed, recordOf(settled.value)["content"] as JsonValue | undefined) : live;
  const author = useAuthor(project);
  if (editorKindOf(mime, seed) === "readonly") {
    return (
      <>
        <ArtifactWell>
          <ValueView value={value} serve={serve} />
        </ArtifactWell>
        <Txt spec={{ voice: "app", scale: 12 / 12.5, color: "warn" }} marginTop={10}>
          This is {mime ?? "not text"}, so there is nothing here to type into. Submitting hands it back unchanged.
        </Txt>
        {settled !== undefined ? null : (
          <View flexDirection="row" flexWrap="wrap" gap={8} marginTop={14}>
            <Button kind="primary" onPress={() => onSubmit({ content: seed })}>
              Done
            </Button>
          </View>
        )}
      </>
    );
  }
  return (
    <>
      <ArtifactPane value={value} seed={seed} mime={mime} draft={draft} editable={settled === undefined} serve={serve} notes={[]} author={author} artifactId={config.source ?? "content"} />
      {settled !== undefined ? null : <EditorActions dirty={draft.dirty || undefined} onSave={() => onSubmit({ content: draft.text })} />}
    </>
  );
}

/**
 * `GateSurface`'s `serve` (`components.tsx`): an artifact under review RUNS against a grant for the task
 * that produced it — the one the gate is ABOUT, else the gate's own — in that task's project (an empty
 * project is the focused one). Kept, one per task and project, as `faces.tsx`'s `serveOf` is: a value view
 * asks for a grant again whenever its `serve` changes, and a new frame address reloads the page.
 */
const serves = new Map<string, (path: string) => Promise<ServedArtifact>>();
export function serveOfGate(pending: PendingInteraction): (path: string) => Promise<ServedArtifact> {
  const taskId = pending.about ?? pending.taskId;
  const project = pending.subjectProject ?? (pending.project === "" ? undefined : pending.project);
  const key = `${taskId}\u0000${project ?? ""}`;
  let serve = serves.get(key);
  if (serve === undefined) {
    serve = (path: string) => invoke("artifact:serve", { taskId, path, ...(project !== undefined ? { project } : {}) });
    serves.set(key, serve);
  }
  return serve;
}

/** What a settled record answered, as a record (`components.tsx`'s `recordOf`). */
const recordOf = (value: unknown): Record<string, unknown> => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

/**
 * `ChangesetGate`: the reviewer, wired as the desktop wires it (`gateServices`) — `$WORKTREE` reads scoped
 * to the task under review, the second door when the gate has one, and the host's own services over both
 * (the gallery's, which reach nothing). Mounted afresh for another request or another author, as the
 * desktop's mount is keyed. `settled`: the review as it was answered (the mount's `settled`).
 */
export function ChangesetGate({ pending, config, inputs, onSubmit, project, host, settled }: { pending: PendingInteraction; config: ReviewArtifactsConfig; inputs: Record<string, unknown>; onSubmit: (value: unknown) => void; project: string | undefined; host?: Partial<ComponentServices> | undefined; settled?: { value: unknown } | undefined }): JSX.Element {
  const author = useAuthor(project);
  const services = useMemo(
    () => gateServices(invoke as never, { config, about: pending.about, project, author, gate: { taskId: pending.taskId, project: pending.project } }, host),
    [config, pending.about, pending.taskId, pending.project, project, author, host],
  );
  return <ChangesetReview key={`${pending.requestId}:${author}`} config={config} inputs={inputs} services={services} onSubmit={onSubmit} {...(settled !== undefined ? { settled } : {})} />;
}
