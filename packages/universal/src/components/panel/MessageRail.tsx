import { useEffect, useState, type JSX } from "react";
import type { ContextReading, ViewId } from "@jaira/shared/browser";
import type { JsonValue } from "@declarative-ai/json";
import { familyIcon } from "@jaira/ui/icons";
import { READING, copyTextOf, cutTitleOf, fullClockOf, readingMenuOf, stampOf, typeMenuOf, type messageReadingOf } from "@jaira/ui/messageReading";
import type { MessageEntry } from "@jaira/ui/transcript";
import type { EditMessage } from "@jaira/ui/transcriptView";
import { View, isWeb } from "@tamagui/core";
import { copyText } from "../../clipboard";
import { Press, Txt, lengthToken } from "../../primitives";
import { useTokens } from "../../tokens";
import { ContextMenu, type MenuAt } from "../Menu";
import { Icon, type IconName } from "./Icon";
import { TurnContext } from "./TurnContext";

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
 *                  --line); its icon 12; `▾` 8, at .7.   .ts-read the same, 3 in
 *   .ts-clock      data 10.5/12, tabular, --dim, padding 0 4
 *
 * The context reading after a turn is `TurnContext.tsx`. "…" offers "Open in context panel"
 * disabled: this shell has no value panel to open one in yet.
 */
export function MessageRail({
  entry,
  value,
  reading,
  onPick,
  shown,
  onEdit,
  types,
  contextBefore,
}: {
  entry: MessageEntry;
  value: JsonValue;
  reading: ReturnType<typeof messageReadingOf>;
  onPick: (view: ViewId) => void;
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
  const radius = lengthToken(t, "control-radius-sm", 6);
  const copy = (): void => {
    void copyText(copyTextOf(entry, value)).then((took) => took && setCopied(true));
  };
  const at = (e: { nativeEvent: { pageX: number; pageY: number } }): { x: number; y: number } => ({ x: e.nativeEvent.pageX, y: e.nativeEvent.pageY + 12 });
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
                items: typeMenuOf({ entry, own: types.own, override: types.override, given, mime, conversation: types.conversation, assert: types.assert, clear: types.clear }),
              })
            }
            title={`${named.label} — ${mime}`}
            flexDirection="row"
            alignItems="center"
            gap={4}
            paddingVertical={2}
            paddingHorizontal={6}
            borderRadius={radius}
            borderWidth={1}
            borderStyle="solid"
            borderColor={(types.override !== undefined ? t.mix(t.v("accent"), 42, t.v("line")) : t.v("line")) as never}
            backgroundColor={t.v("panel") as never}
          >
            {({ hovered }) => {
              const ink = types.override !== undefined ? "accent" : hovered ? "text" : "dim";
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
              onPress={(e) => setMenu({ ...at(e), items: readingMenuOf(views, view, onPick) })}
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
              borderColor={t.v("line") as never}
              backgroundColor={t.v("panel") as never}
            >
              {({ hovered }) => (
                <>
                  <Txt spec={{ ...chip, color: hovered ? "text" : "dim" }} numberOfLines={1}>
                    {READING[view].label}
                  </Txt>
                  <Txt spec={{ ...chip, color: hovered ? "text" : "dim" }} fontSize={8} opacity={0.7}>
                    ▾
                  </Txt>
                </>
              )}
            </Press>
          ) : null}
        </>
      ) : null}
      <View flex={1} minWidth={0} />
      {entry.context !== undefined ? <TurnContext context={entry.context} before={contextBefore} /> : null}
      <Txt spec={{ voice: "data", scale: 10.5 / 12, color: "dim", tabular: true }} paddingHorizontal={4} numberOfLines={1} {...((isWeb && fullClockOf(entry.at) !== undefined ? { title: fullClockOf(entry.at) } : {}) as object)}>
        {stampOf(entry.at)}
      </Txt>
      {/* "What else can be done with this": the context panel's, which this shell cannot open a value in yet. */}
      <Press
        onPress={(e) => setMenu({ x: e.nativeEvent.pageX - 232, y: e.nativeEvent.pageY + 12, items: [{ label: "Open in context panel", note: "not in this app yet", disabled: true, onSelect: () => undefined }] })}
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
      {menu !== null ? <ContextMenu anchor={menu} onClose={() => setMenu(null)} /> : null}
    </View>
  );
}
