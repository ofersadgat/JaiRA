import { useContext, useEffect, useMemo, useState, type JSX, type ReactNode } from "react";
import { Linking, Platform, ScrollView, useWindowDimensions } from "react-native";
import { View, isWeb } from "@tamagui/core";
import type { JsonValue } from "@declarative-ai/json";
import {
  baselineOf,
  changesetInputOf,
  deriveDecisions,
  mimeOfPath,
  monacoGrammarOf,
  reviewSettled,
  REVIEW_NOTE_ARTIFACT,
  type BaselineFile,
  type Change,
  type Changeset,
  type DecisionKind,
  type RemoteStatusView,
  type ReviewArtifactsConfig,
  type ReviewNote,
  type ReviewRemote,
} from "@jaira/shared/browser";
import {
  actionIcon,
  changesetAnswerOf,
  changesetSubmitOf,
  changesetVerdictOf,
  discardWhatOf,
  draftsOfDecisions,
  driftedChanges,
  noteFor,
  optionKindOf,
  pathLabelOf,
  pictureOf,
  recordedOf,
  reviewCounts,
  withForgeNotes,
  type ComponentServices,
  type Draft,
  type Drafts,
} from "@jaira/ui/changesetReviewModel";
import { repliesOnForge, stripWords } from "@jaira/ui/remoteStrip";
import { Island, type IslandHandle } from "../../islands";
import { PLAIN_SCROLLER, Press, Txt, edge, lengthToken, scrollbarProps, useHover, viewScrollbarProps } from "../../primitives";
import { useTokens, type Tokens } from "../../tokens";
import { FieldFrame } from "../floats/Choices";
import { GateTitle } from "../floats/GateTitle";
import { InlineGlyph } from "../floats/InlineGlyph";
import { ModalBox } from "../floats/Modal";
import { Icon } from "../panel/Icon";
import { BrandIcon } from "../settings/bits";
import { Button } from "../settings/Button";
import { ImageDiff, type ImageLayout } from "./ImageDiff";
import type { PendingSelection } from "./noteSelection";
import { NoteComposer, NoteList, PlainBox } from "./ReviewNotes";
import { SettledBy } from "./SettledBy";
import { SourceMark } from "./SourceMark";
import { Toggle } from "./Toggle";

/**
 * `changesetReview.tsx`'s reviewer, universal (decision 0015): a chooser of the set's changes and the
 * one under review — its diff, its notes, a comment on it and what will happen to its file — then a
 * comment on the whole review, what it will do in four numbers, and the button. Everything it decides
 * is `changesetReviewModel.ts`'s and `@jaira/shared`'s (`deriveDecisions` reads the gestures; there
 * are no decision buttons), the desktop's own; what is here is the drawing. The rules, from
 * `styles.css`:
 *
 *   .review-artifacts   column, gap 8; a container: at most 720 wide, one column (the chooser at most
 *                       30vh tall, over the detail), else the chooser 180–260 beside it, gap 10
 *   .review-head        app 12/12.5 --dim; its `code` data 11/12
 *   .review-chooser     --bg, 1px --line, radius 8, scrolls; a row: centred, a --line under it (not the
 *                       last), selected --fill-ghost-selected; its pick padding 6 8, gap 6, hovered
 *                       --fill-ghost-hover; the path app 13/12.5, one line, cut at its START (`rtl`);
 *                       excluded, struck through in --dim; notes --warn, ⚠ --warn, • --accent,
 *                       "reverted" --bad 8 in from the right
 *   .change-action      app 700 at 11/12.5, 0.04em, upper, padding 1 6, 1px --line, radius 4, --dim
 *                       (create --ok, delete --bad); the glyph 13, gap 5
 *   .review-detail      --bg, 1px --line, radius 8, padding 10
 *   .detail-head        row, baseline, gap 8: the action, the path (data at app 12/12.5), the layout
 *                       toggle (`.vv-toggle`), Revert (`danger`) or Put it back, Undo my edits
 *   .change-reason      app 12/12.5 --dim, 4 above;  .change-drift --warn, 6 above
 *   .change-unshowable  --warn, app 12/12.5, 8 above
 *   .review-detail .monaco-host   the diff's box: 1px --line, radius 6, at least 120 (the island's `frame`)
 *   .field              12 above in a modal or an inline gate (`FieldFrame`), gap 4; its label app
 *                       11/12.5, 0.04em, upper, --dim; the textarea
 *                       (the page's) data 12/12, two rows — `.change-comment` 8 more above it
 *   .change-files-note  app 11/12.5 --dim, 6 above, at least 14 tall
 *   .review-foot        a --line above, 8 in
 *   .review-summary     row, wrapping, baseline, gap 10, 8 above, --dim; a count: glyph 13, gap 5;
 *                       removed --bad, commented --warn, unopened --accent 600; the verdict italic, a
 *                       line of its own
 *   .options            row, wrapping, gap 8, 14 above
 *   .review-remote      row, centred, wrapping, gap 10, padding 7 10, 1px --line (an error: --bad 50%),
 *                       radius --control-radius, --panel-2, app 12.5; the forge 600 with its mark 14;
 *                       the request data (--accent), the branch data 11.5 --dim; the window --warn
 *                       with a clock 13; checked at the data size × 11.5/12 in the strip's face,
 *                       --dim; Check now in the strip's 12.5 (`button { font: inherit }`)
 *
 * The diff is the `diff` island (Monaco, the editor exception), wired as the desktop wires its pane: a
 * line selection in it opens the note composer and turns Revert into "Revert these lines" (`select`,
 * `revertSelectedLines`), and a change of code is checked by the compiler on each side (`intel`), its
 * buffer withdrawn when the change closes. A picture's two versions are `ImageDiff`.
 *
 * `settled`: the review as it was answered (`readOnly` in the DOM) — the decisions, the notes and the
 * comments the record spells, the forge's word on it (`SettledBy`), and nothing that can change them:
 * no Revert, Put it back or Undo my edits, no replies, the fields read-only and the buttons as they read
 * when pressed (`.gate-settled button:disabled`: full strength, a primary keeping its --sheen). Nothing
 * is polled, merged or drift-checked for a record.
 */
export function ChangesetReview({
  config,
  inputs,
  services,
  onSubmit,
  settled,
}: {
  config: ReviewArtifactsConfig;
  inputs: Record<string, unknown>;
  services: ComponentServices;
  onSubmit: (value: unknown) => void;
  settled?: { value: unknown } | undefined;
}): JSX.Element {
  const t = useTokens();
  const win = useWindowDimensions();
  const parsed = useMemo((): { changeset?: Changeset; error?: string } => {
    const found = changesetInputOf(inputs);
    return found.changeset === undefined ? { error: found.error ?? "no input holds a changeset" } : { changeset: found.changeset };
  }, [inputs]);
  // Settled: the state the submitted decisions spell, and nothing that can change it.
  const readOnly = settled !== undefined;
  const recorded: Record<string, JsonValue> = recordedOf(settled?.value as JsonValue | undefined);
  const [drafts, setDrafts] = useState<Drafts>(() => (readOnly ? draftsOfDecisions(recorded["decisions"]) : {}));
  const [reviewComment, setReviewComment] = useState(() => (readOnly && typeof recorded["comments"] === "string" ? recorded["comments"] : ""));
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [width, setWidth] = useState<number | undefined>(undefined);

  // The second door (decision 0004): what the forge has said, re-read as main keeps it.
  const remote = config.remote?.number !== undefined ? config.remote : undefined;
  const [remoteStatus, setRemoteStatus] = useState<RemoteStatusView | undefined>(undefined);
  const [checking, setChecking] = useState(false);
  const watch = services.remote;
  useEffect(() => {
    if (remote === undefined || watch === undefined || readOnly) return;
    let live = true;
    const mine = (rows: RemoteStatusView[]): void => {
      if (live) setRemoteStatus(rows.find((row) => row.key === remote.key) ?? rows[0]);
    };
    const read = (): void => void watch.status().then(mine).catch(() => undefined);
    read();
    const timer = setInterval(read, 10_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remote?.key, remote?.number, readOnly]);
  useEffect(() => {
    const theirs = remoteStatus?.notes;
    if (theirs !== undefined && !readOnly) setDrafts((held) => withForgeNotes(held, theirs));
  }, [remoteStatus, readOnly]);
  const generalNotes = readOnly ? ((Array.isArray(recorded["notes"]) ? recorded["notes"] : []) as unknown as ReviewNote[]) : ((remoteStatus?.notes?.[REVIEW_NOTE_ARTIFACT] ?? []) as ReviewNote[]);
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const [confirming, setConfirming] = useState<string | undefined>(undefined);
  const [moved, setMoved] = useState<ReadonlySet<string>>(new Set());
  const changesetForDrift = parsed.changeset;
  useEffect(() => {
    // Drift is about what a merge would do; a record of a review already made has no merge ahead of it.
    if (changesetForDrift === undefined || readOnly) return undefined;
    let alive = true;
    void driftedChanges(changesetForDrift, config.tree, services).then((flagged) => {
      if (alive) setMoved(flagged);
    });
    return () => {
      alive = false;
    };
  }, [changesetForDrift, services, config.tree, readOnly]);
  // Open the first change on mount: it is the one a reviewer would have clicked.
  const firstId = changesetForDrift?.changes[0]?.id;
  useEffect(() => {
    if (firstId === undefined) return;
    setSelected(firstId);
    setOpened((seen) => new Set([...seen, firstId]));
  }, [firstId]);
  // The whole set's before-side, once (`baselineOf`): a base file compiles only among its siblings' bases.
  const baseline = useMemo(() => (changesetForDrift === undefined ? [] : baselineOf(changesetForDrift)), [changesetForDrift]);

  if (parsed.changeset === undefined) {
    return <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "bad" }}>This state&apos;s changeset input is malformed: {parsed.error}</Txt>;
  }
  const changeset = parsed.changeset;
  const draftOf = (id: string): Draft => drafts[id] ?? {};
  const set = (id: string, patch: Partial<Draft>): void => setDrafts((d) => ({ ...d, [id]: { ...draftOf(id), ...(d[id] ?? {}), ...patch } }));
  const show = (id: string): void => {
    setSelected(id);
    setOpened((seen) => new Set([...seen, id]));
  };
  const decisions = deriveDecisions(changeset.changes, drafts, reviewComment);
  const decisionOf = (id: string): DecisionKind => decisions.find((d) => d.id === id)!.decision;
  const counts = reviewCounts(changeset.changes, decisions, opened);
  const going = reviewSettled(decisions);
  const submit = (level?: string): void => onSubmit(changesetAnswerOf(decisions, level, reviewComment));
  const change = changeset.changes.find((c) => c.id === selected);
  const confirmingChange = changeset.changes.find((c) => c.id === confirming);
  // `@container (max-width: 720px)`: one column, the chooser capped at 30vh.
  const narrow = width === undefined || width <= 720;
  const dim = String(t.v("dim"));
  // `.gate-settled button:disabled`: a record's buttons at full strength, a primary keeping its --sheen.
  const pressed = (kind: "primary" | "danger" | "ghost", press: () => void): Record<string, unknown> =>
    readOnly ? { disabled: true, opacity: 1, ...(kind === "primary" ? { boxShadow: t.v("sheen") } : {}) } : { onPress: press };

  const chooser = (
    <Scroller t={t} maxHeight={narrow ? win.height * 0.3 : undefined} testID="review-chooser" box={{ backgroundColor: t.v("bg"), borderRadius: 8, ...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }) as object), ...(narrow ? {} : { width: 260, flexShrink: 0 }) }}>
      {changeset.changes.map((c, i) => (
        <ChooserRow
          key={c.id}
          change={c}
          decision={decisionOf(c.id)}
          selected={c.id === selected}
          opened={opened.has(c.id)}
          moved={moved.has(c.id)}
          notes={(draftOf(c.id).notes ?? []).length}
          last={i === changeset.changes.length - 1}
          onShow={() => show(c.id)}
        />
      ))}
    </Scroller>
  );
  const detail = (
    <View flexGrow={1} flexShrink={1} flexBasis={narrow ? "auto" : 0} minWidth={0} padding={10} borderRadius={8} backgroundColor={t.v("bg") as never} {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }) as object)} testID="review-detail">
      {change === undefined ? (
        <Txt spec={{ voice: "app", scale: 13 / 12.5, color: "dim" }}>Pick a change on the left.</Txt>
      ) : (
        // Not keyed by the change, as the desktop's is not: the layout chosen holds from one change to the next.
        <ChangeDetail
          change={change}
          tree={config.tree}
          decision={decisionOf(change.id)}
          draft={draftOf(change.id)}
          onDraft={(patch) => set(change.id, patch)}
          moved={moved.has(change.id)}
          services={services}
          baseline={baseline}
          readOnly={readOnly}
          onForgeReply={
            readOnly || watch === undefined || remote === undefined
              ? undefined
              : async (thread, body, resolve) => {
                  const rows = await watch.reply(thread, body, resolve);
                  setRemoteStatus(rows.find((row) => row.key === remote.key) ?? rows[0]);
                }
          }
        />
      )}
    </View>
  );

  return (
    <View flexDirection="column" gap={8} minHeight={0} onLayout={(e) => setWidth(e.nativeEvent.layout.width)} testID="changeset-review">
      <Txt spec={{ voice: "app", scale: 12 / 12.5, color: "dim" }}>
        {"against "}
        <Txt spec={{ voice: "data", scale: 11 / 12, color: "dim" }}>{changeset.source}</Txt>
      </Txt>
      {remote === undefined ? null : (
        <RemoteStrip
          remote={remote}
          status={remoteStatus}
          busy={checking}
          {...(readOnly || watch === undefined
            ? {}
            : {
                onCheck: () => {
                  setChecking(true);
                  void watch
                    .check()
                    .then((rows) => setRemoteStatus(rows.find((row) => row.key === remote.key) ?? rows[0]))
                    .catch(() => undefined)
                    .finally(() => setChecking(false));
                },
              })}
        />
      )}
      <ReviewThread notes={generalNotes} />
      {readOnly ? <SettledBy recorded={recorded} /> : null}

      <View flexDirection={narrow ? "column" : "row"} gap={10} minHeight={0} {...(narrow ? {} : { alignItems: "flex-start" })}>
        {chooser}
        {detail}
      </View>

      <View paddingTop={8} {...(edge(t, { top: 1 }) as object)}>
        <Field label="Comment on the whole review (optional)">
          <PlainBox multiline rows={2} value={reviewComment} placeholder={readOnly ? "" : "Anything that is about the set rather than one file…"} readOnly={readOnly} onChangeText={setReviewComment} t={t} />
        </Field>
        <View flexDirection="row" flexWrap="wrap" alignItems="baseline" gap={10} marginTop={8} testID="review-summary">
          <Count icon="check" color={dim} t={t}>
            {counts.keeping}
            {" keeping"}
          </Count>
          {counts.removed > 0 ? <Count icon="cross" color={String(t.v("bad"))} t={t}>
              {counts.removed}
              {" removed"}
            </Count> : null}
          {counts.commented > 0 ? <Count icon="comment" color={String(t.v("warn"))} t={t}>
              {counts.commented}
              {" commented"}
            </Count> : null}
          {counts.unopened > 0 ? (
            <Count icon="alert" color={String(t.v("accent"))} weight={600} title="derivation approves what you did not touch" t={t}>
              {counts.unopened}
              {" you did not open"}
            </Count>
          ) : null}
          <Txt spec={{ voice: "app", scale: 13 / 12.5, italic: true, color: "dim" }} flexBasis="100%">
            {changesetVerdictOf(going)}
          </Txt>
        </View>
        <View flexDirection="row" flexWrap="wrap" gap={8} marginTop={14}>
          {config.options === undefined ? (
            // Settled: the one button there was, as it read when it was pressed, and unpressable.
            <Button kind="primary" {...pressed("primary", () => submit())} testID="submit-review">
              {changesetSubmitOf(going)}
            </Button>
          ) : (
            config.options.map((option) => {
              // Settled: the option that was chosen keeps its fill; the others go quiet.
              const kind = optionKindOf(option, readOnly, recorded);
              return (
                <Button key={option.value} kind={kind} {...pressed(kind, () => submit(option.value))} testID={`submit-${option.value}`}>
                  {option.label ?? option.value}
                </Button>
              );
            })
          )}
        </View>
      </View>

      {confirmingChange !== undefined ? (
        <DiscardNotes
          change={confirmingChange}
          notes={(draftOf(confirmingChange.id).notes ?? []).length}
          hasComment={(draftOf(confirmingChange.id).comment ?? "").trim().length > 0}
          onCancel={() => setConfirming(undefined)}
          onDiscard={() => {
            set(confirmingChange.id, { excluded: true, comment: "", notes: [] });
            setConfirming(undefined);
          }}
        />
      ) : null}
    </View>
  );
}

/** A scrolling box: on web a plain `overflow: auto` one, as the DOM's is (a react-native-web scroller is composited). */
function Scroller({ t, maxHeight, box, testID, children }: { t: Tokens; maxHeight?: number | undefined; box: object; testID?: string; children: ReactNode }): JSX.Element {
  if (isWeb) {
    return (
      <View minHeight={0} overflow="hidden" {...(maxHeight !== undefined ? { maxHeight } : {})} {...(box as object)} {...({ overflowY: "auto" } as object)} {...(viewScrollbarProps(t) as object)} {...(testID !== undefined ? { testID } : {})}>
        {children}
      </View>
    );
  }
  return (
    <View minHeight={0} overflow="hidden" {...(maxHeight !== undefined ? { maxHeight } : {})} {...(box as object)} {...(testID !== undefined ? { testID } : {})}>
      <ScrollView style={PLAIN_SCROLLER as never} nestedScrollEnabled>
        {children}
      </ScrollView>
    </View>
  );
}

/** `.change-action`: the action word in a small ringed badge, its glyph beside it. */
function ActionBadge({ action, short = false }: { action: Change["action"]; short?: boolean }): JSX.Element {
  const t = useTokens();
  const ink = action === "create" ? "ok" : action === "delete" ? "bad" : "dim";
  return (
    <View flexDirection="row" alignItems="center" gap={5} flexShrink={0} paddingVertical={1} paddingHorizontal={6} borderRadius={4} {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }) as object)}>
      <Icon name={actionIcon(action)} size={13} color={String(t.v(ink))} />
      <Txt spec={{ voice: "app", scale: 11 / 12.5, weight: 700, ls: 0.04, upper: true, color: ink }}>{short ? action.slice(0, 3) : action}</Txt>
    </View>
  );
}

/** One row of the chooser: what the change is, what it is about to become. */
function ChooserRow({ change, decision, selected, opened, moved, notes, last, onShow }: { change: Change; decision: DecisionKind; selected: boolean; opened: boolean; moved: boolean; notes: number; last: boolean; onShow: () => void }): JSX.Element {
  const t = useTokens();
  const out = decision === "denied" || decision === "reverted";
  const body = { voice: "app", scale: 13 / 12.5 } as const;
  return (
    <View flexDirection="row" alignItems="center" {...(selected ? { backgroundColor: t.v("fill-ghost-selected") as never } : {})} {...(last ? {} : (edge(t, { bottom: 1 }) as object))}>
      <Press
        onPress={onShow}
        testID={`chooser-${change.id}`}
        flexGrow={1}
        flexShrink={1}
        flexBasis={0}
        minWidth={0}
        flexDirection="row"
        alignItems="center"
        gap={6}
        paddingVertical={6}
        paddingHorizontal={8}
        borderRadius={lengthToken(t, "control-radius", 7)}
        box={({ hovered }) => ({ backgroundColor: hovered ? t.v("fill-ghost-hover") : "transparent" })}
      >
        <ActionBadge action={change.action} short />
        {/* `direction: rtl`: a long path is cut at its START, so the file's own name stays. */}
        <Txt spec={{ ...body, color: out ? "dim" : "text" }} flexGrow={1} flexShrink={1} flexBasis={0} minWidth={0} numberOfLines={1} ellipsizeMode="head" title={change.path} {...(out ? { textDecorationLine: "line-through" } : {})} {...((isWeb ? { style: { direction: "rtl", textAlign: "left", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } } : {}) as object)}>
          {pathLabelOf(change)}
        </Txt>
        {notes > 0 ? (
          <View flexDirection="row" alignItems="center" gap={2} flexShrink={0} {...({ title: `${notes} note${notes === 1 ? "" : "s"}` } as object)}>
            <Icon name="comment" size={13} color={String(t.v("warn"))} />
            <Txt spec={{ ...body, color: "warn" }}>{String(notes)}</Txt>
          </View>
        ) : null}
        {moved ? (
          <Txt spec={{ ...body, color: "warn" }} flexShrink={0} title="this file moved since the review was produced">
            ⚠
          </Txt>
        ) : null}
        {!opened ? (
          <Txt spec={{ ...body, color: "accent" }} flexShrink={0} title="you have not opened this one">
            •
          </Txt>
        ) : null}
      </Press>
      {out ? (
        <Txt spec={{ ...body, color: "bad" }} flexShrink={0} paddingRight={8}>
          reverted
        </Txt>
      ) : null}
    </View>
  );
}

/**
 * The change under review: its head, why it was made, its diff, its notes, a comment on it, and what
 * happens to its file. `readOnly`: the change as it was decided — the diff, the notes and the comment,
 * none of them editable, and no verb in the head.
 */
function ChangeDetail({
  change,
  tree,
  decision,
  draft,
  onDraft,
  moved,
  services,
  baseline,
  readOnly,
  onForgeReply,
}: {
  change: Change;
  tree: "base" | "proposal";
  decision: DecisionKind;
  draft: Draft;
  onDraft: (patch: Partial<Draft>) => void;
  moved: boolean;
  services: ComponentServices;
  /** The whole changeset's before-side — see `baselineOf` and `CheckFileRequest.baseline`. */
  baseline: BaselineFile[];
  readOnly: boolean;
  onForgeReply?: ((thread: string, body: string, resolve?: boolean) => Promise<void>) | undefined;
}): JSX.Element {
  const t = useTokens();
  const [layout, setLayout] = useState<"inline" | "split">("inline");
  const [imageLayout, setImageLayout] = useState<ImageLayout>("overlay");
  /** A selection in the diff's modified side (the island's `select`), what a note is anchored to. */
  const [selection, setSelection] = useState<PendingSelection | null>(null);
  const [canRevertLines, setCanRevertLines] = useState(false);
  /** What only the drawn diff can do (`revertSelectedLines`), once it is drawn. */
  const [diff, setDiff] = useState<IslandHandle | null>(null);
  const [hotThread, setHotThread] = useState<number | null>(null);
  /**
   * The compiler on both sides, each asked in the tree that can answer it (`MonacoDiffProps.intel`):
   * TypeScript and JavaScript only, where the host has the channel, and never about a side with no text.
   */
  const askable = services.checkFile;
  const grammar = monacoGrammarOf(mimeOfPath(change.path));
  const code = grammar === "typescript" || grammar === "javascript";
  const intel = useMemo(() => {
    if (askable === undefined || !code) return undefined;
    return {
      ...(change.after === undefined ? {} : { modified: { check: (text: string) => askable({ path: change.path, text }) } }),
      ...(change.before === undefined ? {} : { original: { check: (text: string) => askable({ path: change.path, text, baseline }) } }),
    };
  }, [askable, code, change.path, change.after, change.before, baseline]);
  // The proposed side's buffer is withdrawn when this change closes, or an abandoned edit goes on
  // shadowing the worktree for every file that imports it.
  const release = services.releaseFile;
  useEffect(() => {
    if (release === undefined || !code || change.after === undefined) return undefined;
    return () => release(change.path);
  }, [release, code, change.path, change.after]);
  const picture = pictureOf(change, draft);
  const notes = draft.notes ?? [];
  const author = services.author ?? "you";
  const hasDraft = services.drafts !== undefined && (services.drafts.has(`project:${change.path}`) || services.drafts.has(`base:${change.path}`));
  const small = { voice: "app", scale: 12 / 12.5 } as const;
  // A REVERTED change has no diff: showing the proposal anyway would claim what was just refused.
  const modified = draft.excluded === true ? (change.before ?? "") : (draft.content ?? change.after ?? "");
  // A phone's island needs a height: the desktop's pane takes its text's, 120 to 620 (`MonacoDiffPane`).
  const lines = (change.before ?? "").split("\n").length + modified.split("\n").length;
  const size = Number(t.scaled("size-app", 13 / 12.5)) || 13;
  const refuse = (): void => onDraft({ excluded: true, content: undefined, comment: "", notes: [] });
  return (
    <View testID={`detail-${change.id}`}>
      <View flexDirection="row" alignItems="baseline" gap={8}>
        <ActionBadge action={change.action} />
        {services.openFile !== undefined ? (
          // `button.link.change-path`: data 12/12, --accent, underlined under the pointer — into the editor.
          <PathLink label={pathLabelOf(change)} onPress={() => services.openFile!("project", change.path)} />
        ) : (
          <Txt spec={{ voice: "data", scale: 1, color: "text" }} fontSize={t.scaled("size-app", 12 / 12.5) as never} lineHeight={(Number(t.scaled("size-app", 12 / 12.5)) || 12) * 1.5} flexShrink={1} minWidth={0}>
            {pathLabelOf(change)}
          </Txt>
        )}
        <View flexGrow={1} />
        {picture === undefined && change.unshowable === undefined ? (
          <Toggle
            label="How to lay the diff out"
            options={[
              ["inline", "Inline"],
              ["split", "Side by side"],
            ]}
            value={layout}
            onPick={(next) => setLayout(next as "inline" | "split")}
          />
        ) : null}
        {readOnly ? null : draft.excluded === true ? (
          // `content: undefined` as well: putting a change back restores what was PROPOSED.
          <Button kind="ghost" onPress={() => onDraft({ excluded: false, content: undefined })}>
            Put it back
          </Button>
        ) : (
          // With lines selected, revert exactly those (the island answers `reverted`); with none, refuse
          // the whole change — the edits, the whole-file comment and the notes go with it.
          <Button
            kind="danger"
            title={canRevertLines ? "put the original back over the selected lines" : "refuse this change — select lines first to revert only those"}
            onPress={() => (canRevertLines && diff !== null ? diff.command("revertSelectedLines") : refuse())}
          >
            {canRevertLines ? "Revert these lines" : "Revert"}
          </Button>
        )}
        {!readOnly && draft.excluded !== true && draft.content !== undefined && draft.content !== change.after ? (
          <Button kind="ghost" onPress={() => onDraft({ content: undefined })}>
            Undo my edits
          </Button>
        ) : null}
      </View>
      {change.reason !== undefined ? (
        <Txt spec={{ ...small, color: "dim" }} marginTop={4}>
          {change.reason}
        </Txt>
      ) : null}
      {moved ? (
        <Txt spec={{ ...small, color: "warn" }} marginTop={6}>
          ⚠ this file moved since the review was produced — what you merge may not be what you read (§3.2); applying will re-check and refuse
        </Txt>
      ) : null}
      {hasDraft ? (
        <Txt spec={{ ...small, color: "warn" }} marginTop={6}>
          ✎ this file has unsaved edits in the editor — a merge writes past them
        </Txt>
      ) : null}
      {picture !== undefined ? (
        <ImageDiff before={picture.before} after={picture.after} layout={imageLayout} onLayout={setImageLayout} />
      ) : change.unshowable !== undefined ? (
        <Txt spec={{ ...small, color: "warn" }} marginTop={8}>
          {change.unshowable}
        </Txt>
      ) : (
        <Island
          component="diff"
          {...(Platform.OS === "web" ? {} : { height: Math.min(Math.max(lines * 19 + 8, 120), 620) })}
          props={{
            original: change.before ?? "",
            modified,
            mime: mimeOfPath(change.path),
            file: change.path,
            readOnly: readOnly || change.after === undefined,
            sideBySide: layout === "split",
            select: !readOnly,
            ...(intel === undefined ? {} : { intel }),
            // `.review-detail .monaco-host`: the pane's ring, radius and floor (its height is its own `fit`).
            frame: { minHeight: "120px", border: `1px solid ${String(t.v("line"))}`, borderRadius: "6px", overflow: "hidden", boxSizing: "border-box" },
            // `.diff-pane-loading` while Monaco loads: centred, --dim, on the body's line.
            loading: { text: "loading the diff editor…", style: { display: "grid", placeItems: "center", color: String(t.v("dim")), fontFamily: String(t.v("font-app")), fontSize: `${size}px`, lineHeight: `${size * 1.5}px` } },
          }}
          handle={setDiff}
          onEvent={(name, value) => {
            if (name === "modified" && !readOnly) onDraft({ content: value === change.after ? undefined : String(value) });
            if (name === "select") {
              const picked = value as { selection: PendingSelection | null; canRevert: boolean };
              setSelection(picked.selection);
              // On every selection, not on the press: the button's words say which of its two meanings is live.
              setCanRevertLines(picked.canRevert);
            }
            // The lines put back — or nothing to put back (the selection moved on), which refuses the change.
            if (name === "reverted") {
              if (typeof value === "string") onDraft({ content: value });
              else refuse();
            }
          }}
        />
      )}
      {selection !== null && !readOnly ? (
        <NoteComposer
          selection={selection}
          author={author}
          onCancel={() => setSelection(null)}
          onSave={(body) => {
            onDraft({
              notes: [
                ...notes,
                // A diff's selection is always in the MODIFIED side, so it always has an honest side.
                { artifact: change.id, quote: selection.quote, range: { start: selection.start, end: selection.end }, side: "after" as const, body, author, at: new Date().toISOString() },
              ],
            });
            setSelection(null);
          }}
        />
      ) : null}
      <NoteList
        notes={notes}
        text={draft.content ?? change.after ?? ""}
        author={author}
        hovered={hotThread}
        onHover={setHotThread}
        // The desktop's reselects in a well Monaco owns, which holds none of the note's words: nothing.
        onReselect={() => undefined}
        {...(readOnly
          ? {}
          : {
              onReply: (i: number, body: string, resolve?: boolean) => {
                const target = notes[i];
                if (target !== undefined && onForgeReply !== undefined && repliesOnForge(target)) return onForgeReply(target.thread!, body, resolve);
                return onDraft({ notes: notes.map((note, at) => (at === i ? { ...note, replies: [...(note.replies ?? []), { author, body, at: new Date().toISOString() }] } : note)) });
              },
              onRemove: (i: number) => onDraft({ notes: notes.filter((_, at) => at !== i) }),
            })}
      />
      <Field
        label={
          // Three text runs, as the DOM writes them (Blink shapes each apart).
          <>
            {"Comment on this "}
            {change.unshowable !== undefined ? "change" : "whole file"}
            {" (optional)"}
          </>
        }
      >
        <View marginTop={8}>
          <PlainBox
            multiline
            rows={2}
            value={draft.comment ?? ""}
            placeholder={change.unshowable !== undefined ? "Nothing here to select, so say it about the change as a whole…" : "For anything that is not about one passage…"}
            readOnly={readOnly}
            onChangeText={(text: string) => onDraft({ comment: text })}
            t={t}
          />
        </View>
      </Field>
      <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }} marginTop={6} minHeight={14}>
        {noteFor(decision, tree)}
      </Txt>
    </View>
  );
}

/**
 * `label.field`: gap 4, its label app 11/12.5, 0.04em, upper case, --dim; 12 above where its host frames
 * a field (`.modal .field`, `.inline-gate .field` — `FieldFrame`), none in a state's panel.
 */
function Field({ label, children }: { label: ReactNode; children: ReactNode }): JSX.Element {
  const framed = useContext(FieldFrame);
  return (
    <View flexDirection="column" gap={4} marginTop={framed ? 12 : 0}>
      <Txt spec={{ voice: "app", scale: 11 / 12.5, ls: 0.04, upper: true, color: "dim" }}>{label}</Txt>
      {children}
    </View>
  );
}

/** `.review-count`: a glyph and its number, gap 5. */
function Count({ icon, color, weight = 400, title, children }: { icon: "check" | "cross" | "comment" | "alert"; color: string; weight?: 400 | 600; title?: string; t: Tokens; children: ReactNode }): JSX.Element {
  return (
    <View flexDirection="row" alignItems="center" gap={5} {...(title !== undefined ? { title } : {})}>
      <Icon name={icon} size={13} color={color} />
      <Txt spec={{ voice: "app", scale: 13 / 12.5, weight, color }}>{children}</Txt>
    </View>
  );
}

/** The confirm that stands between an X and somebody's words. */
function DiscardNotes({ change, notes, hasComment, onCancel, onDiscard }: { change: Change; notes: number; hasComment: boolean; onCancel: () => void; onDiscard: () => void }): JSX.Element {
  return (
    <ModalBox onDismiss={onCancel} testID="discard-notes" label="Remove this change and discard what you wrote?">
      <GateTitle>Remove this change and discard what you wrote?</GateTitle>
      <Txt spec={{ voice: "data", scale: 11 / 12, color: "dim" }}>{change.path}</Txt>
      <Txt spec={{ voice: "app", scale: 12 / 12.5, color: "warn" }} marginTop={10}>
        It carries {discardWhatOf(notes, hasComment)}. A change that is not in the review has nothing for a note to be about, so removing it throws them away.
      </Txt>
      <View flexDirection="row" flexWrap="wrap" gap={8} marginTop={14}>
        <Button kind="danger" onPress={onDiscard}>
          Remove and discard
        </Button>
        <Button kind="ghost" onPress={onCancel}>
          Keep it
        </Button>
      </View>
    </ModalBox>
  );
}

/** `remoteStripView.tsx`'s `RemoteStrip`: where the request lives, who has spoken there, and the quiet window. */
function RemoteStrip({ remote, status, busy, onCheck }: { remote: ReviewRemote; status: RemoteStatusView | undefined; busy: boolean; onCheck?: () => void }): JSX.Element {
  const t = useTokens();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  const words = stripWords(remote, status, now);
  const [linkHovered, hoverLink] = useHover();
  const size = { voice: "app", scale: 1 } as const;
  const warnOrBad = words.error !== undefined ? "bad" : "warn";
  const checkedSize = Number(t.scaled("size-data", 11.5 / 12)) || 11.5;
  return (
    <View
      flexDirection="row"
      alignItems="center"
      flexWrap="wrap"
      gap={10}
      paddingVertical={7}
      paddingHorizontal={10}
      marginBottom={8}
      borderRadius={lengthToken(t, "control-radius", 7)}
      backgroundColor={t.v("panel-2") as never}
      {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }, words.error !== undefined ? t.mix(t.v("bad"), 50, t.v("line")) : "line") as object)}
      testID="review-remote"
    >
      <View flexDirection="row" alignItems="center" gap={6}>
        <BrandIcon name={remote.provider ?? ""} size={14} />
        <Txt spec={{ ...size, weight: 600 }}>{words.forge}</Txt>
      </View>
      <View {...(hoverLink as object)}>
        <Txt spec={{ voice: "data", scale: 1, color: "accent" }} {...(words.href !== undefined && linkHovered ? { textDecorationLine: "underline" } : {})} {...((words.href !== undefined ? (isWeb ? { href: words.href, hrefAttrs: { target: "_blank", rel: "noreferrer" } } : { onPress: () => void Linking.openURL(words.href!) }) : {}) as object)}>
          {words.label}
        </Txt>
      </View>
      <Txt spec={{ voice: "data", scale: 11.5 / 12, color: "dim" }}>{words.branch}</Txt>
      <View flexGrow={1} flexShrink={1} flexBasis="auto" />
      {words.who !== undefined ? <Txt spec={{ ...size, color: "dim" }}>{words.who}</Txt> : null}
      {words.error !== undefined || words.window !== undefined ? (
        <View flexDirection="row" alignItems="center" gap={6} {...((words.error !== undefined ? status?.error : words.window?.title) !== undefined ? { title: words.error !== undefined ? status?.error : words.window?.title } : {})}>
          <Icon name={words.error !== undefined ? "alert" : "clock"} size={13} color={String(t.v(warnOrBad))} />
          <Txt spec={{ ...size, color: warnOrBad, tabular: true }}>{words.error ?? words.window?.text}</Txt>
        </View>
      ) : null}
      {/* `.rr-checked`: the data SIZE (× 11.5/12) in the strip's own face — no rule gives it the data face. */}
      {words.checked !== undefined ? (
        <Txt spec={{ voice: "app", scale: 1, color: "dim", lineHeight: { px: checkedSize * 1.5 } }} fontSize={checkedSize}>
          {words.checked}
        </Txt>
      ) : null}
      {onCheck === undefined ? null : (
        // `button { font: inherit }`: the strip's 12.5, not the body's 13.
        <Button kind="ghost" disabled={busy} onPress={onCheck} font={{ scale: 1 }}>
          Check now
        </Button>
      )}
    </View>
  );
}

/** `button.link.change-path`: the changed file's path, which opens it in the Files room. */
function PathLink({ label, onPress }: { label: string; onPress: () => void }): JSX.Element {
  return (
    <Press onPress={onPress} fill={false} flexShrink={1} minWidth={0}>
      {({ hovered }) => (
        <Txt spec={{ voice: "data", scale: 12 / 12, color: "accent" }} {...(hovered ? { textDecorationLine: "underline" } : {})}>
          {label}
        </Txt>
      )}
    </Press>
  );
}

/** `ReviewThread`: the request's comments as a whole, about the set — 8 under, a column of messages, gap 6. */
function ReviewThread({ notes }: { notes: readonly ReviewNote[] }): JSX.Element | null {
  const t = useTokens();
  if (notes.length === 0) return null;
  const body = { voice: "app", scale: 13 / 12.5 } as const;
  return (
    <View flexDirection="column" gap={6} marginBottom={8} testID="review-thread">
      {notes.map((note, i) => (
        <View key={`${note.at}-${i}`} marginTop={6} paddingLeft={8} {...(edge(t, { left: 2 }) as object)}>
          {/* `.note-msg-by`: the glyph inline on the baseline (no rule lowers it here, as `.note-row`'s does), a
              space, the author and where it was written (`SourceMark`). */}
          <Txt spec={{ ...body, weight: 600, color: "dim" }}>
            <InlineGlyph size={13}>
              <Icon name="comment" size={13} color={String(t.v("dim"))} />
            </InlineGlyph>{" "}
            {note.author}
            {note.source === undefined ? null : <SourceMark source={note.source} />}
          </Txt>
          <Txt spec={{ ...body, color: "text" }} whiteSpace="pre-wrap">
            {note.body}
          </Txt>
        </View>
      ))}
    </View>
  );
}
