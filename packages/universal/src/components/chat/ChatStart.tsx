import { useEffect, useState, type JSX } from "react";
import { ScrollView } from "react-native";
import { View, isWeb } from "@tamagui/core";
import type { ChatPlanView, ChatSettings } from "@jaira/shared/browser";
import type { ChatSurface } from "@jaira/ui/chatSurface";
import { CHAT_SESSION } from "@jaira/ui/chatWorkflow";
import { chatStartWhereOf } from "@jaira/ui/chatListModel";
import { invoke } from "@jaira/ui/store";
import { PLAIN_SCROLLER, Txt, scrollbarProps } from "../../primitives";
import { useTokens } from "../../tokens";
import { ChatError } from "./ChatThread";
import { Composer } from "./Composer";
import { useMentions } from "@jaira/ui/chatMentions";

/**
 * The empty Chat room — say the first thing. There is no task yet, so the composer's plan is asked of
 * the STATE (`chat:startPlan`). How it looks:
 *
 *   the room             centred both ways, scrolls
 *   its middle           900 at most, padding 24 0
 *   the heading          app 500 20/12.5, padding 0 16, 4 under
 *   where it will run    --dim at 12.5/12.5, padding 0 16, 14 under
 */
export function ChatStart({ surface }: { surface: ChatSurface }): JSX.Element {
  const t = useTokens();
  const [overrides, setOverrides] = useState<ChatSettings>({});
  const [plan, setPlan] = useState<ChatPlanView | null>(null);
  const project = surface.project ?? undefined;
  const mentions = useMentions(surface.hasProject, project);
  useEffect(() => {
    let live = true;
    void invoke("chat:startPlan", { stateId: CHAT_SESSION, overrides, ...(project !== undefined ? { project } : {}) })
      .then((next) => live && setPlan(next))
      .catch(() => live && setPlan(null));
    return () => {
      live = false;
    };
  }, [project, overrides]);
  return (
    <ScrollView
      {...(scrollbarProps(t) as object)}
      style={{ flex: 1, minHeight: 0, ...PLAIN_SCROLLER } as never}
      contentContainerStyle={{ flexGrow: 1, alignItems: "center", justifyContent: "center", ...PLAIN_SCROLLER } as never}
    >
      <View width="100%" maxWidth={900} paddingVertical={24}>
        <Txt spec={{ voice: "app", scale: 20 / 12.5, weight: 500 }} paddingHorizontal={16} marginBottom={4}>
          What are we doing?
        </Txt>
        <Txt spec={{ voice: "app", scale: 1, color: "dim" }} paddingHorizontal={16} marginBottom={14}>
          {chatStartWhereOf(surface.hasProject)}
        </Txt>
        {surface.error !== null ? <ChatError text={surface.error} /> : null}
        <Composer
          plan={plan}
          busy={surface.busy}
          overrides={overrides}
          onOverrides={setOverrides}
          placeholder="Ask for a change, or a question about the code…"
          draftKey={`chat:new:${project ?? ""}`}
          onSend={(message) => void surface.onNew(message, overrides)}
          onSavePermissionSet={(request) => invoke("permissionSet:save", { ...request, ...(project !== undefined ? { project } : {}) })}
          // With no project open this runs in JaiRA's own root, which has no "this project" to keep in.
          saveLayers={surface.hasProject ? ["project", "base"] : ["base"]}
          {...mentions}
        />
      </View>
    </ScrollView>
  );
}
