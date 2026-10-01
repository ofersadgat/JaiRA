import { Children, type JSX, type ReactNode } from "react";
import { View } from "@tamagui/core";
import { DEFAULT_MEDIA_TYPE, SLOT_TYPES, type SlotType, type SlotTypeName } from "@jaira/shared/browser";
import { NO_ISSUES, type FormIssues } from "@jaira/ui/issues";
import { slotValueOf, useRunReading } from "@jaira/ui/reading";
import { emptySlotRow, type SlotRow } from "@jaira/ui/slotForm";
import {
  DEFAULT_PLACEHOLDER,
  DEFAULT_TITLE,
  LINKED_LIST_TITLE,
  LIST_TITLE,
  MEDIA_TITLE,
  OPTIONAL_TITLE,
  SPREAD_TITLE,
  SPREAD_WORDS,
  bindingHeadOf,
  bindingPlaceholderOf,
  bindingTitleOf,
  linkedRows,
  linkedTypeWords,
  linkedWrapper,
  namePlaceholderOf,
  nameTitleOf,
  slotMarksOf,
  slotMoreShown,
  slotPathOf,
  slotTypeHint,
  slotTypeShapeOf,
  slotTypeWords,
  summarizeSchema,
} from "@jaira/ui/slotTableModel";
import { Txt, edge } from "../../primitives";
import { useTokens } from "../../tokens";
import { Box, Details, FieldName, Pick, ROW, SlotOpt, SlotOptWords, SlotsHead, SmallButton, Sub, markOf, useLists, useReadOnly, useReading, type Mark } from "./controls";
import { LinkInput, LinkPreview, LinkToggle, ReadValue } from "./Links";

/**
 * The workflow editor's one table for `inputs`, `outputs` and an operation's `input`/`output` — a row
 * per slot (name, type, binding, optional, ✕), its default & description under it, and in a reading
 * the value the run put through it. What each row says and which box a diagnostic marks is
 * `slotTableModel.ts`'s. How it looks:
 *
 *   the table           column, gap 5, a --line over it and 8 under that; every child but the heading 11 in
 *   a row               a grid: minmax(0, 1fr) minmax(0, 1.3fr) minmax(0, 1.4fr) auto [auto], gap 5,
 *                       centred — drawn as a row of {@link Grid} tracks, an empty track still spaced
 *   the columns' heads  app 10/12.5, 0.06em, upper, --dim, 1 under; each cell one line, cut with …
 *   a row's boxes       padding 3 6, app 12/12.5
 *   the type            row, centred, gap 4; its select grows and shrinks from the whole width, the
 *                       media type's box 1 1 60
 *   a type in words     data 11/12, --dim, one line (a reading: wraps)
 *   a slot's group      column, gap 3, 4 under; after another, a --line over it and 6 more above
 *   what hangs under    8 in, 9 more, a 2px --dim 30% rule on its left
 *   a row of controls   row, centred, gap 5; each 1 1 auto (a field 1 1 0), min 0
 */

/** One track of a {@link Grid}: a share of what is left (`minmax(0, Nfr)`), or as wide as it is (`auto`). */
export type Track = number | "auto";

/**
 * A one-row CSS grid, as flex: every track is there whether or not it has a child — an empty `auto`
 * track is nothing wide but still has a gap before it, which is what lines a table's head up with its
 * rows in a reading.
 */
export function Grid({ tracks, children, gap = 5, ...box }: { tracks: readonly Track[]; children: ReactNode; gap?: number } & Record<string, unknown>): JSX.Element {
  const cells = Children.toArray(children);
  return (
    <View flexDirection="row" alignItems="center" gap={gap} minWidth={0} {...box}>
      {tracks.map((track, i) => (
        <View key={i} {...(track === "auto" ? { flexGrow: 0, flexShrink: 0, flexBasis: "auto" } : { flexGrow: track, flexShrink: 1, flexBasis: 0, minWidth: 0 })} justifyContent="center">
          {cells[i] ?? null}
        </View>
      ))}
    </View>
  );
}

const SLOT_TRACKS = (optional: boolean): Track[] => (optional ? [1, 1.3, 1.4, "auto", "auto"] : [1, 1.3, 1.4, "auto"]);

/** A type in words: data 11/12 --dim — one line, or wrapping in a reading. */
function TypeWords({ children, title, mark = "" }: { children: string; title?: string | undefined; mark?: Mark }): JSX.Element {
  const reading = useReading();
  return (
    <Txt spec={{ voice: "data", scale: 11 / 12, color: mark === "bad" ? "bad" : mark === "warn" ? "warn" : "dim", ...(mark !== "" ? { weight: 600 } : {}) }} {...(reading ? {} : { numberOfLines: 1, ellipsizeMode: "tail" })} {...({ title } as object)}>
      {children}
    </Txt>
  );
}

/** A slot's type: the vocabulary, a `list of` toggle and an artifact's media type — or the type in words. */
export function SlotTypePicker({
  row,
  targets,
  mark = "",
  onChange,
  onLink,
}: {
  row: SlotRow;
  targets?: readonly string[];
  mark?: string;
  onChange: (type: SlotType) => void;
  onLink?: (ref: string | null) => void;
}): JSX.Element {
  const readOnly = useReadOnly();
  const m = markOf(mark);
  const shape = slotTypeShapeOf(row);
  if (shape === "spread") return <TypeWords title={SPREAD_TITLE} mark={m}>{SPREAD_WORDS}</TypeWords>;
  if (shape === "linked") {
    const wrapped = linkedWrapper(row);
    if (onLink === undefined) return <TypeWords title={`${row.typeRef} — a linked type; edit it on the JSON tab`} mark={m}>{linkedTypeWords(row)}</TypeWords>;
    return (
      <View flexDirection="row" alignItems="center" gap={3} minWidth={0}>
        <View flexGrow={1} flexShrink={1} flexBasis="100%" minWidth={0}>
          <LinkInput value={row.typeRef ?? ""} targets={targets ?? []} placeholder="$/types/markdown" mark={m} size={ROW} onChange={(ref) => onLink(ref)} />
        </View>
        <SlotOpt checked={wrapped.list} onChange={(list) => onChange({ ...wrapped, list })} title={LINKED_LIST_TITLE}>
          list
        </SlotOpt>
        <LinkToggle linked onToggle={() => onLink(null)} />
      </View>
    );
  }
  if (shape === "custom") return <TypeWords title={`${row.schemaText} — edit it on the JSON tab`} mark={m}>{summarizeSchema(row.schemaText)}</TypeWords>;
  const type = row.type!;
  if (readOnly) return <TypeWords title={slotTypeHint(type)} mark={m}>{slotTypeWords(type)}</TypeWords>;
  return (
    <View flexDirection="row" alignItems="center" gap={4} minWidth={0}>
      <Pick
        value={type.name}
        options={SLOT_TYPES.map((t) => ({ value: t.name, label: t.label }))}
        size={ROW}
        mark={m}
        title={slotTypeHint(type)}
        flexGrow={1}
        flexShrink={1}
        flexBasis="100%"
        onChange={(v) => {
          const name = v as SlotTypeName;
          onChange({ name, list: type.list, ...(name === "artifact" ? { mediaType: type.mediaType ?? DEFAULT_MEDIA_TYPE } : {}) });
        }}
      />
      <SlotOpt checked={type.list} onChange={(list) => onChange({ ...type, list })} title={LIST_TITLE}>
        list
      </SlotOpt>
      {type.name === "artifact" ? (
        <Box value={type.mediaType ?? ""} onChange={(mediaType) => onChange({ ...type, mediaType })} placeholder={DEFAULT_MEDIA_TYPE} size={ROW} title={MEDIA_TITLE} flexGrow={1} flexShrink={1} flexBasis={60} width="auto" />
      ) : null}
      {onLink !== undefined ? <LinkToggle linked={false} onToggle={() => onLink("")} /> : null}
    </View>
  );
}

/** A slot's group: one row and what hangs under it; after the first, a --line over it. */
export function SlotGroup({ first, children, box = false }: { first: boolean; children: ReactNode; box?: boolean }): JSX.Element {
  const t = useTokens();
  if (box) {
    // A child's group is a card: --panel-2, 1px --line, radius 6, padding 6 7; 6 apart.
    return (
      <View flexDirection="column" gap={3} paddingVertical={6} paddingHorizontal={7} borderRadius={6} backgroundColor={t.v("panel-2") as never} {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }) as object)} {...(first ? {} : { marginTop: 6 })}>
        {children}
      </View>
    );
  }
  return (
    <View flexDirection="column" gap={3} paddingBottom={4} {...(first ? {} : { paddingTop: 6, ...edge(t, { top: 1 }) })}>
      {children}
    </View>
  );
}

/** What hangs under a group's row: 8 in (4 on a child's card), 9 more, a 2px --dim 30% rule on its left. */
export function Hung({ children, inCard = false }: { children: ReactNode; inCard?: boolean }): JSX.Element {
  const t = useTokens();
  return (
    <View flexDirection="column" marginLeft={inCard ? 4 : 8} paddingLeft={9} {...(edge(t, { left: 2 }, t.tint("dim", 30)) as object)}>
      {children}
    </View>
  );
}

/** Controls side by side: a row, centred, gap 5; each control 1 1 auto (a field 1 1 0), min 0. */
export function RowControls({ children, fields = [] }: { children: ReactNode; fields?: readonly boolean[] }): JSX.Element {
  const cells = Children.toArray(children);
  return (
    <View flexDirection="row" alignItems="center" gap={5} minWidth={0}>
      {cells.map((cell, i) => (
        <View key={i} minWidth={0} flexGrow={1} flexShrink={1} flexBasis={fields[i] === true ? 0 : "auto"}>
          {cell}
        </View>
      ))}
    </View>
  );
}

/** A control with its name over it in a reading (a field: a column, gap 4), and bare in a form. */
function Boxed({ readOnly, label, children }: { readOnly: boolean; label: string; children: ReactNode }): JSX.Element {
  return readOnly ? (
    <View flexDirection="column" gap={4} minWidth={0}>
      <FieldName>{label}</FieldName>
      {children}
    </View>
  ) : (
    <>{children}</>
  );
}

export function SlotTable({
  title,
  rows,
  optional = false,
  bindingHint,
  targets,
  emptyBindingMeans,
  path,
  issues = NO_ISSUES,
  onChange,
}: {
  title: string;
  rows: SlotRow[];
  optional?: boolean;
  bindingHint: string;
  targets: readonly string[];
  bindingListId?: string | undefined;
  emptyBindingMeans?: string;
  path?: string;
  issues?: FormIssues;
  onChange: (rows: SlotRow[]) => void;
}): JSX.Element | null {
  const t = useTokens();
  const readOnly = useReadOnly();
  const reading = useRunReading();
  const lists = useLists();
  const edit = (index: number, patch: Partial<SlotRow>): void => onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  // A table with nothing in it would be a heading over the word "none": a form needs that (it is where
  // the first row is added), a reading is better off not mentioning the table.
  if (readOnly && rows.length === 0) return null;
  const tracks = SLOT_TRACKS(optional);
  return (
    <View flexDirection="column" gap={5} paddingTop={8} {...(edge(t, { top: 1 }) as object)}>
      <SlotsHead title={title}>
        {readOnly ? null : (
          <SmallButton weight={600} onPress={() => onChange([...rows, emptySlotRow()])}>
            + Add
          </SmallButton>
        )}
      </SlotsHead>
      {rows.length === 0 ? (
        <Sub marginLeft={11}>none declared</Sub>
      ) : (
        <>
          <Grid tracks={tracks} marginLeft={11} paddingBottom={1}>
            {[
              <Head key="n">Name</Head>,
              <Head key="t">Type</Head>,
              <Head key="b">{bindingHeadOf(emptyBindingMeans)}</Head>,
              ...(optional ? [<View key="o" />] : []),
              ...(readOnly ? [] : [<View key="x" />]),
            ]}
          </Grid>
          {rows.map((row, i) => {
            const rowPath = slotPathOf(path, row);
            const { typeMark, bindingMark } = slotMarksOf(issues, rowPath);
            const value = slotValueOf(reading, path, row.name, row.binding);
            const more = slotMoreShown(readOnly, row.default.length > 0, row.description.length > 0, value);
            const controls = (
              <RowControls fields={[value !== undefined, readOnly, readOnly]}>
                {value !== undefined ? <ReadValue value={value} /> : null}
                {readOnly && row.default.length === 0 ? null : (
                  <Boxed readOnly={readOnly} label="default">
                    <Box value={row.default} onChange={(d) => edit(i, { default: d })} placeholder={DEFAULT_PLACEHOLDER} title={DEFAULT_TITLE} />
                  </Boxed>
                )}
                {readOnly && row.description.length === 0 ? null : (
                  <Boxed readOnly={readOnly} label="description">
                    <Box value={row.description} onChange={(d) => edit(i, { description: d })} placeholder="description" />
                  </Boxed>
                )}
              </RowControls>
            );
            return (
              <View key={i} marginLeft={11}>
                <SlotGroup first={i === 0}>
                  <Grid tracks={tracks}>
                    {[
                      <Box key="n" value={row.name} onChange={(name) => edit(i, { name })} placeholder={namePlaceholderOf(optional)} size={ROW} title={nameTitleOf(row)} />,
                      <SlotTypePicker key="t" row={row} targets={targets} mark={typeMark} onChange={(type) => edit(i, { type })} onLink={(ref) => onChange(linkedRows(rows, i, ref))} />,
                      <Box
                        key="b"
                        value={row.binding}
                        onChange={(binding) => edit(i, { binding })}
                        placeholder={bindingPlaceholderOf(row, emptyBindingMeans, bindingHint)}
                        size={ROW}
                        listed={lists.bindings}
                        mark={markOf(bindingMark)}
                        disabled={row.structured === true}
                        title={bindingTitleOf(row, emptyBindingMeans)}
                      />,
                      ...(optional
                        ? [
                            readOnly ? (
                              <SlotOptWords key="o">{row.optional ? "optional" : ""}</SlotOptWords>
                            ) : (
                              <SlotOpt key="o" checked={row.optional} onChange={(o) => edit(i, { optional: o })} title={OPTIONAL_TITLE}>
                                opt
                              </SlotOpt>
                            ),
                          ]
                        : []),
                      ...(readOnly
                        ? []
                        : [
                            <SmallButton key="x" title="remove" onPress={() => onChange(rows.filter((_, j) => j !== i))}>
                              ✕
                            </SmallButton>,
                          ]),
                    ]}
                  </Grid>
                  {!more ? null : readOnly ? (
                    <Hung>
                      <View marginTop={4}>{controls}</View>
                    </Hung>
                  ) : (
                    <Hung>
                      <Details summary="default & description" open={row.default.length > 0 || row.description.length > 0}>
                        {controls}
                      </Details>
                    </Hung>
                  )}
                  {row.typeRef !== undefined && row.typeRef.length > 0 ? <LinkPreview reference={row.typeRef} /> : null}
                </SlotGroup>
              </View>
            );
          })}
        </>
      )}
    </View>
  );
}

/** A column's head: app 10/12.5, 0.06em, upper, --dim, one line, cut with …. */
function Head({ children }: { children: string }): JSX.Element {
  return (
    <Txt spec={{ voice: "app", scale: 10 / 12.5, ls: 0.06, upper: true, color: "dim" }} numberOfLines={1} ellipsizeMode="tail">
      {children}
    </Txt>
  );
}
