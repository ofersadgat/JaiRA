/**
 * Settings → Toolsets and the state editor's Tools field (decision 0007 §6), server-rendered to one
 * static page — the real components over the real stylesheet, with no Electron in the way.
 *
 * `npx tsx --tsconfig packages/app/tsconfig.json packages/app/shots/toolsets-static.mts <out.html> [light|dark]`
 *
 * One stage per state of the approved mockups (`docs/engineering/decisions/0007-assets/settings-toolsets.html`
 * and `state-tools-field.html`), in their order, then the states they do not draw. The `chat` and
 * `chat_control` toolsets are the files that SHIP, read off disk; the project's override and the
 * `feature` bucket are fixture. `--fragments <dir>` writes each stage's markup to its own file instead,
 * which is what the catalog mockups under `docs/ui/assets/` are cut from.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TOOL_SPECS, parseToolset, type ToolsetDecl, type ToolsetRecord, type ToolsetsView as ToolsetsData, type WorkflowLayer } from "@jaira/shared";
import { LayerPicker } from "../src/renderer/panes";
import { ToolsFieldControl } from "../src/renderer/toolsField";
import { toolsFieldOf } from "../src/renderer/toolsFieldForm";
import { programFold } from "../src/renderer/toolsetCard";
import { ToolsetsView, type ToolsetsViewProps } from "../src/renderer/toolsetsPane";

const out = process.argv[2];
if (out === undefined) throw new Error("usage: toolsets-static.mts <out.html> [light|dark] | --fragments <dir>");

const TOOLSETS = join(import.meta.dirname, "..", "..", "shared", "builtin", "toolsets");
const shipped: ToolsetRecord[] = readdirSync(TOOLSETS).flatMap((bucket) =>
  readdirSync(join(TOOLSETS, bucket)).map((file): ToolsetRecord => {
    const name = file.replace(/\.json$/, "");
    const decl = JSON.parse(readFileSync(join(TOOLSETS, bucket, file), "utf8")) as ToolsetDecl;
    return { id: `${bucket}/${name}`, bucket, name, files: [{ layer: "system", file: `built in/toolsets/${bucket}/${name}.json`, format: "json", decl }] };
  }),
);
/**
 * The project's override of `chat/read-only`, as `readToolsetLayers` hands it over: the map with its
 * `$ref` FOLLOWED. So it is what ships plus what the override says — an override cannot hold fewer
 * lines than the file it follows, because a line it leaves out is one the lower file still supplies.
 */
const SHIPPED_READ_ONLY = JSON.parse(readFileSync(join(TOOLSETS, "chat", "read-only.json"), "utf8")) as ToolsetDecl;
const READ_ONLY: ToolsetDecl = {
  ...SHIPPED_READ_ONLY,
  glob: { mode: "allow", implementation: "native" },
  git: "allow",
  "git status": "allow",
  "git log": "allow",
  "git diff": "allow",
  web_fetch: "ask",
};
const records: ToolsetRecord[] = [
  ...shipped.map((record) =>
    record.id === "chat/read-only"
      ? { ...record, files: [{ layer: "project" as const, file: ".jaira/toolsets/chat/read-only.json", format: "json" as const, follows: "$SYSTEM/toolsets/chat/read-only", decl: READ_ONLY }, ...record.files] }
      : record,
  ),
  {
    id: "feature/writes-asking",
    bucket: "feature",
    name: "writes-asking",
    files: [{ layer: "project", file: ".jaira/toolsets/feature/writes-asking.json", format: "json", decl: { read_file: "allow", glob: "allow", grep: "allow", edit: "ask", write_file: "ask", bash: "ask", "npm test": "allow", script: "ask", other: "ask" } }],
  },
  {
    // Lines that name FUNCTIONS (decision 0007, amended 2026-09-22): the shipped `smart` on the shell,
    // a project's own judge on writes.
    id: "feature/judged",
    bucket: "feature",
    name: "judged",
    files: [
      {
        layer: "project",
        file: ".jaira/toolsets/feature/judged.json",
        format: "json",
        decl: { read_file: "allow", edit: "ask", write_file: { function: "judge.writes" }, bash: { function: "smart" }, "git push": "ask", other: "deny" },
      },
    ],
  },
  {
    id: "feature/implementation/reads-only",
    bucket: "feature/implementation",
    name: "reads-only",
    files: [{ layer: "base", file: "~/.jaira/toolsets/feature/implementation/reads-only.json", format: "json", decl: { read_file: "allow", glob: "allow", grep: "allow", other: "deny" } }],
  },
];

const NATIVES: Record<string, string> = { read_file: "Read", glob: "Glob", grep: "Grep", edit: "Edit", write_file: "Write", bash: "Bash", web_fetch: "WebFetch", web_search: "WebSearch" };
const tools = TOOL_SPECS.filter((spec) => spec.nativeOnly !== true).map((spec) => ({ name: spec.name, ...(NATIVES[spec.name] !== undefined ? { natives: { "claude-cli": NATIVES[spec.name]! } } : {}) }));
const data: ToolsetsData = {
  records,
  usedBy: { "chat/read-only": ["sync/review", ...Array.from({ length: 18 }, (_, i) => `feature/s${i}`)], "chat_control/ask-first": ["chat/control"], "feature/writes-asking": ["feature/build", "feature/fix"] },
  tools,
  layers: ["project", "base", "system"],
};

const none = (): void => undefined;
const view = (layer: WorkflowLayer, toolset: string, extra: Partial<ToolsetsViewProps> = {}): string =>
  `<div class="settings-head">` +
  renderToStaticMarkup(createElement(LayerPicker<WorkflowLayer>, { value: layer, layers: ["project", "base", "system"], onChange: none })) +
  `</div>` +
  renderToStaticMarkup(
    createElement(ToolsetsView, {
      data,
      layer,
      choice: { toolset },
      onChoice: none,
      drafts: {},
      onDraft: none,
      comparing: false,
      onCompare: none,
      naming: {},
      onNaming: none,
      locked: false,
      problem: null,
      onSave: none,
      onReset: none,
      onOverride: none,
      onAdd: none,
      ...extra,
    }),
  );

const choices = [
  ...shipped.map((record) => ({ id: record.id, bucket: record.bucket, name: record.name, layer: "system" as const, decl: record.files[0]!.decl! })),
  { id: "chat/read-only", bucket: "chat", name: "read-only", layer: "project" as const, decl: READ_ONLY },
];
const field = (raw: unknown, startAdding = false): string =>
  `<div class="sb-panel"><section class="sb-sheet"><div class="sb-body">` +
  renderToStaticMarkup(createElement(ToolsFieldControl, { value: toolsFieldOf(raw)!, toolsets: choices, tools, startAdding, onChange: none })) +
  `</div></section></div>`;

const withoutGlob = parseToolset((({ glob: _gone, ...rest }) => ({ ...rest, bash: "ask" }))(READ_ONLY)).toolset;

const stages: Array<{ name: string; caption: string; html: string; panel?: true }> = [
  {
    name: "project",
    caption: "This project — chat / read-only is the one this project overrides (the dot); git is open, and its add line lists what it does not hold",
    html: view("project", "chat/read-only", { folds: new Set(["files", "execution", programFold("git")]), startAdding: programFold("git") }),
  },
  { name: "built-in", caption: "Built in — what ships. It reads the same and changes nothing; the way to change it is to override it", html: view("system", "chat_control/ask-first", { folds: new Set(["tasks"]) }) },
  { name: "inherited", caption: "This project, a toolset it only inherits — read, until it is overridden here", html: view("project", "chat/full", { folds: new Set(["files"]) }) },
  {
    name: "unsaved",
    caption: "edited and not saved — a line what ships holds was taken out, so the save stops following; compared with what ships",
    html: view("project", "chat/read-only", { drafts: { "chat/read-only": withoutGlob }, comparing: true, folds: new Set(["files"]) }),
  },
  { name: "nested", caption: "a project's own toolset, in a bucket that holds another bucket; Execution's add line open", html: view("project", "feature/writes-asking", { folds: new Set(["execution", programFold("npm")]), startAdding: "execution" }) },
  {
    name: "function",
    caption: "Built in — chat / auto: every line hands its call to the smart function, which asks you when it is unsure",
    html: view("system", "chat/auto", { folds: new Set(["files", "execution"]) }),
  },
  {
    name: "function-menu",
    caption: "a project's toolset whose lines name functions — the shell's mode menu open: the three words, then function…",
    html: view("project", "feature/judged", { folds: new Set(["files", "execution", programFold("git")]), startMode: { subject: "bash", open: "menu" } }),
  },
  {
    name: "function-form",
    caption: "function… picked — which function decides the line, asked through the schema form",
    html: view("project", "feature/judged", { folds: new Set(["files", "execution"]), startMode: { subject: "write_file", open: "function" } }),
  },
  { name: "new-toolset", caption: "+ toolset, a name it has to refuse", html: view("project", "", { choice: { newIn: "chat" }, naming: { name: "read-only" } }) },
  { name: "new-bucket", caption: "+ bucket", html: view("base", "", { choice: "bucket", naming: { bucket: "review", name: "reads" } }) },
  { name: "refused", caption: "while a write is in flight, and what the last one was refused with", html: view("project", "feature/writes-asking", { locked: true, problem: "'feature/writes-asking' changed on disk since it was read — nothing was written", folds: new Set(["files"]) }) },
  { name: "state-field", caption: "the state editor — the toolset it starts from, and what it writes over it", html: field({ $ref: "$/toolsets/chat/read-only", write_file: "ask", "git commit": "ask" }), panel: true },
  { name: "state-field-adding", caption: "the state editor — no toolset, lines of its own only; the add line open", html: field({ read_file: "allow", other: "deny" }, true), panel: true },
  { name: "state-field-none", caption: "the state editor — a state that names nothing yet", html: field(undefined), panel: true },
];

/** A stage inside the container it really renders in — the settings column, or the state panel. */
const staged = (stage: { html: string; panel?: true }): string =>
  stage.panel === true ? stage.html : `<div class="col mid settings-body">${stage.html}</div>`;

if (out === "--fragments") {
  // Whole catalog mockups, in the head format `docs/ui/assets/**` uses — see any other one.
  const dir = process.argv[3];
  const doc = process.argv[4] ?? "ui/surfaces/settings-toolsets";
  // The pane's states and the state FIELD's are two catalog entries — a surface and a component —
  // so which of them this call writes is said here rather than by moving files afterwards.
  const only = process.argv[5] === "--field" ? true : process.argv[5] === "--pane" ? false : undefined;
  if (dir === undefined) throw new Error("usage: toolsets-static.mts --fragments <dir> [doc-id] [--pane|--field]");
  const today = new Date().toISOString().slice(0, 10);
  const name = doc.slice(doc.lastIndexOf("/") + 1);
  mkdirSync(dir, { recursive: true });
  const wanted = stages.filter((stage) => only === undefined || (stage.panel === true) === only);
  for (const stage of wanted) {
    writeFileSync(
      join(dir, `${stage.name}.html`),
      `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="doc" content="${doc}">\n<meta name="state" content="${stage.name}">\n` +
        `<meta name="captured" content="${today}">\n<meta name="reflects" content="shipped">\n<title>${name} · ${stage.name}</title>\n` +
        `<link rel="stylesheet" href="../../../../packages/app/src/renderer/styles.css">\n<link rel="stylesheet" href="../mockup.css">\n` +
        `<script>if (location.hash === "#dark") document.documentElement.dataset.theme = "dark";</script>\n</head>\n<body class="mockup">\n` +
        `<p class="mockup-caption">${doc} · ${stage.name}</p>\n` +
        `<div class="mockup-stage${stage.panel === true ? " is-bare" : ""}" style="width: ${stage.panel === true ? 720 : 900}px; background: var(--bg)">\n${staged(stage)}\n</div>\n</body>\n</html>\n`,
      "utf8",
    );
  }
  console.log(`wrote ${wanted.length} mockups to ${dir}`);
} else {
  const css = pathToFileURL(join(import.meta.dirname, "..", "src", "renderer", "styles.css")).href;
  writeFileSync(
    out,
    `<!doctype html><html data-theme="${process.argv[3] ?? "light"}"><head><meta charset="utf8"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="${css}"></head>` +
      `<body style="overflow:auto;height:auto"><div style="max-width:900px;margin:0 auto;padding:16px;background:var(--bg)">` +
      stages.map((stage) => `<p style="margin:26px 0 8px;font:12px sans-serif;color:var(--dim)">${stage.caption}</p>${staged(stage)}`).join("") +
      `</div></body></html>`,
  );
  console.log(`wrote ${out}`);
}
