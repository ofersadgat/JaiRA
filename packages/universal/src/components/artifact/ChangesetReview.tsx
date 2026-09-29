import { useEffect, useMemo, useState, type JSX, type ReactNode } from "react";
import { Platform, ScrollView, useWindowDimensions } from "react-native";
import { View, isWeb } from "@tamagui/core";
import type { JsonValue } from "@declarative-ai/json";
import {
  changesetInputOf,
  deriveDecisions,
  mimeOfPath,
  reviewSettled,
  REVIEW_NOTE_ARTIFACT,
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
  driftedChanges,
  noteFor,
  optionKindOf,
  pathLabelOf,
  pictureOf,
  reviewCounts,
  withForgeNotes,
  type ComponentServices,
  type Draft,
  type Drafts,
} from "@jaira/ui/changesetReviewModel";
import { repliesOnForge, stripWords } from "@jaira/ui/remoteStrip";
import { Uncopied } from "../../app/Uncopied";
import { Island } from "../../islands";
import { PLAIN_SCROLLER, Press, Txt, edge, lengthToken, scrollbarProps, useHover } from "../../primitives";
import { useTokens, type Tokens } from "../../tokens";
import { GateTitle } from "../floats/GateTitle";
import { ModalBox } from "../floats/Modal";
import { Icon } from "../panel/Icon";
import { BrandIcon } from "../settings/bits";
import { Button } from "../settings/Button";
import { NoteList, PlainBox } from "./ReviewNotes";

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
 *   .field              12 above, gap 4; its label app 11/12.5, 0.04em, upper, --dim; the textarea
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
 *                       with a clock 13; checked data 11.5 --dim
 *
 * The diff is the `diff` island (Monaco, the editor exception): a reviewer's line selection inside it
 * (the note composer, "Revert these lines") stays with the desktop; Revert refuses the whole change. The
 * comparison of two versions of a picture is {@link Uncopied}.
 */
export function ChangesetReview({
  config,
  inputs,
  services,
  onSubmit,
}: {
  config: ReviewArtifactsConfig;
  inputs: Record<string, unknown>;
  services: ComponentServices;
  onSubmit: (value: unknown) => void;
}): JSX.Element {
  const t = useTokens();
  const win = useWindowDimensions();
  const parsed = useMemo((): { changeset?: Changeset; error?: string } => {
    const found = changesetInputOf(inputs);
    return found.changeset === undefined ? { error: found.error ?? "no input holds a changeset" } : { changeset: found.changeset };
  }, [inputs]);
  const [drafts, setDrafts] = useState<Drafts>({});
  const [reviewComment, setReviewComment] = useState("");
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [width, setWidth] = useState<number | undefined>(undefined);

  // The second door (decision 0004): what the forge has said, re-read as main keeps it.
  const remote = config.remote?.number !== undefined ? config.remote : undefined;
  const [remoteStatus, setRemoteStatus] = useState<RemoteStatusView | undefined>(undefined);
  const [checking, setChecking] = useState(false);
  const watch = services.remote;
  useEffect(() => {
    if (remote === undefined || watch === undefined) return;
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
  }, [remote?.key, remote?.number]);
  useEffect(() => {
    const theirs = remoteStatus?.notes;
    if (theirs !== undefined) setDrafts((held) => withForgeNotes(held, theirs));
  }, [remoteStatus]);
  const generalNotes = (remoteStatus?.notes?.[REVIEW_NOTE_ARTIFACT] ?? []) as ReviewNote[];
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const [confirming, setConfirming] = useState<string | undefined>(undefined);
  const [moved, setMoved] = useState<ReadonlySet<string>>(new Set());
  const changesetForDrift = parsed.changeset;
  useEffect(() => {
    if (changesetForDrift === undefined) return undefined;
    let alive = true;
    void driftedChanges(changesetForDrift, config.tree, services).then((flagged) => {
      if (alive) setMoved(flagged);
    });
    return () => {
      alive = false;
    };
  }, [changesetForDrift, services, config.tree]);
  // Open the first change on mount: it is the one a reviewer would have clicked.
  const firstId = changesetForDrift?.changes[0]?.id;
  useEffect(() => {
    if (firstId === undefined) return;
    setSelected(firstId);
    setOpened((seen) => new Set([...seen, firstId]));
  }, [firstId]);

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
        <ChangeDetail
          key={change.id}
          change={change}
          tree={config.tree}
          decision={decisionOf(change.id)}
          draft={draftOf(change.id)}
          onDraft={(patch) => set(change.id, patch)}
          moved={moved.has(change.id)}
          services={services}
          onForgeReply={
            watch === undefined || remote === undefined
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
          {...(watch === undefined
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

      <View flexDirection={narrow ? "column" : "row"} gap={10} minHeight={0} {...(narrow ? {} : { alignItems: "flex-start" })}>
        {chooser}
        {detail}
      </View>

      <View paddingTop={8} {...(edge(t, { top: 1 }) as object)}>
        <Field label="Comment on the whole review (optional)">
          <PlainBox multiline rows={2} value={reviewComment} placeholder="Anything that is about the set rather than one file…" onChangeText={setReviewComment} t={t} />
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
            <Button kind="primary" onPress={() => submit()} testID="submit-review">
              {changesetSubmitOf(going)}
            </Button>
          ) : (
            config.options.map((option) => (
              <Button key={option.value} kind={optionKindOf(option, false, {} as Record<string, JsonValue>)} onPress={() => submit(option.value)} testID={`submit-${option.value}`}>
                {option.label ?? option.value}
              </Button>
            ))
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
      <View minHeight={0} overflow="hidden" {...(maxHeight !== undefined ? { maxHeight } : {})} {...(box as object)} {...({ overflowY: "auto" } as object)} {...(scrollbarProps(t) as object)} {...(testID !== undefined ? { testID } : {})}>
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

/** The change under review: its head, why it was made, its diff, its notes, a comment on it, and what happens to its file. */
function ChangeDetail({
  change,
  tree,
  decision,
  draft,
  onDraft,
  moved,
  services,
  onForgeReply,
}: {
  change: Change;
  tree: "base" | "proposal";
  decision: DecisionKind;
  draft: Draft;
  onDraft: (patch: Partial<Draft>) => void;
  moved: boolean;
  services: ComponentServices;
  onForgeReply?: ((thread: string, body: string, resolve?: boolean) => Promise<void>) | undefined;
}): JSX.Element {
  const t = useTokens();
  const [layout, setLayout] = useState<"inline" | "split">("inline");
  const picture = pictureOf(change, draft);
  const notes = draft.notes ?? [];
  const author = services.author ?? "you";
  const hasDraft = services.drafts !== undefined && (services.drafts.has(`project:${change.path}`) || services.drafts.has(`base:${change.path}`));
  const small = { voice: "app", scale: 12 / 12.5 } as const;
  const modified = draft.excluded === true ? (change.before ?? "") : (draft.content ?? change.after ?? "");
  // A phone's island needs a height: the desktop's pane takes its text's, 120 to 620 (`MonacoDiffPane`).
  const lines = (change.before ?? "").split("\n").length + modified.split("\n").length;
  return (
    <View testID={`detail-${change.id}`}>
      <View flexDirection="row" alignItems="baseline" gap={8}>
        <ActionBadge action={change.action} />
        <Txt spec={{ voice: "data", scale: 1, color: "text" }} fontSize={t.scaled("size-app", 12 / 12.5) as never} lineHeight={(Number(t.scaled("size-app", 12 / 12.5)) || 12) * 1.5} flexShrink={1} minWidth={0}>
          {pathLabelOf(change)}
        </Txt>
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
        {draft.excluded === true ? (
          <Button kind="ghost" onPress={() => onDraft({ excluded: false, content: undefined })}>
            Put it back
          </Button>
        ) : (
          // Refusing a change drops everything about it: the edits, the whole-file comment, the notes.
          <Button kind="danger" title="refuse this change" onPress={() => onDraft({ excluded: true, content: undefined, comment: "", notes: [] })}>
            Revert
          </Button>
        )}
        {draft.excluded !== true && draft.content !== undefined && draft.content !== change.after ? (
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
        <Uncopied name="the comparison of two versions of a picture (ImageDiff)" height={120} />
      ) : change.unshowable !== undefined ? (
        <Txt spec={{ ...small, color: "warn" }} marginTop={8}>
          {change.unshowable}
        </Txt>
      ) : (
        <Island
          component="diff"
          {...(Platform.OS === "web" ? {} : { height: Math.min(Math.max(lines * 19 + 8, 120), 620) })}
          props={{ original: change.before ?? "", modified, mime: mimeOfPath(change.path), file: change.path, readOnly: change.after === undefined, sideBySide: layout === "split" }}
          onEvent={(name, text) => {
            if (name === "modified") onDraft({ content: text === change.after ? undefined : String(text) });
          }}
        />
      )}
      <NoteList
        notes={notes}
        text={draft.content ?? change.after ?? ""}
        author={author}
        onReselect={() => undefined}
        onReply={(i, body, resolve) => {
          const target = notes[i];
          if (target !== undefined && onForgeReply !== undefined && repliesOnForge(target)) return onForgeReply(target.thread!, body, resolve);
          return onDraft({ notes: notes.map((note, at) => (at === i ? { ...note, replies: [...(note.replies ?? []), { author, body, at: new Date().toISOString() }] } : note)) });
        }}
        onRemove={(i) => onDraft({ notes: notes.filter((_, at) => at !== i) })}
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

/** `label.field`: 12 above, gap 4, its label app 11/12.5, 0.04em, upper case, --dim. */
function Field({ label, children }: { label: ReactNode; children: ReactNode }): JSX.Element {
  return (
    <View flexDirection="column" gap={4} marginTop={12}>
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

/** `.vv-toggle`: a ringed row of buttons, the one on --fill-ghost-selected at 600. */
function Toggle({ label, options, value, onPick }: { label: string; options: ReadonlyArray<[string, string]>; value: string; onPick: (next: string) => void }): JSX.Element {
  const t = useTokens();
  return (
    <View role="group" aria-label={label} flexDirection="row" flexShrink={0} borderWidth={1} borderStyle="solid" borderColor={t.v("line") as never} borderRadius={6} overflow="hidden">
      {options.map(([id, words], i) => (
        <Press key={id} onPress={() => onPick(id)} {...({ "aria-pressed": id === value } as object)} paddingVertical={1} paddingHorizontal={7} {...(edge(t, { left: i === 0 ? 0 : 1 }) as object)} box={({ hovered }) => ({ backgroundColor: id === value ? t.v("fill-ghost-selected") : hovered ? t.v("fill-ghost-hover") : "transparent" })}>
          {({ hovered }) => (
            <Txt spec={{ voice: "app", scale: 10.5 / 12.5, weight: id === value ? 600 : 400, color: id === value || hovered ? "text" : "tok-hint" }} textAlign="center" numberOfLines={1}>
              {words}
            </Txt>
          )}
        </Press>
      ))}
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
        <Txt spec={{ voice: "data", scale: 1, color: "accent" }} {...(words.href !== undefined && linkHovered ? { textDecorationLine: "underline" } : {})} {...((words.href !== undefined && isWeb ? { href: words.href, hrefAttrs: { target: "_blank", rel: "noreferrer" } } : {}) as object)}>
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
      {words.checked !== undefined ? <Txt spec={{ voice: "data", scale: 11.5 / 12, color: "dim" }}>{words.checked}</Txt> : null}
      {onCheck === undefined ? null : (
        <Button kind="ghost" disabled={busy} onPress={onCheck}>
          Check now
        </Button>
      )}
    </View>
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
          <View flexDirection="row" alignItems="center" gap={4}>
            <Icon name="comment" size={13} color={String(t.v("dim"))} />
            <Txt spec={{ ...body, weight: 600, color: "dim" }}>{note.author}</Txt>
            {note.source === undefined ? null : <BrandIcon name={note.source} size={13} />}
          </View>
          <Txt spec={{ ...body, color: "text" }} whiteSpace="pre-wrap">
            {note.body}
          </Txt>
        </View>
      ))}
    </View>
  );
}
