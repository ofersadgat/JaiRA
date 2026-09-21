/**
 * What a claude agent is handed under one effective block, MEASURED — and the comparison a
 * list-to-toolset migration is held to (decision 0007 step 7).
 *
 * The measurement goes through the real chain (engine → `withAgentToolset` → the upstream executor →
 * the spawn options, with a fake query standing in for the binary), so these tests pin what it READS
 * OFF that chain, and that the comparison catches the rewrite it exists to catch.
 */
import { describe, expect, it, vi } from "vitest";
import { lowerToolset, parseToolset, type PermissionsDecl } from "@jaira/shared";
import { handedDifferences, handedToClaude, type HandedEnvironment } from "../src/agentHanded";

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
    // The list names the shell, so ours is served and the project's policy judges each line — as a map's is.
    const list: HandedEnvironment = { tools: ["read_file", "bash"] };
    const before = await handedToClaude(list);
    const everything = { read_file: "ask", glob: "ask", grep: "ask", edit: "ask", write_file: "ask", bash: "allow", web_fetch: "ask", web_search: "ask" };
    expect(handedDifferences(before, await handedToClaude(map({ ...everything, other: "ask" })), list)).toEqual([]);
    const tightened = handedDifferences(before, await handedToClaude(map({ ...everything, other: "deny" })), list);
    expect(tightened.every((difference) => difference.tolerated === undefined)).toBe(true);
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
   * A KNOWN GAP, pinned so that closing it is noticed. A map's shell entry lowers as `smart` with its
   * authored mode under `permissions.subjects` — and the engine hands the policy a state's `tools`,
   * `default`, `other` and `scopes` only (`literalPermissions`), so in a RUN the subjects never
   * arrive and the line is judged by the project's policy alone. When this test starts failing the
   * gap has closed: `bash: "ask"` would then keep a list's unlisted shell as it was, and
   * `unlisted-shell` would have nothing left to be for.
   */
  it("a list's UNLISTED shell has no map: holding it hands a run a shell nobody is asked about, and not holding it removes it", async () => {
    const list: HandedEnvironment = { tools: ["read_file", "write_file"], permissions: { tools: { read_file: "allow", write_file: "allow" } } };
    const rest = { read_file: "allow", write_file: "allow", glob: "ask", grep: "ask", edit: "ask", web_fetch: "ask", web_search: "ask", other: "ask" };
    const before = await handedToClaude(list);
    expect(before.shell).toEqual({ command: "ask", read: "ask", write: "ask", script: "ask" });

    const held = await handedToClaude(map({ ...rest, bash: "ask" }));
    expect(held.shell["command"]).toBe("allow");
    expect(handedDifferences(before, held, list).filter((d) => d.tolerated === undefined).map((d) => d.subject)).toContain("shell:command");

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

  it("a shell that was never there is a failure, whatever its entry says", async () => {
    const ro = await handedToClaude(LEGACY_READ_ONLY);
    const withShell = await handedToClaude(map({ read_file: "allow", glob: "ask", grep: "ask", web_fetch: "ask", web_search: "ask", bash: "deny", other: "deny" }));
    expect(handedDifferences(ro, withShell, LEGACY_READ_ONLY).filter((d) => d.tolerated === undefined).map((d) => d.subject)).toContain("bash");
  });
});
