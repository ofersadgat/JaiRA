import { useMemo, useState, type JSX, type ReactNode } from "react";
import { TextInput as RNTextInput } from "react-native";
import { View, isWeb } from "@tamagui/core";
import { hasGrammar, type JairaAppearanceConfig } from "@jaira/shared/browser";
import { lookOf } from "@jaira/ui/appearanceLayer";
import { docKey, useDraftBox } from "@jaira/ui/drafts";
import { editorThemeSpec, editorThemeVars } from "@jaira/ui/editorThemes";
import { configAuthoredText, configSaveOf, isLocatedFile } from "@jaira/ui/fileEditModel";
import { isReading, type FileSurfaceProps } from "@jaira/ui/fileTypes";
import { useShell } from "../../app/shell";
import { Island } from "../../islands";
import { Txt, font } from "../../primitives";
import { useTokens } from "../../tokens";
import { EditorActions, EditorActionsRow, FileEdit, ReadingNote, Sub } from "./EditorActions";

/**
 * The code surfaces, universal (decision 0015): `fileSurfaces.tsx`'s `TextEdit`, `CodeSourceView` and
 * `ConfigEdit`. Monaco (the editor, and the tokenizer's reading) is an island — `client/island/code.tsx`,
 * the desktop's own `MonacoCodePane` and `CodeText` — in the band the DOM surface gives it, inside the
 * chrome drawn natively around it. The plain box (`textarea.code-editor`) is not Monaco: it is a native
 * text box here, as the desktop's is a textarea. What the surfaces decide is `fileEditModel.ts`'s.
 *
 * Not on a phone: code intelligence (the compiler's diagnostics, definitions, hover), which asks main
 * through the window's bridge; the island's editor is the desktop's without its `intel`.
 */

/** The person's appearance block, for an editor island to draw in (`IslandProps.appearance`). */
export function useEditorAppearance(): JairaAppearanceConfig {
  const { state } = useShell();
  return useMemo(() => lookOf(state.config), [state.config]);
}

/**
 * The band an editor island fills — the DOM's `.file-edit > .monaco-host` (flex 1 1 auto, at least
 * `min` tall; its border and radius are drawn inside the island, by the island's own stylesheet) —
 * measured, since an island is given a fixed height and scrolls inside it.
 */
export function IslandBand({ min, children }: { min: number; children: (height: number) => ReactNode }): JSX.Element {
  const [height, setHeight] = useState(0);
  return (
    <View flexGrow={1} flexShrink={1} flexBasis="auto" minHeight={min} onLayout={(e) => setHeight(Math.round(e.nativeEvent.layout.height))}>
      {height > 0 ? children(height) : null}
    </View>
  );
}

/**
 * `textarea.code-editor`, in `.file-edit` (`cascade.mts '.code-editor'`): the plain box a type with no
 * grammar falls back to, and the configuration editor.
 *
 *   .code-editor               editor size / --ed-code-lh (1.5) in the data face, --text on --bg, 1px
 *                              --line, radius 6, padding 8, full width, tab --ed-code-tab (2)
 *   .file-edit > .code-editor  flex 1 1 auto, at least 120 tall, no resize handle
 *   :root[data-editor-theme] .code-editor
 *                              the editors' own palette (`editorThemeVars`): --ed-text on --ed-bg,
 *                              --ed-line — unless the palette is "follows the app"
 */
export function CodeArea({ value, readOnly, onChange, appearance }: { value: string; readOnly: boolean; onChange: (text: string) => void; appearance: JairaAppearanceConfig }): JSX.Element {
  const t = useTokens();
  const spec = editorThemeSpec(appearance.editorTheme);
  const ed = spec === undefined ? null : editorThemeVars(spec);
  const size = t.v("size-editor");
  const data = t.v("size-data");
  const scale = typeof size === "number" && typeof data === "number" && data > 0 ? size / data : 1;
  const look = appearance.editors.code;
  return (
    <RNTextInput
      value={value}
      onChangeText={onChange}
      multiline
      editable={!readOnly}
      spellCheck={false}
      autoCorrect={false}
      autoCapitalize="none"
      style={
        {
          ...(font(t, { voice: "data", scale, lineHeight: look.lineHeight, color: ed?.["--ed-text"] ?? "text" }) as object),
          flexGrow: 1,
          flexShrink: 1,
          flexBasis: "auto",
          minHeight: 120,
          width: "100%",
          padding: 8,
          borderWidth: 1,
          borderStyle: "solid",
          borderColor: ed?.["--ed-line"] ?? t.v("line"),
          borderRadius: 6,
          backgroundColor: ed?.["--ed-bg"] ?? t.v("bg"),
          textAlignVertical: "top",
          ...(isWeb ? { resize: "none", tabSize: look.tabSize, outlineWidth: 0 } : {}),
        } as never
      }
    />
  );
}

/** `TextEdit`: Monaco for a type with a grammar, the plain box otherwise; the draft box, Save and Revert. */
export function TextEdit({ doc, busy, onSave, context }: FileSurfaceProps): JSX.Element {
  const draft = useDraftBox(context.drafts, context.onDraft, docKey(doc.layer, doc.path), doc.text);
  const reading = isReading(context);
  const appearance = useEditorAppearance();
  const text = reading ? doc.text : draft.text;
  return (
    <FileEdit>
      {hasGrammar(doc.mime) ? (
        <IslandBand min={200}>
          {(height) => (
            <Island
              component="code"
              height={height}
              appearance={appearance}
              props={{ text, mime: doc.mime, readOnly: reading, view: context.view ?? "write", ...(isLocatedFile(doc) ? { file: doc.file } : {}) }}
              onEvent={(name, value) => {
                if (name === "change") draft.set(String(value));
              }}
            />
          )}
        </IslandBand>
      ) : (
        <CodeArea value={text} readOnly={reading} onChange={draft.set} appearance={appearance} />
      )}
      {reading ? (
        <ReadingNote />
      ) : (
        <EditorActions dirty={draft.dirty || !doc.exists} busy={busy} onSave={() => onSave(draft.text)} onRevert={draft.revert}>
          {doc.exists ? null : <Sub>new file — saving creates it</Sub>}
        </EditorActions>
      )}
    </FileEdit>
  );
}

/** `CodeSourceView`: the tokenizer's colours and no editor (`CodeText`, in the island), and why there is no Save. */
export function CodeSourceView({ doc }: FileSurfaceProps): JSX.Element {
  const appearance = useEditorAppearance();
  return (
    <FileEdit>
      <IslandBand min={0}>{(height) => <Island component="code" height={height} appearance={appearance} props={{ text: doc.text, mime: doc.mime, reading: true }} />}</IslandBand>
      <EditorActionsRow>
        <Sub>Code view — coloured, not an editor. Appearance › File types › text.</Sub>
      </EditorActionsRow>
    </FileEdit>
  );
}

/** `ConfigEdit`: `settings.json` as the layer's JSON, parsed before it is written (`configSaveOf`). */
export function ConfigEdit({ doc, busy, context }: FileSurfaceProps): JSX.Element {
  const reading = isReading(context);
  const appearance = useEditorAppearance();
  const authoredText = useMemo(() => configAuthoredText(context.config, doc), [context.config, doc]);
  const draft = useDraftBox(context.drafts, context.onDraft, docKey(doc.layer, doc.path), authoredText);
  const [parseError, setParseError] = useState<string | null>(null);
  const save = (): void => {
    const out = configSaveOf(draft.text, doc.layer);
    if ("error" in out) {
      setParseError(out.error);
      return;
    }
    setParseError(null);
    context.onSaveConfig(out.layer, out.doc);
  };
  return (
    <FileEdit>
      <CodeArea
        value={reading ? authoredText : draft.text}
        readOnly={reading}
        appearance={appearance}
        onChange={(text) => {
          draft.set(text);
          setParseError(null);
        }}
      />
      {parseError !== null ? <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "bad" }}>not valid JSON: {parseError}</Txt> : null}
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
    </FileEdit>
  );
}
