/**
 * The shipped security profiles (`permission-sets/security/`), stacked over `base/allow-all` as a
 * project would stack them — what JaiRA's built-in floor used to refuse or ask about, now LINES a person
 * can read and change (the person, 2026-11-25: "there shouldnt be built in rules. all rules should go
 * through permissions"). With no profile in the stack, nothing of it applies.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LINES_NO_SET_JUDGES, SECURITY_PROFILES, mergeLayerDecls, parsePermissionSet, shippedStack, type PermissionSet } from "@jaira/shared";
import { decideCommand, type PolicyAction } from "../src/policy";
import { namedPlacesOf } from "../src/linePlaces";

const ALLOW_ALL = "$SYSTEM/permission-sets/base/allow-all";
const guarded = shippedStack([ALLOW_ALL, SECURITY_PROFILES.guarded]);
const standard = shippedStack([ALLOW_ALL, SECURITY_PROFILES.standard]);
const strict = shippedStack([ALLOW_ALL, SECURITY_PROFILES.strict]);
const allowAll = shippedStack([ALLOW_ALL]);

const under =
  (set: PermissionSet | undefined, dialect: "posix" | "powershell" = "posix") =>
  (line: string): PolicyAction =>
    decideCommand(set !== undefined ? { fallback: set } : {}, line, dialect, { root: "/repo", places: { root: "/repo", named: namedPlacesOf("/repo") } }).action;

describe("security/guarded", () => {
  const run = under(guarded);
  it("refuses rewriting or force-pushing history, a forced refspec too, and lets an ordinary push through", () => {
    expect(run("git push --force origin main")).toBe("deny");
    expect(run("git push -fu origin main")).toBe("deny");
    expect(run("git push --force-with-lease=main origin main")).toBe("deny");
    expect(run("git push origin +main")).toBe("deny");
    expect(run("git push --mirror backup")).toBe("deny");
    expect(run("git reset --hard HEAD~1")).toBe("deny");
    expect(run("git rebase main")).toBe("deny");
    expect(run("git clean -fdx")).toBe("deny");
    expect(run("git push origin main")).toBe("allow");
    expect(run("git reset HEAD~1")).toBe("allow");
  });

  it("refuses deleting a repository's .git, in either shell, and nothing else that is deleted", () => {
    expect(run("rm -rf .git")).toBe("deny");
    expect(run("rm -r sub/.git")).toBe("deny");
    expect(run("rm -rf build")).toBe("allow");
    expect(under(guarded, "powershell")("Remove-Item -Recurse -Force .git")).toBe("deny");
    expect(under(guarded, "powershell")("Remove-Item .git -Recurse")).toBe("deny");
    expect(under(guarded, "powershell")("Remove-Item -Recurse dist")).toBe("allow");
  });

  it("refuses a start JaiRA could not follow — and a line naming the program lifts it", () => {
    expect(run("setsid node server.js")).toBe("deny");
    expect(run("crontab jobs.txt")).toBe("deny");
    expect(run("crontab -l")).toBe("allow");
    const lifted = parsePermissionSet(
      mergeLayerDecls([
        { id: "allow-all", decl: file("base/allow-all") },
        { id: "guarded", decl: file("security/guarded") },
        { id: "project", decl: { "shell --untracked setsid": "allow" } },
      ]).decl,
    ).permissionSet;
    expect(under(lifted)("setsid node server.js")).toBe("allow");
  });
});

describe("security/standard", () => {
  const run = under(standard);
  it("is guarded, and asks before what leaves the machine", () => {
    expect(run("git push --force origin main")).toBe("deny");
    expect(run("git push origin main")).toBe("require_approval");
    expect(run("git merge feature")).toBe("require_approval");
    expect(run("git config --global user.name x")).toBe("require_approval");
    expect(run("git remote add mirror https://example.com/x.git")).toBe("require_approval");
    expect(run("git remote -v")).toBe("allow");
    expect(run("curl https://example.com")).toBe("require_approval");
    expect(run("ssh box ls")).toBe("require_approval");
    expect(run("npm install left-pad")).toBe("require_approval");
    expect(run("npm publish")).toBe("require_approval");
    expect(run("terraform apply")).toBe("require_approval");
    expect(run("git status")).toBe("allow");
  });

  it("asks before touching credentials, whatever line the command answers to", () => {
    expect(run("node read.js ~/.ssh/config")).toBe("require_approval");
    expect(run("python load.py .env")).toBe("require_approval");
    expect(run("cat ~/.ssh/config")).toBe("require_approval");
    expect(run("node build.js src/app.ts")).toBe("allow");
  });

  it("asks before a variable that changes what runs, a family too, and lets the rest be set", () => {
    expect(run("PATH=/tmp/bin make")).toBe("require_approval");
    expect(run("GIT_DIR=/elsewhere git status")).toBe("require_approval");
    expect(run("FOO=1 make")).toBe("allow");
  });

  it("asks before power", () => {
    expect(run("shutdown -h now")).toBe("require_approval");
  });
});

describe("security/strict", () => {
  it("is standard, and refuses the network, installs and deploys rather than asking", () => {
    const run = under(strict);
    expect(run("curl https://example.com")).toBe("deny");
    expect(run("npm install left-pad")).toBe("deny");
    expect(run("terraform apply")).toBe("deny");
    expect(run("git push origin main")).toBe("require_approval");
    expect(run("git push --force origin main")).toBe("deny");
  });
});

describe("with no security profile", () => {
  it("nothing of it applies: there is no rule in code", () => {
    const run = under(allowAll);
    expect(run("git push --force origin main")).toBe("allow");
    expect(run("curl https://example.com")).toBe("allow");
    expect(run("rm -rf .git")).toBe("allow");
    expect(under(undefined)("git push --force origin main")).toBe("allow");
  });

  it("a line no set judges answers to allow-all under standard", () => {
    const run = under(LINES_NO_SET_JUDGES);
    expect(run("git push --force origin main")).toBe("deny");
    expect(run("curl https://example.com")).toBe("require_approval");
    expect(run("git status")).toBe("allow");
  });
});

/** A shipped set file's own lines. */
function file(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`../../shared/builtin/permission-sets/${name}.json`, import.meta.url)), "utf8")) as Record<string, unknown>;
}
