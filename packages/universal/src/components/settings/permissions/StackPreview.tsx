import { useState, type JSX, type ReactNode } from "react";
import { View as RNView } from "react-native";
import { View } from "@tamagui/core";
import { stackPreviewOf, type PreviewAnswer, type PreviewRow, type PreviewSet } from "@jaira/ui/stackPreviewModel";
import { setIconGlyph } from "@jaira/ui/permissionSetWords";
import { NO_STACK, Press, Txt, edge } from "../../../primitives";
import { useTokens } from "../../../tokens";
import { Checkbox } from "../../form/inputs";
import { ChipIcon, MenuRow, ModeChip, SubMenu, useAnchor } from "./rows";

/**
 * "Show it in a stack" (decision 0023 §4.3), under a set's card in Settings → Tools: a base picked from
 * the sets this layer can see, and what each line the set writes comes to over it — the base's answer,
 * the set's own, the result, and who said it. The rows are `stackPreviewModel.ts`'s; this draws them,
 * and the caller places it.
 *
 *   the head        row, centred, wraps, gap 8, margin 14 0 8: the box, `Show it in a stack` app 600 at
 *                   12/12.5, the base's chip, then `+ {set}, newest last` --tok-hint
 *   the base chip   row, gap 6, padding 3 9, radius 999, --panel-2 (hovered --panel-3): the set's icon,
 *                   its id in the data face with ` / ` between its parts, ⌄
 *   the table       1px --line, radius 8, clipped; a row: gap 10, padding 6 8, centred, a --panel-2 rule
 *                   above; columns 1.5 · 0.85 · 0.85 · 1.2; the head's row padding 4 8, its words --tok-hint
 *   a call          its subject in the data face 11.5/12, then where in --tok-hint
 *   comes to        the result's chip, then who said it in --tok-hint
 */
export function StackPreview({
  layer,
  sets,
  base,
  shown,
  onShown,
  onBase,
}: {
  /** The set shown, as the card has it now — draft and all. */
  layer: PreviewSet & { name: string };
  /** The sets this layer can see that may be its base, each with its icon. */
  sets: ReadonlyArray<PreviewSet & { name: string; icon: string }>;
  base: string | undefined;
  shown: boolean;
  onShown: (next: boolean) => void;
  onBase: (id: string) => void;
}): JSX.Element {
  const picked = sets.find((one) => one.id === base);
  const rows = shown && picked !== undefined ? stackPreviewOf(picked, layer) : [];
  return (
    <View flexDirection="column" gap={8} marginTop={14} minWidth={0}>
      <View flexDirection="row" alignItems="center" flexWrap="wrap" gap={8}>
        <Checkbox checked={shown} onChange={onShown} label="Show it in a stack" />
        <Press onPress={() => onShown(!shown)}>
          <Txt spec={{ voice: "app", scale: 12 / 12.5, weight: 600 }}>Show it in a stack</Txt>
        </Press>
        {shown ? <BasePicker sets={sets} picked={picked} onBase={onBase} /> : null}
        {shown && picked !== undefined ? <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "tok-hint" }}>{`+ ${layer.name}, newest last`}</Txt> : null}
      </View>
      {shown && picked !== undefined ? <PreviewTable rows={rows} baseName={picked.name} layerName={layer.name} /> : null}
      {shown && picked === undefined ? <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "tok-hint" }}>No other permission set to lay it on.</Txt> : null}
    </View>
  );
}

/** A set's id as the base chip reads it: `read-only`, `control / read-only`. */
const spaced = (id: string): string => id.split("/").join(" / ");

function BasePicker({ sets, picked, onBase }: { sets: ReadonlyArray<PreviewSet & { name: string; icon: string }>; picked: (PreviewSet & { icon: string }) | undefined; onBase: (id: string) => void }): JSX.Element {
  const t = useTokens();
  const [ref, measure] = useAnchor();
  const [at, setAt] = useState<{ x: number; y: number; w: number } | null>(null);
  return (
    <RNView ref={ref} collapsable={false} style={NO_STACK as never}>
      <Press
        onPress={() => (at !== null ? setAt(null) : measure(setAt))}
        title="the base: the set it is laid on"
        {...({ "aria-expanded": at !== null } as object)}
        flexDirection="row"
        alignItems="center"
        gap={6}
        paddingVertical={3}
        paddingHorizontal={9}
        borderRadius={999}
        box={({ hovered }) => ({ backgroundColor: t.v(hovered || at !== null ? "panel-3" : "panel-2") })}
      >
        <ChipIcon name={setIconGlyph(picked?.icon ?? "layers")} />
        <Txt spec={{ voice: "data", scale: 11 / 12, color: picked !== undefined ? "text" : "tok-hint" }}>{picked !== undefined ? spaced(picked.id) : "pick a base"}</Txt>
        <Txt spec={{ voice: "app", scale: 10 / 12.5, color: "tok-hint" }}>⌄</Txt>
      </Press>
      {at !== null ? (
        <SubMenu at={at} align="start" width={240} onClose={() => setAt(null)}>
          {sets.map((one) => (
            <MenuRow
              key={one.id}
              on={one.id === picked?.id}
              icon={setIconGlyph(one.icon)}
              name={spaced(one.id)}
              mono
              onPress={() => {
                onBase(one.id);
                setAt(null);
              }}
            />
          ))}
        </SubMenu>
      ) : null}
    </RNView>
  );
}

const COLUMNS = [1.5, 0.85, 0.85, 1.2] as const;

/** One cell, at its column's share of the row. */
function Cell({ at, children }: { at: number; children: ReactNode }): JSX.Element {
  return (
    <View flexGrow={COLUMNS[at]} flexShrink={1} flexBasis={0} minWidth={0} flexDirection="row" alignItems="center" flexWrap="wrap" gap={8}>
      {children}
    </View>
  );
}

function Said({ answer }: { answer: PreviewAnswer | undefined }): JSX.Element {
  if (answer === undefined) return <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "tok-hint" }}>says nothing</Txt>;
  return <ModeChip mode={answer.mode === "unavailable" ? undefined : answer.mode} unavailable={answer.mode === "unavailable"} />;
}

function PreviewTable({ rows, baseName, layerName }: { rows: readonly PreviewRow[]; baseName: string; layerName: string }): JSX.Element {
  const t = useTokens();
  const head = { voice: "app", scale: 11 / 12.5, color: "tok-hint" } as const;
  return (
    <View flexDirection="column" borderRadius={8} overflow="hidden" {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }) as object)}>
      <View flexDirection="row" alignItems="center" gap={10} paddingVertical={4} paddingHorizontal={8}>
        <Cell at={0}>
          <Txt spec={head}>Call</Txt>
        </Cell>
        <Cell at={1}>
          <Txt spec={head} ellip>{`${baseName} says`}</Txt>
        </Cell>
        <Cell at={2}>
          <Txt spec={head} ellip>{`${layerName} says`}</Txt>
        </Cell>
        <Cell at={3}>
          <Txt spec={head}>comes to</Txt>
        </Cell>
      </View>
      {rows.length === 0 ? (
        <View paddingVertical={6} paddingHorizontal={8} {...(edge(t, { top: 1 }, "panel-2") as object)}>
          <Txt spec={head}>It writes no line, so the base answers every call as it would alone.</Txt>
        </View>
      ) : (
        rows.map((row, i) => (
          <View key={`${row.subject}@${row.place ?? (row.where === "" ? "" : "elsewhere")}#${i}`} flexDirection="row" alignItems="center" gap={10} paddingVertical={6} paddingHorizontal={8} {...(edge(t, { top: 1 }, "panel-2") as object)}>
            <Cell at={0}>
              <Txt spec={{ voice: "data", scale: 11.5 / 12, lineHeight: 1.3 }}>{row.subject}</Txt>
              {row.where !== "" ? <Txt spec={head}>{row.where}</Txt> : null}
            </Cell>
            <Cell at={1}>
              <Said answer={row.base} />
            </Cell>
            <Cell at={2}>
              <Said answer={row.layer} />
            </Cell>
            <Cell at={3}>
              <ModeChip mode={row.result.mode === "unavailable" ? undefined : row.result.mode} unavailable={row.result.mode === "unavailable"} />
              <Txt spec={head}>{row.decidedBy}</Txt>
            </Cell>
          </View>
        ))
      )}
    </View>
  );
}
