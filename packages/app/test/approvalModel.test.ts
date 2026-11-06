/**
 * The command approval's model (decision 0007 §4): the line as tinted stretches, the row per part,
 * the reason line, and the split buttons' menu.
 *
 * The parts are the POLICY's, not hand-written: `decideCommand` takes each line apart, so a change
 * to what the engine reports (a span, a width, a `within`) shows up here as a change to what is
 * drawn. Hand-built parts are used only for the shapes no real line produces — overlapping spans,
 * spans off the end of the line.
 */
import { describe, expect, it } from "vitest";
import { parsePermissionSet, partAnswersDecision, partAnswersProblem, partApproval, type CommandApproval, type CommandPart, type PendingApproval } from "@jaira/shared";
import { decideCommand } from "@jaira/runtime";
// Not part of the runtime's public surface: the policy is normally handed a lowered block, and this
// is the one step that turns an authored map into what `decideCommand` takes.
import { shellPermissionSetOf } from "../../runtime/src/commandParts";
import {
  additionOf,
  answerMenu,
  answerWordsOf,
  approvalAnswerOf,
  bottomOf,
  choiceOfAnswer,
  continueAnswerOf,
  continueMenu,
  hueOf,
  layerNameOf,
  layerOptionsOf,
  lineSegments,
  partRows,
  provenanceOf,
  reasonLines,
  rowAnswerOf,
  rowPanel,
  middleOut,
  shortFile,
  whatChoices,
  widthsOf,
  type LineSegment,
} from "../src/renderer/approvalModel";

const PERMISSION_SET = { shell: "ask", read_file: "allow", glob: "allow", write_file: "allow", script: "ask", "git commit": "ask", "git log": "allow", other: "deny" } as const;

function judge(line: string, permissionSet: Record<string, string> = PERMISSION_SET, source = "$/permission-sets/feature/implementation/writes-asking"): CommandApproval {
  return decideCommand({}, line, "posix", { permissionSet: shellPermissionSetOf(parsePermissionSet(permissionSet).permissionSet), permissionSetSource: source }).parts;
}

function pendingOf(parts: CommandApproval, permissionSet?: PendingApproval["permissionSet"]): PendingApproval {
  return { requestId: "a1", tool: "shell", command: parts.line, parts, ...(permissionSet !== undefined ? { permissionSet } : {}), input: { command: parts.line }, taskId: "t1", project: "p", at: 0 };
}

/** The segments as a string a person can read: `[0:rm_ foo.txt]` — brackets a part, `_…_` underlined. */
function sketch(segments: LineSegment[]): string {
  return segments
    .map((s) => (s.kind === "glue" ? s.text : `[${s.part}:${s.pieces.map((p) => (p.matched ? `_${p.text}_` : p.text)).join("")}]`))
    .join("");
}

const WRITABLE: NonNullable<PendingApproval["permissionSet"]> = {
  id: "feature/implementation/writes-asking",
  targets: [
    { layer: "project", file: ".jaira/permission-sets/feature/implementation/writes-asking.json" },
    { layer: "base", file: "~/.jaira/permission-sets/feature/implementation/writes-asking.json", follows: "$SYSTEM/permission-sets/feature/implementation/writes-asking" },
  ],
};

describe("the line in the colours of its parts", () => {
  it("tints each part whole, underlines only what matched, and leaves what joins them as glue", () => {
    const approval = judge("rm foo.txt && git commit -m wip");
    expect(sketch(lineSegments(approval.line, approval.parts))).toBe("[0:_rm_ foo.txt] && [1:_git commit_ -m wip]");
  });

  it("underlines the program alone when nothing but the shell's own line matched", () => {
    const approval = judge("terraform plan -out tf.plan");
    expect(sketch(lineSegments(approval.line, approval.parts))).toBe("[0:_terraform_ plan -out tf.plan]");
  });

  it("underlines words that are not adjacent, and a script's whole invocation", () => {
    expect(sketch(lineSegments("git -C sub commit -m x", judge("git -C sub commit -m x").parts))).toBe("[0:_git_ -C sub _commit_ -m x]");
    const scripts = judge("npm run build && ./scripts/smoke.sh");
    expect(sketch(lineSegments(scripts.line, scripts.parts))).toBe("[0:_npm run build_] && [1:_./scripts/smoke.sh_]");
  });

  it("gives a part written INSIDE another its own colour, and the host the rest — `rm` inside `-exec rm {}`, and the redirect's operator", () => {
    const line = "find . -name '*.tmp' -exec rm {} \\; | tee cleaned.log > out.txt";
    const approval = judge(line);
    expect(approval.parts.map((p) => p.within)).toEqual([undefined, 0, undefined, undefined]);
    expect(sketch(lineSegments(line, approval.parts))).toBe("[0:_find_ . -name '*.tmp' -exec ][1:_rm_ {}][0: \\;] | [2:_tee_ cleaned.log] [3:_>_ out.txt]");
  });

  it("draws what a runner runs indented under it, and says so rather than repeating the line", () => {
    const part = (subject: string, text: string, verdict: CommandPart["verdict"], extra: Partial<CommandPart> = {}): CommandPart => ({
      span: { start: 0, end: 13 },
      matched: [{ start: 0, end: 3 }],
      text,
      kind: "command",
      subject,
      verdict,
      decidedBy: { source: "default", reason: "" },
      widths: [],
      ...extra,
    });
    const rows = partRows({
      line: "npm run build",
      dialect: "powershell",
      verdict: "asks",
      parts: [part("runner:npm", "npm run build", "allowed", { kind: "runner" }), part("script", "npm run build", "asks", { within: 0 }), part("git status", "git status", "allowed", { within: 1, via: ["npm run build"] })],
    });
    expect(rows.map((r) => [r.depth, r.pieces.map((p) => p.text).join("")])).toEqual([
      [0, "npm run build"],
      [1, "what it runs"],
      [2, "git status"],
    ]);
    expect(rows[2]!.note).toBeUndefined();
  });

  it("dims an embedder that is no request itself, and tints what it embeds", () => {
    const approval = judge("bash -c 'git commit -m x && rm y'");
    expect(sketch(lineSegments(approval.line, approval.parts))).toBe("bash -c '[0:_git commit_ -m x] && [1:_rm_ y]'");
  });

  it("survives OVERLAPPING spans: every character is drawn once, by the smaller part, the later one on a tie", () => {
    const part = (start: number, end: number, m: [number, number]): CommandPart => ({
      span: { start, end },
      matched: [{ start: m[0], end: m[1] }],
      text: "",
      kind: "command",
      subject: "x",
      verdict: "asks",
      decidedBy: { source: "default", reason: "" },
      widths: [],
    });
    const line = "abcdefghij";
    //            0123456789 — [0,6) and [4,10) overlap on `ef`; the second is no bigger, so it wins there.
    const segments = lineSegments(line, [part(0, 6, [0, 1]), part(4, 10, [4, 5])]);
    expect(sketch(segments)).toBe("[0:_a_bcd][1:_e_fghij]");
    expect(segments.map((s) => (s.kind === "glue" ? s.text : s.pieces.map((p) => p.text).join(""))).join("")).toBe(line);
    // Spans off the end, reversed or empty draw nothing rather than throwing.
    expect(sketch(lineSegments("ab", [part(1, 99, [1, 99]), part(5, 3, [0, 0]), part(0, 0, [0, 0])]))).toBe("a[0:_b_]");
  });

  it("cycles the four hues past four parts, in source order", () => {
    const approval = judge("a && b && c && d && e && f");
    expect(approval.parts).toHaveLength(6);
    expect(partRows(approval).map((row) => row.hue)).toEqual(["var(--p1)", "var(--p2)", "var(--p3)", "var(--p0)", "var(--p1)", "var(--p2)"]);
    expect(hueOf(4)).toBe(hueOf(0));
    expect(sketch(lineSegments(approval.line, approval.parts))).toBe("[0:_a_] && [1:_b_] && [2:_c_] && [3:_d_] && [4:_e_] && [5:_f_]");
  });
});

describe("one row per part", () => {
  it("says what was typed, what it is a request FOR, where, and the verdict", () => {
    const rows = partRows(judge("rm foo.txt && git commit -m wip"));
    expect(rows).toMatchObject([
      { pieces: [{ text: "rm", matched: true }, { text: " foo.txt", matched: false }], subject: "write_file", note: "foo.txt", verdict: "allowed", depth: 0 },
      { pieces: [{ text: "git commit", matched: true }, { text: " -m wip", matched: false }], subject: "git commit", verdict: "asks", depth: 0 },
    ]);
    expect(rows[1]!.note).toBeUndefined();
  });

  it("names the FALLBACK entry for a program no line names, and says so", () => {
    const [row] = partRows(judge("terraform plan -out tf.plan"));
    expect(row).toMatchObject({ subject: "shell", verdict: "asks" });
    expect(row!.note).toBe("no line names terraform plan — any other command · terraform can deploy or change infrastructure");
  });

  it("indents a part written inside another, and says in words what a part was opened out of when its host is no row", () => {
    const rows = partRows(judge("find . -name '*.tmp' -exec rm {} \\;", { ...PERMISSION_SET, write_file: "ask" }));
    expect(rows.map((r) => [r.subject, r.depth, r.verdict])).toEqual([
      ["glob", 0, "allowed"],
      ["write_file", 1, "asks"],
    ]);
    // `{}` is wherever the find walks, which a bare `.` would not say.
    expect(rows[1]!.note).toBe("whatever find matches under .");
    expect(partRows(judge("bash -c 'git commit -m x'"))[0]!.note).toBe("inside bash");
  });

  it("shows why for a part no permission set decided", () => {
    const approval = judge("git commit -m 'unterminated");
    expect(partRows(approval)).toMatchObject([{ subject: "shell", verdict: "asks", note: "command could not be parsed (unterminated quote)" }]);
  });
});

describe("the reason line", () => {
  it("names the permission set and the subject that asks", () => {
    expect(reasonLines(pendingOf(judge("rm foo.txt && git commit -m wip"), WRITABLE))).toEqual([{ kind: "permissionSet", permissionSet: "feature/implementation/writes-asking", entries: ["git commit"] }]);
  });

  it("names each asking entry once, and a map with no file by no name", () => {
    const pending = pendingOf(judge("git commit -m a && npm run build && git commit -m b", PERMISSION_SET, "inline"));
    expect(reasonLines(pending)).toEqual([{ kind: "permissionSet", entries: ["git commit", "script"] }]);
  });

  it("falls back to the policy's reason — for a part the permission set did not decide, and for a request with no parts", () => {
    expect(reasonLines(pendingOf(judge("git commit -m 'unterminated")))).toEqual([{ kind: "policy", text: "command could not be parsed (unterminated quote)" }]);
    expect(reasonLines({ requestId: "a", tool: "write_file", reason: "writes outside the worktree", input: {}, project: "p", at: 0 })).toEqual([
      { kind: "policy", text: "writes outside the worktree" },
    ]);
    expect(reasonLines({ requestId: "a", tool: "write_file", input: {}, project: "p", at: 0 })).toEqual([]);
  });
});

describe("the answer menu", () => {
  it("asks WHAT first — this subcommand or every command of the program — then HOW FAR", () => {
    const pending = pendingOf(judge("rm foo.txt && git commit -m wip"), WRITABLE);
    const menu = answerMenu(pending, "allow");
    expect(menu.whatLabel).toBe("Allow what");
    expect(menu.what).toEqual([
      { key: "git commit | git", part: 1, chosen: "git commit", options: [{ width: "git commit", program: false }, { width: "git", program: true }] },
    ]);
    expect(menu.reach.map((r) => [r.reach, r.name, r.isDefault])).toEqual([
      ["once", "Allow once", true],
      ["run", "Allow for this run", false],
      ["add:project", "Add to writes-asking, in this project", false],
      ["add:base", "Add to writes-asking, for all projects", false],
    ]);
    // Exactly what will be written, and where.
    expect(menu.reach[2]!.hint).toEqual(["writes ", { code: '"git commit": "allow"' }, " to .jaira/permission-sets/…/writes-asking.json"]);
    expect(menu.reach[3]!.hint).toEqual(["creates ~/.jaira/permission-sets/…/writes-asking.json with ", { code: '"git commit": "allow"' }, ", following the built-in permission set"]);
  });

  it("writes what the person CHOSE: the program's width, and deny as deny", () => {
    const pending = pendingOf(judge("terraform plan -out tf.plan"), WRITABLE);
    const chosen = { "terraform plan | terraform": "terraform" };
    expect(answerMenu(pending, "deny", chosen).reach[2]!.hint).toContainEqual({ code: '"terraform": "deny"' });
    expect(answerMenu(pending, "deny", chosen).reach.map((r) => r.name).slice(0, 2)).toEqual(["Deny once", "Deny for this run"]);
    expect(approvalAnswerOf(pending, "add:base", chosen)).toEqual({ scope: "workflow-run", remember: ["terraform"], addTo: "base" });
    expect(approvalAnswerOf(pending, "run")).toEqual({ scope: "workflow-run", remember: ["terraform plan"] });
    expect(approvalAnswerOf(pending, "once", chosen)).toEqual({ scope: "once" });
    // A width the part does not offer is not a choice.
    expect(widthsOf(pending.parts!, { "terraform plan | terraform": "rm" })).toEqual(["terraform plan"]);
  });

  it("asks once per DISTINCT set of widths among the asking parts, and lists a single width with nothing to choose", () => {
    const approval = judge("git commit -m a && terraform plan && npm run build && ./x.sh && git commit -m b && cat a.txt");
    const what = whatChoices(approval, { "git commit | git": "git" });
    expect(what.map((c) => [c.key, c.part, c.chosen, c.options.length])).toEqual([
      ["git commit | git", 0, "git", 2],
      ["terraform plan | terraform", 1, "terraform plan", 2],
      ["script", 2, "script", 1],
    ]);
    // The allowed `cat` contributes nothing; two `git commit`s and two scripts are one line each.
    expect(additionOf(approval, "allow", { "git commit | git": "git" })).toEqual({ git: "allow", "terraform plan": "allow", script: "allow" });
    expect(widthsOf(approval, { "git commit | git": "git" })).toEqual(["git", "terraform plan", "script"]);
  });

  it("says so, and offers only once and this run, when the permission set has no file", () => {
    const unwritable = "This permission set is written on the state itself, so there is no permission set file to add a line to.";
    const menu = answerMenu(pendingOf(judge("git commit -m wip", PERMISSION_SET, "inline"), { targets: [], unwritable }), "allow");
    expect(menu.reach.map((r) => r.reach)).toEqual(["once", "run"]);
    expect(menu.notes).toEqual([unwritable]);
  });

  it("offers only once for a line nobody could read, and says why", () => {
    const pending = pendingOf(judge("git commit -m 'unterminated"), WRITABLE);
    const menu = answerMenu(pending, "allow");
    expect(menu.what).toEqual([]);
    expect(menu.reach.map((r) => r.reach)).toEqual(["once"]);
    expect(menu.notes[0]).toMatch(/could not be read/);
  });

  it("keeps the same two buttons for a tool with no command line: once, or this run", () => {
    const pending: PendingApproval = { requestId: "a", tool: "write_file", input: { path: "/etc/hosts" }, project: "p", at: 0 };
    const menu = answerMenu(pending, "allow");
    expect(menu.what).toEqual([]);
    expect(menu.reach.map((r) => r.reach)).toEqual(["once", "run"]);
    expect(approvalAnswerOf(pending, "run")).toEqual({ scope: "workflow-run" });
  });

  it("shortens a nested bucket's path to its ends", () => {
    expect(shortFile(".jaira/permission-sets/project/build-safe.json")).toBe(".jaira/permission-sets/…/build-safe.json");
    // A set at the top level has no bucket to cut.
    expect(shortFile(".jaira/permission-sets/ask-first.json")).toBe(".jaira/permission-sets/ask-first.json");
    expect(shortFile("elsewhere.json")).toBe("elsewhere.json");
  });
});

/**
 * Design 4D (decision 0023 ruling 7, §4.4): the rows answered one by one, over a stack. The line is
 * the mockup's — `npm --workspace @jaira/client run build`, its script's `one build` and the inline
 * `node -e` it runs — hand-built, since what the policy reports about a stack is pinned where the stack
 * is judged (`approvalPermissionSet.test.ts`); here it is what is DRAWN and what is SENT.
 */
describe("the rows, answered one by one", () => {
  const where = (at: string): CommandPart["where"] => ({
    kind: "path",
    at,
    widths: [
      { width: "this", place: at },
      { width: "folder", place: "packages" },
      { width: "project", place: "$PROJECT" },
      { width: "anywhere", place: "**" },
    ],
  });
  const part = (text: string, subject: string, verdict: CommandPart["verdict"], decidedBy: CommandPart["decidedBy"], widths: string[], extra: Partial<CommandPart> = {}): CommandPart => ({
    span: { start: 0, end: 0 },
    matched: [],
    text,
    kind: "command",
    subject,
    verdict,
    decidedBy,
    widths,
    ...extra,
  });
  const ASKS = (entry: string): CommandPart["decidedBy"] => ({ source: "permissionSet", entry, layer: "ask-first", reason: `the permission set's '${entry}' is ask` });
  const LINE = "npm --workspace @jaira/client run build";
  const APPROVAL: CommandApproval = {
    line: LINE,
    dialect: "powershell",
    verdict: "asks",
    permissionSet: "$/permission-sets/ask-first",
    stack: ["runtime", "web/docs-sites", "project/build-safe", "ask-first"],
    parts: [
      part(LINE, "runner:npm", "asks", ASKS("runner:npm"), ["runner:npm"], { kind: "runner" }),
      part("npm run build:client", "npm run build", "allowed", { source: "permissionSet", entry: "npm run build", place: "packages/client", layer: "project/build-safe", reason: "" }, ["npm run build", "npm"], { within: 0, where: where("packages/client") }),
      part("one build", "one build", "asks", ASKS("shell"), ["one build", "one"], { within: 1, where: where("packages/client") }),
      part(`node -e "…rmSync(\`dist/client\`)…"`, "script", "asks", ASKS("script"), ["script"], { kind: "script", within: 1 }),
    ],
  };
  const LAYERS: NonNullable<PendingApproval["layers"]> = [
    { id: "runtime", scope: "runtime", targets: [], unwritable: "This task's own answers — answer For this run to add to it." },
    { id: "web/docs-sites", scope: "global", targets: [{ layer: "project", file: ".jaira/permission-sets/web/docs-sites.json", follows: "$/permission-sets/web/docs-sites" }] },
    { id: "project/build-safe", scope: "project", targets: [{ layer: "project", file: ".jaira/permission-sets/project/build-safe.json" }] },
    {
      id: "ask-first",
      scope: "built in",
      everyone: true,
      targets: [
        { layer: "project", file: ".jaira/permission-sets/ask-first.json", follows: "$SYSTEM/permission-sets/ask-first" },
        { layer: "base", file: "~/.jaira/permission-sets/ask-first.json", follows: "$SYSTEM/permission-sets/ask-first" },
      ],
    },
  ];
  const PENDING: PendingApproval = { ...pendingOf(APPROVAL), layers: LAYERS, defaultLayer: "project/build-safe" };

  it("says on each row who decided, with its layer and place", () => {
    const rows = partRows(APPROVAL);
    expect(rows.map((r) => r.who)).toEqual([
      "ask-first asks · no layer above names it",
      "in packages/client · build-safe allows",
      "in packages/client · ask-first asks · no layer names one build",
      "ask-first asks · no layer above names it",
    ]);
    // The fallback's words give way to the layer's; what a runner runs stays indented under it.
    expect(rows[2]!.note).toBe("in packages/client · ask-first asks · no layer names one build");
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2, 2]);
    // The runtime hands the place the part is about absolute; the row names it as a line would write it.
    const absolute = { ...APPROVAL.parts[2]!, where: { ...where("packages/client")!, at: "C:/work/repo/packages/client" } };
    expect(provenanceOf(APPROVAL, absolute)).toBe("in packages/client · ask-first asks · no layer names one build");
    // A layer that is no file is named by what it is.
    expect(provenanceOf(APPROVAL, { ...APPROVAL.parts[0]!, verdict: "allowed", decidedBy: { source: "remembered", layer: "runtime", reason: "" } })).toBe("this run allows");
    expect(layerNameOf("inline")).toBe("this state");
    expect(layerNameOf("tools")).toBe("the tools layer");
    // No layer decided (a built-in): no layer words, and the row keeps its own reason.
    expect(provenanceOf(APPROVAL, { ...APPROVAL.parts[0]!, decidedBy: { source: "builtin", reason: "pushes publish work" } })).toBeUndefined();
  });

  it("names the stack, oldest first, in place of the set and its entries", () => {
    expect(reasonLines(PENDING)).toEqual([{ kind: "stack", layers: ["ask-first", "project/build-safe", "web/docs-sites"], thisRun: true }]);
  });

  it("opens a row's panel on What, Where and How far — narrowest first, once, the default layer — answering nothing", () => {
    const panel = rowPanel(PENDING, 2);
    expect(panel.what).toMatchObject({ chosen: "one build", options: [{ width: "one build", program: false }, { width: "one", program: true }] });
    expect(panel.where!.options.map((o) => [o.label, o.place])).toEqual([
      ["packages/client", "packages/client"],
      ["packages", "packages"],
      ["this project", "$PROJECT"],
      ["anywhere", undefined],
    ]);
    expect(panel.where!.chosen).toBe("packages/client");
    expect(panel.reach.map((r) => [r.reach, r.name, r.disabled])).toEqual([
      ["once", "Once", undefined],
      ["run", "For this run", undefined],
      ["add", "Add to", undefined],
    ]);
    expect(panel.reach[1]!.hint).toEqual(['joins "this run", the top layer; nothing is written']);
    expect(panel.chosenReach).toBe("once");
    // Newest layer first, each file of it; the runtime layer is "For this run", not a file.
    expect(panel.layers.map((o) => [o.name, o.layer, o.addTo, o.everyone])).toEqual([
      ["docs-sites", "web/docs-sites", "project", false],
      ["build-safe", "project/build-safe", "project", false],
      ["ask-first, in this project", "ask-first", "project", true],
      ["ask-first, for all projects", "ask-first", "base", true],
    ]);
    expect(panel.chosenLayer!.id).toBe("project/build-safe");
    // The line it would write, shown before Deny or Allow is pressed.
    expect(panel.line).toBe('"one build": { "packages/client": … }');
  });

  it("shows the line at the place and in the layer chosen, and says when the layer is a shipped preset", () => {
    const panel = rowPanel(PENDING, 2, { place: "packages", reach: "add" });
    expect(panel.chosenReach).toBe("add");
    expect(panel.reach[2]!.hint).toEqual(["writes ", { code: '"one build": { "packages": … }' }, " to .jaira/permission-sets/…/build-safe.json when you continue"]);
    const preset = rowPanel(PENDING, 2, { width: "one", place: "**", reach: "add", layer: "ask-first|base" });
    expect(preset.line).toBe('"one": …');
    expect(preset.reach[2]!.hint).toEqual([
      "creates ~/.jaira/permission-sets/ask-first.json with ",
      { code: '"one": …' },
      ", following the built-in permission set, when you continue",
      " — changes that set for everyone who uses it",
    ]);
  });

  it("answers the row with the button pressed, at the reach chosen — a deny as well as an allow, written into a layer", () => {
    expect(rowAnswerOf(PENDING, 2, { place: "packages", reach: "add" }, "deny")).toEqual({ decision: "deny", reach: "add", width: "one build", place: "packages", layer: "project/build-safe", addTo: "project" });
    expect(rowAnswerOf(PENDING, 2, { width: "one", place: "**", reach: "run" }, "allow")).toEqual({ decision: "allow", reach: "run", width: "one" });
    expect(rowAnswerOf(PENDING, 2, {}, "allow")).toEqual({ decision: "allow", reach: "once", width: "one build", place: "packages/client" });
    // Reopened, the panel shows what was chosen.
    const given = rowAnswerOf(PENDING, 2, { place: "packages", reach: "add", layer: "ask-first|project" }, "deny");
    expect(rowAnswerOf(PENDING, 2, choiceOfAnswer(PENDING, given), "deny")).toEqual(given);
    expect(answerWordsOf(PENDING, 2, given)).toBe("you deny one build · added to ask-first, in this project · in packages");
    expect(answerWordsOf(PENDING, 2, { decision: "allow", reach: "run", width: "one" })).toBe("you allow every one command · for this run");
  });

  it("offers a part with no place no Where, and a part nobody could read only Once", () => {
    expect(rowPanel(PENDING, 3).where).toBeUndefined();
    const unread: PendingApproval = { ...PENDING, parts: { ...APPROVAL, parts: [part("$CMD x", "shell", "asks", { source: "parser", reason: "what runs is decided at run time" }, [])] } };
    const panel = rowPanel(unread, 0, { reach: "run" });
    expect(panel.what).toBeUndefined();
    expect(panel.chosenReach).toBe("once");
    expect(panel.reach.filter((r) => r.disabled !== undefined).map((r) => r.reach)).toEqual(["run", "add"]);
    expect(panel.notes[0]).toMatch(/could not be read/);
  });

  it("says why nothing can be added when no layer can be written, and falls back to the set that asked when there is no stack", () => {
    const unwritable = "These lines are written on the state itself, so there is no permission set file to add a line to.";
    const inline: PendingApproval = { ...PENDING, parts: { ...APPROVAL, permissionSet: "inline", stack: ["inline"] }, layers: [{ id: "inline", scope: "this state", targets: [], unwritable }] };
    const panel = rowPanel(inline, 2, { reach: "add" });
    expect(panel.chosenReach).toBe("once");
    expect(panel.reach[2]!.disabled).toBe(unwritable);
    const flat: PendingApproval = pendingOf(judge("git commit -m wip"), WRITABLE);
    expect(layerOptionsOf(flat).map((o) => [o.key, o.layer, o.addTo])).toEqual([
      ["feature/implementation/writes-asking|project", undefined, "project"],
      ["feature/implementation/writes-asking|base", undefined, "base"],
    ]);
    // With no stack the set that asked is written: no layer is named.
    expect(rowAnswerOf(flat, 0, { reach: "add", layer: "feature/implementation/writes-asking|base" }, "allow")).toEqual({ decision: "allow", reach: "add", width: "git commit", addTo: "base" });
  });

  it("keeps the aggregate Allow / Deny until a row is answered by hand, then Continue / Cancel", () => {
    expect(bottomOf(PENDING, {})).toEqual({ mode: "aggregate" });
    expect(bottomOf(PENDING, { 2: { decision: "allow", reach: "once" } })).toEqual({ mode: "continue", rest: [0, 3], refuses: false });
    expect(bottomOf(PENDING, { 2: { decision: "deny", reach: "once" } })).toEqual({ mode: "continue", rest: [0, 3], refuses: true });
    // A tool with no command line has no rows to answer.
    expect(bottomOf({ requestId: "a", tool: "write_file", input: {}, project: "p", at: 0 }, {})).toEqual({ mode: "aggregate" });
  });

  it("gives Continue a menu for the rows still asking, and none when every row was answered", () => {
    const menu = continueMenu(PENDING, { 2: { decision: "deny", reach: "once" } })!;
    expect(menu.heading).toBe("Continue answers the 2 rows still asking");
    expect(menu.what.map((c) => c.part)).toEqual([0, 3]);
    expect(menu.reach.map((r) => r.name)).toEqual(["Allow once", "Allow for this run"]);
    expect(continueMenu(PENDING, { 0: { decision: "allow", reach: "once" }, 2: { decision: "allow", reach: "once" }, 3: { decision: "allow", reach: "once" } })).toBeUndefined();
  });

  it("sends every row: those answered by hand as they were, the rest at Continue's reach — and a denied row refuses the call", () => {
    const denied = { decision: "deny" as const, reach: "add" as const, width: "one build", place: "packages", layer: "project/build-safe", addTo: "project" as const };
    expect(continueAnswerOf(PENDING, { 2: denied })).toEqual({
      decision: "deny",
      scope: "workflow-run",
      answers: [
        { part: 0, decision: "allow", reach: "once" },
        { part: 2, ...denied },
        { part: 3, decision: "allow", reach: "once" },
      ],
    });
    // Allowed by hand once, the rest for this run at the width Continue's menu chose: the call runs.
    expect(continueAnswerOf(PENDING, { 2: { decision: "allow", reach: "once", width: "one build" } }, "run")).toEqual({
      decision: "allow",
      scope: "workflow-run",
      answers: [
        { part: 0, decision: "allow", reach: "run", width: "runner:npm" },
        { part: 2, decision: "allow", reach: "once", width: "one build" },
        { part: 3, decision: "allow", reach: "run", width: "script" },
      ],
    });
    // Every row once: the answer reaches no further than the call.
    expect(continueAnswerOf(PENDING, { 0: { decision: "allow", reach: "once" } })).toMatchObject({ decision: "allow", scope: "once" });
    // Added to the set that asked, as the aggregate menu's "Add to" does.
    expect(continueAnswerOf(PENDING, { 0: { decision: "allow", reach: "once" } }, "add:project").answers.slice(1)).toEqual([
      { part: 2, decision: "allow", reach: "add", width: "one build", addTo: "project" },
      { part: 3, decision: "allow", reach: "add", width: "script", addTo: "project" },
    ]);
  });

  it("is what the service takes: every answer about a part that asks, at a width and place it offers", () => {
    const { answers } = continueAnswerOf(PENDING, { 2: rowAnswerOf(PENDING, 2, { place: "packages", reach: "add" }, "deny") });
    expect(partAnswersProblem(APPROVAL, answers)).toBeUndefined();
    expect(partAnswersDecision(APPROVAL, answers)).toBe("deny");
    expect(partAnswersProblem(APPROVAL, [{ part: 1, decision: "allow", reach: "once" }])).toMatch(/not a part of this line that asks/);
    expect(partAnswersProblem(APPROVAL, [{ part: 2, decision: "allow", reach: "run", place: "elsewhere" }])).toMatch(/not a place/);
    expect(partAnswersProblem(APPROVAL, [{ part: 2, decision: "allow", reach: "once" }, { part: 2, decision: "deny", reach: "once" }])).toMatch(/twice/);
    // Alone, a part is judged under nothing.
    const { within: _within, ...alone } = APPROVAL.parts[2]!;
    expect(partApproval(APPROVAL, 2).parts).toEqual([alone]);
  });
});

describe("a Where choice too long for its chip", () => {
  it("is cut in the middle, keeping both ends, and one that fits is left whole", () => {
    expect(middleOut("packages/app/build.mjs")).toBe("packages/app/build.mjs");
    const long = "packages/some-very-long-workspace-name/src/generated/deeply/nested/build.mjs";
    const cut = middleOut(long);
    expect([...cut].length).toBe(44);
    expect(cut.startsWith("packages/some-ver")).toBe(true);
    expect(cut.endsWith("nested/build.mjs")).toBe(true);
    expect(cut).toContain("…");
    expect(middleOut("abcdefghij", 7)).toBe("ab…ghij");
  });
});
