import { useState, type JSX, type ReactNode } from "react";
import { View } from "@tamagui/core";
import { parseStructured, type StructuredFormat } from "@jaira/shared/browser";
import { docKey, useDraftBox } from "@jaira/ui/drafts";
import { registerSurfaceTable, newSurfaceRegistry, SURFACE_KEYS, type SurfaceKey } from "@jaira/ui/fileSurfaceTable";
import { isReading, type FileSurface, type FileSurfaceProps } from "@jaira/ui/fileTypes";
import { Island } from "../../islands";
import { Txt } from "../../primitives";
import { useTokens } from "../../tokens";
import { Uncopied } from "../../app/Uncopied";
import { Markdown } from "../Markdown";
import { Button } from "../settings/Button";
import { DataView } from "./DataView";

/**
 * The file surfaces, universal (decision 0015): what draws each half of the Files panel, by the same
 * table the desktop registers (`fileSurfaceTable.ts`) — so a file resolves to the same renderer on both,
 * and only the drawing differs. Viewers are native; an EDITOR is an island (CodeMirror, Monaco), the
 * only WebViews the copy allows. A surface not copied yet is an {@link Uncopied} box where it stands.
 */

/** `p.empty`: --dim, 8 above and below, and the paragraph's margins (1em of the body's 13). */
function Empty({ children }: { children: ReactNode }): JSX.Element {
  const t = useTokens();
  return (
    <Txt spec={{ voice: "app", scale: 13 / 12.5, color: "dim" }} paddingVertical={8} marginVertical={t.scaled("size-app", 13 / 12.5) as number}>
      {children}
    </Txt>
  );
}

/** `fenceRender.tsx`'s `MarkdownView`: the file, rendered — `.markdown` at 13/12.5 in the upper half. */
function MarkdownView({ doc }: FileSurfaceProps): JSX.Element {
  if (doc.text.trim().length === 0) return <Empty>This file is empty.</Empty>;
  return <Markdown text={doc.text} softbreak="space" />;
}

/** `.notice.bad`: a parse failure — --tint-bad ground, --bad, app 11/12.5, radius --control-radius, padding 7 9. */
function Notice({ children }: { children: ReactNode }): JSX.Element {
  const t = useTokens();
  return (
    <View backgroundColor={t.v("tint-bad") as never} borderRadius={t.v("control-radius") as never} paddingVertical={7} paddingHorizontal={9}>
      <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "bad" }}>{children}</Txt>
    </View>
  );
}

/** `StructuredView`: a JSON or YAML document parsed by the one parse (`parseStructured`), as its tree. */
function StructuredView({ text, format }: { text: string; format: StructuredFormat }): JSX.Element {
  if (text.trim().length === 0) return <Empty>This file is empty.</Empty>;
  const parsed = parseStructured(text, format);
  if (!parsed.ok) {
    return (
      <Notice>
        does not parse: {parsed.message}
        {parsed.spot !== undefined ? ` (line ${parsed.spot.line}, column ${parsed.spot.column})` : ""}
      </Notice>
    );
  }
  return <DataView value={parsed.value} />;
}
const JsonView = ({ doc }: FileSurfaceProps): JSX.Element => <StructuredView text={doc.text} format="json" />;
const YamlView = ({ doc }: FileSurfaceProps): JSX.Element => <StructuredView text={doc.text} format="yaml" />;

/** `ConfigEffectiveView`: both configuration layers merged (`.config-effective`: a column, gap 6, padding 2 2 10). */
function ConfigEffectiveView({ context }: FileSurfaceProps): JSX.Element {
  if (context.config === null) return <Empty>Open a project to see the effective configuration.</Empty>;
  return (
    <View flexDirection="column" gap={6} paddingTop={2} paddingHorizontal={2} paddingBottom={10}>
      <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }}>shared config with this project&apos;s laid over it</Txt>
      <DataView value={context.config.effective} />
    </View>
  );
}

/**
 * `editorChrome.tsx`'s `EditorActions`: Save and Revert, pinned under the editor. The rules
 * (`cascade.mts '.pane-actions.pinned'`):
 *
 *   .pane-actions.pinned   row, centred, wrapping, gap 6; 8 above, a --line over it, --panel; pushed to
 *                          the foot (margin-top auto)
 *   button.primary/.ghost  `Button`'s; disabled at half opacity
 *   .sub                   --dim, app 11/12.5
 */
export function EditorActions({ dirty, busy, onSave, onRevert, children }: { dirty?: boolean; busy?: boolean; onSave: () => void; onRevert?: () => void; children?: ReactNode }): JSX.Element {
  return (
    <EditorActionsRow>
      <Button kind="primary" onPress={onSave} disabled={busy === true || dirty === false}>
        Save
      </Button>
      {onRevert !== undefined ? (
        <Button kind="ghost" onPress={onRevert} disabled={dirty === false}>
          Revert
        </Button>
      ) : null}
      {dirty === true ? <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }}>unsaved changes</Txt> : null}
      {children}
    </EditorActionsRow>
  );
}

/** `ReadingNote`: the row a Save button would have been in, saying why there is none. */
function ReadingNote(): JSX.Element {
  return (
    <EditorActionsRow>
      <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }}>The reading of this type — not a place to type. Appearance › File types.</Txt>
    </EditorActionsRow>
  );
}
function EditorActionsRow({ children }: { children: ReactNode }): JSX.Element {
  const t = useTokens();
  return (
    <View flexDirection="row" flexWrap="wrap" alignItems="center" gap={6} flexShrink={0} marginTop="auto" paddingTop={8} backgroundColor={t.v("panel") as never} borderTopWidth={1} borderRightWidth={0} borderBottomWidth={0} borderLeftWidth={0} borderStyle="solid" borderColor={t.v("line") as never}>
      {children}
    </View>
  );
}

/**
 * `fileSurfaces.tsx`'s `MarkdownFileEdit`: markdown, edited in the live preview — CodeMirror, an island
 * (`.file-edit`: a column, gap 8; the editor takes the rest, at least 200 tall, and scrolls inside
 * itself), with the same draft box, Save and Revert as the desktop's.
 */
function MarkdownFileEdit({ doc, busy, onSave, context }: FileSurfaceProps): JSX.Element {
  const draft = useDraftBox(context.drafts, context.onDraft, docKey(doc.layer, doc.path), doc.text);
  const reading = isReading(context);
  const [height, setHeight] = useState(0);
  return (
    <View flexDirection="column" flexGrow={1} flexShrink={1} flexBasis="auto" gap={8} minHeight={0}>
      <View flexGrow={1} flexShrink={1} flexBasis="auto" minHeight={200} onLayout={(e) => setHeight(Math.round(e.nativeEvent.layout.height))}>
        {height > 0 ? (
          <Island
            component="markdownEditor"
            props={{ text: reading ? doc.text : draft.text, readOnly: reading }}
            height={height}
            onEvent={(name, value) => {
              if (name === "change" && !reading) draft.set(String(value));
            }}
          />
        ) : null}
      </View>
      {reading ? (
        <ReadingNote />
      ) : (
        <EditorActions dirty={draft.dirty || !doc.exists} busy={busy} onSave={() => onSave(draft.text)} onRevert={draft.revert}>
          {doc.exists ? null : <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }}>new file — saving creates it</Txt>}
        </EditorActions>
      )}
    </View>
  );
}

/** The copies there are, by the table's key. */
const COPIED: Partial<Record<SurfaceKey, FileSurface>> = { MarkdownView, MarkdownFileEdit, JsonView, YamlView, ConfigEffectiveView };

/** The table, registered with the copies — and an {@link Uncopied} box for every surface without one. */
export const SURFACES = registerSurfaceTable(
  Object.fromEntries(SURFACE_KEYS.map((key) => [key, COPIED[key] ?? ((): JSX.Element => <Uncopied name={key} flex={1} />)])) as Record<SurfaceKey, FileSurface>,
  newSurfaceRegistry(),
);
