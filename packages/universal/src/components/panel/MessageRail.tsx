import { useEffect, useState, type JSX } from "react";
import { typeNameOf, type ContextReading, type ViewId } from "@jaira/shared/browser";
import type { JsonValue } from "@declarative-ai/json";
import { familyIcon } from "@jaira/ui/icons";
import { READING, copyTextOf, cutTitleOf, fullClockOf, readingMenuOf, stampOf, typeMenuOf, type messageReadingOf } from "@jaira/ui/messageReading";
import type { MessageEntry } from "@jaira/ui/transcript";
import type { EditMessage } from "@jaira/ui/transcriptView";
import { View, isWeb } from "@tamagui/core";
import { copyText } from "../../clipboard";
import { Press, Txt, lengthToken } from "../../primitives";
import { useTokens } from "../../tokens";
import { ContextMenu, MENU_WIDTH, type MenuAt } from "../Menu";
import { anchorRectOf } from "../floats/anchor";
import { Icon, type IconName } from "./Icon";
import { TurnContext } from "./TurnContext";
import { useValuePanel } from "@jaira/ui/valuePanel";

/**
 * `transcriptView.tsx`'s message rail, universal (decision 0015): what can be done to a message, what it
 * is, and when it was said — invisible at rest, shown under the pointer (or, on a phone, after a long
 * press on the message). The menus' rows, the tooltips and the clock are `messageReading.ts`'s, the
 * desktop's own. The rules:
 *
 *   .ts-rail       row, centred, gap 2, 4 above, padding 0 1, at least 22 tall, wraps, --dim; opacity 0
 *                  at rest; a user message's to the right
 *   .ts-act        padding 4, radius --control-radius-sm, the icon 13, --dim; hovered
 *                  --fill-ghost-hover and --text
 *   .ts-rail-cut   1 wide, the row's height less 3 each end, 5 each side, --line
 *   .ts-slot       data 10/12, --dim, 2 right
 *   .ts-type       row, gap 4, padding 2 6, 1px --line, radius --control-radius-sm, --panel, app
 *                  10.5/12.5 line 1.35, --dim (hovered --text; asserted: --accent, --accent 42% into
 *                  --line); its icon 12; `▾` 8, at .7.   .ts-read the same, 3 in (.on once a reading
 *                  was picked); each opens its menu under it, from its left edge, 3 below
 *   .ts-clock      data 10.5/12, tabular, --dim, padding 0 4
 *
 * The context reading after a turn is `TurnContext.tsx`. "…" offers "Open in context panel", which the
 * shell's `ValuePanelContext` pushes on the room's panel stack, as `App.tsx`'s does — and is not drawn
 * where there is no panel. On a phone there is no element to hang a menu from: it opens at the press.
 */
export function MessageRail({
  entry,
  value,
  reading,
  onPick,
  picked,
  shown,
  onEdit,
  types,
  contextBefore,
}: {
  entry: MessageEntry;
  value: JsonValue;
  reading: ReturnType<typeof messageReadingOf>;
  onPick: (view: ViewId) => void;
  /** A reading was picked on the rail (`.ts-read.on`). */
  picked: boolean;
  shown: boolean;
  onEdit: EditMessage | undefined;
  /** The reading on the answer before this one — what "+46% since the reply before" is measured from. */
  contextBefore?: ContextReading | undefined;
  types: {
    own: string | undefined;
    override: string | undefined;
    conversation: boolean;
    assert: (next: string, everywhere?: boolean) => void;
    clear: () => void;
  };
}): JSX.Element {
  const t = useTokens();
  const panel = useValuePanel();
  const [copied, setCopied] = useState(false);
  const [menu, setMenu] = useState<MenuAt | null>(null);
  // The tick goes back to being a copy icon on its own.
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(timer);
  }, [copied]);
  const said = entry.text !== undefined && entry.text.length > 0;
  const editable = onEdit !== undefined && entry.turn !== undefined && onEdit.can(entry.turn);
  const cut = onEdit !== undefined && entry.turn !== undefined ? onEdit.cut?.(entry.turn) : undefined;
  const { given, mime, named, views, view } = reading;
  const asserted = types.override !== undefined;
  const radius = lengthToken(t, "control-radius-sm", 6);
  const copy = (): void => {
    void copyText(copyTextOf(entry, value)).then((took) => took && setCopied(true));
  };
  /**
   * Where a chip's menu opens: under the chip and from its left edge (the "…" menu from its right), 3
   * below — the menu is about the control. A phone has no element to measure: at the press.
   */
  const at = (e: { currentTarget?: unknown; nativeEvent: { pageX: number; pageY: number } }, end = false): { x: number; y: number } => {
    const box = anchorRectOf(e.currentTarget);
    if (box === null) return { x: e.nativeEvent.pageX - (end ? MENU_WIDTH : 0), y: e.nativeEvent.pageY + 12 };
    return { x: end ? box.right - MENU_WIDTH : box.left, y: box.bottom + 3 };
  };
  const act = (icon: IconName, title: string, label: string, onPress: () => void): JSX.Element => (
    <Press
      key={label}
      onPress={onPress}
      title={title}
      label={label}
      padding={4}
      borderRadius={radius}
      flexShrink={0}
      box={({ hovered }) => ({ backgroundColor: hovered ? t.v("fill-ghost-hover") : "transparent" })}
    >
      {({ hovered }) => <Icon name={icon} size={13} color={String(t.v(hovered ? "text" : "dim"))} />}
    </Press>
  );
  const chip = { voice: "app" as const, scale: 10.5 / 12.5, lineHeight: 1.35 };
  return (
    <View
      flexDirection="row"
      alignItems="center"
      gap={2}
      marginTop={4}
      paddingHorizontal={1}
      minHeight={22}
      flexWrap="wrap"
      opacity={shown ? 1 : 0}
      {...(entry.role === "user" ? { justifyContent: "flex-end" } : {})}
    >
      {act(copied ? "check" : "copy", "Copy", "Copy", copy)}
      {editable ? act("pencil", "Edit", "Edit this message", () => onEdit.edit(entry.turn!, entry.text ?? "")) : null}
      {cut !== undefined && onEdit?.rewind !== undefined ? act("rewind", cutTitleOf("rewind", cut).title, cutTitleOf("rewind", cut).label, () => onEdit.rewind!(entry.turn!, entry.text ?? "")) : null}
      {cut !== undefined && onEdit?.fork !== undefined ? act("choice", cutTitleOf("fork", cut).title, cutTitleOf("fork", cut).label, () => onEdit.fork!(entry.turn!, entry.text ?? "")) : null}
      {said || entry.output !== undefined ? (
        <>
          <View width={1} alignSelf="stretch" marginVertical={3} marginHorizontal={5} backgroundColor={t.v("line") as never} />
          {entry.output?.name !== undefined ? (
            <Txt spec={{ voice: "data", scale: 10 / 12, color: "dim" }} paddingRight={2}>
              {entry.output.name}
            </Txt>
          ) : null}
          <Press
            onPress={(e) =>
              setMenu({
                ...at(e),
                title: "This text is",
                items: typeMenuOf({ entry, own: types.own, override: types.override, given, mime, conversation: types.conversation, assert: types.assert, clear: types.clear }),
              })
            }
            title={`${named.label} — ${mime}${asserted ? `, set by you (JaiRA said ${typeNameOf(given).label})` : ""}`}
            flexDirection="row"
            alignItems="center"
            gap={4}
            paddingVertical={2}
            paddingHorizontal={6}
            borderRadius={radius}
            borderWidth={1}
            borderStyle="solid"
            borderColor={(asserted ? t.mix(t.v("accent"), 42, t.v("line")) : t.v("line")) as never}
            backgroundColor={t.v("panel") as never}
          >
            {({ hovered }) => {
              const ink = asserted ? "accent" : hovered ? "text" : "dim";
              return (
                <>
                  <Icon name={familyIcon(named.family)} size={12} color={String(t.v(ink))} />
                  <Txt spec={{ ...chip, color: ink }} numberOfLines={1}>
                    {named.label}
                  </Txt>
                  <Txt spec={{ ...chip, color: ink }} fontSize={8} opacity={0.7}>
                    ▾
                  </Txt>
                </>
              );
            }}
          </Press>
          {views.length > 1 ? (
            <Press
              onPress={(e) => setMenu({ ...at(e), title: "Read it as", items: readingMenuOf(views, view, onPick) })}
              title={READING[view].hint}
              marginLeft={3}
              flexDirection="row"
              alignItems="center"
              gap={4}
              paddingVertical={2}
              paddingHorizontal={6}
              borderRadius={radius}
              borderWidth={1}
              borderStyle="solid"
              borderColor={(picked ? t.mix(t.v("accent"), 42, t.v("line")) : t.v("line")) as never}
              backgroundColor={t.v("panel") as never}
            >
              {({ hovered }) => {
                // `.ts-read.on` comes after `:hover`: a picked reading stays --accent under the pointer.
                const ink = picked ? "accent" : hovered ? "text" : "dim";
                return (
                  <>
                    <Txt spec={{ ...chip, color: ink }} numberOfLines={1}>
                      {READING[view].label}
                    </Txt>
                    <Txt spec={{ ...chip, color: ink }} fontSize={8} opacity={0.7}>
                      ▾
                    </Txt>
                  </>
                );
              }}
            </Press>
          ) : null}
        </>
      ) : null}
      <View flex={1} minWidth={0} />
      {entry.context !== undefined ? <TurnContext context={entry.context} before={contextBefore} /> : null}
      <Txt spec={{ voice: "data", scale: 10.5 / 12, color: "dim", tabular: true }} paddingHorizontal={4} numberOfLines={1} {...((isWeb && fullClockOf(entry.at) !== undefined ? { title: fullClockOf(entry.at) } : {}) as object)}>
        {stampOf(entry.at)}
      </Txt>
      {/* "What else can be done with this": open it in the context panel (`valuePanel.ts`), as the
          desktop's — only where there is a panel to open it in. */}
      {panel !== null ? (
        <Press
          onPress={(e) =>
            setMenu({
              ...at(e, true),
              items: [{ label: "Open in context panel", note: "keeps it on screen while you carry on", onSelect: () => panel.open({ title: entry.output?.name ?? (entry.role === "user" ? "Message" : "Answer"), value, hint: reading.hint }) }],
            })
          }
          title="What else can be done with this"
          padding={4}
          borderRadius={radius}
          flexShrink={0}
          box={({ hovered }) => ({ backgroundColor: hovered ? t.v("fill-ghost-hover") : "transparent" })}
        >
          {({ hovered }) => (
            <Txt spec={{ voice: "app", scale: 11 / 12.5, color: hovered ? "text" : "dim", lineHeight: 1 }} numberOfLines={1}>
              …
            </Txt>
          )}
        </Press>
      ) : null}
      {menu !== null ? <ContextMenu anchor={menu} onClose={() => setMenu(null)} /> : null}
    </View>
  );
}
