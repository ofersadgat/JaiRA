/**
 * What a claude agent is handed under one effective block, MEASURED — and the comparison a
 * list-to-toolset migration is held to (decision 0007 step 7).
 *
 * The measurement goes through the real chain (engine → `withAgentToolset` → the upstream executor →
 * the spawn options, with a fake query standing in for the binary), so these tests pin what it READS
 * OFF that chain, and that the comparison catches the rewrite it exists to catch.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { lowerToolset, parseToolset, SHELL_DENIED_MARKERS, shellCarriedKey, TOOLSET_MARKERS, type PermissionsDecl } from "@jaira/shared";
import { handedDifferences, handedToClaude, handedToCodex, type HandedContext, type HandedEnvironment } from "../src/agentHanded";

vi.setConfig({ testTimeout: 60_000 });

const LEGACY_READ_ONLY: HandedEnvironment = { tools: ["read_file"], permissions: { profile: "read-only", tools: { read_file: "allow" } } };
const map = (decl: Record<string, string>): HandedEnvironment => lowerToolset(parseToolset(decl).toolset);

describe("handedToClaude", () => {
  it("a read-only LIST keeps claude's own search and web tools, under a person, and loses every writer", async () => {
    const handed = await handedToClaude(LEGACY_READ_ONLY);
    expect(handed.form).toBe("legacy");
    expect(handed.served).toEqual(["read_file", "show_artifact"]);
    expect(handed.tools["read_file"]).toEqual({ reachable: true, via: ["app", "Read"], decision: "allow" });
    // THE POINT OF THE WHOLE TASK: a list is a grant, so these four are still the agent's.
    for (const name of ["glob", "grep", "web_fetch", "web_search"]) expect(handed.tools[name]).toMatchObject({ reachable: true, decision: "ask" });
    expect(handed.tools["glob"]!.via).toEqual(["Glob"]);
    for (const name of ["edit", "write_file", "bash"]) expect(handed.tools[name]).toEqual({ reachable: false, via: [] });
    expect(handed.natives).toEqual({ Task: "removed", Agent: "removed", SlashCommand: "removed" });
    // The profile never had an opinion about a name nobody declared: it asked.
    expect(handed.other).toBe("ask");
    expect(handed.shell).toEqual({});
  });

  it("a list with NO profile leaves claude everything it has, each call put to a person", async () => {
    const handed = await handedToClaude({ tools: ["read_file", "write_file"], permissions: { tools: { read_file: "allow", write_file: "allow" } } });
    expect(handed.tools["write_file"]).toMatchObject({ reachable: true, decision: "allow" });
    expect(handed.tools["edit"]).toEqual({ reachable: true, via: ["Edit", "MultiEdit", "NotebookEdit"], decision: "ask" });
    expect(handed.tools["bash"]).toEqual({ reachable: true, via: ["Bash"] });
    expect(handed.shell).toEqual({ command: "ask", read: "ask", write: "ask", script: "ask" });
    expect(handed.natives).toEqual({ Task: "ask", Agent: "ask", SlashCommand: "ask" });
  });

  it("a MAP is the whole grant: what it does not hold is not reachable, and `deny` is not a way in", async () => {
    const handed = await handedToClaude(map({ read_file: "allow", edit: "deny", other: "deny" }));
    expect(handed.form).toBe("map");
    expect(handed.tools["read_file"]).toEqual({ reachable: true, via: ["app"], decision: "allow" });
    for (const name of ["glob", "grep", "edit", "write_file", "bash", "web_fetch", "web_search"]) expect(handed.tools[name]!.reachable).toBe(false);
    expect(handed.other).toBe("deny");
  });

  it("ignores `scopes`: a table answers per place, and is compared as a table", async () => {
    const scoped: PermissionsDecl = { ...LEGACY_READ_ONLY.permissions, scopes: [{ path: "docs/**", tools: { read_file: "allow" } }] };
    expect(await handedToClaude({ tools: ["read_file"], permissions: scoped })).toEqual(await handedToClaude(LEGACY_READ_ONLY));
  });

  it("refuses a block the engine would refuse", async () => {
    await expect(handedToClaude({ tools: ["reed_file"] })).rejects.toThrow(/never reached the agent/);
  });
});

describe("handedDifferences — the proof", () => {
  it("CATCHES the naive rewrite: the map of what the list SAID takes away what the list left", async () => {
    const before = await handedToClaude(LEGACY_READ_ONLY);
    // What a mechanical rewrite of `tools: ["read_file"]` + `profile: "read-only"` would write.
    const naive = await handedToClaude(map({ read_file: "allow", other: "deny" }));
    const differences = handedDifferences(before, naive, LEGACY_READ_ONLY);
    const failures = differences.filter((difference) => difference.tolerated === undefined);
    expect(failures.map((difference) => difference.subject).sort()).toEqual(["glob", "grep", "web_fetch", "web_search"]);
    expect(failures[0]).toMatchObject({ before: "reachable, ask", after: "not reachable" });
  });

  it("passes the map of what the list DOES, with the one difference no map can avoid named", async () => {
    const before = await handedToClaude(LEGACY_READ_ONLY);
    const honest = await handedToClaude(map({ read_file: "allow", glob: "ask", grep: "ask", web_fetch: "ask", web_search: "ask", other: "deny" }));
    expect(handedDifferences(before, honest, LEGACY_READ_ONLY)).toEqual([{ subject: "other", before: "ask", after: "deny", tolerated: "profile-unknown-name" }]);
  });

  it("does NOT tolerate a tightened `other` where no profile was in force, nor a loosened one anywhere", async () => {
    // The list names the shell, so ours is served and the project's policy judges each line. A map's
    // lines are judged by the MAP, part by part — `cat` as `read_file`, which asks here — so the shell
    // differs, and that is the one difference `shell-judged` exists to accept; `other` is not.
    const list: HandedEnvironment = { tools: ["read_file", "bash"] };
    const judged: HandedContext = { ...list, accept: ["shell-judged"] };
    const before = await handedToClaude(list);
    const everything = { read_file: "ask", glob: "ask", grep: "ask", edit: "ask", write_file: "ask", bash: "allow", web_fetch: "ask", web_search: "ask" };
    const same = handedDifferences(before, await handedToClaude(map({ ...everything, other: "ask" })), judged);
    expect(same.filter((difference) => difference.tolerated === undefined)).toEqual([]);
    expect(same.map((difference) => difference.subject).sort()).toEqual(["shell:read", "shell:script", "shell:write"]);
    const tightened = handedDifferences(before, await handedToClaude(map({ ...everything, other: "deny" })), judged);
    expect(tightened.filter((difference) => !difference.subject.startsWith("shell:")).every((difference) => difference.tolerated === undefined)).toBe(true);
    expect(tightened.map((difference) => difference.subject)).toEqual(expect.arrayContaining(["other", "native:Task"]));
    const ro = await handedToClaude(LEGACY_READ_ONLY);
    const loosened = handedDifferences(
      ro,
      await handedToClaude(map({ read_file: "allow", glob: "ask", grep: "ask", web_fetch: "ask", web_search: "ask", other: "ask" })),
      LEGACY_READ_ONLY,
    );
    expect(loosened.some((difference) => difference.subject.startsWith("native:") && difference.tolerated === undefined)).toBe(true);
  });

  /**
   * The gap this used to pin has CLOSED: a map's shell subjects reach a run's policy in the key
   * lowering carries them in (`SHELL_SUBJECTS_KEY_PREFIX`), so `bash: "ask"` asks in a run for every
   * command and script, as it does in a conversation. What still keeps `unlisted-shell` in business
   * is §4 itself: a part that is a FILE utility answers to the file tool's own entry, so a list whose
   * `read_file` allowed while its unlisted shell asked about every `cat` has no map.
   */
  it("a list's UNLISTED shell has no map: holding it judges file parts as the file tools, and not holding it removes it", async () => {
    const list: HandedEnvironment = { tools: ["read_file", "write_file"], permissions: { tools: { read_file: "allow", write_file: "allow" } } };
    const rest = { read_file: "allow", write_file: "allow", glob: "ask", grep: "ask", edit: "ask", web_fetch: "ask", web_search: "ask", other: "ask" };
    const before = await handedToClaude(list);
    expect(before.shell).toEqual({ command: "ask", read: "ask", write: "ask", script: "ask" });

    const held = await handedToClaude(map({ ...rest, bash: "ask" }));
    expect(held.shell).toEqual({ command: "ask", read: "allow", write: "allow", script: "ask" });
    expect(handedDifferences(before, held, list).filter((d) => d.tolerated === undefined).map((d) => d.subject).sort()).toEqual(["shell:read", "shell:write"]);

    const dropped = await handedToClaude(map(rest));
    expect(handedDifferences(before, dropped, list).filter((d) => d.tolerated === undefined).map((d) => d.subject)).toContain("bash");
    // …so taking it away is a choice somebody has to make, by name.
    expect(handedDifferences(before, dropped, { ...list, accept: ["unlisted-shell"] })).toEqual([
      { subject: "bash", before: "reachable, judged by line", after: "not reachable", tolerated: "unlisted-shell" },
    ]);

    // A shell the list NAMED is never dropped under that consent.
    const named: HandedEnvironment = { tools: ["read_file", "bash"], permissions: { tools: { bash: "ask" } } };
    const withoutIt = handedDifferences(
      await handedToClaude(named),
      await handedToClaude(map({ read_file: "ask", glob: "ask", grep: "ask", edit: "ask", write_file: "ask", web_fetch: "ask", web_search: "ask", other: "ask" })),
      { ...named, accept: ["unlisted-shell"] },
    );
    expect(withoutIt.find((d) => d.subject === "bash")?.tolerated).toBeUndefined();
  });

  it("a shell that was never there is a failure when the map offers one, and none when its entry withholds it", async () => {
    const ro = await handedToClaude(LEGACY_READ_ONLY);
    const rest = { read_file: "allow", glob: "ask", grep: "ask", web_fetch: "ask", web_search: "ask", other: "deny" };
    // `"bash": "deny"` with nothing that allows a command is WITHHELD: the same grant as no shell.
    const withheld = await handedToClaude(map({ ...rest, bash: "deny" }));
    expect(withheld.tools["bash"]).toEqual({ reachable: false, via: [] });
    expect(handedDifferences(ro, withheld, LEGACY_READ_ONLY).filter((d) => d.tolerated === undefined)).toEqual([]);
    // A command it allows OFFERS the shell, for that command — which the list never had.
    const commands = await handedToClaude(map({ ...rest, bash: "deny", "git status": "allow" }));
    expect(handedDifferences(ro, commands, LEGACY_READ_ONLY).filter((d) => d.tolerated === undefined).map((d) => d.subject)).toContain("bash");
  });
});

describe("a shell the toolset denies, MEASURED in a run", () => {
  it("hands claude NO shell for `\"bash\": \"deny\"` — not ours, not its own", async () => {
    const handed = await handedToClaude(map({ read_file: "allow", bash: "deny", other: "deny" }));
    expect(handed.served).not.toContain("bash");
    expect(handed.removed).toContain("Bash");
    expect(handed.tools["bash"]).toEqual({ reachable: false, via: [] });
    expect(handed.shell).toEqual({});
  });

  it("hands the SHIPPED `chat/read-only` no shell", async () => {
    const decl = JSON.parse(readFileSync(fileURLToPath(new URL("../../shared/builtin/toolsets/chat/read-only.json", import.meta.url)), "utf8")) as unknown;
    const handed = await handedToClaude(lowerToolset(parseToolset(decl).toolset));
    expect(handed.form).toBe("map");
    expect(handed.removed).toContain("Bash");
    expect(handed.tools["bash"]).toEqual({ reachable: false, via: [] });
  });

  it("judges a \"no shell but these commands\" map's lines BY THE MAP, where the project's policy would have run them", async () => {
    const handed = await handedToClaude(map({ read_file: "allow", bash: "deny", "git status": "allow", other: "deny" }));
    expect(handed.tools["bash"]).toEqual({ reachable: true, via: ["app"] });
    expect(handed.removed).toContain("Bash");
    // `git status` is named; `cat` is `read_file`, allowed; `rm` is `write_file`, which the map
    // does not hold; `./build.sh` is `script`, which it does not name either.
    expect(handed.shell).toEqual({ command: "allow", read: "allow", write: "deny", script: "deny" });
    // The project's policy alone — what a run used to judge this line by — runs every one of them.
    expect((await handedToClaude({ tools: ["read_file", "bash"] })).shell).toEqual({ command: "allow", read: "allow", write: "allow", script: "allow" });
  });
});

/**
 * A RUN reads the state's resolved block, as a conversation turn does — upstream hands it over whole
 * since declarative-ai 3f5e5cc (`literalPermissions` keeps a host's keys; `ExecServices.authored`).
 * Each of these was a failure row in tool-policy.md, and each is measured through the real chain.
 */
describe("what a RUN reads off the state's block, MEASURED", () => {
  const lowered = (decl: Record<string, unknown>): HandedEnvironment => lowerToolset(parseToolset(decl).toolset);

  it("a written `other: \"ask\"` forces `Task`, `Agent` and `SlashCommand` to the callback — the gate's own default does not", async () => {
    const asking = await handedToClaude(map({ read_file: "allow", other: "ask" }));
    expect(asking.askRules).toEqual(["Agent", "SlashCommand", "Task"]);
    expect(asking.natives).toEqual({ Task: "ask", Agent: "ask", SlashCommand: "ask" });
    // A map that says nothing about `other` is not forced: the gate's `ask` is a last resort, not a choice.
    expect((await handedToClaude(map({ read_file: "allow" }))).askRules).toEqual([]);
    // …and the LEGACY reading is handed on untouched, whatever its block says.
    expect((await handedToClaude({ tools: ["read_file"], permissions: { tools: { read_file: "allow" }, other: "ask" } })).askRules).toEqual([]);
  });

  it("`implementation: \"native\"` keeps the built-in in a run: ours is not served, the native is forced to the callback, and the ENTRY decides", async () => {
    const handed = await handedToClaude(lowered({ read_file: "allow", grep: { mode: "ask", implementation: "native" }, other: "deny" }));
    expect(handed.served).toEqual(["read_file", "show_artifact"]);
    expect(handed.removed).not.toContain("Grep");
    expect(handed.askRules).toEqual(["Grep"]);
    expect(handed.tools["grep"]).toEqual({ reachable: true, via: ["Grep"], decision: "ask" });
    // Ours still serves what the entry did not hand to the agent.
    expect(handed.tools["read_file"]).toEqual({ reachable: true, via: ["app"], decision: "allow" });
    // A `deny` beside `native` is a removal, not a question.
    const shut = await handedToClaude(lowered({ read_file: "allow", grep: { mode: "deny", implementation: "native" }, other: "deny" }));
    expect(shut.removed).toContain("Grep");
    expect(shut.tools["grep"]!.reachable).toBe(false);
  });

  it("a child's OWN shell entries win over a parent's that offered a shell — even a parent pinned from a snapshot lowered the old way", async () => {
    // The parent: "no shell but `npm test`", lowered as it was between 2026-09-22 and 3f5e5cc — its
    // subjects carried a second time in a key of `tools`, beside the pair that says its shell is `deny`.
    const parentSubjects = { bash: "deny" as const, "npm test": "allow" as const };
    const parentOld: HandedEnvironment = {
      tools: ["bash"],
      permissions: {
        tools: { bash: "smart", ...TOOLSET_MARKERS, ...SHELL_DENIED_MARKERS, [shellCarriedKey({ subjects: parentSubjects })]: "allow" },
        subjects: parentSubjects,
      },
    };
    const child = map({ read_file: "allow", bash: "ask", git: "allow", other: "deny" });
    const alone = await handedToClaude(child);
    expect(alone.shell["command"]).toBe("allow");
    // The child's map runs `git status`; the parent's `bash: "deny"` would have refused it.
    const under = await handedToClaude(child, { parent: parentOld });
    expect(under.shell).toEqual(alone.shell);
    // Lowered today, a parent carries nothing a child could inherit beside its own.
    expect((await handedToClaude(child, { parent: map({ bash: "deny", "npm test": "allow" }) })).shell).toEqual(alone.shell);
    // And codex's writing sandbox follows the CHILD's shell, not the pair it inherited.
    for (const via of ["route", "function"] as const) {
      expect((await handedToCodex(map({ bash: "ask" }), { parent: parentOld, via })).permissionMode).toBeUndefined();
    }
  });
});

describe("handedToCodex — codex is held by its sandbox, by a model prefix and as a FUNCTION alike", () => {
  it.each(["route", "function"] as const)("%s: a toolset with no open writer runs read-only; one with one, or an unmigrated state, keeps the configured sandbox", async (via) => {
    expect((await handedToCodex(map({ other: "deny" }), { via })).permissionMode).toBe("plan");
    expect((await handedToCodex(map({ bash: "deny", other: "deny" }), { via })).permissionMode).toBe("plan");
    expect((await handedToCodex(map({ bash: "deny", "git status": "allow" }), { via })).permissionMode).toBe("plan");
    expect((await handedToCodex(map({ bash: "ask" }), { via })).permissionMode).toBeUndefined();
    // Unmigrated: exactly as before — the configured sandbox, and on the route an old read-only
    // profile still `plan`. (The function rig stands a fake query in for codex's adapter, which is
    // where the profile's mapping lives, so it is measured on the route alone.)
    expect((await handedToCodex({}, { via })).permissionMode).toBeUndefined();
    if (via === "route") expect((await handedToCodex({ permissions: { profile: "read-only" } }, { via })).permissionMode).toBe("plan");
  });
});
