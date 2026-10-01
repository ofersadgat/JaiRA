import { useMemo } from "react";
import type { ChatSurface } from "@jaira/ui/chatSurface";
import { chatSurfaceOf, conversationsAt } from "@jaira/ui/chatSurface";
import { hueOf } from "@jaira/ui/pillModel";
import { useShell } from "../../app/shell";

/**
 * The Chat room's surface, assembled from the shell's state (`chatSurface.ts`): the conversations
 * here, the open one, and the verbs on them. For the room, its drawers and its title.
 */
export function useChatSurface(): ChatSurface {
  const { state, actions } = useShell();
  const conversations = useMemo(
    () => conversationsAt({ at: state.at, allConversations: state.allConversations, tasks: state.tasks }),
    [state.at, state.allConversations, state.tasks],
  );
  const hues = useMemo(() => Object.fromEntries(state.projects.map((p, i) => [p.project, hueOf(p.kind, i)])), [state.projects]);
  const names = useMemo(() => Object.fromEntries(state.projects.map((p) => [p.project, p.label])), [state.projects]);
  return chatSurfaceOf(state, actions, { conversations, hues, names });
}
