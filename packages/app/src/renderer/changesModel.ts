/**
 * What the side panel's Changes tab DERIVES — the groups and what each one's head says, who made a change,
 * the files as a tree — moved out of `changesPanel.tsx` unchanged so the universal copy (decision 0015,
 * `packages/universal/src/components/panel/ChangesPanel.tsx`) groups and names the same changes from
 * the same code. Nothing here draws.
 */
import type { ChangeAuthor, FileChange, GitStep, MergeRequestView, TaskChangeLog } from "@jaira/shared/browser";
import type { PATHS } from "./iconPaths";

type IconName = keyof typeof PATHS;
export type GroupId = "files" | "execution" | "web" | "git" | "tasks" | "mcp" | "other";

export const GROUPS: ReadonlyArray<{ id: GroupId; name: string; icon: IconName }> = [
  { id: "files", name: "Files", icon: "files" },
  { id: "execution", name: "Execution", icon: "terminal" },
  { id: "web", name: "Web", icon: "web" },
  { id: "git", name: "Git", icon: "git" },
  { id: "tasks", name: "Tasks & workflows", icon: "workflow" },
  { id: "mcp", name: "MCP", icon: "tool" },
  { id: "other", name: "Other", icon: "tool" },
];

/** Whether any change was made by a subagent or a subtask — what offers the switch that takes them out. */
export function hasAuthored(log: TaskChangeLog): boolean {
  const any = (list: ReadonlyArray<{ by?: ChangeAuthor }>): boolean => list.some((item) => item.by !== undefined);
  return any(log.files) || any(log.execution) || any(log.web) || any(log.git.steps) || any(log.tasks) || any(log.mcp) || any(log.other);
}

/** What a group's head says beside its name, and how many it holds. `null` ⇒ the group is not drawn. */
export type GroupSummary = { kind: "files"; added: number; removed: number } | { kind: "branch"; branch: string } | { kind: "words"; text: string };

export function groupFactsOf(id: GroupId, log: TaskChangeLog): { summary: GroupSummary; count: number } | null {
  switch (id) {
    case "files": {
      if (log.files.length === 0) return null;
      const added = log.files.reduce((n, file) => n + (file.added ?? 0), 0);
      const removed = log.files.reduce((n, file) => n + (file.removed ?? 0), 0);
      return { summary: { kind: "files", added, removed }, count: log.files.length };
    }
    case "git": {
      if (log.git.steps.length === 0) return null;
      const branch = log.git.requests[0]?.branch;
      return {
        summary: branch !== undefined ? { kind: "branch", branch } : { kind: "words", text: `${log.git.steps.length} ${log.git.steps.length === 1 ? "step" : "steps"}` },
        count: log.git.steps.length,
      };
    }
    default: {
      const items = log[id];
      if (items.length === 0) return null;
      const word = id === "execution" ? "command" : id === "tasks" ? "task change" : "change";
      return { summary: { kind: "words", text: `${items.length} ${word}${items.length === 1 ? "" : "s"}` }, count: items.length };
    }
  }
}

export const LETTER: Record<FileChange["action"], string> = { create: "A", modify: "M", rename: "R", delete: "D" };

interface Folder {
  dirs: Map<string, Folder>;
  files: FileChange[];
}

/** The files as folders, a folder that holds only one folder merged into it — `src/renderer`. */
export function treeOf(files: readonly FileChange[]): Array<{ kind: "folder"; name: string; depth: number; key: string } | { kind: "file"; file: FileChange; depth: number }> {
  const root: Folder = { dirs: new Map(), files: [] };
  for (const file of files) {
    let at = root;
    const parts = file.path.split("/");
    for (const part of parts.slice(0, -1)) {
      if (!at.dirs.has(part)) at.dirs.set(part, { dirs: new Map(), files: [] });
      at = at.dirs.get(part)!;
    }
    at.files.push(file);
  }
  const out: ReturnType<typeof treeOf> = [];
  const walk = (node: Folder, depth: number, prefix: string): void => {
    for (const [first, child0] of [...node.dirs].sort(([a], [b]) => a.localeCompare(b))) {
      let name = first;
      let child = child0;
      while (child.files.length === 0 && child.dirs.size === 1) {
        const [next, only] = [...child.dirs][0]!;
        name += `/${next}`;
        child = only;
      }
      const key = `${prefix}${name}/`;
      out.push({ kind: "folder", name, depth, key });
      walk(child, depth + 1, key);
    }
    for (const file of node.files) out.push({ kind: "file", file, depth });
  };
  walk(root, 0, "");
  return out;
}

export const baseOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
export const dirOf = (path: string): string => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

/** Where a renamed file came from, as its row says it: the old name, or the old path when it moved folders. */
export const fromOf = (file: FileChange): string | undefined => (file.from !== undefined ? (dirOf(file.from) === dirOf(file.path) ? baseOf(file.from) : file.from) : undefined);

export const STATE_WORDS: Record<MergeRequestView["state"], string> = { open: "open", merged: "merged", closed: "closed" };

export const STEP_WORDS: Record<GitStep["kind"], string> = {
  commit: "Committed",
  push: "Pushed",
  open: "Opened",
  comment: "Commented on",
  merge: "Merged",
  close: "Closed",
  stage: "Staged",
  other: "Ran",
};
