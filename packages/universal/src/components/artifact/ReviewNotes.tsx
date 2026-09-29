import { useEffect, useRef, useState, type JSX, type Ref } from "react";
import { TextInput } from "react-native";
import { View, isWeb } from "@tamagui/core";
import { anchorNotes, decisionWordOf, shortQuote, type ReviewNote } from "@jaira/shared/browser";
import { forgeName, repliesOnForge } from "@jaira/ui/remoteStrip";
import { notesCount } from "@jaira/ui/artifactReview";
import { Press, Txt, edge, font, lengthToken, placeholderColor, useHover } from "../../primitives";
import { useTokens, type Tokens } from "../../tokens";
import { Float } from "../floats/Float";
import { InlineGlyph } from "../floats/InlineGlyph";
import { TipLayer } from "../floats/TipLayer";
import { Icon } from "../panel/Icon";
import { Button } from "../settings/Button";
import { KEEPS_SELECTION, type PendingSelection } from "./noteSelection";

/**
 * `reviewNotes.tsx`'s surfaces, universal (decision 0015): the composer that floats at a selected
 * passage, and the notes on an artifact as threads. Which notes still resolve, the quote's shortening and
 * a forge's word for itself are the desktop's (`anchorNotes`, `shortQuote`, `remoteStrip.ts`). The rules,
 * from `styles.css`:
 *
 *   .note-composer       --panel, 1px --line, radius 10, --lift, padding 10, column, gap 8; 320 wide,
 *                        8 below the selection
 *   .note-composer-head  row, centred, gap 6; the comment glyph (13, --dim), `.note-author` 600 --text
 *   .note-quote          padding-left 8, a 2px --warn rule on its left, --dim, italic
 *   textarea             (the page's) data 12/12, --bg, 1px --line (hovered --rule), radius
 *                        --control-radius, padding 5 9, three rows
 *   .note-list           12 above, 1px --line, radius 8, clipped
 *   .note-list-head      row, centred, gap 6, padding 6 10, --panel-2, --dim
 *   .note-row            padding 8 10, a --line above; `.hot` --fill-ghost-hover
 *   .note-row-quote      the quote, one line, --dim, italic (hovered --accent, underlined); an orphan's
 *                        "text changed" --warn, upright
 *   .note-msg            6 above, a 2px --line on its left, 8 in; `.note-msg-by` --dim 600, the glyph;
 *                        `.note-msg-body` --text, pre-wrap
 *   .note-reply          row, gap 6, 6 above, 10 in; the input (the page's: app, padding 5 9) and ghost
 *                        buttons
 *
 * A phone has no selection to anchor a note to, so the composer is web's (`noteSelection.ts`); the
 * threads are drawn on both.
 */

/** The page's text — the modal's body font (app 13/12.5, line 1.5). */
const BODY = { voice: "app", scale: 13 / 12.5 } as const;

/** The composer, floating at the selection: the author, the passage, what should change. */
export function NoteComposer({ selection, author, onSave, onCancel }: { selection: PendingSelection; author: string; onSave: (body: string) => void; onCancel: () => void }): JSX.Element {
  const t = useTokens();
  const [body, setBody] = useState("");
  const input = useRef<TextInput>(null);
  useEffect(() => {
    input.current?.focus();
  }, []);
  const said = body.trim();
  return (
    <TipLayer>
      <Float
        anchor={selection.rect}
        side="below"
        align="start"
        offset={8}
        width={320}
        pointerEvents="auto"
        flexDirection="column"
        gap={8}
        padding={10}
        borderRadius={10}
        backgroundColor={t.v("panel") as never}
        {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }) as object)}
        {...({ boxShadow: t.v("lift") } as object)}
        // A press inside must not clear the selection the note is about (`KEEPS_SELECTION`).
        {...((isWeb ? { dataSet: { [dataKey(KEEPS_SELECTION)]: "" }, onMouseDown: (e: { preventDefault: () => void; target?: unknown }) => (e.target as { tagName?: string } | undefined)?.tagName !== "TEXTAREA" && e.preventDefault() } : {}) as object)}
        testID="note-composer"
      >
        <View flexDirection="row" alignItems="center" gap={6}>
          <Icon name="comment" size={13} color={String(t.v("dim"))} />
          <Txt spec={{ ...BODY, weight: 600 }}>{author}</Txt>
        </View>
        <Txt spec={{ ...BODY, italic: true, color: "dim" }} paddingLeft={8} {...(edge(t, { left: 2 }, "warn") as object)}>
          {shortQuote(selection.quote)}
        </Txt>
        <PlainBox
          ref={input}
          multiline
          rows={3}
          value={body}
          placeholder="What should change here?"
          onChangeText={setBody}
          onKeyPress={(e: { nativeEvent: { key: string; shiftKey?: boolean }; preventDefault?: () => void }) => {
            if (e.nativeEvent.key === "Escape") onCancel();
            // Enter submits; Shift+Enter is a newline. A note is normally one sentence.
            if (e.nativeEvent.key === "Enter" && e.nativeEvent.shiftKey !== true && said.length > 0) {
              e.preventDefault?.();
              onSave(said);
            }
          }}
          t={t}
        />
        <View flexDirection="row" gap={8}>
          <Button kind="primary" disabled={said.length === 0} onPress={() => onSave(said)}>
            Comment
          </Button>
          <Button kind="ghost" onPress={onCancel}>
            Cancel
          </Button>
        </View>
      </Float>
    </TipLayer>
  );
}

/**
 * Every note on the artifact, as THREADS: the quote each is about (pressed, the passage is selected
 * again), its messages oldest first, and a box to answer it. An orphan — its words no longer in the
 * artifact — stays and says so.
 */
export function NoteList({
  notes,
  text,
  author,
  hovered,
  onHover,
  onReselect,
  onReply,
  onRemove,
}: {
  notes: readonly ReviewNote[];
  text: string;
  author: string;
  hovered?: number | null;
  onHover?: ((index: number | null) => void) | undefined;
  onReselect: (note: ReviewNote) => void;
  onReply?: ((index: number, body: string, resolve?: boolean) => void | Promise<void>) | undefined;
  onRemove?: ((index: number) => void) | undefined;
}): JSX.Element | null {
  const t = useTokens();
  if (notes.length === 0) return null;
  const anchored = anchorNotes(text, notes);
  return (
    <View marginTop={12} borderRadius={8} overflow="hidden" {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }) as object)} testID="note-list">
      <View flexDirection="row" alignItems="center" gap={6} paddingVertical={6} paddingHorizontal={10} backgroundColor={t.v("panel-2") as never}>
        <Icon name="comment" size={13} color={String(t.v("dim"))} />
        <Txt spec={{ ...BODY, color: "dim" }}>{notesCount(notes.length)}</Txt>
      </View>
      {anchored.map((note, i) => (
        <NoteThread
          key={`${note.at}-${i}`}
          note={note}
          author={author}
          orphan={note.resolved === undefined}
          hot={hovered === i}
          onEnter={() => onHover?.(i)}
          onLeave={() => onHover?.(null)}
          onReselect={() => onReselect(note)}
          onReply={onReply === undefined ? undefined : (body, resolve) => onReply(i, body, resolve)}
          onRemove={onRemove === undefined ? undefined : () => onRemove(i)}
        />
      ))}
    </View>
  );
}

function NoteThread({
  note,
  author,
  orphan,
  hot,
  onEnter,
  onLeave,
  onReselect,
  onReply,
  onRemove,
}: {
  note: ReviewNote;
  author: string;
  orphan: boolean;
  hot: boolean;
  onEnter(): void;
  onLeave(): void;
  onReselect(): void;
  onReply?: ((body: string, resolve?: boolean) => void | Promise<void>) | undefined;
  onRemove?: (() => void) | undefined;
}): JSX.Element {
  const t = useTokens();
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState<string | undefined>(undefined);
  const onForge = repliesOnForge(note);
  const send = (resolve: boolean): void => {
    const body = reply.trim();
    if (body.length === 0 || onReply === undefined || sending) return;
    setFailed(undefined);
    const sent = onReply(body, resolve);
    if (!(sent instanceof Promise)) {
      setReply("");
      return;
    }
    // The words stay in the box until the forge has them.
    setSending(true);
    void sent
      .then(() => setReply(""))
      .catch((e: unknown) => setFailed((e as Error).message))
      .finally(() => setSending(false));
  };
  const messages = [{ author: note.author, body: note.body, at: note.at }, ...(note.replies ?? [])];
  const empty = reply.trim().length === 0;
  return (
    <View
      paddingVertical={8}
      paddingHorizontal={10}
      {...(edge(t, { top: 1 }) as object)}
      {...(hot ? { backgroundColor: t.v("fill-ghost-hover") as never } : {})}
      {...((isWeb ? { onMouseEnter: onEnter, onMouseLeave: onLeave } : {}) as object)}
    >
      <View flexDirection="row" alignItems="baseline" gap={8}>
        <Press onPress={onReselect} disabled={orphan} title={orphan ? "this passage is no longer in the artifact" : "show this passage"} flexGrow={1} flexShrink={1} minWidth={0}>
          {({ hovered }) => (
            <Txt spec={{ ...BODY, italic: !orphan, color: orphan ? "warn" : hovered ? "accent" : "dim" }} ellip {...(hovered && !orphan ? { textDecorationLine: "underline" } : {})}>
              {orphan ? "text changed" : shortQuote(note.quote)}
            </Txt>
          )}
        </Press>
        {/* A thread that lives on the forge cannot be deleted from here: this is a view of it. */}
        {onRemove === undefined || note.source !== undefined ? null : (
          <Button kind="ghost" title="delete this thread" onPress={onRemove} paddingVertical={0} paddingHorizontal={4}>
            <Icon name="cross" size={13} color={String(t.v("text"))} />
          </Button>
        )}
      </View>
      {messages.map((message, i) => (
        <View key={`${message.at}-${i}`} marginTop={6} paddingLeft={8} {...(edge(t, { left: 2 }) as object)}>
          <Txt spec={{ ...BODY, weight: 600, color: "dim" }}>
            <InlineGlyph size={13} drop={2}>
              <Icon name="comment" size={13} color={String(t.v("dim"))} />
            </InlineGlyph>{" "}
            {message.author}
            {note.source === undefined ? null : ` ${forgeName(note.source)}`}
          </Txt>
          {/* A message whose whole body is a decision word IS that decision (decision 0004). */}
          <Txt spec={{ ...BODY, color: "text", ...(note.source !== undefined && decisionWordOf(message.body) !== undefined ? { weight: 600 } : {}) }} whiteSpace="pre-wrap">
            {message.body}
          </Txt>
        </View>
      ))}
      {onReply === undefined ? null : (
        <View flexDirection="row" gap={6} marginTop={6} paddingLeft={10} alignItems="center">
          <View flex={1} minWidth={0}>
            <PlainBox value={reply} editable={!sending} placeholder={onForge ? `Reply on ${forgeName(note.source)}…` : `Reply as ${author}…`} onChangeText={setReply} onSubmitEditing={() => send(false)} t={t} app />
          </View>
          <Button kind="ghost" disabled={sending || empty} onPress={() => send(false)}>
            {sending ? "Sending…" : "Reply"}
          </Button>
          {onForge ? (
            <Button kind="ghost" disabled={sending || empty} title="post the reply and mark the thread resolved on the forge" onPress={() => send(true)}>
              Reply &amp; resolve
            </Button>
          ) : null}
          {failed === undefined ? null : <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "warn" }}>{failed}</Txt>}
        </View>
      )}
    </View>
  );
}

/**
 * The page's own `input`/`textarea` (the global rule): the body's font for an input, data 12/12 for a
 * textarea; --text on --bg, 1px --line (hovered --rule), radius --control-radius, padding 5 9.
 */
export const PlainBox = ({ t, app = false, rows, multiline, ref, ...rest }: { t: Tokens; app?: boolean; rows?: number; multiline?: boolean; ref?: Ref<TextInput> } & Record<string, unknown>): JSX.Element => {
  const [hovered, hover] = useHover();
  const size = Number(t.scaled(app ? "size-app" : "size-data", app ? 13 / 12.5 : 1)) || 13;
  return (
    <View {...(hover as object)}>
      <TextInput
        ref={ref}
        {...(multiline === true ? { multiline: true, numberOfLines: rows } : {})}
        {...((rows !== undefined && isWeb ? { rows } : {}) as object)}
        placeholderTextColor={placeholderColor("light")}
        {...(rest as object)}
        style={
          {
            ...(font(t, app ? { ...BODY, color: "text" } : { voice: "data", scale: 1, color: "text" }) as object),
            width: "100%",
            paddingVertical: 5,
            paddingHorizontal: 9,
            borderWidth: 1,
            borderStyle: "solid",
            borderColor: t.v(hovered ? "rule" : "line"),
            borderRadius: lengthToken(t, "control-radius", 7),
            backgroundColor: t.v("bg"),
            ...(multiline === true ? { textAlignVertical: "top", ...(isWeb ? { resize: "vertical" } : { height: (rows ?? 2) * size * 1.5 + 12 }) } : {}),
          } as never
        }
      />
    </View>
  );
};

/** `data-keeps-selection` as react-native-web's `dataSet` names it (`keepsSelection`). */
export const dataKey = (attribute: string): string => attribute.replace(/^data-/, "").replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
