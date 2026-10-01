import type { JSX } from "react";
import type { JsonValue } from "@declarative-ai/json";
import { View } from "@tamagui/core";
import { mimeOfPath } from "@jaira/shared/browser";
import { LINK_PLACEHOLDER, UNRESOLVED_NOTE, isUnresolvedLink, linkPreviewTitle, linkToggleTitle, linkToggleWords, useLinkPreview, valueTextOf } from "@jaira/ui/linkModel";
import { Press, Txt, edge, lengthToken } from "../../primitives";
import { useTokens } from "../../tokens";
import { ValueView } from "../panel/ValueView";
import { Box, FieldName, Sub, useLists, useReadOnly, type ControlSize, type Mark } from "./controls";

/**
 * A linked value in the workflow editor: the link toggle, the box a linked value shows instead of its
 * own control, what the linked file says under it, and the value a run put through a slot. What they
 * say and decide is `linkModel.ts`'s. How they look:
 *
 *   the toggle            a small ghost button, app 11/12.5, padding 2 8, 6 in from what it follows, at
 *                         0.7 (hovered 1); linked, an --accent ring and text at 1
 *   the linked box        data 11.5/12; naming nothing, ringed --warn with a --warn note under it
 *   the preview           column, 4 above, a 2px --rule on its left, 8 in; its bar a row, centred,
 *                         gap 5, padding 1 4, 4 out to the left, radius 5 (hovered --fill-ghost-hover);
 *                         the bar's caret app 10/12.5 --dim; its body padding 4 0 2, at most 320 tall
 *   the run's value       a field, its name in --accent; the box at the data size × 11.5/12, pre-wrap,
 *                         padding 6 9, 1px --line, radius --control-radius, --panel-2, at most 260 tall
 */

/** The link/unlink toggle — a chain glyph and the word. Nothing in a reading. */
export function LinkToggle({ linked, disabled = false, onToggle }: { linked: boolean; disabled?: boolean; onToggle: (linked: boolean) => void }): JSX.Element | null {
  const t = useTokens();
  if (useReadOnly()) return null;
  return (
    <Press
      onPress={() => onToggle(!linked)}
      disabled={disabled}
      title={linkToggleTitle(linked)}
      flexDirection="row"
      alignItems="center"
      justifyContent="center"
      flexShrink={0}
      marginLeft={6}
      paddingVertical={2}
      paddingHorizontal={8}
      borderWidth={1}
      borderStyle="solid"
      borderRadius={lengthToken(t, "control-radius-sm", 6)}
      box={({ hovered }) => ({
        opacity: disabled ? 0.5 : linked || hovered ? 1 : 0.7,
        backgroundColor: hovered && !disabled ? t.v("fill-ghost-hover") : "transparent",
        borderColor: t.v(linked ? "accent" : hovered && !disabled ? "rule" : "line"),
      })}
    >
      {/* A small button's face and padding: app 11/12.5, and 2 8 on the box above. */}
      <Txt spec={{ voice: "app", scale: 11 / 12.5, color: linked ? "accent" : "text" }} numberOfLines={1}>
        {linkToggleWords(linked)}
      </Txt>
    </Press>
  );
}

/** The box a linked value shows instead of its own control, and the advisory note when it names nothing. */
export function LinkInput({
  value,
  targets,
  placeholder,
  mark = "",
  size,
  onChange,
  ...layout
}: {
  value: string;
  targets: readonly string[];
  placeholder?: string;
  mark?: Mark;
  size?: ControlSize;
  onChange: (value: string) => void;
} & Record<string, unknown>): JSX.Element {
  const unresolved = isUnresolvedLink(value, targets);
  const lists = useLists();
  return (
    <>
      <Box value={value} onChange={onChange} placeholder={placeholder ?? LINK_PLACEHOLDER} voice="data" dataScale={11.5 / 12} listed={lists.links} mark={mark !== "" ? mark : unresolved ? "warn" : ""} {...(size !== undefined ? { size } : {})} {...layout} />
      {unresolved ? <Sub color="warn">{UNRESOLVED_NOTE}</Sub> : null}
    </>
  );
}

/** The target of one link, read-only, under the control that names it — shown in the app's own value view. */
export function LinkPreview({ reference }: { reference: string }): JSX.Element | null {
  const t = useTokens();
  const preview = useLinkPreview(reference);
  if (preview === null) return null;
  const { at, text, open, toggle } = preview;
  return (
    <View flexDirection="column" alignItems="stretch" width="100%" marginTop={4} paddingLeft={8} {...(edge(t, { left: 2 }, "rule") as object)}>
      <Press
        onPress={toggle}
        title={linkPreviewTitle(at.path, open)}
        flexDirection="row"
        alignItems="center"
        justifyContent="flex-start"
        width="100%"
        gap={5}
        paddingVertical={1}
        paddingHorizontal={4}
        marginLeft={-4}
        borderRadius={5}
        box={({ hovered }) => ({ backgroundColor: hovered ? t.v("fill-ghost-hover") : "transparent" })}
      >
        <Txt spec={{ voice: "app", scale: 10 / 12.5, color: "dim" }} flexShrink={0}>
          {open ? "▾" : "▸"}
        </Txt>
        <Sub>what {reference} says</Sub>
      </Press>
      {open ? (
        <View maxHeight={320} overflow="hidden" paddingTop={4} paddingBottom={2}>
          {text === "reading" ? (
            <Txt spec={{ voice: "app", scale: 13 / 12.5, color: "dim" }} paddingVertical={8} marginVertical={t.scaled("size-app", 13 / 12.5) as number}>
              Reading…
            </Txt>
          ) : text === null ? (
            <Txt spec={{ voice: "app", scale: 13 / 12.5, color: "dim" }} paddingVertical={8} marginVertical={t.scaled("size-app", 13 / 12.5) as number}>
              Nothing readable at {at.path}.
            </Txt>
          ) : (
            <ValueView value={text} hint={{ mime: mimeOfPath(at.path) }} />
          )}
        </View>
      ) : null}
    </View>
  );
}

/** The value a binding actually produced, in the row that declares it — nothing where there is none. */
export function ReadValue({ value, ...layout }: { value: JsonValue | undefined } & Record<string, unknown>): JSX.Element | null {
  const t = useTokens();
  if (value === undefined) return null;
  return (
    <View flexDirection="column" gap={4} minWidth={0} {...layout}>
      <FieldName accent>value</FieldName>
      <View
        minWidth={0}
        maxHeight={260}
        overflow="hidden"
        paddingVertical={6}
        paddingHorizontal={9}
        borderRadius={lengthToken(t, "control-radius", 7)}
        backgroundColor={t.v("panel-2") as never}
        {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }) as object)}
      >
        {/* The value: the data SIZE (× 11.5/12) in the app voice, not the data face. */}
        <Txt spec={{ voice: "app", scale: (11.5 / 12) * (12 / 12.5) }} {...({ style: { whiteSpace: "pre-wrap", overflowWrap: "anywhere" } } as object)}>
          {valueTextOf(value)}
        </Txt>
      </View>
    </View>
  );
}
