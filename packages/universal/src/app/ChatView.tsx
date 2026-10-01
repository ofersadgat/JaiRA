import type { JSX } from "react";
import { useReadMark } from "@jaira/ui/chatThreadModel";
import { View } from "@tamagui/core";
import { ChatStart } from "../components/chat/ChatStart";
import { ChatThread } from "../components/chat/ChatThread";
import { useChatSurface } from "../components/chat/surface";
import { ChatPanel } from "../components/chat/ChatPanel";

/**
 * The Chat room: a conversation, or the offer to start one — then the side panel, which in this room is
 * the conversation's context (folded to its rail until opened). A row: the thread taking the width the
 * panel's splitter and column leave, or all of it while there is no panel.
 */
export function ChatView(): JSX.Element {
  const surface = useChatSurface();
  // Reading a conversation is what marks it read (`useReadMark`).
  useReadMark(surface);
  return (
    <View flex={1} minWidth={0} minHeight={0} flexDirection="row">
      <View flex={1} minWidth={0} minHeight={0}>
        {surface.taskId === null ? <ChatStart surface={surface} /> : <ChatThread surface={surface} key={surface.taskId} />}
      </View>
      <ChatPanel surface={surface} />
    </View>
  );
}
