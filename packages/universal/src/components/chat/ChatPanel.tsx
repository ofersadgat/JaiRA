import type { JSX } from "react";
import { View } from "@tamagui/core";
import { CHAT_PANEL_SUB, chatPanelTitleOf, chatTabs } from "@jaira/ui/panelFaceModel";
import { closeFoldsOf, panelGeometryOf, panelRuleOf, roomOf, usePanelStacks, useRoomRule } from "@jaira/ui/panelHost";
import { topOf, type PanelEntry } from "@jaira/ui/panelStack";
import { conversationInMainOf } from "@jaira/ui/panelHost";
import { Uncopied } from "../../app/Uncopied";
import { useShell } from "../../app/shell";
import { runMode } from "../../app/viewState";
import { edge } from "../../primitives";
import { useTokens } from "../../tokens";
import { Icon } from "../panel/Icon";
import { SidePanel, type PanelFace } from "../panel/SidePanel";
import type { ChatSurface } from "@jaira/ui/chatPane";
import { chatProjectOf } from "@jaira/ui/chatWorkflow";

/**
 * The Chat room's side panel (`aside.ctx-panel` beside `ChatView`, `App.tsx`; the `chat` entry's face in
 * `panelFaces.tsx`): the conversation's context — what it produced, what it changed, what is held out
 * of it. Folded to its rail until opened. The stack, the room's rule and the column's width are
 * `panelHost.ts`'s, the same code `App.tsx` runs; the tabs and words are `panelFaceModel.ts`'s. The
 * frame is the one `PanelColumn.tsx` draws for the Tasks room:
 *
 *   .ctx-panel     --panel, a --line on the left (--rule folded), clipped; the column's width
 *   .splitter      6 wide, a 2px --line down its middle (open only)
 *
 * {@link Uncopied}: the tabs' bodies (Produced, Changes, Held), and any entry but the conversation's own.
 */
export function ChatPanel({ surface }: { surface: ChatSurface }): JSX.Element | null {
  const t = useTokens();
  const { state, actions } = useShell();
  const ui = state.settings.ui;
  const room = roomOf(state.view);
  const { setStacks, onStack, panelStack } = usePanelStacks(room);
  const rule = room === null ? null : panelRuleOf(room, state, { taskId: surface.taskId, project: surface.project ?? chatProjectOf(null, state.at) }, conversationInMainOf(state, runMode.use()));
  useRoomRule(room, rule, undefined, setStacks);
  const top = topOf(panelStack);
  const geometry = panelGeometryOf(ui, room, top);
  const face = (entry: PanelEntry): PanelFace => {
    if (entry.kind !== "chat") return { title: entry.kind, titleText: entry.kind, body: <Uncopied name={`the ${entry.kind} panel`} flex={1} />, scroll: false };
    const title = chatPanelTitleOf(surface.detail);
    return {
      glyph: <Icon name="comment" size={13} color={String(t.v("dim"))} />,
      title,
      titleText: title,
      sub: CHAT_PANEL_SUB,
      // Nothing is held in this shell yet: the held list is `App.tsx`'s own state.
      tabs: chatTabs(0),
      tab: entry.tab,
      body: <Uncopied name={`the ${entry.tab} tab`} flex={1} />,
      scroll: false,
    };
  };
  if (top === undefined) return null;
  return (
    <>
      {geometry.open ? (
        <View width={6} flexShrink={0} alignItems="center">
          <View width={2} flex={1} backgroundColor={t.v("line") as never} />
        </View>
      ) : null}
      <View
        width={geometry.width}
        flexShrink={0}
        minHeight={0}
        flexDirection="column"
        overflow="hidden"
        backgroundColor={t.v("panel") as never}
        {...(edge(t, { left: 1 }, geometry.open ? "line" : "rule") as object)}
      >
        <SidePanel stack={panelStack} onStack={onStack} face={face} folded={!geometry.open} onFold={(folded) => geometry.foldKey !== null && actions.setFold(geometry.foldKey, !folded)} closeFolds={closeFoldsOf(panelStack)} />
      </View>
    </>
  );
}
