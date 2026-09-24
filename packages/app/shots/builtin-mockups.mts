/**
 * The two catalog mockups for the built-in layer (decision 0006), written from the REAL components:
 * `docs/ui/assets/file-tree/built-in.html` and `docs/ui/assets/workflow-editor/built-in.html`.
 *
 * `npx tsx --tsconfig packages/app/tsconfig.json packages/app/shots/builtin-mockups.mts`
 *
 * Server-rendered rather than hand-written so the markup and class names are what ships; re-run it
 * when the tree's root heading or the editor's top bar changes. The catalog head is the one every
 * mockup under `docs/ui/assets` carries.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { FileNode, FileTree, WorkflowLayer, WorkflowSource } from "@jaira/shared";
import { FileTreePanel } from "../src/renderer/files";
import { WorkflowEditor } from "../src/renderer/stateEditor";

const repo = join(import.meta.dirname, "..", "..", "..");
const shipped = (stateId: string): string =>
  readFileSync(join(repo, "packages", "shared", "builtin", "workflows", `${stateId}.json`), "utf8");

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
  mime: "application/vnd.jaira.workflow+json",
  layer,
  stateId,
  ...extra,
});

const tree: FileTree = {
  roots: [
    {
      layer: "project",
      project: "C:/UbuntuCode/JaiRA",
      label: "JaiRA",
      dir: "C:/UbuntuCode/JaiRA",
      prefix: ".jaira",
      exists: true,
      nodes: [
        dir("project", ".jaira", [
          dir("project", ".jaira/workflows", [
            dir("project", ".jaira/workflows/chat", [
              state("project", ".jaira/workflows/chat/session.json", "chat/session", { overridesBuiltIn: true }),
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
            state("system", "workflows/chat/session.json", "chat/session", { shadowed: true }),
            state("system", "workflows/chat/control.json", "chat/control"),
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

const noop = (): undefined => undefined;
const never = async (): Promise<null> => null;

const treeHtml = renderToStaticMarkup(
  createElement(FileTreePanel, {
    tree,
    selected: { layer: "system", path: "workflows/chat/control.json" },
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
    project: "C:/UbuntuCode/JaiRA",
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
      layerActions: { hasProject, onOverride: noop },
    } as unknown as Parameters<typeof WorkflowEditor>[0]),
  );

const head = (doc: string, stateName: string): string =>
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="doc" content="${doc}">
<meta name="state" content="${stateName}">
<meta name="captured" content="2026-09-21">
<meta name="reflects" content="shipped">
<title>${doc.slice(doc.lastIndexOf("/") + 1)} · ${stateName}</title>
<link rel="stylesheet" href="../../../../packages/app/src/renderer/styles.css">
<link rel="stylesheet" href="../mockup.css">
<script>if (location.hash === "#dark") document.documentElement.dataset.theme = "dark";</script>
</head>
<body class="mockup">
<p class="mockup-caption">${doc} · ${stateName}</p>
`;

writeFileSync(
  join(repo, "docs", "ui", "assets", "file-tree", "built-in.html"),
  `${head("ui/components/file-tree", "built-in")}<div class="mockup-stage is-bare" style="width: 250px">
  <nav class="sidebar">
    <div class="side-nav">
      <div class="side-section open" style="--hue: var(--p1)">
        <div class="side-row side-project-row">
          <button class="side-hit" title="C:\\UbuntuCode\\JaiRA" aria-expanded="true"><i class="side-dot"></i><span class="side-label side-name"><span class="ellip data-title">JaiRA</span><span class="side-where ellip data-faint">UbuntuCode</span></span></button>
        </div>
        <div class="side-views">
          <div class="side-row side-nested on is-active">
            <button class="side-hit" title="Files" aria-label="Files" aria-current="page"><span class="side-glyph">❏</span><span class="side-label ellip app-label">Files</span></button>
            <button class="side-act" title="new file, folder or workflow" aria-label="new file, folder or workflow">+</button>
            <button class="side-act" title="find in files" aria-label="find in files" aria-pressed="false">⌕</button>
          </div>
          <div class="side-drawer">
            ${treeHtml}
          </div>
        </div>
      </div>
    </div>
  </nav>
</div>
</body>
</html>
`,
  "utf8",
);

const stage = (comment: string, html: string, height: number): string =>
  `  <!-- ${comment} -->\n  <div class="col mid" style="height: ${height}px; overflow: hidden"><div class="config-half whole">${html}</div></div>\n`;

writeFileSync(
  join(repo, "docs", "ui", "assets", "workflow-editor", "built-in.html"),
  `${head("ui/components/workflow-editor", "built-in")}<div class="mockup-stage is-bare" style="width: 760px; display: grid; gap: 14px">
${stage(
  "a shipped state: read-only, with the two places it can be overridden, the form inert and no foot",
  editor({ stateId: "chat/control", layer: "system", file: "C:/Program Files/JaiRA/resources/builtin/workflows/chat/control.json", text: shipped("chat/control"), exists: true, builtIn: { layers: ["system"] } }),
  330,
)}${stage(
    "a shipped state both other layers already override: neither override is offered",
    editor({ stateId: "chat/session", layer: "system", file: "C:/Program Files/JaiRA/resources/builtin/workflows/chat/session.json", text: shipped("chat/session"), exists: true, builtIn: { layers: ["project", "base", "system"] } }),
    34,
  )}${stage(
    "this project's file of a shipped id",
    editor({ stateId: "chat/session", layer: "project", file: "C:/UbuntuCode/JaiRA/.jaira/workflows/chat/session.json", text: shipped("chat/session"), exists: true, builtIn: { layers: ["project", "system"] } }),
    34,
  )}${stage(
    "a shared copy of a shipped id: the comparison is one click away",
    editor({ stateId: "chat/control", layer: "base", file: "C:/Users/Ofer/.jaira/workflows/chat/control.json", text: shipped("chat/control"), exists: true, builtIn: { layers: ["base", "system"] } }),
    34,
  )}</div>
</body>
</html>
`,
  "utf8",
);
console.log("wrote docs/ui/assets/file-tree/built-in.html and docs/ui/assets/workflow-editor/built-in.html");
