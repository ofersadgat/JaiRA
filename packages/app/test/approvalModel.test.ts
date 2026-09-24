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
import { parsePermissionSet, type CommandApproval, type CommandPart, type PendingApproval } from "@jaira/shared";
import { decideCommand } from "@jaira/runtime";
// Not part of the runtime's public surface: the policy is normally handed a lowered block, and this
// is the one step that turns an authored map into what `decideCommand` takes.
import { shellPermissionSetOf } from "../../runtime/src/commandParts";
import {
  additionOf,
  answerMenu,
  approvalAnswerOf,
  hueOf,
  lineSegments,
  partRows,
  reasonLines,
  shortFile,
  whatChoices,
  widthsOf,
  type LineSegment,
} from "../src/renderer/approvalModel";

const PERMISSION_SET = { bash: "ask", read_file: "allow", glob: "allow", write_file: "allow", script: "ask", "git commit": "ask", "git log": "allow", other: "deny" } as const;

function judge(line: string, permissionSet: Record<string, string> = PERMISSION_SET, source = "$/permission-sets/feature/implementation/writes-asking"): CommandApproval {
  return decideCommand({}, line, "posix", { permissionSet: shellPermissionSetOf(parsePermissionSet(permissionSet).permissionSet), permissionSetSource: source }).parts;
}

function pendingOf(parts: CommandApproval, permissionSet?: PendingApproval["permissionSet"]): PendingApproval {
  return { requestId: "a1", tool: "bash", command: parts.line, parts, ...(permissionSet !== undefined ? { permissionSet } : {}), input: { command: parts.line }, taskId: "t1", project: "p", at: 0 };
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
    expect(row).toMatchObject({ subject: "bash", verdict: "asks" });
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
    expect(partRows(approval)).toMatchObject([{ subject: "bash", verdict: "asks", note: "command could not be parsed (unterminated quote)" }]);
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
    expect(shortFile(".jaira/permission-sets/chat/ask-first.json")).toBe(".jaira/permission-sets/…/ask-first.json");
    expect(shortFile("elsewhere.json")).toBe("elsewhere.json");
  });
});
