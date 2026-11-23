import type { JSX } from "react";
import { View } from "@tamagui/core";
import { ChatStart } from "../components/chat/ChatStart";
import { ChatThread } from "../components/chat/ChatThread";
import { useChatSurface } from "../components/chat/surface";
import { ChatPanel } from "../components/chat/ChatPanel";
import { ArtifactInMain } from "./ArtifactInMain";
import { useSheetInset } from "./columnsFit";
import { Panes } from "./SplitPane";
import { usePhone } from "./phone";
import { ROOM, taskPaneEntryOf } from "@jaira/ui/splitModel";

/**
 * The Chat room: a conversation (on a computer, the path its pane stands on), or the offer to start one — then the side panel, which in this room is
 * the conversation's context (folded to its rail until opened). A row: the thread taking the width the
 * panel's splitter and column leave, or all of it while there is no panel.
 */
export function ChatView(): JSX.Element {
  const surface = useChatSurface();
  // Reading a conversation is what marks it read: its thread does it (`SeenWhileShown`), wherever it is drawn.
  // On a phone the panel is a sheet over the room: the thread stops above its head.
  const inset = useSheetInset();
  const phone = usePhone();
  return (
    <View flex={1} minWidth={0} minHeight={0} flexDirection="row">
      <Panes
        here={phone || surface.taskId === null ? ROOM : taskPaneEntryOf(surface.taskId, surface.project ?? undefined)}
        roomBox={{ paddingBottom: inset }}
        room={
          // On a computer the room's own view is the start page alone: a conversation is a path, drawn
          // as any pane draws it (`PaneBody`). A phone has no panes, and draws its thread here.
          phone ? (
            <>
              {surface.taskId === null ? <ChatStart surface={surface} /> : <ChatThread surface={surface} key={surface.taskId} />}
              <ArtifactInMain at={surface.taskId} />
            </>
          ) : (
            <ChatStart surface={surface} />
          )
        }
      />
      <ChatPanel surface={surface} />
    </View>
  );
}
