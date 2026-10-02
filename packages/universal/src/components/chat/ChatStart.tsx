import { useEffect, useState, type JSX } from "react";
import { ScrollView } from "react-native";
import { Text, View, isWeb } from "@tamagui/core";
import type { ChatPlanView, ChatSettings } from "@jaira/shared/browser";
import type { ChatSurface } from "@jaira/ui/chatSurface";
import { CHAT_SESSION } from "@jaira/ui/chatWorkflow";
import { startSentenceOf } from "@jaira/ui/environmentModel";
import type { FloatRect } from "@jaira/ui/floatPlace";
import { invoke } from "@jaira/ui/store";
import { PLAIN_SCROLLER, Txt, scrollbarProps } from "../../primitives";
import { useTokens } from "../../tokens";
import { ChatError } from "./ChatThread";
import { Icon } from "../panel/Icon";
import { Composer } from "./Composer";
import { useAnchorRect } from "./ComposerCards";
import { EnvironmentBar, EnvironmentList } from "./EnvironmentBar";
import { useChatEnvironment } from "./environment";
import { useMentions } from "@jaira/ui/chatMentions";

/**
 * The empty Chat room — say the first thing. There is no task yet, so the composer's plan is asked of
 * the STATE (`chat:startPlan`). How it looks:
 *
 *   the room             centred both ways, scrolls
 *   its middle           900 at most, padding 24 0
 *   the heading          app 500 20/12.5, padding 0 16, 4 under
 *   where it will run    --dim at 12.5/12.5, padding 0 16, 14 under; the part of it that is the choice
 *                        --accent with a dashed --accent line under it and a chevron (11) — pressed, it opens the
 *                        list the bar under the composer opens (`EnvironmentBar.tsx`), and the two and
 *                        the chip beside the title say the same choice
 */
export function ChatStart({ surface }: { surface: ChatSurface }): JSX.Element {
  const t = useTokens();
  // A conversation taken back to be said again brings what was picked for it.
  const [overrides, setOverrides] = useState<ChatSettings>(surface.startSettings ?? {});
  const [plan, setPlan] = useState<ChatPlanView | null>(null);
  const project = surface.project ?? undefined;
  const mentions = useMentions(surface.hasProject, project);
  const env = useChatEnvironment(surface);
  const where = startSentenceOf(env.view, surface.runOn, surface.hasProject);
  const [link, measure] = useAnchorRect();
  const [list, setList] = useState<FloatRect | null>(null);
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
        <View ref={link as never} collapsable={false} paddingHorizontal={16} marginBottom={14}>
          <Txt spec={{ voice: "app", scale: 1, color: "dim" }}>
            {where.before}
            {where.choice !== undefined ? (
              <Text
                color={t.v("accent") as never}
                onPress={() => measure((at) => setList((was) => (was === null ? at : null)))}
                {...({ role: "button", "aria-expanded": list !== null, cursor: "pointer", textDecorationLine: "underline", textDecorationStyle: "dashed", textDecorationColor: String(t.v("accent")) } as object)}
                // Clear of the descenders (web; a phone draws its own underline).
                {...((isWeb ? { style: { textUnderlineOffset: 4, textDecorationThickness: 1 } } : {}) as object)}
              >
                {where.choice}
                <View display={"inline-flex" as never} width={13} height={11} paddingLeft={2} {...((isWeb ? { style: { verticalAlign: -1 } } : {}) as object)}>
                  <Icon name="chevron" size={11} color={String(t.v("accent"))} />
                </View>
              </Text>
            ) : null}
            {where.after}
          </Txt>
        </View>
        {list !== null && env.view !== undefined ? (
          <EnvironmentList
            anchor={list}
            view={env.view}
            target={surface.runOn}
            onChoose={(target) => {
              setList(null);
              surface.onRunOn(target);
            }}
            onClose={() => setList(null)}
          />
        ) : null}
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
          tray={<EnvironmentBar view={env.view} stage={env.stage} onChoose={env.onChoose} />}
          {...mentions}
        />
      </View>
    </ScrollView>
  );
}
