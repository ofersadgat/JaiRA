/**
 * Every cmdlet of PowerShell's own modules, and what a permission set judges it as (decision 0007 §4,
 * amended 2026-10-20). The shell is a way to call the standard tools: a cmdlet that reads, lists,
 * searches, writes or fetches is that tool, on its places, so a set's `read_file` line holds
 * `Get-Content` as it holds `cat` and the agent's own `Read`. A cmdlet that changes nothing outside
 * the line is no request; one that runs code is `script` or opens what it runs; one that points a
 * name elsewhere is not vouched for; one that acts on the machine with no standard tool for it
 * is a command, answering to its own line or the shell's; one that acts on the machine where a System
 * tool does (`Stop-Process` is `stop_process`, `Set-Service` is `control_service`, decision 0019) is that
 * tool — as `kill` and `systemctl start` are.
 *
 * The list is Windows PowerShell 5.1's, as this ran to make it:
 *   Get-Command -Module Microsoft.PowerShell.Management, Microsoft.PowerShell.Utility,
 *     Microsoft.PowerShell.Core, Microsoft.PowerShell.Archive, Microsoft.PowerShell.Security,
 *     BitsTransfer, PowerShellGet, PackageManagement -CommandType Cmdlet, Function
 */
import { describe, expect, it } from "vitest";
import { POWERSHELL_ALIASES, takeApart } from "@jaira/shared";
import { classifyRequest } from "../src/commandParts";

const words = (text: string): string[] => text.trim().split(/\s+/);

const READ = words(`
  format-hex get-acl get-authenticodesignature get-cmsmessage get-content get-filehash get-item get-itemproperty get-itempropertyvalue
  get-pfxcertificate import-clixml import-csv import-localizeddata import-powershelldatafile select-xml test-filecatalog test-modulemanifest
  test-pssessionconfigurationfile test-scriptfileinfo unprotect-cmsmessage`);
const LIST = words(`convert-path get-childitem resolve-path test-path`);
const SEARCH = words(`select-string`);
const WRITE = words(`
  add-content clear-content clear-item clear-itemproperty clear-recyclebin compress-archive copy-item copy-itemproperty expand-archive
  export-alias export-clixml export-console export-csv export-formatdata export-pssession move-item move-itemproperty new-filecatalog
  new-item new-itemproperty new-modulemanifest new-psrolecapabilityfile new-pssessionconfigurationfile new-scriptfileinfo new-temporaryfile
  out-file protect-cmsmessage remove-item remove-itemproperty rename-item rename-itemproperty save-help set-acl set-authenticodesignature
  set-content set-item set-itemproperty tee-object unblock-file update-modulemanifest update-scriptfileinfo`);
const FETCH = words(`invoke-restmethod invoke-webrequest start-bitstransfer`);
const NO_REQUEST = words(`
  add-history add-member clear-history clear-variable compare-object convertfrom-csv convertfrom-json convertfrom-sddlstring
  convertfrom-securestring convertfrom-string convertfrom-stringdata convert-string convertto-csv convertto-html convertto-json
  convertto-securestring convertto-xml export-modulemember foreach-object format-custom format-list format-table format-wide get-alias
  get-command get-culture get-date get-event get-eventsubscriber get-executionpolicy get-formatdata get-help get-history get-host get-job
  get-location get-member get-module get-psbreakpoint get-pscallstack get-psdrive get-psprovider get-pssession get-pssnapin get-random
  get-runspace get-runspacedebug get-timezone get-tracesource get-transaction get-typedata get-uiculture get-unique get-variable group-object
  join-path measure-command measure-object new-guid new-pssessionoption new-pstransportoption new-timespan new-variable out-default
  out-gridview out-host out-null out-string pop-location push-location read-host receive-job register-argumentcompleter remove-job
  remove-module remove-variable resume-job select-object set-location set-strictmode set-variable sort-object split-path start-sleep
  stop-job suspend-job update-list wait-event wait-job wait-process where-object write-debug write-error write-host write-information
  write-output write-progress write-verbose write-warning`);
const SCRIPT = words(`add-type import-module`);
/** Each with a line that hands it something to run: what runs is a request of its own, beside the runner. */
const RUNNERS: Record<string, string> = {
  "invoke-expression": "Invoke-Expression 'git status'",
  "start-process": "Start-Process git -ArgumentList status",
  "invoke-command": "Invoke-Command { git status }",
  "start-job": "Start-Job { git status }",
};
const REDEFINERS = words(`add-pssnapin import-alias import-pssession invoke-history new-alias new-module set-alias`);
/** What acts on the machine where a System tool does that (decision 0019 §3): each is the tool. */
const SYSTEM: Record<string, string[]> = {
  read_system: words(`get-computerinfo get-computerrestorepoint get-controlpanelitem get-eventlog get-hotfix get-wmiobject`),
  power: words(`restart-computer stop-computer`),
  list_processes: words(`get-process`),
  stop_process: words(`stop-process`),
  list_services: words(`get-service`),
  control_service: words(`new-service restart-service resume-service set-service start-service stop-service suspend-service`),
  list_software: words(`get-installedmodule get-installedscript get-package get-packageprovider get-packagesource get-psrepository`),
  install_software: words(`import-packageprovider install-module install-package install-packageprovider install-script register-packagesource register-psrepository save-module save-package save-script set-packagesource set-psrepository uninstall-module uninstall-package uninstall-script unregister-packagesource unregister-psrepository update-help update-module update-script`),
  write_settings: words(`add-computer checkpoint-computer clear-eventlog disable-computerrestore enable-computerrestore limit-eventlog new-eventlog remove-computer remove-eventlog rename-computer reset-computermachinepassword restore-computer set-date set-executionpolicy set-timezone write-eventlog`),
  read_clipboard: words(`get-clipboard`),
  write_clipboard: words(`set-clipboard`),
};
/** What opens a file, a folder or a link in its app: `open_app` — and running it, when it would run (decision 0019 §3). */
const OPENS = words(`invoke-item`);
const COMMANDS = words(`
  add-bitsfile complete-bitstransfer complete-transaction connect-pssession debug-job debug-process debug-runspace disable-psbreakpoint
  disable-psremoting disable-pssessionconfiguration disable-runspacedebug disconnect-pssession enable-psbreakpoint enable-psremoting
  enable-pssessionconfiguration enable-runspacedebug enter-pshostprocess enter-pssession exit-pshostprocess exit-pssession find-command
  find-dscresource find-module find-package find-packageprovider find-rolecapability find-script get-bitstransfer get-credential
  get-pshostprocessinfo get-pssessioncapability get-pssessionconfiguration invoke-wmimethod new-event new-object new-psdrive
  new-pssession new-webserviceproxy out-printer publish-module publish-script receive-pssession register-engineevent
  register-objectevent register-pssessionconfiguration register-wmievent remove-bitstransfer remove-event remove-psbreakpoint
  remove-psdrive remove-pssession remove-pssnapin remove-typedata remove-wmiobject resume-bitstransfer send-mailmessage set-bitstransfer
  set-psbreakpoint set-psdebug set-pssessionconfiguration set-tracesource set-wmiinstance show-command show-controlpanelitem
  show-eventlog start-transaction suspend-bitstransfer test-computersecurechannel test-connection trace-command undo-transaction
  unregister-event unregister-pssessionconfiguration update-formatdata update-typedata use-transaction wait-debugger`);

/** The parts of a PowerShell line, classified. */
const partsOf = (line: string) =>
  takeApart(line, "powershell").requests.flatMap((request) => {
    const part = classifyRequest(request, "powershell");
    return part === undefined ? [] : [{ request, part }];
  });

/** The one part a cmdlet given a file by its `-Path` is — its first word may be something else (`Select-String`'s is the pattern). */
const partOf = (cmdlet: string) => {
  const parts = partsOf(`${cmdlet} ${cmdlet === "import-localizeddata" ? "-BaseDirectory" : "-Path"} notes.txt`);
  expect(parts, cmdlet).toHaveLength(1);
  return parts[0]!.part;
};

describe("every cmdlet of PowerShell's own modules", () => {
  const groups = { READ, LIST, SEARCH, WRITE, FETCH, NO_REQUEST, SCRIPT, RUNNERS: Object.keys(RUNNERS), REDEFINERS, SYSTEM: Object.values(SYSTEM).flat(), OPENS, COMMANDS };

  it("is in exactly one group — all 321 of them", () => {
    const all = Object.values(groups).flat();
    expect(all).toHaveLength(321);
    expect(new Set(all).size).toBe(all.length);
  });

  it.each<[string, string[], string]>([
    ["reads", READ, "read_file"],
    ["lists", LIST, "glob"],
    ["searches", SEARCH, "grep"],
    ["writes", WRITE, "write_file"],
  ])("is the standard tool on its places when it %s a file", (_, cmdlets, tool) => {
    for (const cmdlet of cmdlets) {
      const part = partOf(cmdlet);
      expect({ cmdlet, kind: part.kind, subject: part.subject }).toEqual({ cmdlet, kind: "tool", subject: tool });
      expect(part.paths, cmdlet).toContain("notes.txt");
    }
  });

  it("is `web_fetch` at its url when it fetches one", () => {
    for (const cmdlet of FETCH) expect(partsOf(`${cmdlet} https://example.com/x`).map(({ part }) => [part.subject, part.url]), cmdlet).toEqual([["web_fetch", "https://example.com/x"]]);
  });

  it("is no request at all when it changes nothing outside the line", () => {
    for (const cmdlet of NO_REQUEST) {
      // `ForEach-Object` handed a block runs the block, which is taken apart where it was written.
      const line = cmdlet === "foreach-object" ? "ForEach-Object { $_ }" : `${cmdlet} notes.txt`;
      expect(partsOf(line).map(({ part }) => part.noRequest === true), cmdlet).toEqual([true]);
    }
  });

  it("is `script` when it runs code or a file", () => {
    for (const cmdlet of SCRIPT) expect(partOf(cmdlet).subject, cmdlet).toBe("script");
  });

  it("opens what it runs, which is judged as a request of its own", () => {
    for (const [cmdlet, line] of Object.entries(RUNNERS)) {
      const commands = takeApart(line, "powershell").requests.flatMap((r) => (r.kind === "command" ? [`${r.command.program}${r.opened !== undefined ? " (opened)" : ""}`] : []));
      expect(commands, cmdlet).toEqual([`${cmdlet} (opened)`, "git"]);
    }
  });

  it("is not vouched for when it points a name at something the line does not show", () => {
    for (const cmdlet of REDEFINERS) expect(partOf(cmdlet).unmodelled, cmdlet).toBeDefined();
  });

  it("is the System tool when it acts on the machine and one does that", () => {
    for (const [tool, cmdlets] of Object.entries(SYSTEM)) {
      for (const cmdlet of cmdlets) expect({ cmdlet, kind: partOf(cmdlet).kind, subject: partOf(cmdlet).subject }).toEqual({ cmdlet, kind: "tool", subject: tool });
    }
  });

  it("is `open_app` when it opens a file in its app, and `script` when what it opens would run", () => {
    for (const cmdlet of OPENS) {
      expect(partOf(cmdlet).subject, cmdlet).toBe("open_app");
      expect(partsOf(`${cmdlet} -Path build.ps1`).map(({ part }) => part.subject), cmdlet).toEqual(["script"]);
      expect(partsOf(`${cmdlet} -Path:run.bat`).map(({ part }) => part.subject), cmdlet).toEqual(["script"]);
    }
  });

  it("is a command of its own name when it acts on the machine and no standard tool does that", () => {
    for (const cmdlet of COMMANDS) {
      const part = partOf(cmdlet);
      expect({ cmdlet, kind: part.kind, subject: part.subject, vouched: part.unmodelled === undefined }).toEqual({ cmdlet, kind: "command", subject: cmdlet, vouched: true });
    }
  });

  it("is reached by every alias PowerShell gives it", () => {
    // `mkdir` and `Clear-Host` are functions every session defines, not a module's cmdlets.
    const known = new Set([...Object.values(groups).flat(), "mkdir", "clear-host"]);
    for (const [alias, cmdlet] of Object.entries(POWERSHELL_ALIASES)) expect(known.has(cmdlet), `${alias} → ${cmdlet}`).toBe(true);
  });
});
