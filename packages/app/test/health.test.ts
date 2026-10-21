/**
 * Settings' warnings and errors: a tool is only lost if it once worked where it is checked; working,
 * switched off or never-configured tools raise nothing; dismissing a lost tool forgets it worked, so
 * only working and failing again brings it back; any other dismissal lasts until the condition clears;
 * log errors and warnings count until they are dismissed; everything can be dismissed at once; and what
 * worked is remembered across a restart.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HealthItem } from "@jaira/shared";
import { HealthBoard } from "@jaira/service/health";

let dir: string;
let pushed: HealthItem[][];

function board(): HealthBoard {
  return new HealthBoard({ file: join(dir, "system", "health.json"), publish: (items) => pushed.push(items), now: () => 1000 });
}

const claude = (name: string) => ({ title: name === "claude-cli" ? "Claude Code" : name, action: "sign-in" as const, subject: name });
const route = (name: string) => ({ title: name, action: "check" as const, subject: name });

/** Where a check ran: one project open, another, and the shared root (none or several open). */
const A = "c:\\work\\a";
const B = "c:\\work\\b";
const SHARED = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jaira-health-"));
  pushed = [];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("the health board", () => {
  it("raises an error only for a tool that worked and then stopped", () => {
    const health = board();
    health.observe("executor", A, [{ name: "codex", status: "failed", detail: "codex is not installed" }], claude);
    expect(health.list()).toEqual([]);
    health.observe("executor", A, [{ name: "claude-cli", status: "ok", detail: "signed in" }], claude);
    health.observe("executor", A, [{ name: "claude-cli", status: "failed", detail: "signed out — its token expired", fix: "sign in again" }], claude);
    expect(health.list()).toEqual([
      { id: "executor:claude-cli", level: "error", page: "connections", title: "Claude Code", detail: "signed out — its token expired", fix: "sign in again", action: "sign-in", subject: "claude-cli", since: 1000 },
    ]);
  });

  it("clears when the tool works again, or is switched off", () => {
    const health = board();
    health.observe("forge", A, [{ name: "gitlab", status: "ok", detail: "" }], () => ({ title: "GitLab" }));
    health.observe("forge", A, [{ name: "gitlab", status: "failed", detail: "the sign-in session expired" }], () => ({ title: "GitLab" }));
    expect(health.list()).toHaveLength(1);
    health.observe("forge", A, [{ name: "gitlab", status: "ok", detail: "" }], () => ({ title: "GitLab" }));
    expect(health.list()).toEqual([]);
    health.observe("forge", A, [{ name: "gitlab", status: "failed", detail: "refused" }], () => ({ title: "GitLab" }));
    health.observe("forge", A, [{ name: "gitlab", status: "disabled", detail: "" }], () => ({ title: "GitLab" }));
    expect(health.list()).toEqual([]);
  });

  it("remembers across a restart what worked, so a token that expired overnight is still an error", () => {
    board().observe("executor", A, [{ name: "claude-cli", status: "ok", detail: "" }], claude);
    const next = board();
    next.observe("executor", A, [{ name: "claude-cli", status: "failed", detail: "signed out" }], claude);
    expect(next.list().map((i) => i.id)).toEqual(["executor:claude-cli"]);
  });

  it("remembers what worked per configuration: a key one project has is not lost in another", () => {
    const health = board();
    health.observe("route", A, [{ name: "anthropic", status: "ok", detail: "ANTHROPIC_API_KEY from .env.local" }], route);
    health.observe("route", SHARED, [{ name: "anthropic", status: "failed", detail: "no key" }], route);
    health.observe("route", B, [{ name: "anthropic", status: "failed", detail: "no key" }], route);
    expect(health.list()).toEqual([]);
    // Back in the project it worked in, the same failure is the key lost.
    health.observe("route", A, [{ name: "anthropic", status: "failed", detail: "no key" }], route);
    expect(health.list().map((i) => i.id)).toEqual(["route:anthropic"]);
    // …which a check of a configuration it never worked in does not speak for: the board shows what is lost where it is checked.
    health.observe("route", SHARED, [{ name: "anthropic", status: "failed", detail: "no key" }], route);
    expect(health.list()).toEqual([]);
  });

  it("forgets a dismissed lost tool worked: only working and then failing again shows it", () => {
    const health = board();
    health.observe("executor", A, [{ name: "claude-cli", status: "ok", detail: "" }], claude);
    health.observe("executor", A, [{ name: "claude-cli", status: "failed", detail: "signed out" }], claude);
    health.dismiss("executor:claude-cli");
    expect(health.list()).toEqual([]);
    health.observe("executor", A, [{ name: "claude-cli", status: "failed", detail: "signed out" }], claude);
    expect(health.list()).toEqual([]);
    // Switched off and on again is not working again.
    health.observe("executor", A, [{ name: "claude-cli", status: "disabled", detail: "" }], claude);
    health.observe("executor", A, [{ name: "claude-cli", status: "failed", detail: "signed out" }], claude);
    expect(health.list()).toEqual([]);
    health.observe("executor", A, [{ name: "claude-cli", status: "ok", detail: "" }], claude);
    health.observe("executor", A, [{ name: "claude-cli", status: "failed", detail: "signed out" }], claude);
    expect(health.list().map((i) => i.id)).toEqual(["executor:claude-cli"]);
  });

  it("forgets it everywhere it worked, and across a restart", () => {
    const health = board();
    health.observe("executor", A, [{ name: "claude-cli", status: "ok", detail: "" }], claude);
    health.observe("executor", B, [{ name: "claude-cli", status: "ok", detail: "" }], claude);
    health.observe("executor", B, [{ name: "claude-cli", status: "failed", detail: "signed out" }], claude);
    health.dismiss("executor:claude-cli");
    health.observe("executor", A, [{ name: "claude-cli", status: "failed", detail: "signed out" }], claude);
    expect(health.list()).toEqual([]);
    const next = board();
    next.observe("executor", A, [{ name: "claude-cli", status: "failed", detail: "signed out" }], claude);
    next.observe("executor", B, [{ name: "claude-cli", status: "failed", detail: "signed out" }], claude);
    expect(next.list()).toEqual([]);
  });

  it("hides any other dismissed item until its condition clears, and shows it again if it comes back", () => {
    const health = board();
    const failed = { id: "plugin:llama-cuda", level: "warning", page: "about", title: "Local models: CUDA", detail: "download failed — offline" } as const;
    health.set(failed);
    health.dismiss("plugin:llama-cuda");
    expect(health.list()).toEqual([]);
    health.set(failed);
    expect(health.list()).toEqual([]);
    health.clear("plugin:llama-cuda");
    health.set(failed);
    expect(health.list().map((i) => i.id)).toEqual(["plugin:llama-cuda"]);
  });

  it("counts log errors and warnings since they were last dismissed, which clears the count", () => {
    const health = board();
    health.logged("error");
    health.logged("error");
    health.logged("warn");
    expect(health.list()).toMatchObject([
      { id: "log:errors", level: "error", page: "logs", detail: "2 errors were logged", action: "open-logs" },
      { id: "log:warnings", level: "warning", page: "logs", detail: "1 warning was logged" },
    ]);
    health.dismiss("log:errors");
    expect(health.list().map((i) => i.id)).toEqual(["log:warnings"]);
    health.logged("error");
    expect(health.list()[0]).toMatchObject({ id: "log:errors", detail: "1 error was logged" });
  });

  it("dismisses everything at once", () => {
    const health = board();
    health.observe("executor", A, [{ name: "claude-cli", status: "ok", detail: "" }], claude);
    health.observe("executor", A, [{ name: "claude-cli", status: "failed", detail: "signed out" }], claude);
    health.logged("warn");
    health.set({ id: "update", level: "warning", page: "about", title: "Updates", detail: "offline" });
    health.dismissAll();
    expect(health.list()).toEqual([]);
    health.logged("warn");
    expect(health.list()).toMatchObject([{ id: "log:warnings", detail: "1 warning was logged" }]);
  });

  it("puts errors before warnings, and pushes the whole board on every change", () => {
    const health = board();
    health.set({ id: "plugin:llama-cuda", level: "warning", page: "about", title: "Local models: CUDA", detail: "download failed — offline", action: "retry-plugin", subject: "llama-cuda" });
    health.logged("error");
    expect(health.list().map((i) => i.level)).toEqual(["error", "warning"]);
    expect(pushed.at(-1)?.map((i) => i.id)).toEqual(["log:errors", "plugin:llama-cuda"]);
    health.clear("plugin:llama-cuda");
    expect(pushed.at(-1)?.map((i) => i.id)).toEqual(["log:errors"]);
  });
});
