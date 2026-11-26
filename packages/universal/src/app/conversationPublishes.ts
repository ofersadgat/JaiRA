import { useEffect, useMemo } from "react";
import { entriesOf } from "@jaira/ui/transcript";
import { publishSuccessorsOf, publishedOf, shownOf, type PublishedRef } from "@jaira/ui/transcriptRows";
import { useLiveTurnOf } from "@jaira/ui/taskRun";
import { useView } from "@jaira/ui/useView";
import { followPublishes } from "./places";

/**
 * A conversation's publishes, read on their own — for an artifact drawn where its conversation is not.
 *
 * The views opened from a publish's card go on to a later publish in the same run (`publishSuccessorsOf`,
 * `followPublishes`), and it was the conversation's transcript that told them, as it drew. An artifact put
 * in the main view takes the conversation's place there, so nothing drew it and nothing told them: a canvas
 * Claude was still filling in, opened large at 3 of 10, stayed at 3 (the person, 2026-11-26). This reads
 * the same thread and live tail the transcript is drawn from (`chat:thread`, `useLiveTurnOf`), whether or
 * not anything draws them.
 *
 *   successors   `publishSuccessorsOf` of the conversation, as the transcript reads it
 *   newest       each artifact's newest version Claude published in it, by its url, in any turn — what a
 *                view still on an older one says is newer (its version menu)
 *
 * `taskId` null reads nothing.
 */
export function useConversationPublishes(taskId: string | null, project: string | undefined): { successors: ReadonlyMap<string, PublishedRef>; newest: ReadonlyMap<string, number> } {
  const live = useLiveTurnOf(taskId, project);
  const request = useMemo(() => (taskId === null ? null : { taskId, ...(project !== undefined ? { project } : {}) }), [taskId, project]);
  const held = useView("chat:thread", request, live !== null);
  const session = held.value?.session ?? null;
  return useMemo(() => {
    if (taskId === null) return { successors: NONE, newest: NO_VERSIONS };
    const entries = entriesOf(session, [], live);
    const newest = new Map<string, number>();
    for (const entry of entries) {
      if (entry.kind !== "tool" || entry.ok === false) continue;
      const one = publishedOf(entry.result);
      for (const ref of one !== undefined ? [one] : (shownOf(entry.result)?.items ?? [])) newest.set(ref.url, Math.max(ref.version, newest.get(ref.url) ?? 0));
    }
    return { successors: publishSuccessorsOf(entries), newest };
  }, [taskId, session, live]);
}

/**
 * Every place showing an artifact opened from one of this conversation's publishes goes on to the run's
 * later publish of it (`followPublishes`), told whenever one lands — what the transcript does as it draws.
 */
export function useFollowPublishes(successors: ReadonlyMap<string, PublishedRef>): void {
  const followed = [...successors].map(([call, ref]) => `${call}>${String(ref.version)}`).join(" ");
  useEffect(() => followPublishes(successors), [followed]); // eslint-disable-line react-hooks/exhaustive-deps
}

const NONE: ReadonlyMap<string, PublishedRef> = new Map();
const NO_VERSIONS: ReadonlyMap<string, number> = new Map();
