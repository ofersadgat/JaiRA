import type { JSX } from "react";
import { View } from "@tamagui/core";
import { chatTitleOf } from "@jaira/ui/chatListModel";
import { Txt } from "../../primitives";
import { useTokens } from "../../tokens";
import { Icon } from "../panel/Icon";
import type { ChatListSurface } from "./ChatListPanel";

/**
 * The open conversation's name in the title bar: where the other rooms put their address, set as the
 * address's last crumb is. How it looks:
 *
 *   the title           row, centred, gap 7, padding 0 16; app 600 13/12.5, line 1.3, --text
 *   its glyph           14 square, --dim
 */
export function ChatTitle({ surface }: { surface: Pick<ChatListSurface, "conversations" | "taskId"> }): JSX.Element {
  const t = useTokens();
  return (
    <View flexDirection="row" alignItems="center" gap={7} minWidth={0} paddingHorizontal={16}>
      <Icon name="comment" size={14} color={String(t.v("dim"))} />
      <Txt spec={{ voice: "app", scale: 13 / 12.5, weight: 600, lineHeight: 1.3 }} ellip flexShrink={1} minWidth={0}>
        {chatTitleOf(surface.conversations, surface.taskId)}
      </Txt>
    </View>
  );
}
