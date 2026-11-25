/**
 * Variables read through as a line is taken apart (decision 0007 §4, amended 2026-11-25) —
 * `shellVariables.ts` through `takeApart(line, dialect, [], { env })`.
 */
import { describe, expect, it } from "vitest";
import { takeApart, type CommandDialect, type ParsedCommand } from "../src/shellCommand";
import { environmentLookupOf, looksSecret } from "../src/shellVariables";

const ENV = environmentLookupOf({ TEMP: String.raw`C:\Users\me\AppData\Local\Temp`, HOME: "/home/me", GITHUB_TOKEN: "ghp_x", SPACED: "a b", EDGE: "/opt/edge" }, true);

const commandsOf = (line: string, dialect: CommandDialect, env = ENV): ParsedCommand[] => takeApart(line, dialect, [], { env }).commands;
const first = (line: string, dialect: CommandDialect, env = ENV): ParsedCommand => commandsOf(line, dialect, env)[0]!;
const variablesOf = (line: string, dialect: CommandDialect, env = ENV): string[] =>
  (takeApart(line, dialect, [], { env }).variables ?? []).map((v) => `${line.slice(v.span.start, v.span.end)}=${v.value}`);

const EDGE = String.raw`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`;

describe("PowerShell", () => {
  const line = String.raw`$d="$env:TEMP\tdshots"; $e="${EDGE}"; foreach($n in 1..6){ & $e --headless --disable-gpu --hide-scrollbars --screenshot="$d\d$n.png" --window-size=1440,1560 --virtual-time-budget=12000 "http://127.0.0.1:8142/?hero=$n" 2>$null | Out-Null }; Start-Sleep 5; dir $d | select Name,Length`;

  it("reads `& $e` as the program it was set to, and its arguments through the variables that are certain", () => {
    const edge = commandsOf(line, "powershell").find((c) => c.program === "msedge")!;
    expect(edge.dynamic).toBeUndefined();
    expect(edge.tokens[0]).toBe(EDGE);
    // `$d` is certain, the loop's `$n` is not.
    expect(edge.tokens).toContain(String.raw`--screenshot=C:\Users\me\AppData\Local\Temp\tdshots\d$n.png`);
    expect(edge.words!.find((w) => w.value.startsWith("--screenshot"))!.dynamic).toBe(true);
    expect(commandsOf(line, "powershell").find((c) => c.program === "get-childitem")!.subcommand).toBe(String.raw`c:\users\me\appdata\local\temp\tdshots`);
  });

  it("records each reference read through, with its span in the line as written", () => {
    expect(variablesOf(line, "powershell")).toEqual([
      String.raw`$env:TEMP=C:\Users\me\AppData\Local\Temp`,
      `$e=${EDGE}`,
      String.raw`$d=C:\Users\me\AppData\Local\Temp\tdshots`,
      String.raw`$d=C:\Users\me\AppData\Local\Temp\tdshots`,
    ]);
  });

  it("reads single quotes, `${braced}` names, and a variable set to another", () => {
    expect(first("$a = 'C:\\x\\git.exe'; $b = $a; & ${b} status", "powershell").program).toBe("git");
  });

  it("leaves a value that is not certain where it is read decided at run time", () => {
    const dynamic = (l: string): boolean | undefined => commandsOf(l, "powershell").at(-1)!.dynamic;
    expect(dynamic("& $e x; $e = 'git'")).toBe(true); // read before it is set
    expect(dynamic("$e = 'git'; $e = 'rm'; & $e x")).toBe(true); // set twice
    expect(dynamic("if ($c) { $e = 'git' }; & $e x")).toBe(true); // set in a block
    expect(dynamic("$e = 'git'; foreach ($i in 1..2) { $e += 'x' }; & $e x")).toBe(true); // set again in a loop
    expect(dynamic("$e = (Get-Command git).Source; & $e x")).toBe(true); // set from what a command prints
    expect(dynamic("$e = 'git'; Set-Variable e rm; & $e x")).toBe(true); // set a way this does not follow
    expect(dynamic("$e = 'git'; .\\setup.ps1; & $e x")).toBe(true); // a script could set it
    expect(dynamic("$e = 'git'; & $e.Trim() x")).toBe(true); // a member of it
    expect(dynamic("& $env:GITHUB_TOKEN x")).toBe(true); // a secret's name
    expect(dynamic("& $env:NOPE x")).toBe(true); // not in the environment
    expect(dynamic("$env:EDGE = 'rm'; & $env:EDGE x")).toBe(true); // the line sets it
    expect(dynamic("& $HOME\\x.exe")).toBe(true); // automatic: PowerShell's, not the line's
  });

  it("reads the environment only when it is given one", () => {
    expect(first("& $env:EDGE --x", "powershell").program).toBe("edge");
    expect(takeApart("& $env:EDGE --x", "powershell").commands[0]!.dynamic).toBe(true);
  });

  it("hands a payload the value an expandable string gave it, and leaves a single-quoted one to the shell it starts", () => {
    expect(commandsOf(`$e = 'git'; powershell -Command "& $e status"`, "powershell").map((c) => c.program)).toContain("git");
    const inner = commandsOf(`$e = 'git'; powershell -Command '& $e status'`, "powershell").find((c) => c.via !== undefined);
    expect(inner?.dynamic).toBe(true);
  });
});

describe("POSIX", () => {
  it("reads a top-level assignment and the environment", () => {
    const cmd = first('e=/usr/bin/foo; "$e" --x "$HOME/a"', "posix");
    expect(cmd.program).toBe("foo");
    expect(cmd.tokens).toEqual(["/usr/bin/foo", "--x", "/home/me/a"]);
    expect(variablesOf('e=/usr/bin/foo; "$e" --x "$HOME/a"', "posix")).toEqual(["$e=/usr/bin/foo", "$HOME=/home/me"]);
    expect(commandsOf("export E=/opt/x; ${E} run", "posix").at(-1)!.program).toBe("x");
  });

  it("never reads an unquoted value the shell would split or glob", () => {
    expect(first("$SPACED x", "posix").dynamic).toBe(true);
    expect(first('"$SPACED" x', "posix").program).toBe("a b");
    expect(first("e='a*'; $e x", "posix").dynamic).toBe(true);
  });

  it("leaves what is not certain decided at run time", () => {
    const dynamic = (l: string): boolean | undefined => commandsOf(l, "posix").at(-1)!.dynamic;
    expect(dynamic("e=git x; $e status")).toBe(true); // set for one command only
    expect(dynamic("true && e=git; $e status")).toBe(true); // after `&&`
    expect(dynamic("if true; then e=git; fi; $e status")).toBe(true); // in a branch
    expect(dynamic("e=git; e=rm; $e status")).toBe(true); // set twice
    expect(dynamic("e=git; eval e=rm; $e status")).toBe(true); // set a way this does not follow
    expect(dynamic("e=$(which git); $e status")).toBe(true); // what a command prints
    expect(dynamic("$PWD/x")).toBe(true); // the shell's own
    expect(dynamic("$GITHUB_TOKEN x")).toBe(true); // a secret's name
  });

  it("gives a payload's own shell the environment, less what the line around it sets", () => {
    expect(commandsOf("sh -c '$HOME/bin/x'", "posix").find((c) => c.via !== undefined)!.program).toBe("x");
    expect(commandsOf("export HOME=/tmp; sh -c '$HOME/bin/x'", "posix").find((c) => c.via !== undefined)!.dynamic).toBe(true);
  });
});

describe("cmd", () => {
  it("reads %NAME% from the environment where it stays one word", () => {
    expect(first(String.raw`"%TEMP%\tool.exe" /q`, "cmd").program).toBe("tool");
    expect(first(String.raw`%EDGE% /q`, "cmd").program).toBe("edge");
    expect(first(String.raw`%SPACED% /q`, "cmd").dynamic).toBe(true);
    expect(first(String.raw`set X=1 & %EDGE% /q`, "cmd").dynamic).toBeUndefined();
    expect(commandsOf(String.raw`set X=1 & %EDGE% /q`, "cmd").at(-1)!.dynamic).toBe(true);
  });
});

it("knows a secret's name", () => {
  for (const name of ["GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY", "DB_PASSWORD", "API_KEY", "apikey", "NPM_AUTH", "SSH_PRIVATE"]) expect(looksSecret(name)).toBe(true);
  for (const name of ["TEMP", "HOME", "PATH", "e", "d", "EDGE", "MONKEY"]) expect(looksSecret(name)).toBe(false);
});

describe("an assignment that is not exported (decision 0007 §4, amended 2026-11-25 (later))", () => {
  const unvouched = (line: string, env?: (name: string) => string | undefined): string[] =>
    takeApart(line, "posix", [], env !== undefined ? { env } : {}).requests.flatMap((r) => (r.kind === "unvouched" ? [r.reason] : []));

  it("reaches a program only when the environment holds the name already, whatever its case", () => {
    expect(unvouched("E=/usr/bin/foo; $E x", ENV)).toEqual([]);
    expect(first("E=/usr/bin/foo; $E x", "posix").program).toBe("foo");
    expect(unvouched("EDGE=/tmp/x; git status", ENV)).toEqual(["it sets EDGE, which can change what runs after it"]);
    const proxied = environmentLookupOf({ http_proxy: "http://corp:8080" }, false);
    expect(unvouched("http_proxy=http://evil:8080; curl https://x", proxied)).toEqual(["it sets http_proxy, which can change what runs after it"]);
    expect(unvouched("http_proxy=http://evil:8080; curl https://x", ENV)).toEqual([]);
  });

  it("is guessed from the convention when there is no environment to ask — the proxies too", () => {
    expect(unvouched("E=/usr/bin/foo; $E x")).toEqual(["it sets E, which can change what runs after it"]);
    expect(unvouched("f=/usr/bin/foo; $f x")).toEqual([]);
    expect(unvouched("http_proxy=http://evil:8080; curl https://x")).toEqual(["it sets http_proxy, which can change what runs after it"]);
  });
});
