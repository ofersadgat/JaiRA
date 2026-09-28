import { useEffect, useState, type JSX, type ReactNode } from "react";
import { ScrollView } from "react-native";
import { View } from "@tamagui/core";
import { listSchemas, propertiesOf, schemaById, type SchemaEntry, type SchemaFormat, type SchemaProperty, type ValidateSchemaResult } from "@jaira/shared/browser";
import { docKey, useDraftBox } from "@jaira/ui/drafts";
import { schemaFormatOf, useSchemaChoice } from "@jaira/ui/fileEditModel";
import { isReading, type FileSurfaceProps, type UiSurface } from "@jaira/ui/fileTypes";
import {
  ANY_KEY,
  REFERENCE_WIDTH,
  VALIDATE_DEBOUNCE_MS,
  addMissingTitle,
  fieldInside,
  plainSchemaLabel,
  referenceNote,
  referenceTitle,
  schemaSyntax,
  schemaVerdict,
} from "@jaira/ui/schemaEditorModel";
import { FOLD, PANE } from "@jaira/ui/uiState";
import { Island } from "../../islands";
import { Press, Txt, edge, lengthToken, scrollbarProps } from "../../primitives";
import { useTokens } from "../../tokens";
import { Checkbox } from "../form/inputs";
import { Select } from "../logs/Select";
import { Button } from "../settings/Button";
import { useEditorAppearance } from "./CodeEdit";
import { EditorActions, Sub } from "./EditorActions";
import { Splitter } from "./Splitter";

/**
 * `fileSurfaces.tsx`'s `JsonEdit` and the `SchemaJsonEditor` it draws, universal (decision 0015). The
 * text — the coloured layer, the textarea over it, the hints and the completion list — is the
 * desktop's own `SchemaTextStack`, an island (`client/island/schemaText.tsx`); the chrome around it is
 * drawn here, from `schemaEditorModel.ts` (the verdict, the words, the reference's shape) and
 * `fileEditModel.ts` (which schema, which syntax). The rules, from `styles.css`
 * (`cascade.mts '.schema-edit' --scene files-json`):
 *
 *   .file-edit.schema-edit   a column, gap 8, the half's height
 *   .edit-bar.schema-bar     row, centred, gap 8, wrapping
 *   .schema-pick             row, centred, gap 6: `.sub` "Schema" and a plain `select` (at most 200)
 *   .toggle.wrap-toggle      a label, inline: Chromium's checkbox at the label's width (its margins
 *                            3 3 3 4, so the box is drawn centred 4 in), and `.sub` "Wrap" wrapped
 *                            under it — the label is as wide as both on one line
 *   .chip                    app 10/12.5, --dim, 1px --line, round, padding 0 6; -ok/-bad in --ok/--bad
 *   .schema-hint             `.sub`, 4 closer to the bar (margin-top -4)
 *   .schema-body             row, the rest; .schema-main a column, gap 8, the rest
 *   .editor-stack            (the island) at least 140 tall
 *   .reason                  --bad, app 11/12.5
 *   .notice.bad.violation    --tint-bad, --bad, app 11/12.5, radius --control-radius, padding 7 9; its
 *                            path in bold data voice
 *   .schema-reference        the width the splitter writes (300), padding-left 10, scrolling; h4 700
 *                            at the body's size, 0 0 4 margin; its fields `dl.kv.schema-fields`
 */

/** `JsonEdit`: the editor with a draft, a save path, the schema choice and its remembered layout. */
export function JsonEdit({ doc, busy, onSave, context }: FileSurfaceProps): JSX.Element {
  const key = docKey(doc.layer, doc.path);
  const draft = useDraftBox(context.drafts, context.onDraft, key, doc.text);
  const chosen = useSchemaChoice(doc, context);
  const reading = isReading(context);
  return (
    <SchemaJsonEditor
      text={reading ? doc.text : draft.text}
      mime={doc.mime}
      format={schemaFormatOf(doc)}
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
      ui={context.ui}
    />
  );
}

export function SchemaJsonEditor({
  text,
  busy,
  onChange,
  onSave,
  dirty,
  onRevert,
  validate,
  format = "json",
  schemaId,
  onSchema,
  lockedSchema = false,
  readOnly = false,
  mime,
  wrap,
  onWrap,
  ui,
}: {
  text: string;
  busy: boolean;
  onChange: (text: string) => void;
  onSave?: (() => void) | undefined;
  dirty?: boolean;
  onRevert?: (() => void) | undefined;
  validate: (schemaId: string, text: string, format?: SchemaFormat) => Promise<ValidateSchemaResult | null>;
  format?: SchemaFormat;
  schemaId: string | null;
  onSchema: (schemaId: string | null) => void;
  lockedSchema?: boolean;
  readOnly?: boolean;
  mime?: string;
  wrap?: boolean;
  onWrap?: ((wrap: boolean) => void) | undefined;
  ui?: UiSurface | undefined;
}): JSX.Element {
  const t = useTokens();
  const appearance = useEditorAppearance();
  const [result, setResult] = useState<ValidateSchemaResult | null>(null);
  const [localWrap, setLocalWrap] = useState(false);
  const [localReference, setLocalReference] = useState(false);
  const [localWidth, setLocalWidth] = useState(REFERENCE_WIDTH);
  /** "Add missing fields", as a count the island's stack answers (`SchemaTextField`'s `fill`). */
  const [fill, setFill] = useState(0);
  const [height, setHeight] = useState(0);
  const [bodyWidth, setBodyWidth] = useState(0);

  const wrapping = wrap ?? localWrap;
  const setWrapping = (next: boolean): void => (onWrap ? onWrap(next) : setLocalWrap(next));
  // `schemaReferenceProps`, read through the same remembered layout.
  const showReference = ui !== undefined ? ui.open(FOLD.schemaReference, false) : localReference;
  const setShowReference = (next: boolean): void => (ui !== undefined ? ui.setOpen(FOLD.schemaReference, next) : setLocalReference(next));
  const width = ui !== undefined ? ui.pane(PANE.schemaReference, REFERENCE_WIDTH) : localWidth;
  const setWidth = (next: number): void => (ui !== undefined ? ui.setPane(PANE.schemaReference, next) : setLocalWidth(next));

  const entry = schemaId === null ? undefined : schemaById(schemaId);

  // The check, once the draft has stopped moving — the desktop's debounce.
  useEffect(() => {
    if (entry === undefined) {
      setResult(null);
      return;
    }
    const timer = setTimeout(() => {
      void validate(entry.id, text, format).then(setResult);
    }, VALIDATE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [entry, text, format, validate]);

  const parses = result?.parseError === undefined;
  const syntax = schemaSyntax(format);
  const plain = plainSchemaLabel(format);
  const verdict = schemaVerdict(result, syntax);
  const reference = showReference && entry !== undefined;

  return (
    <View flexDirection="column" flexGrow={1} flexShrink={1} flexBasis="auto" gap={8} minHeight={0} position="relative">
      <View flexDirection="row" alignItems="center" gap={8} flexWrap="wrap" flexShrink={0} minWidth={0}>
        {lockedSchema ? (
          <View flexDirection="row" alignItems="center" gap={6}>
            <Sub>Schema</Sub>
            <Chip>{entry?.label ?? plain}</Chip>
          </View>
        ) : (
          <View flexDirection="row" alignItems="center" gap={6}>
            <Sub>Schema</Sub>
            <Select
              value={schemaId ?? ""}
              label="Schema"
              options={[{ label: plain, value: "" }, ...listSchemas(format).map((option) => ({ label: option.label, value: option.id }))]}
              onChange={(v) => onSchema(v === "" ? null : v)}
            />
          </View>
        )}
        {entry !== undefined ? (
          <>
            <Button kind="ghost" onPress={() => setFill((n) => n + 1)} disabled={busy || !parses} title={addMissingTitle(entry, parses, syntax)}>
              Add missing fields
            </Button>
            <Button kind="ghost" onPress={() => setShowReference(!showReference)}>
              {showReference ? "Hide fields" : "Fields"}
            </Button>
            <Chip tone={verdict.tone}>{verdict.text}</Chip>
          </>
        ) : null}
        <WrapToggle on={wrapping} onChange={setWrapping} />
      </View>
      {entry !== undefined ? <Sub marginTop={-4}>{entry.hint}</Sub> : null}

      <View flexDirection="row" flexGrow={1} flexShrink={1} flexBasis="auto" minHeight={0} minWidth={0} onLayout={(e) => setBodyWidth(e.nativeEvent.layout.width)}>
        <View flexDirection="column" gap={8} flexGrow={1} flexShrink={1} flexBasis="auto" minWidth={0} minHeight={0}>
          <View flexGrow={1} flexShrink={1} flexBasis="auto" minHeight={140} onLayout={(e) => setHeight(Math.round(e.nativeEvent.layout.height))}>
            {height > 0 ? (
              <Island
                component="schemaText"
                height={height}
                appearance={appearance}
                props={{ text, readOnly, wrap: wrapping, schemaId, format, ...(mime !== undefined ? { mime } : {}), fill }}
                onEvent={(name, value) => {
                  if (name === "change") onChange(String(value));
                }}
              />
            ) : null}
          </View>
          {result?.parseError !== undefined ? (
            <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "bad" }} flexShrink={0}>
              not valid {syntax}: {result.parseError}
            </Txt>
          ) : (
            (result?.violations ?? []).map((violation, i) => (
              <View key={`${violation.path}-${i}`} flexShrink={0} backgroundColor={t.v("tint-bad") as never} borderRadius={lengthToken(t, "control-radius", 7)} paddingVertical={7} paddingHorizontal={9}>
                <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "bad" }}>
                  <Txt spec={{ voice: "data", scale: 1, weight: 700, color: "bad" }}>{violation.path.length > 0 ? violation.path : "(root)"}</Txt> — {violation.message}
                </Txt>
              </View>
            ))
          )}
        </View>
        {reference && entry !== undefined ? (
          <>
            <Splitter label="Resize the field reference" value={width} reset={REFERENCE_WIDTH} invert min={200} max={620} extent={bodyWidth} onChange={setWidth} />
            <SchemaReference entry={entry} width={width} />
          </>
        ) : null}
      </View>

      {onSave !== undefined ? <EditorActions {...(dirty !== undefined ? { dirty } : {})} busy={busy} onSave={onSave} onRevert={onRevert} /> : null}
    </View>
  );
}

/** `.chip`, and its -ok and -bad. */
function Chip({ tone = "plain", children }: { tone?: "plain" | "ok" | "bad"; children: ReactNode }): JSX.Element {
  const t = useTokens();
  const ink = tone === "plain" ? "dim" : tone;
  return (
    <View flexShrink={0} borderRadius={999} paddingHorizontal={6} {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }, tone === "plain" ? "line" : tone) as object)}>
      <Txt spec={{ voice: "app", scale: 10 / 12.5, color: ink }} numberOfLines={1}>
        {children}
      </Txt>
    </View>
  );
}

/**
 * `label.toggle.wrap-toggle`: an inline label holding the checkbox and "Wrap". It is as wide as the two
 * on one line (the checkbox's 20 with its margins, and the word), and the checkbox, `width: 100%` from
 * `input`'s rule, takes that whole width plus its margins — so the word wraps under it, and Chromium
 * draws the 13-square box centred in its wide one: 4 in from the label, at the label's middle.
 *
 * Lines at the body's 13/19.5: the first is the checkbox's (its border box above the baseline, 3 of
 * margin, the strut's descent below): 21.5; the second the word's, whose 11px run sits on the strut's
 * baseline, 3.5 below the line's top.
 */
function WrapToggle({ on, onChange }: { on: boolean; onChange: (next: boolean) => void }): JSX.Element {
  const t = useTokens();
  const size = t.v("size-app");
  const s = typeof size === "number" ? size / 12.5 : 1;
  return (
    // A box, not a button: the checkbox is its own button, and a button inside a button is markup a
    // browser rebuilds (and a press that toggles twice). The word beside it is the label's other half.
    <View flexShrink={0} flexDirection="column" alignItems="flex-start" {...({ title: "wrap long lines instead of scrolling sideways" } as object)}>
      {/* The label's width: both on one line, laid out and not drawn. */}
      <View flexDirection="row" height={0} overflow="hidden" aria-hidden>
        <View width={20} />
        <Sub numberOfLines={1}>Wrap</Sub>
      </View>
      <View alignSelf="stretch" height={21.5 * s} position="relative">
        <View position="absolute" top={0} left="50%" marginLeft={-6.5}>
          <Checkbox checked={on} onChange={onChange} label="Wrap" />
        </View>
      </View>
      <Press onPress={() => onChange(!on)} label="Wrap" marginTop={2.4 * s}>
        <Sub>Wrap</Sub>
      </Press>
    </View>
  );
}

/** A size stated against the app voice (`calc(var(--size-app) * f)`), as a scale of the data voice. */
function appAt(t: ReturnType<typeof useTokens>, f: number): number {
  const app = t.v("size-app");
  const data = t.v("size-data");
  return typeof app === "number" && typeof data === "number" && data > 0 ? (f * app) / data : (f * 12.5) / 12;
}

/** `SchemaReference`: every field the schema declares, expandable into the blocks they nest. */
function SchemaReference({ entry, width }: { entry: SchemaEntry; width: number }): JSX.Element {
  const t = useTokens();
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (at: string): void =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(at)) next.delete(at);
      else next.add(at);
      return next;
    });
  return (
    <ScrollView {...(scrollbarProps(t) as object)} style={{ flexGrow: 0, flexShrink: 0, width, minHeight: 0 }} contentContainerStyle={{ paddingLeft: 10 }}>
      <Txt spec={{ voice: "app", scale: 13 / 12.5, weight: 700 }} marginBottom={4}>
        {referenceTitle(entry)}
      </Txt>
      <Sub>{referenceNote(entry)}</Sub>
      <FieldList entry={entry} path={[]} open={open} onToggle={toggle} />
    </ScrollView>
  );
}

/**
 * `dl.kv.schema-fields`: a grid of two tracks — the names at least 118 and as wide as the widest, the
 * rest after — gap 4 10, app 12/12.5. The first track is shared by every row, so the names are laid
 * out once unseen to find it.
 */
function FieldList({ entry, path, open, onToggle, nested = false }: { entry: SchemaEntry; path: string[]; open: ReadonlySet<string>; onToggle: (at: string) => void; nested?: boolean }): JSX.Element {
  const properties = propertiesOf(entry, path);
  const [names, setNames] = useState(0);
  const track = Math.max(118, names);
  return (
    <View flexDirection="column" gap={4} {...(nested ? { marginTop: 2 } : {})}>
      <View position="absolute" opacity={0} height={0} overflow="hidden" alignItems="flex-start" onLayout={(e) => setNames(e.nativeEvent.layout.width)} aria-hidden>
        {properties.map((property) => (
          <FieldName key={property.key} entry={entry} path={path} property={property} open={open} onToggle={() => undefined} />
        ))}
      </View>
      {properties.map((property) => (
        <FieldRow key={property.key} entry={entry} path={path} property={property} open={open} onToggle={onToggle} track={track} />
      ))}
    </View>
  );
}

/** A `dt`: --dim, 3 above, never wrapping; ★ for an expected field, and the name — disclosing, when it holds more. */
function FieldName({ entry, path, property, open, onToggle }: { entry: SchemaEntry; path: string[]; property: SchemaProperty; open: ReadonlySet<string>; onToggle: (at: string) => void }): JSX.Element {
  const { at, hasChildren } = fieldInside(entry, path, property);
  const expanded = open.has(at);
  const code = { voice: "data", scale: 11 / 12 } as const;
  return (
    <View flexDirection="row" alignItems="baseline" paddingTop={3} flexShrink={0}>
      {property.expected ? <Txt spec={{ voice: "app", scale: 12 / 12.5, color: "dim" }}>★ </Txt> : null}
      {hasChildren ? (
        <Press onPress={() => onToggle(at)} flexDirection="row" alignItems="baseline" gap={3} {...({ "aria-expanded": expanded } as object)}>
          {({ hovered }) => (
            <>
              <Txt spec={{ ...code, color: "accent" }} {...(hovered ? { textDecorationLine: "underline" } : {})}>
                {expanded ? "▾" : "▸"}
              </Txt>
              <Txt spec={{ ...code, color: "accent" }} {...(hovered ? { textDecorationLine: "underline" } : {})} numberOfLines={1}>
                {property.key}
              </Txt>
            </>
          )}
        </Press>
      ) : (
        <Txt spec={{ ...code, color: "dim" }} numberOfLines={1}>
          {property.key}
        </Txt>
      )}
    </View>
  );
}

function FieldRow({ entry, path, property, open, onToggle, track }: { entry: SchemaEntry; path: string[]; property: SchemaProperty; open: ReadonlySet<string>; onToggle: (at: string) => void; track: number }): JSX.Element {
  const t = useTokens();
  const { here, at, perEntry } = fieldInside(entry, path, property);
  const expanded = open.has(at);
  return (
    <>
      <View flexDirection="row" gap={10}>
        <View width={track} flexShrink={0}>
          <FieldName entry={entry} path={path} property={property} open={open} onToggle={onToggle} />
        </View>
        {/* The `dd`: row, baseline, gap 6, wrapping. */}
        <View flex={1} minWidth={0} flexDirection="row" alignItems="baseline" gap={6} flexWrap="wrap">
          {property.type ? <Chip>{property.type}</Chip> : null}
          {/* `code.sub`: the data face at `.sub`'s size (the app's 11/12.5). */}
          {property.values ? <Txt spec={{ voice: "data", scale: appAt(t, 11 / 12.5), color: "dim" }}>{property.values.join(" · ")}</Txt> : null}
          {/* A flex item's leading space collapses, as the DOM's " description" does. */}
          {property.description ? <Sub>{property.description}</Sub> : null}
        </View>
      </View>
      {expanded ? (
        // `dd.nested`: the whole row, 2 0 6 10 outside, 8 in from a --line on its left.
        <View marginTop={2} marginBottom={6} marginLeft={10} paddingLeft={8} {...(edge(t, { left: 1 }) as object)}>
          {perEntry.length > 0 ? (
            <>
              <Sub>each entry — the key is yours to name</Sub>
              <FieldList entry={entry} path={[...here, ANY_KEY]} open={open} onToggle={onToggle} nested />
            </>
          ) : (
            <FieldList entry={entry} path={here} open={open} onToggle={onToggle} nested />
          )}
        </View>
      ) : null}
    </>
  );
}
