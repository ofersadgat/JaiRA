import type { ComponentType } from "react";
import type { ReviewNote } from "@jaira/shared/browser";
import { NoteList as DomNoteList } from "@jaira/ui/reviewNotes";
import { NoteList } from "@jaira/universal";

/**
 * A review's notes (`reviewNotes.tsx`'s `NoteList`), as the changeset reviewer draws them: one written
 * here, one read from the forge with its replies — its source said beside the author (`.note-src`) and
 * a reply that is a decision word drawn as the decision (`.note-msg.is-word`).
 */
export interface ReviewSpecimen {
  width: number;
  dom: ComponentType;
  rn: ComponentType;
}

const TEXT = "The pause keeps the worktree as it is.\nA resume starts where it stopped.";

const NOTES: ReviewNote[] = [
  { artifact: "plan", quote: "keeps the worktree", body: "Say what happens to untracked files.", author: "you", at: "2026-09-21T10:00:00Z" },
  {
    artifact: "plan",
    quote: "starts where it stopped",
    body: "Does it replay the last turn?",
    author: "dana",
    at: "2026-09-21T10:02:00Z",
    source: "gitlab",
    thread: "t-7",
    replies: [{ author: "dana", body: "approve", at: "2026-09-21T10:05:00Z" }],
  },
];

const none = (): void => undefined;

export const REVIEW_SPECIMENS: Record<string, ReviewSpecimen> = {
  "review-notes": {
    width: 520,
    dom: () => <DomNoteList notes={NOTES} text={TEXT} author="you" onReselect={none} onReply={none} onRemove={none} />,
    rn: () => <NoteList notes={NOTES} text={TEXT} author="you" onReselect={none} onReply={none} onRemove={none} />,
  },
};
