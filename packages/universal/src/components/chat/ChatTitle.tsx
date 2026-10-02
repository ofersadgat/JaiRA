import { useState, type JSX } from "react";
import { View as RNView } from "react-native";
import { View } from "@tamagui/core";
import type { ChatSurface } from "@jaira/ui/chatSurface";
import { chatTitleOf } from "@jaira/ui/chatListModel";
import { barFactsOf, titleChipOf } from "@jaira/ui/environmentModel";
import type { FloatRect } from "@jaira/ui/floatPlace";
import { NO_DRAG, NO_STACK, Press, Txt } from "../../primitives";
import { useTokens } from "../../tokens";
import { MachineIcon } from "../MachineIcon";
import { Icon } from "../panel/Icon";
import { useAnchorRect } from "./ComposerCards";
import { EnvironmentList } from "./EnvironmentBar";
import { useChatEnvironment } from "./environment";

/**
 * The open conversation's name in the title bar: where the other rooms put their address, set as the
 * address's last crumb is — and beside it where the conversation runs (decision 0013 §5): the machine's
 * icon and `machine / workspace`, the same choice the bar under the composer states. While it is still
 * the person's to choose (before the first message, or while it waits) the chip opens the same list.
 * How it looks:
 *
 *   the title           row, centred, gap 7, padding 0 16; app 600 13/12.5, line 1.3, --text
 *   its glyph           14 square, --dim
 *   where it runs       a chip, 3 after the title: row, centred, gap 7, padding 2 9 2 7, 1px --line
 *                       (dashed while nothing is decided), round; the machine's icon 14, its words app
 *                       11/12.5 --text (--dim while nothing is decided), a ⌄ 11 when it opens the list;
 *                       hovered --fill-ghost-hover
 */
export function ChatTitle({ surface }: { surface: Pick<ChatSurface, "conversations" | "taskId" | "project" | "queued" | "runOn" | "detail" | "onRunOn"> }): JSX.Element {
  const t = useTokens();
  const env = useChatEnvironment(surface);
  const chip = titleChipOf(barFactsOf(env.view, env.stage));
  const [ref, measure] = useAnchorRect();
  const [open, setOpen] = useState<FloatRect | null>(null);
  const opens = chip !== undefined && chip.open && env.onChoose !== undefined;
  const target = env.stage.kind === "choosing" ? env.stage.target : env.stage.kind === "running" ? undefined : env.stage.queued.target;
  const inside =
    chip === undefined ? null : (
      <>
        <MachineIcon face={chip.face} size={14} ground="panel" />
        <Txt spec={{ voice: "app", scale: 11 / 12.5, color: chip.dashed ? "dim" : "text" }} numberOfLines={1}>
          {chip.text}
        </Txt>
        {opens ? <Icon name="chevron" size={11} color={String(t.v("dim"))} /> : null}
      </>
    );
  const box = { flexDirection: "row", alignItems: "center", gap: 7, paddingVertical: 2, paddingLeft: 7, paddingRight: 9, borderWidth: 1, borderStyle: chip?.dashed === true ? "dashed" : "solid", borderColor: t.v("line"), borderRadius: 999 } as const;
  return (
    <View flexDirection="row" alignItems="center" gap={7} minWidth={0} paddingHorizontal={16}>
      <Icon name="comment" size={14} color={String(t.v("dim"))} />
      <Txt spec={{ voice: "app", scale: 13 / 12.5, weight: 600, lineHeight: 1.3 }} ellip flexShrink={1} minWidth={0}>
        {chatTitleOf(surface.conversations, surface.taskId)}
      </Txt>
      {chip !== undefined ? (
        <RNView ref={ref} collapsable={false} style={{ flexShrink: 0, marginLeft: 3, ...NO_STACK, ...NO_DRAG } as never}>
          {opens ? (
            <Press onPress={() => measure((at) => setOpen((was) => (was === null ? at : null)))} label="Where this conversation runs" {...({ "aria-expanded": open !== null } as object)} {...(box as object)} box={({ hovered }) => ({ backgroundColor: hovered || open !== null ? t.v("fill-ghost-hover") : "transparent" })}>
              {inside}
            </Press>
          ) : (
            <View testID="chat-where" {...(box as object)}>{inside}</View>
          )}
        </RNView>
      ) : null}
      {open !== null && env.view !== undefined && env.onChoose !== undefined ? (
        <EnvironmentList
          anchor={open}
          view={env.view}
          target={target}
          onChoose={(next) => {
            setOpen(null);
            env.onChoose?.(next);
          }}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </View>
  );
}
