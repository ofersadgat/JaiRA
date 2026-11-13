import { useMemo } from "react";
import type { ChatSurface } from "@jaira/ui/chatSurface";
import { chatSurfaceOf, conversationsAt } from "@jaira/ui/chatSurface";
import { hueOf } from "@jaira/ui/pillModel";
import { inScope, placesOf, scopeOf } from "@jaira/ui/scopeModel";
import { groupOf, groupProjects } from "@jaira/ui/workspaceGroups";
import { useShell } from "../../app/shell";

/**
 * The Chat room's surface, assembled from the shell's state (`chatSurface.ts`): the conversations
 * here, the open one, and the verbs on them. For the room, its drawers and its title.
 *
 * Inside a project, the conversations are those of the machine or workspace its title narrows to
 * (`scopeModel.ts`); at the root, every project's, each naming its own.
 */
export function useChatSurface(): ChatSurface {
  const { state, actions } = useShell();
  const ui = state.settings.ui;
  const grouped = ui.groupWorkspaces !== false;
  const group = useMemo(() => groupOf(groupProjects(state.projects, grouped), state.at), [state.projects, grouped, state.at]);
  const scope = useMemo(() => (group === undefined ? {} : scopeOf(ui, group)), [group, ui]);
  const conversations = useMemo(() => {
    const here = conversationsAt({ at: state.at, allConversations: state.allConversations, projects: state.projects }, grouped);
    return group === undefined ? here : here.filter((c) => inScope(group, scope, c.project));
  }, [state.at, state.allConversations, state.projects, grouped, group, scope]);
  const places = useMemo(() => (group === undefined ? undefined : placesOf(group, scope)), [group, scope]);
  const hues = useMemo(() => Object.fromEntries(state.projects.map((p, i) => [p.project, hueOf(p.kind, i)])), [state.projects]);
  const names = useMemo(() => Object.fromEntries(state.projects.map((p) => [p.project, p.label])), [state.projects]);
  return chatSurfaceOf(state, actions, { conversations, spans: state.at === null, ...(places !== undefined ? { places } : {}), hues, names });
}
