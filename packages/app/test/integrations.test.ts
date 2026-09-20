/**
 * Settings → Integrations, below the pixels (decision 0004 §1).
 *
 * Three things the screen rests on and cannot show to be true by itself: that a connection's state
 * is what the HOST said about the token, that a settings write is refused by the parser a run will
 * use, and that a token's value never comes back out of main.
 *
 * The forge is a replay of fixtures (`runtime/test/forgeReplay.ts`): nothing here reaches a network.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject } from "@jaira/persistence";
import { testHome } from "@jaira/testing";
import type { ForgeCheck } from "@jaira/shared";
import { AppService } from "../src/main/service";
import { forgeState } from "../src/renderer/integrationsPane";
import { replayForge, type Replay } from "../../runtime/test/forgeReplay";

let dir: string;
let home: string;
let service: AppService;
let replay: Replay;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "jaira-integrations-"));
  home = testHome();
  initProject(dir, home);
  replay = replayForge();
  service = new AppService({ baseDir: home, watchWorkflows: false, forgeHttp: replay.http });
  await service.open(dir);
});

afterEach(async () => {
  await service.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("checking a connection", () => {
  it("makes no request at all while no token is stored", async () => {
    const { forges } = await service.refreshAvailability();
    expect(forges?.map((f) => [f.name, f.status])).toEqual([
      ["gitlab", "unconfigured"],
      ["github", "unconfigured"],
    ]);
    expect(replay.seen).toEqual([]);
  });

  it("asks the host who the token is once one is stored, and reports where the token was found", async () => {
    service.setSecret({ name: "GITLAB_TOKEN", value: "good", target: "project-env-local" });
    const { forges } = await service.refreshAvailability();
    const gitlab = forges!.find((f) => f.name === "gitlab")!;
    expect(gitlab).toMatchObject({ status: "ok", detail: "signed in as @jaira-bot", credential: { source: "project-jaira-env-local" } });
    expect(replay.seen.map((r) => r.url)).toEqual(["https://gitlab.com/api/v4/user"]);
  });

  it("never lets the token's value out of main: not in the snapshot, not in the settings file", async () => {
    service.setSecret({ name: "GITLAB_TOKEN", value: "good", target: "project-env-local" });
    const snapshot = await service.refreshAvailability();
    expect(JSON.stringify(snapshot)).not.toContain('"good"');
    expect(JSON.stringify(service.readConfig())).not.toContain("good");
    // Where it DID go: the one file of the chain JaiRA gitignores.
    expect(readFileSync(join(dir, ".jaira", ".env.local"), "utf8")).toContain('GITLAB_TOKEN="good"');
  });

  it("reports a refused token as not working, with what would fix it", async () => {
    service.setSecret({ name: "GITHUB_TOKEN", value: "refused", target: "project-env-local" });
    const { forges } = await service.refreshAvailability();
    expect(forges!.find((f) => f.name === "github")).toMatchObject({
      status: "failed",
      detail: "the token was refused (401)",
      fix: "replace the token; it needs the `repo` scope to open and read pull requests",
    });
  });
});

describe("writing the integrations block", () => {
  it("adds another host to one layer, and the effective config then has three connections", () => {
    const view = service.writeConfig({
      layer: "project",
      config: { integrations: { forges: { work: { provider: "gitlab", host: "git.example.org", credential: "WORK_TOKEN" } } } },
    });
    const forges = (view.effective as { integrations: { forges: Record<string, unknown> } }).integrations.forges;
    expect(Object.keys(forges)).toEqual(["gitlab", "github", "work"]);
    // The layer holds only what was written — the built-ins are defaults, not copies.
    expect(view.project).toEqual({ integrations: { forges: { work: { provider: "gitlab", host: "git.example.org", credential: "WORK_TOKEN" } } } });
  });

  it("refuses a second connection on a host that has one, before anything is written", () => {
    const before = service.readConfig().project;
    expect(() =>
      service.writeConfig({ layer: "project", config: { integrations: { forges: { mirror: { provider: "gitlab", host: "gitlab.com" } } } } }),
    ).toThrow(/both name the host gitlab.com/);
    expect(service.readConfig().project).toEqual(before);
  });

  it("starts a new project with NO integrations block, so the shared root's connections are not shadowed", () => {
    // `initProject` spells out the other defaults; a connection is a fact about a machine.
    expect(service.readConfig().project).not.toHaveProperty("integrations");
    service.writeConfig({ layer: "base", config: { integrations: { review: { settleAfter: "45m" } } } });
    const effective = service.readConfig().effective as { integrations: { review: { settleAfter: string } } };
    expect(effective.integrations.review.settleAfter).toBe("45m");
  });

  it("refuses a token written where a token's name belongs", () => {
    expect(() =>
      service.writeConfig({ layer: "project", config: { integrations: { forges: { gitlab: { credential: "glpat-not a name" } } } } }),
    ).toThrow(/NAMES the token/);
  });

  it("keeps the two defaults: how long to wait after a comment, and whether publishing asks", () => {
    const view = service.writeConfig({
      layer: "project",
      config: { integrations: { review: { settleAfter: "30m" } }, policy: { remote: { publish: "allow" } } },
    });
    const effective = view.effective as { integrations: { review: { settleAfter: string } }; policy: { remote: { publish: string } } };
    expect(effective.integrations.review.settleAfter).toBe("30m");
    expect(effective.policy.remote.publish).toBe("allow");
  });
});

describe("what a row says", () => {
  const check = (status: ForgeCheck["status"]): ForgeCheck => ({ name: "gitlab", provider: "gitlab", host: "gitlab.com", status, detail: "" });

  it("has the Providers screen's four states, and one for not having looked yet", () => {
    expect(forgeState(true, check("ok"))).toBe("available");
    expect(forgeState(true, check("failed"))).toBe("unavailable");
    expect(forgeState(true, check("unconfigured"))).toBe("unconfigured");
    expect(forgeState(true, undefined)).toBe("unchecked");
    // Off is what the person SAID, so it beats whatever the last check saw.
    expect(forgeState(false, check("ok"))).toBe("off");
  });
});
