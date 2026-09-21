/**
 * The built-in layer's three surfaces (decision 0006), server-rendered to one static page — the real
 * components over the real stylesheet, with no Electron in the way.
 *
 * `npx tsx --tsconfig packages/app/tsconfig.json packages/app/shots/builtin-static.mts <out.html> [light|dark]`
 *
 * What it draws: the Files tree ending in its read-only "Built in" root (with the old-copies offer
 * on it), the state editor's top bar on each of the three kinds of file, and the Debug pane's rows.
 * The state files are the ones that ship; the rest is fixture.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { BuiltInLeftover, FileNode, FileTree, WorkflowLayer, WorkflowSource } from "@jaira/shared";
import { DebugPane } from "../src/renderer/debugPane";
import { FileTreePanel } from "../src/renderer/files";
import { WorkflowEditor } from "../src/renderer/stateEditor";

const out = process.argv[2];
if (out === undefined) throw new Error("usage: builtin-static.mts <out.html> [light|dark]");

const shipped = (stateId: string): string =>
  readFileSync(join(import.meta.dirname, "..", "..", "shared", "builtin", "workflows", `${stateId}.json`), "utf8");

const WORKFLOW = "application/vnd.jaira.workflow+json";
const dir = (layer: WorkflowLayer, path: string, children: FileNode[]): FileNode => ({
  path,
  name: path.slice(path.lastIndexOf("/") + 1),
  kind: "directory",
  mime: "inode/directory",
  layer,
  children,
});
const state = (layer: WorkflowLayer, path: string, stateId: string, extra: Partial<FileNode> = {}): FileNode => ({
  path,
  name: path.slice(path.lastIndexOf("/") + 1),
  kind: "workflow",
  mime: WORKFLOW,
  layer,
  stateId,
  ...extra,
});

const tree: FileTree = {
  roots: [
    {
      layer: "project",
      project: "C:/w/atlas",
      label: "atlas",
      dir: "C:/w/atlas",
      prefix: ".jaira",
      exists: true,
      nodes: [
        dir("project", ".jaira", [
          dir("project", ".jaira/workflows", [
            dir("project", ".jaira/workflows/chat", [
              state("project", ".jaira/workflows/chat/agent.json", "chat/agent", { overridesBuiltIn: true }),
            ]),
            state("project", ".jaira/workflows/feature.json", "feature"),
          ]),
        ]),
      ],
    },
    {
      layer: "system",
      label: "Built in",
      dir: "C:/Program Files/JaiRA/resources/builtin",
      prefix: "",
      exists: true,
      nodes: [
        { path: "README.md", name: "README.md", kind: "other", mime: "text/markdown", layer: "system" },
        dir("system", "workflows", [
          dir("system", "workflows/chat", [
            state("system", "workflows/chat/agent.json", "chat/agent", { shadowed: true }),
            state("system", "workflows/chat/assistant.json", "chat/assistant"),
          ]),
          dir("system", "workflows/debug", [
            dir("system", "workflows/debug/hello_world", []),
            state("system", "workflows/debug/hello_world.json", "debug/hello_world"),
          ]),
        ]),
      ],
    },
  ],
};

const leftovers: BuiltInLeftover[] = [
  { stateId: "chat/assistant", layer: "base", file: "C:/Users/me/.jaira/workflows/chat/assistant.json", identical: "superseded" },
  { stateId: "debug/hello_world", layer: "base", file: "C:/Users/me/.jaira/workflows/debug/hello_world.json", identical: "current" },
];

const noop = (): undefined => undefined;
const never = async (): Promise<null> => null;

const treeHtml = renderToStaticMarkup(
  createElement(FileTreePanel, {
    tree,
    selected: { layer: "system", path: "workflows/chat/assistant.json" },
    expanded: new Set([
      "project:.jaira",
      "project:.jaira/workflows",
      "project:.jaira/workflows/chat",
      "system:workflows",
      "system:workflows/chat",
      "system:workflows/debug",
    ]),
    onToggleExpanded: noop,
    busy: false,
    hasProject: true,
    onSelect: noop,
    onOpen: noop,
    onCreate: noop,
    onCreateFile: noop,
    onMove: never,
    onDelete: never,
    onRenameFile: never,
    onDeleteFile: never,
    onReveal: noop,
    project: "C:/w/atlas",
    leftovers,
    onCleanup: noop,
  } as unknown as Parameters<typeof FileTreePanel>[0]),
);

const editor = (source: WorkflowSource, hasProject = true): string =>
  renderToStaticMarkup(
    createElement(WorkflowEditor, {
      source,
      tree: null,
      executors: [],
      busy: false,
      onSave: noop,
      layerActions: { hasProject, onOverride: noop, onDeleteCopy: noop },
    } as unknown as Parameters<typeof WorkflowEditor>[0]),
  );

const debugHtml = renderToStaticMarkup(
  createElement(DebugPane, {
    debug: {
      files: [
        { stateId: "debug/hello_world", file: "C:/Users/me/.jaira/workflows/debug/hello_world.json", layer: "base", text: shipped("debug/hello_world"), identical: "current" },
        { stateId: "debug/hello_world/say", file: "$SYSTEM/workflows/debug/hello_world/say.json", layer: "system", text: shipped("debug/hello_world/say") },
        { stateId: "debug/hello_world/check", file: "$SYSTEM/workflows/debug/hello_world/check.json", layer: "system", text: shipped("debug/hello_world/check") },
      ],
      taskId: null,
      busy: false,
      error: null,
    },
    detail: null,
    conversation: null,
    sessionHistory: [],
    session: null,
    sessionInstance: null,
    liveTurn: null,
    stream: [],
    availability: { checkedAt: 0, routes: [], executors: [] },
    hasProject: true,
    onRun: noop,
    onCancel: noop,
    onCleanup: noop,
    onRecheck: noop,
    onDismissError: noop,
    onOpenState: noop,
    onShowSession: noop,
  } as unknown as Parameters<typeof DebugPane>[0]),
);

const caption = (text: string): string => `<p style="margin:26px 0 8px;font:12px sans-serif;color:var(--dim)">${text}</p>`;
const stage = (html: string, width: number, height?: number): string =>
  `<div style="width:${width}px;${height === undefined ? "" : `height:${height}px;overflow:hidden;`}border:1px solid var(--line);background:var(--bg)">${html}</div>`;

const css = pathToFileURL(join(import.meta.dirname, "..", "src", "renderer", "styles.css")).href;
writeFileSync(
  out,
  `<!doctype html><html data-theme="${process.argv[3] ?? "light"}"><head><meta charset="utf8"><link rel="stylesheet" href="${css}"></head>` +
    `<body style="overflow:auto;height:auto;padding:16px;background:var(--bg)">` +
    caption("the Files tree: a checkout, then what ships — read-only, with the old-copies offer") +
    stage(`<nav class="sidebar"><div class="side-drawer">${treeHtml}</div></nav>`, 300) +
    caption("the editor on a built-in") +
    stage(editor({ stateId: "chat/assistant", layer: "system", file: "C:/Program Files/JaiRA/resources/builtin/workflows/chat/assistant.json", text: shipped("chat/assistant"), exists: true, builtIn: { layers: ["system"] } }), 760, 330) +
    caption("the editor on a built-in this project already overrides, with nothing to override FOR all projects either") +
    stage(editor({ stateId: "chat/agent", layer: "system", file: "x", text: shipped("chat/agent"), exists: true, builtIn: { layers: ["project", "base", "system"] } }), 760, 60) +
    caption("the editor on a project file that overrides a built-in") +
    stage(editor({ stateId: "chat/agent", layer: "project", file: "C:/w/atlas/.jaira/workflows/chat/agent.json", text: shipped("chat/agent"), exists: true, builtIn: { layers: ["project", "system"] } }), 760, 60) +
    caption("the editor on a shared copy JaiRA itself installed") +
    stage(editor({ stateId: "chat/assistant", layer: "base", file: "C:/Users/me/.jaira/workflows/chat/assistant.json", text: shipped("chat/assistant"), exists: true, builtIn: { layers: ["base", "system"], identical: "superseded" } }), 760, 60) +
    caption("the editor on an ordinary shared file") +
    stage(editor({ stateId: "review/step", layer: "base", file: "C:/Users/me/.jaira/workflows/review/step.json", text: "{}", exists: true }), 760, 60) +
    caption("the Debug pane") +
    stage(debugHtml, 1000, 620) +
    `</body></html>`,
);
console.log(`wrote ${out}`);
