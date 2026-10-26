import { useEffect, useState, type JSX } from "react";
import { ScrollView } from "react-native";
import { Text, View, isWeb } from "@tamagui/core";
import type { ChatPlanView, ChatSettings } from "@jaira/shared/browser";
import type { ChatSurface } from "@jaira/ui/chatSurface";
import { startSentenceOf } from "@jaira/ui/environmentModel";
import type { FloatRect } from "@jaira/ui/floatPlace";
import { invoke } from "@jaira/ui/store";
import { PLAIN_SCROLLER, Txt, scrollbarProps } from "../../primitives";
import { useTokens } from "../../tokens";
import { ChatError } from "./ChatThread";
import { Icon } from "../panel/Icon";
import { Composer } from "./Composer";
import { ContextMenu, type MenuAt } from "../Menu";
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
 *   what it runs         only while the workflow a conversation runs is DISABLED here (decision 0021): the
 *                        same line and the same dashed choice, "choose a workflow" until one is picked —
 *                        pressed, the menu "Run this conversation as": the workflows that can be one, the
 *                        disabled one greyed. Until a pick the composer is off; the pick is this one's alone
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
  // What it runs: the settings' workflow, or — that one disabled here — the one picked for this conversation.
  const start = surface.start;
  const [runAs, setRunAs] = useState<string | null>(null);
  const [runMenu, setRunMenu] = useState<MenuAt | null>(null);
  const [runLink, measureRun] = useAnchorRect();
  const runs = runAs ?? start.workflow;
  const picked = runAs !== null ? start.choices.find((c) => c.stateId === runAs) : undefined;
  useEffect(() => {
    let live = true;
    void invoke("chat:startPlan", { stateId: runs, overrides, ...(project !== undefined ? { project } : {}) })
      .then((next) => live && setPlan(next))
      .catch(() => live && setPlan(null));
    return () => {
      live = false;
    };
  }, [project, overrides, runs]);
  const openRunMenu = (): void =>
    measureRun((at) =>
      setRunMenu((was) =>
        was !== null
          ? null
          : {
              x: at.left,
              y: at.bottom + 3,
              title: "Run this conversation as",
              items: [
                ...start.choices.map((choice) => ({ label: choice.label ?? choice.stateId, note: choice.stateId, checked: choice.stateId === runAs, onSelect: () => setRunAs(choice.stateId) })),
                { label: start.label ?? start.workflow, note: "disabled here", disabled: true, onSelect: () => undefined },
              ],
            },
      ),
    );
  const choiceLink = (words: string, onPress: () => void, open: boolean): JSX.Element => (
    <Text
      color={t.v("accent") as never}
      onPress={onPress}
      {...({ role: "button", "aria-expanded": open, cursor: "pointer", textDecorationLine: "underline", textDecorationStyle: "dashed", textDecorationColor: String(t.v("accent")) } as object)}
      // Clear of the descenders (web; a phone draws its own underline).
      {...((isWeb ? { style: { textUnderlineOffset: 4, textDecorationThickness: 1 } } : {}) as object)}
    >
      {words}
      <View display={"inline-flex" as never} width={13} height={11} paddingLeft={2} {...((isWeb ? { style: { verticalAlign: -1 } } : {}) as object)}>
        <Icon name="chevron" size={11} color={String(t.v("accent"))} />
      </View>
    </Text>
  );
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
            {where.choice !== undefined ? choiceLink(where.choice, () => measure((at) => setList((was) => (was === null ? at : null))), list !== null) : null}
            {where.after}
          </Txt>
        </View>
        {start.disabled ? (
          <View ref={runLink as never} collapsable={false} paddingHorizontal={16} marginTop={-8} marginBottom={14}>
            <Txt spec={{ voice: "app", scale: 1, color: "dim" }}>
              {`${start.label ?? start.workflow} is disabled ${surface.hasProject ? "in this project" : "here"}, so choose what this conversation runs: `}
              {choiceLink(picked !== undefined ? (picked.label ?? picked.stateId) : "choose a workflow", openRunMenu, runMenu !== null)}
            </Txt>
          </View>
        ) : null}
        {runMenu !== null ? <ContextMenu anchor={runMenu} onClose={() => setRunMenu(null)} /> : null}
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
          onSend={(message) => void surface.onNew(message, overrides, runAs ?? undefined)}
          {...(start.disabled && runAs === null ? { disabled: "choose what this conversation runs, above" } : {})}
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
