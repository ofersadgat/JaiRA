import { useRef, useState, type JSX } from "react";
import { ScrollView, useWindowDimensions } from "react-native";
import { View, isWeb } from "@tamagui/core";
import type { ReviewNote } from "@jaira/shared/browser";
import type { DraftBox } from "@jaira/ui/drafts";
import { artifactChangeOf, artifactReadingOf } from "@jaira/ui/artifactReview";
import { PLAIN_SCROLLER, edge, scrollbarProps, viewScrollbarProps } from "../../primitives";
import { useTokens } from "../../tokens";
import { Button } from "../settings/Button";
import { ValueView } from "../panel/ValueView";
import { HELD_QUOTE, reselect, useFlatText, useHoveredNote, useNoteHighlights, useSelectionInside } from "./noteSelection";
import { NoteComposer, NoteList, dataKey } from "./ReviewNotes";

/**
 * `components.tsx`'s `ArtifactPane`, universal (decision 0015): one artifact, read and — where the state
 * allows it — written, with the review's notes on top. Which reading is on screen and what the edit is as
 * a change are `artifactReview.ts`'s, the desktop's own: markdown shows a change without leaving the
 * document; anything else shows the edit as a change once there is one. The rules, from `styles.css`:
 *
 *   .artifact-view   --bg, 1px --line, radius 8, padding 10, 12 above, at most 46vh tall, scrolls
 *
 * Selecting a passage opens the note composer on web (the desktop's own selection code over the DOM
 * react-native-web draws, `noteSelection.web.ts`); a phone has no selection to anchor one to, and lists
 * the notes a review carries.
 */
export function ArtifactPane({
  value,
  seed,
  mime,
  draft,
  editable,
  notes,
  onNote,
  onRemoveNote,
  onReply,
  author,
  artifactId,
  marginTop = 12,
}: {
  value: unknown;
  seed: string;
  mime: string | undefined;
  draft: DraftBox;
  editable: boolean;
  notes: readonly ReviewNote[];
  onNote?: ((note: ReviewNote) => void) | undefined;
  onRemoveNote?: ((index: number) => void) | undefined;
  onReply?: ((index: number, body: string) => void) | undefined;
  author: string;
  artifactId: string;
  marginTop?: number;
}): JSX.Element {
  const well = useRef<unknown>(null);
  const [selection, clearSelection] = useSelectionInside(well as never);
  const flatText = useFlatText(well as never, seed);
  const hovered = useHoveredNote(well as never, notes);
  const [hotThread, setHotThread] = useState<number | null>(null);
  useNoteHighlights(well as never, notes, hovered ?? hotThread, selection);

  const dirty = draft.dirty;
  const reading = artifactReadingOf(mime, seed, dirty);
  const change = artifactChangeOf(artifactId, seed, draft.text, mime);
  const hint = mime === undefined ? undefined : { mime };
  // Reverting is the way back to the document, so it is the only control the changes view needs.
  const actions = dirty ? (
    <Button kind="ghost" title="throw away what you typed" onPress={draft.revert}>
      Revert
    </Button>
  ) : undefined;

  return (
    <>
      <ArtifactWell marginTop={marginTop} wellRef={well} {...(selection !== null ? { held: selection.quote } : {})}>
        {reading === "prose" ? (
          <ValueView
            value={draft.text}
            hint={hint}
            actions={actions}
            softbreak="space"
            {...(editable ? { edit: draft.set } : {})}
            {...(dirty ? { diff: { before: seed, after: draft.text, hunks: change.hunks ?? [] } } : {})}
          />
        ) : reading === "changes" ? (
          <ValueView value={{ changes: [change] }} actions={actions} />
        ) : (
          <ValueView value={value} hint={hint} actions={actions} softbreak="space" {...(editable ? { edit: draft.set } : {})} />
        )}
      </ArtifactWell>

      {selection !== null && onNote !== undefined ? (
        <NoteComposer
          selection={selection}
          author={author}
          onCancel={clearSelection}
          onSave={(body) => {
            onNote({ artifact: artifactId, quote: selection.quote, range: { start: selection.start, end: selection.end }, body, author, at: new Date().toISOString() });
            if (isWeb) window.getSelection()?.removeAllRanges();
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
 * `.artifact-view`: the framed, scrollable well a value is drawn in. On web a plain `overflow: auto` box,
 * as the DOM's is (a react-native-web scroller is composited, and its text drawn greyscale); `held` is the
 * passage the composer is holding (`HELD_QUOTE`), for the window's right-click menu.
 */
export function ArtifactWell({ marginTop = 12, wellRef, held, children }: { marginTop?: number; wellRef?: { current: unknown }; held?: string; children: JSX.Element }): JSX.Element {
  const t = useTokens();
  const win = useWindowDimensions();
  const box = {
    marginTop,
    maxHeight: win.height * 0.46,
    backgroundColor: t.v("bg") as never,
    borderRadius: 8,
    ...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }) as object),
  };
  if (isWeb) {
    return (
      <View
        ref={wellRef as never}
        testID="artifact"
        padding={10}
        {...box}
        {...({ overflow: "auto" } as object)}
        {...(viewScrollbarProps(t) as object)}
        {...((held !== undefined ? { dataSet: { [dataKey(HELD_QUOTE)]: held } } : {}) as object)}
      >
        {children}
      </View>
    );
  }
  return (
    <View {...box} overflow="hidden" testID="artifact">
      <ScrollView style={PLAIN_SCROLLER as never} contentContainerStyle={{ padding: 10 }} nestedScrollEnabled>
        <View ref={wellRef as never}>{children}</View>
      </ScrollView>
    </View>
  );
}

