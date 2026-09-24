/**
 * The command approval's catalog mockups, server-rendered from the REAL component over the real
 * stylesheet, with the REAL policy taking each line apart — no Electron (decision 0007 §4).
 *
 * `npx tsx --tsconfig packages/app/tsconfig.json packages/app/shots/approval-static.mts [outDir]`
 *
 * With no `outDir` it rewrites `docs/ui/assets/command-approval/*.html`, which is where the catalog
 * keeps them: a mockup that is generated from what ships cannot drift from it. Only the conversation
 * chrome around the surface (the sheet, the state's heading) is written by hand here.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { lowerPermissionSet, parseComponentConfig, parsePermissionSet, type ApprovalPermissionSet, type CommandApproval, type PendingApproval, type PendingInteraction, type PermissionSetDecl } from "@jaira/shared";
import { commandDecisionOf, compilePolicy, decideCommand } from "../../runtime/src/policy";
import { shellPermissionSetOf } from "../../runtime/src/commandParts";
import { withPermissionFunctions, type PermissionFunctionRunner } from "../../runtime/src/permissionFunctions";
import { ApprovalSurface } from "../src/renderer/approvalSurface";
import { GateSurface } from "../src/renderer/components";

const REPO = join(import.meta.dirname, "..", "..", "..");
const outDir = process.argv[2] ?? join(REPO, "docs", "ui", "assets", "command-approval");
mkdirSync(outDir, { recursive: true });
const CAPTURED = "2026-09-22";

const WRITES_ASKING = { bash: "ask", read_file: "allow", glob: "allow", write_file: "allow", script: "ask", "git commit": "ask", "git log": "allow", other: "deny" };
const WRITES_REF = "$/permission-sets/feature/implementation/writes-asking";
const WRITES: ApprovalPermissionSet = {
  id: "feature/implementation/writes-asking",
  targets: [
    { layer: "project", file: ".jaira/permission-sets/feature/implementation/writes-asking.json" },
    { layer: "base", file: "~/.jaira/permission-sets/feature/implementation/writes-asking.json" },
  ],
};
const ASK_FIRST: ApprovalPermissionSet = {
  id: "chat/ask-first",
  targets: [
    { layer: "project", file: ".jaira/permission-sets/chat/ask-first.json", follows: "$SYSTEM/permission-sets/chat/ask-first" },
    { layer: "base", file: "~/.jaira/permission-sets/chat/ask-first.json", follows: "$SYSTEM/permission-sets/chat/ask-first" },
  ],
};
const INLINE: ApprovalPermissionSet = { targets: [], unwritable: "This permission set is written on the state itself, so there is no permission set file to add a line to." };

function shell(line: string, permissionSet: Record<string, string>, source: string, where: ApprovalPermissionSet | undefined): PendingApproval {
  const decided = decideCommand({}, line, "posix", { permissionSet: shellPermissionSetOf(parsePermissionSet(permissionSet).permissionSet), permissionSetSource: source });
  return { requestId: "apr", tool: "Bash", command: line, reason: decided.reason, parts: decided.parts, ...(where !== undefined ? { permissionSet: where } : {}), input: { command: line }, taskId: "t-1", project: "p", at: 0 };
}

const surface = (pending: PendingApproval, initialMenu?: "allow" | "deny", error?: string): string =>
  renderToStaticMarkup(h(ApprovalSurface, { pending, onDecide: () => undefined, ...(initialMenu !== undefined ? { initialMenu } : {}), ...(error !== undefined ? { error } : {}) }));

const CHEVRON = '<svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg>';

interface Sheet {
  caption: string;
  session: string;
  workflow: string;
  at: string;
  state: string;
  label: string;
  says?: string;
  body: string;
  /** Room under the surface for an open menu, which is absolutely positioned and would otherwise be clipped by the stage. */
  room?: number;
}

function sheet(s: Sheet): string {
  return [
    `<div><p class="mockup-caption">${s.caption}</p>`,
    '<div class="mockup-stage is-bare" style="width: 720px; flex: none"><div class="sb-panel">',
    `<div class="sb-gutter"><span class="sb-session mono ellip">${s.session}</span><button type="button" class="link sb-workflow ellip">${s.workflow}</button><span class="sb-span">${s.at}</span></div>`,
    '<section class="sb-sheet"><div class="sb-body"><div class="st-block">',
    `<button type="button" class="lh tb accent" aria-expanded="true"><span class="lh-chev open">${CHEVRON}</span><span class="lh-dot ts-dot-running"></span><span class="lh-name mono">${s.state}</span><span class="lh-label ellip">${s.label}</span><span class="lh-meta">${s.at}</span></button>`,
    s.says !== undefined ? `<div class="ts"><div class="ts-msg ts-msg-assistant"><div class="markdown"><p>${s.says}</p></div></div></div>` : "",
    `<div class="inline-gate">${s.body}</div>`,
    s.room !== undefined ? `<div style="height: ${s.room}px"></div>` : "",
    "</div></div></section></div></div></div>",
  ].join("");
}

function page(state: string, body: string): string {
  const css = relative(outDir, join(REPO, "packages", "app", "src", "renderer", "styles.css")).replace(/\\/g, "/");
  const mockupCss = relative(outDir, join(REPO, "docs", "ui", "assets", "mockup.css")).replace(/\\/g, "/");
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="doc" content="ui/components/command-approval">',
    `<meta name="state" content="${state}">`,
    `<meta name="captured" content="${CAPTURED}">`,
    '<meta name="reflects" content="shipped">',
    `<title>command-approval · ${state}</title>`,
    `<link rel="stylesheet" href="${css}">`,
    `<link rel="stylesheet" href="${mockupCss}">`,
    '<script>if (location.hash === "#dark") document.documentElement.dataset.theme = "dark";</script>',
    "</head>",
    '<body class="mockup" style="display: grid; gap: 22px; justify-items: start; align-content: start">',
    body,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

const builder = { session: "builder", workflow: "feature/build", state: "implement", label: "Implement the cache" };

/**
 * A shell line under a permission set whose lines name FUNCTIONS, decided the way a run decides it: the REAL
 * narrowing takes it apart, and the REAL approver asks `run` about each part a function answers for,
 * before the approval this page draws — which is what the person then sees.
 */
async function judged(line: string, permissionSet: PermissionSetDecl, run: PermissionFunctionRunner): Promise<PendingApproval> {
  const block = lowerPermissionSet(parsePermissionSet(permissionSet).permissionSet, undefined, "$/permission-sets/chat/auto").permissions!;
  const input = { command: line };
  compilePolicy({}).scopeOf!({ name: "bash" }, input as never, block as never);
  let asked: CommandApproval | undefined;
  await withPermissionFunctions(
    (req) => {
      asked = commandDecisionOf(req.input)?.parts;
      return { decision: "deny", scope: "once" };
    },
    { run },
  )({ tool: "bash", input: input as never, sessionId: "s" });
  const parts = asked ?? commandDecisionOf(input)!.parts;
  return { requestId: "apr", tool: "Bash", command: line, reason: commandDecisionOf(input)!.reason, parts, permissionSet: ASK_FIRST, input, taskId: "t-1", project: "p", at: 0 };
}

const AUTO: PermissionSetDecl = { read_file: { function: "smart" }, bash: { function: "smart" }, other: { function: "smart" } };
const smartSaid = (allowed: string[]): PermissionFunctionRunner => async (_reference, request) => (allowed.includes(request.part?.program ?? "") ? "allow" : "deny");
const functionAsking = await judged("npm test && git push origin cache-probe", AUTO, smartSaid(["npm"]));
const functionFailed = await judged("cargo check && tsc --noEmit", AUTO, async (_reference, request) => {
  if (request.part?.program === "tsc") throw new Error("'smart' failed: the judge's model is not reachable");
  return "allow";
});

/** The approval PROMPT as a function calls it (`approve_tool_call`) — parked as a gate, for the person. */
function promptGate(prompt: string, request: Record<string, unknown>): PendingInteraction {
  const inputs = { prompt, request } as never;
  return { requestId: "ui-9", taskId: "t-1", project: "", component: "approve_tool_call", inputs, config: parseComponentConfig("approve_tool_call", inputs) };
}
const unsure = promptGate("smart is unsure — publishing a package is public and cannot be taken back", {
  tool: "bash",
  subject: "bash",
  function: "smart",
  input: { command: "npm test && npm publish --access public", cwd: "/repo" },
  line: "npm test && npm publish --access public",
  part: { text: "npm publish --access public", kind: "command", subject: "npm publish", span: { start: 12, end: 39 }, program: "npm", subcommand: "publish", args: [], flags: ["--access"] },
  cwd: "/repo",
  state: "feature/release/publish",
  task: "t-1",
  permissionSet: "$/permission-sets/chat/auto",
});
const writeAsked = promptGate("Allow this tool call?", {
  tool: "write_file",
  subject: "write_file",
  function: "judge.writes",
  input: { path: "deploy/production.env", content: "API_URL=https://api.internal" },
  state: "feature/build/implement",
  task: "t-1",
  permissionSet: "$/permission-sets/feature/judged",
});
const gate = (pending: PendingInteraction, settled?: string): string =>
  renderToStaticMarkup(h(GateSurface, { pending, onSubmit: () => undefined, ...(settled !== undefined ? { settled: { value: settled } } : {}) }));

const twoRequests = shell("rm foo.txt && git commit -m wip", WRITES_ASKING, WRITES_REF, WRITES);
const terraform = shell("terraform plan -out tf.plan", { bash: "ask", read_file: "allow", other: "deny" }, "$/permission-sets/chat/ask-first", ASK_FIRST);
const hosts: PendingApproval = { requestId: "apr", tool: "write_file", reason: "writes outside the worktree", input: { path: "/etc/hosts", content: "127.0.0.1 registry.internal" }, taskId: "t-1", project: "p", at: 0 };

const pages: Record<string, string> = {
  asking: [
    sheet({
      ...builder,
      at: "15:02:47",
      caption: "ui/components/command-approval · asking · one line, two requests: each tinted, only the words that matched underlined, the asking row highlighted",
      says: "The probe result is stale. Removing it and committing the fix.",
      body: surface(twoRequests),
    }),
    sheet({
      session: "builder",
      workflow: "ops/hosts",
      state: "route",
      label: "Point the registry at the mirror",
      at: "15:20:11",
      caption: "a tool with no command line: its input, the policy's reason, and the same two answers",
      body: surface(hosts),
    }),
  ].join("\n"),

  "answer-menu": [
    sheet({ ...builder, at: "15:02:47", caption: "the arrow beside Allow: what the answer covers, then how far it reaches — once, this run, or a line written into the permission set", body: surface(twoRequests, "allow"), room: 250 }),
    sheet({
      session: "operator",
      workflow: "ops/infra",
      state: "plan",
      label: "Plan the change",
      at: "16:40:02",
      caption: "a program the permission set has no line for, under a built-in permission set: the write creates an override that keeps following it. Deny offers the same reaches",
      body: surface(terraform, "deny"),
      room: 270,
    }),
    sheet({
      ...builder,
      at: "15:31:09",
      caption: "several asking parts: one choice per distinct set of widths, in the part's colour; a permission set written on the state has no file, and the menu says so",
      body: surface(shell("git commit -m wip && terraform plan && npm run build", WRITES_ASKING, "inline", INLINE), "allow"),
      room: 290,
    }),
    sheet({ session: "builder", workflow: "ops/hosts", state: "route", label: "Point the registry at the mirror", at: "15:20:11", caption: "a tool with no command line: once, or for this run", body: surface(hosts, "allow"), room: 110 }),
  ].join("\n"),

  embedded: [
    sheet({
      ...builder,
      at: "15:09:12",
      caption: "embedded commands are opened: rm sits inside its find, one step in; the pipe and the redirect are requests of their own",
      body: surface(shell("find . -name '*.tmp' -exec rm {} \\; | tee cleaned.log > out.txt", { ...WRITES_ASKING, write_file: "ask" }, WRITES_REF, WRITES)),
    }),
    sheet({
      session: "builder",
      workflow: "feature/build",
      state: "verify",
      label: "Build and check",
      at: "15:14:30",
      caption: "running a file is script: the whole of what names the file is what matched",
      body: surface(shell("npm run build && ./scripts/smoke.sh", WRITES_ASKING, WRITES_REF, WRITES)),
    }),
    sheet({
      ...builder,
      at: "15:18:44",
      caption: "past four parts the four hues repeat, in source order; pointing at a row lights its words on the line",
      body: surface(shell("git add -A && git commit -m wip && git log -1 && cat notes.md && npm run build && git push origin cache", WRITES_ASKING, WRITES_REF, WRITES)),
    }),
    sheet({
      ...builder,
      at: "15:22:03",
      caption: "a line nobody could read: one part, the parser's reason, and an answer that cannot be remembered",
      body: surface(shell("git commit -m 'unterminated", WRITES_ASKING, WRITES_REF, WRITES), "allow"),
      room: 120,
    }),
  ].join("\n"),

  function: [
    sheet({
      ...builder,
      at: "15:40:12",
      caption: "ui/components/command-approval · function · the permission set hands the shell to the smart function: it allowed npm test, which says so and is not asked about; the push still asks, because a built-in ask is stricter than a function",
      says: "Tests pass locally. Pushing the branch.",
      body: surface(functionAsking),
    }),
    sheet({
      ...builder,
      at: "15:41:30",
      caption: "a function that could not decide: its part asks, with the function's own sentence; the part it did decide is marked",
      body: surface(functionFailed),
    }),
    sheet({
      session: "release",
      workflow: "feature/release",
      state: "publish",
      label: "Publish the package",
      at: "16:02:55",
      caption: "the approval PROMPT a function calls (approve_tool_call) — smart was unsure, so it asked: the part it is asking about, which permission set line and which function, and Allow or Deny, which is what the function returns",
      body: gate(unsure),
    }),
    sheet({
      ...builder,
      at: "16:05:10",
      caption: "the same prompt for a tool that is not the shell — its arguments — and, once answered, drawn as it was answered",
      body: gate(writeAsked, "deny"),
    }),
  ].join("\n"),

  "outside-a-conversation": [
    '<div><p class="mockup-caption">ui/components/command-approval · outside a conversation · a request that names no task, in a modal; a failed answer is reported under the buttons</p>',
    `<div class="mockup-stage is-bare" style="width: 600px"><div class="modal">${surface(shell("git push origin cache-probe", WRITES_ASKING, WRITES_REF, WRITES), undefined, "no pending approval 'apr-7f3k2q'")}</div></div></div>`,
  ].join("\n"),
};

for (const [state, body] of Object.entries(pages)) {
  const file = join(outDir, `${state}.html`);
  writeFileSync(file, page(state, body), "utf8");
  console.log(`wrote ${file}`);
}
