/**
 * The Components view's own second door (decision 0004) — a forge that exists only on the card.
 *
 * A live gate's `remote` services go to main, which answers from the request it is polling. The
 * gallery's gates belong to a placeholder project main has never opened, so wiring them the same way
 * asks main about a project that is not there, and main says so — every ten seconds, per card. The
 * host decides what a component is wired to, so the gallery supplies this instead: the variant's
 * fixture read as a status row, Check now as a fresh read of it, and a reply kept on the card.
 */
import { parseDuration, type GalleryForge, type RemoteStatusView, type ReviewNote, type ReviewRemote } from "@jaira/shared/browser";
import type { ComponentServices } from "./changesetReview";

export function galleryRemote(
  remote: ReviewRemote,
  forge: GalleryForge | undefined,
  now: () => number = Date.now,
): NonNullable<ComponentServices["remote"]> {
  const drawn = now();
  const quiet = forge?.settling === true ? parseDuration(remote.settle_after ?? "") : undefined;
  // Copied, because a reply writes into it and the fixture is shared by every card that draws it.
  const notes: Record<string, ReviewNote[]> = Object.fromEntries(
    Object.entries(forge?.notes ?? {}).map(([id, list]) => [id, list.map((note) => ({ ...note, replies: [...(note.replies ?? [])] }))]),
  );
  let checkedAt = drawn;
  const rows = (): RemoteStatusView[] => [
    {
      key: remote.key ?? "review",
      provider: (remote.provider ?? "gitlab") as RemoteStatusView["provider"],
      host: remote.host ?? "",
      project: remote.project ?? "",
      branch: remote.branch ?? "",
      target: remote.target ?? "",
      ...(remote.number !== undefined ? { number: remote.number } : {}),
      ...(remote.url !== undefined ? { url: remote.url } : {}),
      awaiting: true,
      ...(quiet !== undefined ? { settleAt: drawn + quiet } : {}),
      checkedAt,
      commenters: [...(forge?.commenters ?? [])],
      notes: Object.fromEntries(Object.entries(notes).map(([id, list]) => [id, list.map((note) => ({ ...note, replies: [...(note.replies ?? [])] }))])),
    },
  ];
  return {
    status: () => Promise.resolve(rows()),
    check: () => {
      checkedAt = now();
      return Promise.resolve(rows());
    },
    reply: (thread, body, resolve) => {
      for (const [id, list] of Object.entries(notes)) {
        const at = list.findIndex((note) => note.thread === thread);
        if (at === -1) continue;
        if (resolve === true) notes[id] = list.filter((_, i) => i !== at);
        else list[at]!.replies!.push({ author: "you", body, at: new Date(now()).toISOString() });
      }
      return Promise.resolve(rows());
    },
  };
}
