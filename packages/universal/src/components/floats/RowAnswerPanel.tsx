import { useState, type JSX } from "react";
import { View, isWeb } from "@tamagui/core";
import { middleOut, shortFile, type LayerOption, type RowChoice, type RowPanel, type RowReachItem, type WhereOption } from "@jaira/ui/approvalModel";
import type { FloatRect } from "@jaira/ui/floatPlace";
import { Press, Txt, lengthToken } from "../../primitives";
import { useTokens } from "../../tokens";
import { MenuLayer } from "../MenuLayer";
import { Icon } from "../panel/Icon";
import { Button } from "../settings/Button";
import { anchorRectOf } from "./anchor";
import { HINT, Hint, Rule, Segments, widthSegments } from "./AnswerMenu";
import { Float } from "./Float";

/**
 * One row's own answer (decision 0023 ruling 7, design 4D), opened by the row's `asks ⌄`: choices that
 * answer nothing — WHAT (the part's widths), WHERE (its place widths) and HOW FAR (Once, For this run,
 * Add to a layer of the stack, with the line it would write) — then Deny and Allow, and pressing one
 * answers the row at the reach chosen. What it draws is `approvalModel.ts`'s `rowPanel`. Over
 * everything in the `MenuLayer` (a modal on a phone, where it opens on the press it always did), under
 * the pill, end-aligned. How it looks:
 *
 *   the card               column, gap 1, padding 4, 1px --line, radius 9, --panel, a 0 10 28 shadow at
 *                          28% black; 390 to 490 wide (at most 86% of the window)
 *   what and where         column, gap 5, padding 5 7 7; each label a hint (app 10.5/12.5, --tok-hint),
 *                          the second 3 further down; each a segmented choice (`Segments`)
 *   a rule                 1 tall, 3 4 margins, --line
 *   how far                its label a hint, padding 4 7 2; then a radio per reach: a row from the top
 *                          left, gap 9, padding 6 8, radius 7; hovered --text at 7%. The radio 12 round,
 *                          1px --line, centred on the name; chosen, a 4px --accent ring. Its name app 12/12.5 at 500,
 *                          line 1.3; its hint under it, app 10.5/12.5, --tok-hint, what would be written
 *                          in bold. A reach that cannot be had: half opacity, its reason as its title.
 *   the layer picker       inside `Add to`, after its name, gap 6: app 11/12.5 at 600 on a line of 1.5,
 *                          padding 0 7, round, --accent on --accent 13%, a 10 chevron; it opens the
 *                          stack's layers newest first under it, each its name over its file, a shipped
 *                          preset also "changes that set for everyone who uses it"
 *   a note                 padding 4 7 5, app 10.5/12.5, line 1.4, --tok-hint
 *   the answers            a row, end-aligned, gap 8, padding 6 8 8: `Deny` (danger) then `Allow`
 *                          (primary); a row answered by hand also starts with a quiet `Ask again`
 */
export function RowAnswerPanel({
  anchor,
  panel,
  answered,
  onChoose,
  onAnswer,
  onReset,
  onClose,
}: {
  anchor: FloatRect | null;
  panel: RowPanel;
  /** The row holds an answer given by hand: `Ask again` takes it back. */
  answered: boolean;
  onChoose: (choice: Partial<RowChoice>) => void;
  onAnswer: (decision: "allow" | "deny") => void;
  onReset: () => void;
  onClose: () => void;
}): JSX.Element {
  const t = useTokens();
  const [picker, setPicker] = useState<FloatRect | null | false>(false);
  const box = {
    minWidth: 390,
    maxWidth: isWeb ? "min(490px, 86vw)" : 490,
    flexDirection: "column",
    gap: 1,
    padding: 4,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: t.v("line"),
    borderRadius: 9,
    backgroundColor: t.v("panel"),
    boxShadow: "0 10px 28px rgba(0, 0, 0, 0.28)",
    role: "dialog",
    "aria-label": "Answer this part",
    testID: "approval-row-panel",
  };
  const body = (
    <>
      {panel.what !== undefined || panel.where !== undefined ? (
        <>
          <View flexDirection="column" gap={5} paddingTop={5} paddingHorizontal={7} paddingBottom={7}>
            {panel.what !== undefined ? (
              <>
                <Txt spec={HINT}>Answer what</Txt>
                <View flexDirection="row">
                  <Segments label="Answer what" options={widthSegments(panel.what)} chosen={panel.what.chosen} onChoose={(width) => onChoose({ width })} testID="approval-row-what" />
                </View>
              </>
            ) : null}
            {panel.where !== undefined ? (
              <>
                <Txt spec={HINT} marginTop={panel.what !== undefined ? 3 : 0}>
                  Where
                </Txt>
                <WhereChoices options={panel.where.options} chosen={panel.where.chosen} onChoose={(place) => onChoose({ place })} />
              </>
            ) : null}
          </View>
          <Rule />
        </>
      ) : null}
      <View paddingTop={4} paddingHorizontal={7} paddingBottom={2}>
        <Txt spec={HINT}>How far</Txt>
      </View>
      <View role="radiogroup" aria-label="How far" flexDirection="column" gap={1}>
        {panel.reach.map((item) => (
          <ReachRadio
            key={item.reach}
            item={item}
            on={panel.chosenReach === item.reach}
            onPress={() => onChoose({ reach: item.reach })}
            layer={item.reach === "add" && item.disabled === undefined ? panel.chosenLayer : undefined}
            onPicker={(at) => {
              onChoose({ reach: "add" });
              setPicker(at);
            }}
          />
        ))}
      </View>
      {panel.notes.length > 0 ? (
        <>
          <Rule />
          {panel.notes.map((note) => (
            <Txt key={note} spec={{ voice: "app", scale: 10.5 / 12.5, lineHeight: 1.4, color: "tok-hint" }} paddingTop={4} paddingHorizontal={7} paddingBottom={5}>
              {note}
            </Txt>
          ))}
        </>
      ) : null}
      <Rule />
      <View flexDirection="row" alignItems="center" gap={8} paddingTop={6} paddingHorizontal={8} paddingBottom={8}>
        {answered ? (
          <Button kind="quiet" onPress={onReset} testID="approval-row-reset" title="Put this row back to asking">
            Ask again
          </Button>
        ) : null}
        <View flexGrow={1} />
        <Button kind="danger" onPress={() => onAnswer("deny")} testID="approval-row-deny">
          Deny
        </Button>
        <Button kind="primary" onPress={() => onAnswer("allow")} testID="approval-row-allow">
          Allow
        </Button>
      </View>
    </>
  );
  return (
    <MenuLayer onClose={onClose}>
      {anchor === null ? (
        <View position="absolute" left={8} right={8} bottom={8} {...(box as object)}>
          {body}
        </View>
      ) : (
        <Float anchor={anchor} side="below" align="end" {...box}>
          {body}
        </Float>
      )}
      {picker !== false ? (
        <LayerPicker
          anchor={picker}
          layers={panel.layers}
          chosen={panel.chosenLayer?.key}
          onChoose={(key) => {
            onChoose({ reach: "add", layer: key });
            setPicker(false);
          }}
          onClose={() => setPicker(false)}
        />
      ) : null}
    </MenuLayer>
  );
}

/**
 * WHERE's choices. A place is a path or a host as long as it is, so these do not share the width as
 * `Segments` do: each sizes to its words and the row wraps onto more lines when they do not fit, the
 * chips of a line growing to fill it. A place longer than a choice can hold is cut in the middle
 * (`middleOut`), the whole place its title. The choices are radios.
 *
 *   the choices    row, wrapping, gap 4
 *   a choice       grows from its words; 1px --line, radius --control-radius, --panel, padding 4 9;
 *                  app 11/12.5 at 500, --dim, one line; on: --accent at 13% and a --accent edge, 650,
 *                  --text; hovered --text at 7%
 */
function WhereChoices({ options, chosen, onChoose }: { options: readonly WhereOption[]; chosen: string; onChoose: (key: string) => void }): JSX.Element {
  const t = useTokens();
  return (
    <View flexDirection="row" flexWrap="wrap" gap={4} minWidth={0} role="radiogroup" aria-label="Where" testID="approval-row-where">
      {options.map((option) => {
        const on = chosen === option.key;
        const shown = middleOut(option.label);
        const title = option.title === option.label ? option.label : `${option.label} — ${option.title}`;
        return (
          <Press
            key={option.key}
            onPress={() => onChoose(option.key)}
            title={title}
            flexGrow={1}
            flexShrink={1}
            flexBasis="auto"
            minWidth={0}
            maxWidth="100%"
            flexDirection="row"
            alignItems="center"
            justifyContent="center"
            paddingVertical={4}
            paddingHorizontal={9}
            borderWidth={1}
            borderStyle="solid"
            borderRadius={lengthToken(t, "control-radius", 7)}
            box={({ hovered }) => ({
              borderColor: t.v(on ? "accent" : "line"),
              backgroundColor: on ? t.mix(t.v("accent"), 13, "transparent") : hovered ? t.mix(t.v("text"), 7, "transparent") : t.v("panel"),
            })}
            {...((isWeb ? { role: "radio", "aria-checked": on } : {}) as object)}
          >
            <Txt spec={{ voice: "app", scale: 11 / 12.5, weight: on ? 650 : 500, color: on ? "text" : "dim" }} ellip {...((isWeb ? { whiteSpace: "nowrap" } : {}) as object)}>
              {shown}
            </Txt>
          </Press>
        );
      })}
    </View>
  );
}

/** One reach, as a radio: its name (and, for `Add to`, the layer it writes), its hint under it. */
function ReachRadio({ item, on, onPress, layer, onPicker }: { item: RowReachItem; on: boolean; onPress: () => void; layer: LayerOption | undefined; onPicker: (at: FloatRect | null) => void }): JSX.Element {
  const t = useTokens();
  const disabled = item.disabled !== undefined;
  // The layer pill is a button of its own, so it sits BESIDE the radio's button, never inside it (a
  // button in a button is no HTML); the hint under them presses the radio too.
  const [hovered, setHovered] = useState(false);
  const hover = isWeb && !disabled ? { onMouseEnter: () => setHovered(true), onMouseLeave: () => setHovered(false) } : {};
  return (
    <View
      {...(hover as object)}
      flexDirection="column"
      gap={1}
      paddingVertical={6}
      paddingHorizontal={8}
      borderRadius={7}
      backgroundColor={(hovered ? t.mix(t.v("text"), 7, "transparent") : "transparent") as never}
      {...(disabled ? { opacity: 0.5, ...(isWeb ? { title: item.disabled } : {}) } : {})}
    >
      <View flexDirection="row" alignItems="center" gap={6} flexWrap="wrap">
        <Press
          onPress={onPress}
          disabled={disabled}
          testID={`approval-row-reach-${item.reach}`}
          fill={false}
          flexDirection="row"
          alignItems="center"
          gap={9}
          {...((isWeb ? { role: "radio", "aria-checked": on, "aria-disabled": disabled } : {}) as object)}
        >
          <View width={12} height={12} flexShrink={0} borderRadius={999} borderStyle="solid" borderWidth={on ? 4 : 1} borderColor={t.v(on ? "accent" : "line") as never} />
          <Txt spec={{ voice: "app", scale: 12 / 12.5, weight: 500, lineHeight: 1.3, color: on ? "text" : "dim" }}>{item.name}</Txt>
        </Press>
        {layer !== undefined ? <LayerPill layer={layer} onPress={onPicker} /> : null}
      </View>
      {item.hint.length > 0 ? (
        <Press onPress={onPress} disabled={disabled} focusable={false} fill={false} marginLeft={21} minWidth={0}>
          <Txt spec={HINT} {...((isWeb ? { style: { overflowWrap: "anywhere" } } : {}) as object)}>
            <Hint hint={item.hint} spec={HINT} />
          </Txt>
        </Press>
      ) : null}
    </View>
  );
}

/** `build-safe ⌄`: the layer `Add to` writes into, opening the stack's layers to choose another. */
function LayerPill({ layer, onPress }: { layer: LayerOption; onPress: (at: FloatRect | null) => void }): JSX.Element {
  const t = useTokens();
  const ink = String(t.v("accent"));
  return (
    <Press
      onPress={(e) => onPress(anchorRectOf(isWeb ? (e as unknown as { currentTarget: unknown }).currentTarget : undefined))}
      label={`Add to ${layer.name}: choose the layer`}
      title={`${layer.id} — ${layer.file}`}
      testID="approval-row-layer"
      {...((isWeb ? { "aria-haspopup": "menu" } : {}) as object)}
      flexDirection="row"
      alignItems="center"
      gap={3}
      paddingHorizontal={7}
      borderRadius={999}
      fill={false}
      box={({ hovered }) => ({ backgroundColor: t.mix(t.v("accent"), hovered ? 20 : 13, "transparent") })}
    >
      <Txt spec={{ voice: "app", scale: 11 / 12.5, weight: 600, lineHeight: 1.5, color: "accent" }}>{layer.name}</Txt>
      <Icon name="chevron" size={10} color={ink} />
    </Press>
  );
}

/** The stack's layers newest first, each file of it — what `Add to` can write into. */
function LayerPicker({ anchor, layers, chosen, onChoose, onClose }: { anchor: FloatRect | null; layers: readonly LayerOption[]; chosen: string | undefined; onChoose: (key: string) => void; onClose: () => void }): JSX.Element {
  const t = useTokens();
  const box = {
    minWidth: 260,
    maxWidth: isWeb ? "min(420px, 86vw)" : 420,
    flexDirection: "column",
    gap: 1,
    padding: 4,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: t.v("line"),
    borderRadius: 9,
    backgroundColor: t.v("panel"),
    boxShadow: "0 10px 28px rgba(0, 0, 0, 0.28)",
    role: "menu",
  };
  const body = layers.map((layer) => {
    const on = layer.key === chosen;
    return (
      <Press
        key={layer.key}
        onPress={() => onChoose(layer.key)}
        testID={`approval-row-layer-${layer.key}`}
        flexDirection="row"
        alignItems="flex-start"
        gap={8}
        paddingVertical={5}
        paddingHorizontal={7}
        borderRadius={7}
        {...((isWeb ? { role: "menuitemradio", "aria-checked": on } : {}) as object)}
        box={({ hovered }) => ({ backgroundColor: on ? t.mix(t.v("accent"), 13, "transparent") : hovered ? t.mix(t.v("text"), 7, "transparent") : "transparent" })}
      >
        <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "ok" }} width={10} flexShrink={0}>
          {on ? "✓" : ""}
        </Txt>
        <View flexDirection="column" gap={1} minWidth={0} flexShrink={1}>
          <Txt spec={{ voice: "app", scale: 12 / 12.5, weight: 500, lineHeight: 1.25, color: "text" }}>
            {layer.name} <Txt spec={{ voice: "data", scale: 10.5 / 12, color: "tok-hint" }}>{layer.id}</Txt>
          </Txt>
          <Txt spec={HINT}>
            {shortFile(layer.file)}
            {layer.everyone ? " — changes that set for everyone who uses it" : ""}
          </Txt>
        </View>
      </Press>
    );
  });
  return (
    <MenuLayer onClose={onClose} z={1001}>
      {anchor === null ? (
        <View position="absolute" left={8} right={8} bottom={8} {...(box as object)}>
          {body}
        </View>
      ) : (
        <Float anchor={anchor} side="below" align="start" {...box}>
          {body}
        </Float>
      )}
    </MenuLayer>
  );
}
