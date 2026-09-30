import { useEffect, type ComponentType, type JSX, type ReactNode } from "react";
import type { BoardCard, ConversationView, FileSource, UpdateState } from "@jaira/shared/browser";
import { invoke } from "@jaira/ui/store";
import { publishUpdate } from "@jaira/ui/updatesStore";
import { UpdateSplit as DomUpdateSplit } from "@jaira/ui/updatesView";
import { CardDom } from "@jaira/ui/board";
import { Conversation as DomConversation } from "@jaira/ui/detail";
import { JsonFormView as DomJsonFormView, PatchSideBySide as DomPatchSideBySide, RenderedFileView as DomRenderedFileView } from "@jaira/ui/fileSurfaces";
import type { FileSurfaceContext, FileSurfaceProps } from "@jaira/ui/fileTypes";
import { AboutUpdateSplit, Conversation, JsonFormView, PatchSideBySide, RenderedFileView, TaskCard } from "@jaira/universal";

/**
 * Pieces of the rooms as specimens (decision 0015): each DOM original against its universal copy, from
 * the same fixture.
 *
 *  - `card-origin`, `card-undo`, `card-undo-ended` — `board.tsx`'s card with its origin line (a task the
 *    events task started; pressing it opens that task) and with **Undo** (a moment after a drop), running
 *    and finished. The copy is drawn with `copied`: on web a card with either is still the DOM card's.
 *  - `debug-journal` — the Debug room's journal under a result (`detail.tsx`'s `Conversation`): every kind
 *    of turn, a tool turn in the data face, a failure.
 *  - `file-patch-side`, `file-html`, `file-json-form`, `file-json-form-package` — the Files viewer's
 *    Side by side (the diff an island, painted out), Rendered (the page an island) and Form surfaces.
 *  - `about-update-split` — About's Update: the split button whose chevron opens the other ways, with a
 *    downloaded update on the feed.
 */
export interface RoomSpecimen {
  width: number;
  dom: ComponentType;
  rn: ComponentType;
}

const NOW = Date.now();

function cardOf(over: Partial<BoardCard>): BoardCard {
  return {
    taskId: "t-origin",
    title: "rebuild the docs site",
    status: "running",
    workflow: "feature/plan",
    activeStateId: "draft",
    activePath: [],
    hasSubBoard: false,
    updatedAt: NOW,
    ...over,
  } as BoardCard;
}

const STARTED = cardOf({
  status: "completed",
  activeStatus: "completed",
  activeStateId: "review",
  endedAt: NOW - 18 * 60_000,
  startedBy: { by: "events", fromTask: "t-events", state: { key: "push_main", stateId: "events/push_main" } as never, event: "git.push", summary: "git.push a1b2c3d on main" },
});
const MOVED = cardOf({ taskId: "t-moved", title: "tighten the changeset lint", status: "running", activeStatus: "running", activeStateId: "critique" });
const MOVED_ENDED = cardOf({ taskId: "t-moved-2", title: "retire the old lint", status: "completed", activeStatus: "completed", activeStateId: "done", endedAt: NOW - 3 * 60_000 });

const none = (): void => undefined;

function cardSpecimen(card: BoardCard, extra: { onUndo?: () => void; onOrigin?: () => void }): RoomSpecimen {
  return {
    width: 268,
    dom: () => <CardDom card={card} selected={false} onSelect={none} {...extra} />,
    rn: () => <TaskCard card={card} selected={false} onSelect={none} last copied {...extra} />,
  };
}

const JOURNAL: ConversationView = {
  taskId: "t-self-test",
  title: "self-test",
  turns: [
    { seq: 1, at: NOW, kind: "operation", stateId: "debug/greet", text: "prompt" },
    { seq: 2, at: NOW, kind: "tool", stateId: "debug/greet", tool: "read_file", text: "read README.md", data: { path: "README.md" } },
    { seq: 3, at: NOW, kind: "output", stateId: "debug/greet", text: "Hello from the self-test — a greeting long enough to wrap onto a second line in a narrow column.", data: { greeting: "hello" } },
    { seq: 4, at: NOW, kind: "policy", stateId: "debug/judge", text: "write_file refused: outside the project" },
    { seq: 5, at: NOW, kind: "transition", stateId: "debug/judge", text: "judge → done" },
    { seq: 6, at: NOW, kind: "failure", stateId: "debug/judge", text: "the judge published no verdict", ok: false },
  ],
} as ConversationView;

/** Enough of the room's context for these surfaces: a schema already chosen, nothing to detect. */
function contextOf(choice: Record<string, string>): FileSurfaceContext {
  return { schemaChoice: choice, detectSchema: async () => null, onSchemaChoice: none } as unknown as FileSurfaceContext;
}

function fileOf(path: string, mime: string, text: string): FileSource {
  return { layer: "project", path, file: `/home/me/work/checkout/${path}`, mime, text, exists: true };
}

const PATCH = fileOf(
  "change.patch",
  "text/x-diff",
  ["--- a/lint.ts", "+++ b/lint.ts", "@@ -3,5 +3,6 @@", " ", " export function laneOfCard(card: { status: string; endedAt?: number }): Lane {", '   if (card.status === "running") return "running";', '-  return card.endedAt !== undefined ? "finished" : "not-started";', '+  if (card.endedAt !== undefined) return "finished";', '+  return "not-started";', " }", ""].join("\n"),
);
const HTML = fileOf("notes.html", "text/html", "<!doctype html>\n<html>\n  <body>\n    <h1>Release notes</h1>\n    <p>Cards now keep their lane.</p>\n  </body>\n</html>\n");
const TSCONFIG = fileOf("tsconfig.json", "application/json", JSON.stringify({ compilerOptions: { target: "ES2022", strict: true, module: "esnext", outDir: "dist" }, include: ["src", "test"] }, null, 2));
const PACKAGE = fileOf(
  "package.json",
  "application/json",
  JSON.stringify({ name: "@acme/site", version: "1.4.0", private: true, description: "The docs site.", scripts: { build: "vite build", test: "vitest" }, dependencies: { react: "^19.0.0" } }, null, 2),
);

function surfaceSpecimen(Dom: ComponentType<FileSurfaceProps>, Rn: ComponentType<FileSurfaceProps>, doc: FileSource, choice: Record<string, string> = {}): RoomSpecimen {
  const props: FileSurfaceProps = { doc, busy: false, onSave: none, context: contextOf(choice) };
  return { width: 640, dom: () => <Dom {...props} />, rn: () => <Rn {...props} /> };
}

/** A downloaded update, published after main's own answer has landed, so the fixture is what shows. */
const DOWNLOADED = { status: "downloaded", version: "0.3.282", channel: "stable", available: { version: "0.3.290", releaseDate: "2026-09-27T08:00:00Z", url: "https://example.com/releases/0.3.290" } } as UpdateState;
function WithUpdate({ children }: { children: ReactNode }): JSX.Element {
  useEffect(() => {
    void invoke("update:state", undefined).finally(() => publishUpdate(DOWNLOADED));
  }, []);
  return <>{children}</>;
}

export const ROOM_SPECIMENS: Record<string, RoomSpecimen> = {
  "about-update-split": {
    width: 220,
    dom: () => (
      <WithUpdate>
        <DomUpdateSplit label="Restart to update" state={DOWNLOADED} busy={undefined} queued={undefined} />
      </WithUpdate>
    ),
    rn: () => (
      <WithUpdate>
        <AboutUpdateSplit label="Restart to update" />
      </WithUpdate>
    ),
  },
  "card-origin": cardSpecimen(STARTED, { onOrigin: none }),
  "card-undo": cardSpecimen(MOVED, { onUndo: none }),
  "card-undo-ended": cardSpecimen(MOVED_ENDED, { onUndo: none }),
  "debug-journal": { width: 640, dom: () => <DomConversation conversation={JOURNAL} />, rn: () => <Conversation conversation={JOURNAL} /> },
  "file-patch-side": surfaceSpecimen(DomPatchSideBySide, PatchSideBySide, PATCH),
  "file-html": surfaceSpecimen(DomRenderedFileView, RenderedFileView, HTML),
  "file-json-form": surfaceSpecimen(DomJsonFormView, JsonFormView, TSCONFIG, { "project:tsconfig.json": "tsconfig" }),
  "file-json-form-package": surfaceSpecimen(DomJsonFormView, JsonFormView, PACKAGE, { "project:package.json": "package-json" }),
};
