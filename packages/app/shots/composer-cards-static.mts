/**
 * The composer's Permissions and Tools cards over permission sets (decision 0007 §5), server-rendered to one
 * static page — the real component over the real stylesheet, with no Electron in the way.
 *
 * `npx tsx --tsconfig packages/app/tsconfig.json packages/app/shots/composer-cards-static.mts <out.html> [light|dark]`
 *
 * One stage per state of the approved mockup (`docs/engineering/decisions/0007-assets/composer-cards.html`),
 * in its order. The `chat` and `chat_control` permission sets are the files that SHIP, read off disk; the
 * `feature` buckets and the custom map are fixture. `--fragments <dir>` writes each stage's markup to
 * its own file instead, which is what the catalog mockups under `docs/ui/assets/` are cut from.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TOOL_SPECS, bucketOf, lowerPermissionSet, parsePermissionSet, permissionSetOfSettings, type ChatPlanView, type ChatSettings, type PermissionSetChoice, type PermissionSetDecl } from "@jaira/shared";
import { Composer, type ComposerOpen } from "../src/renderer/composer";

const out = process.argv[2];
if (out === undefined) throw new Error("usage: composer-cards-static.mts <out.html> [light|dark] | --fragments <dir>");

const PERMISSION_SETS = join(import.meta.dirname, "..", "..", "shared", "builtin", "permission-sets");
const shipped: PermissionSetChoice[] = readdirSync(PERMISSION_SETS).flatMap((bucket) =>
  readdirSync(join(PERMISSION_SETS, bucket)).map((file) => {
    const name = file.replace(/\.json$/, "");
    return { id: `${bucket}/${name}`, bucket, name, layer: "system" as const, decl: JSON.parse(readFileSync(join(PERMISSION_SETS, bucket, file), "utf8")) as PermissionSetDecl };
  }),
);
const project = (id: string, decl: PermissionSetDecl): PermissionSetChoice => {
  const cut = id.lastIndexOf("/");
  return { id, bucket: id.slice(0, cut), name: id.slice(cut + 1), layer: "project", decl };
};
const permissionSets: PermissionSetChoice[] = [
  ...shipped,
  project("feature/plan", { read_file: "allow", glob: "allow", grep: "allow", other: "deny" }),
  project("feature/review", { read_file: "allow", grep: "allow", "git diff": "allow", other: "deny" }),
  project("feature/implementation/writes-asking", { read_file: "allow", edit: "ask", write_file: "ask", bash: "ask", other: "deny" }),
  project("feature/implementation/reads-only", { read_file: "allow", glob: "allow", grep: "allow", other: "deny" }),
];
const declOf = (id: string): PermissionSetDecl => permissionSets.find((t) => t.id === id)!.decl;

const NATIVES: Record<string, string> = { read_file: "Read", glob: "Glob", grep: "Grep", edit: "Edit", write_file: "Write", bash: "Bash", web_fetch: "WebFetch", web_search: "WebSearch" };
const tools = TOOL_SPECS.map((spec) => ({ name: spec.name, ...(NATIVES[spec.name] !== undefined ? { natives: { "claude-cli": NATIVES[spec.name]! } } : {}) }));
const registered = tools.map((t) => t.name);

/** A plan as main would build it: `permission set` is the person's override when `own`, else what the state lowered to. */
function plan(permissionSet: PermissionSetDecl, from: string, own: boolean): ChatPlanView {
  // Inherited, a permission set arrives the way a loaded state holds it: the list and block it LOWERED to.
  const lowered = lowerPermissionSet(parsePermissionSet(permissionSet).permissionSet);
  const settings: ChatSettings = {
    model: "claude-cli/claude-sonnet-5",
    reasoning: { effort: "high" },
    ...(own ? { permissionSet } : { tools: lowered.tools, ...(lowered.permissions !== undefined ? { permissions: lowered.permissions } : {}) }),
  };
  const origin = own ? "override" : "inherited";
  return {
    settings,
    origin: { model: "inherited", reasoning: "inherited", tools: origin, permissions: origin, implementations: "unset", permissionSet: own ? "override" : "unset" },
    from,
    unresolved: [],
    live: "idle",
    effective: { model: "claude-cli/claude-sonnet-5", reasoning: "high", permissions: "" },
    available: { routes: ["claude-cli"], tools, models: [], permissionSets, bucket: bucketOf(permissionSetOfSettings(settings).permissionSet, permissionSets, registered) },
  } as ChatPlanView;
}

const noop = (): undefined => undefined;
const draw = (view: ChatPlanView, startOpen: ComposerOpen): string =>
  renderToStaticMarkup(
    createElement(Composer, { plan: view, overrides: {}, onOverrides: noop, onSend: noop, placeholder: "Reply…", onSavePermissionSet: async () => undefined, startOpen }),
  );

/** `chat/ask-first` with the commands a project might have named: what Execution is for. */
const WITH_COMMANDS: PermissionSetDecl = (() => {
  const { other, ...lines } = declOf("chat/ask-first") as Record<string, PermissionSetDecl[string]>;
  return {
    ...lines,
    "git status": "allow",
    "git log": "allow",
    "git diff": "allow",
    "git commit": "ask",
    "git rm": "ask",
    "npm install": "ask",
    "npm test": "ask",
    script: "ask",
    other: other!,
  };
})();

const STAGES: Array<{ name: string; caption: string; lift: number; html: string }> = [
  {
    name: "permissions-matched",
    caption: "the Permissions card — the four rows are the permission sets of the chat bucket. The head names the bucket; the chip names the permission set the tools and modes match",
    lift: 250,
    html: draw(plan(declOf("chat/ask-first"), "chat/session", false), { card: "Permissions" }),
  },
  {
    name: "permissions-buckets",
    caption: "the bucket picker open — the permission set hierarchy, each bucket with what it holds and the layer that defines it",
    lift: 250,
    html: draw(plan(declOf("chat/ask-first"), "chat/session", false), { card: "Permissions", buckets: true }),
  },
  {
    name: "permissions-control",
    caption: "another bucket has its own versions of the same names — chat_control's four speak only of the task and workflow tools",
    lift: 250,
    html: draw(plan(declOf("chat_control/ask-first"), "chat/control", false), { card: "Permissions" }),
  },
  {
    name: "permissions-custom",
    caption: "a mode changed under Tools — it matches no permission set, so it reads custom, and + keeps it as a new permission set in this bucket",
    lift: 250,
    html: draw(plan({ ...declOf("chat/ask-first"), "git commit": "allow" }, "chat/session", true), { card: "Permissions", keep: true }),
  },
  {
    name: "tools-execution",
    caption: "the Tools card — unchanged but for what Execution holds: the shell, the commands this permission set names grouped under their program, and script",
    lift: 700,
    html: draw(plan(WITH_COMMANDS, "chat/session", false), { card: "Tools", folds: ["execution", "program:git"] }),
  },
  {
    name: "tools-tasks",
    caption: "the Tools card over chat_control/read-only — Tasks & workflows open",
    lift: 720,
    html: draw(plan(declOf("chat_control/read-only"), "chat/control", false), { card: "Tools", folds: ["tasks"] }),
  },
];

/** Composers with nothing open, and one before the plan has been read — the chip row at rest. */
const chosen = ((): ChatPlanView => {
  const view = plan({ bash: "ask", other: "deny" }, "feature/build/implement", true);
  return { ...view, settings: { ...view.settings, reasoning: { effort: "xhigh" } }, origin: { ...view.origin, reasoning: "override" }, effective: { ...view.effective, reasoning: "xhigh" } };
})();
const undeclared = ((): ChatPlanView => {
  const view = plan({}, "chat/assistant", false);
  return { ...view, settings: { model: "claude-cli/claude-sonnet-5" }, origin: { ...view.origin, tools: "unset", permissions: "unset", reasoning: "unset" }, effective: { ...view.effective, reasoning: "the model's default", permissions: "ask by default" } };
})();

/**
 * The catalog mockups of `ui/components/composer-setting-chip`, one file per state, each a stack of
 * stages. Cut from the same renders, so a mockup that says `reflects: shipped` is the component's own
 * markup and not a copy of it.
 */
const CATALOG: Array<{ state: string; width: number; stages: Array<{ lift: number; html: string }> }> = [
  {
    state: "resting",
    width: 932,
    stages: [
      { lift: 0, html: draw(plan(declOf("chat/ask-first"), "chat/session", false), {}) },
      { lift: 0, html: draw(chosen, {}) },
      { lift: 0, html: draw(undeclared, {}) },
      { lift: 0, html: renderToStaticMarkup(createElement(Composer, { plan: null, overrides: {}, onOverrides: noop, onSend: noop, placeholder: "Reply…" })) },
    ],
  },
  {
    state: "inherited",
    width: 932,
    stages: [
      { lift: 230, html: draw(plan(declOf("chat/ask-first"), "chat/session", false), { card: "Thinking" }) },
      { lift: 250, html: STAGES[0]!.html },
      { lift: 250, html: draw(undeclared, { card: "Permissions" }) },
    ],
  },
  { state: "overridden", width: 932, stages: [{ lift: 250, html: draw(plan(declOf("chat/read-only"), "chat/session", true), { card: "Permissions" }) }] },
  { state: "buckets", width: 932, stages: [{ lift: 250, html: STAGES[1]!.html }, { lift: 250, html: STAGES[2]!.html }] },
  { state: "custom", width: 932, stages: [{ lift: 250, html: draw(plan({ ...declOf("chat/ask-first"), "git commit": "allow" }, "chat/session", true), { card: "Permissions" }) }, { lift: 250, html: STAGES[3]!.html }] },
  { state: "tools", width: 932, stages: [{ lift: 700, html: STAGES[4]!.html }, { lift: 720, html: STAGES[5]!.html }] },
];

if (out === "--fragments") {
  const dir = process.argv[3];
  if (dir === undefined) throw new Error("--fragments needs a directory");
  mkdirSync(dir, { recursive: true });
  for (const stage of STAGES) writeFileSync(join(dir, `${stage.name}.html`), stage.html);
  console.log(`wrote ${STAGES.length} fragments to ${dir}`);
} else if (out === "--catalog") {
  const dir = process.argv[3];
  const captured = process.argv[4];
  if (dir === undefined || captured === undefined) throw new Error("--catalog needs a directory and a capture date (YYYY-MM-DD)");
  mkdirSync(dir, { recursive: true });
  for (const page of CATALOG) {
    const stages = page.stages
      .map((s) => `<div class="mockup-stage" style="${s.lift > 0 ? `padding-top: ${s.lift}px; ` : ""}overflow: visible; width: ${page.width}px">\n${s.html}\n</div>`)
      .join("\n");
    writeFileSync(
      join(dir, `${page.state}.html`),
      `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="doc" content="ui/components/composer-setting-chip">\n<meta name="state" content="${page.state}">\n` +
        `<meta name="captured" content="${captured}">\n<meta name="reflects" content="shipped">\n<title>composer-setting-chip · ${page.state}</title>\n` +
        `<link rel="stylesheet" href="../../../../packages/app/src/renderer/styles.css">\n<link rel="stylesheet" href="../mockup.css">\n` +
        `<script>if (location.hash === "#dark") document.documentElement.dataset.theme = "dark";</script>\n</head>\n<body class="mockup">\n` +
        `<p class="mockup-caption">ui/components/composer-setting-chip · ${page.state}</p>\n` +
        `<div class="mockup-stage is-bare" style="width: ${page.width + 48}px; display: grid; gap: 16px">\n${stages}\n</div>\n</body>\n</html>\n`,
    );
  }
  console.log(`wrote ${CATALOG.length} catalog mockups to ${dir}`);
} else {
  const css = pathToFileURL(join(import.meta.dirname, "..", "src", "renderer", "styles.css")).href;
  const stage = (s: (typeof STAGES)[number]): string =>
    `<p style="margin:26px 0 8px;font:12px sans-serif;color:var(--dim)">${s.name} · ${s.caption}</p>` +
    `<div data-stage="${s.name}" style="width:932px;padding-top:${s.lift}px;background:var(--bg)">${s.html}</div>`;
  writeFileSync(
    out,
    `<!doctype html><html data-theme="${process.argv[3] ?? "light"}"><head><meta charset="utf8"><link rel="stylesheet" href="${css}"></head>` +
      `<body style="overflow:auto;height:auto;padding:16px;background:var(--bg)">${STAGES.map(stage).join("")}</body></html>`,
  );
  console.log(`wrote ${out}`);
}
