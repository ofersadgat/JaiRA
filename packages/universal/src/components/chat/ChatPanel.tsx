import type { JSX } from "react";
import type { ChatSurface } from "@jaira/ui/chatSurface";
import { chatProjectOf } from "@jaira/ui/chatWorkflow";
import { PanelColumn } from "../../app/PanelColumn";
import { useShell } from "../../app/shell";

/**
 * The Chat room's side panel, beside the thread in `ChatView`: the conversation's context — what it
 * produced, what it changed, what is held out of it. Folded to its rail until opened. It is the one
 * panel column every room stands (`PanelColumn.tsx`), on this room's rule: the conversation the thread
 * is showing.
 */
export function ChatPanel({ surface }: { surface: ChatSurface }): JSX.Element | null {
  const { state } = useShell();
  return <PanelColumn chat={{ taskId: surface.taskId, project: surface.project ?? chatProjectOf(null, state.at), detail: surface.detail }} />;
}
