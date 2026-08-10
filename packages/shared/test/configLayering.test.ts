/**
 * Laying a project's `config.json` over the shared base root's (DESIGN §3).
 *
 * Three merge rules, and each was chosen because the alternative is worse. The tests below state
 * which alternative, because that is the part a future reader cannot recover from the code.
 */
import { describe, expect, it } from "vitest";
import { mergeConfigDocuments, parseConfig } from "../src/config";

describe("mergeConfigDocuments", () => {
  it("merges objects key by key, so a project keeps what it did not mention", () => {
    const base = { models: { default: "anthropic/claude-sonnet-5" }, memo: { enabled: true } };
    const project = { memo: { enabled: false } };

    // A wholesale replace would lose `models` here — and overriding one field is the common case,
    // which is the entire reason a shared root is worth having.
    expect(mergeConfigDocuments(base, project)).toEqual({
      models: { default: "anthropic/claude-sonnet-5" },
      memo: { enabled: false },
    });
  });

  it("merges nested objects too", () => {
    const base = { artifacts: { destination: "$CENTRAL", dir: "shared-artifacts", inlineMaxBytes: 1024 } };
    const project = { artifacts: { dir: "local-artifacts" } };

    expect(mergeConfigDocuments(base, project)).toEqual({
      artifacts: { destination: "$CENTRAL", dir: "local-artifacts", inlineMaxBytes: 1024 },
    });
  });

  it("REPLACES arrays rather than concatenating them", () => {
    const base = { workflows: { path: ["$JAIRA/workflows", "$BASE/workflows"] } };
    const project = { workflows: { path: ["$JAIRA/workflows"] } };

    // Concatenating would make the effective search order depend on a file the author is not
    // reading, and would leave a project no way to REMOVE an entry the base added.
    expect(mergeConfigDocuments(base, project)).toEqual({ workflows: { path: ["$JAIRA/workflows"] } });
  });

  it("merges agents.genericCli BY NAME, keeping the base's order", () => {
    const base = { agents: { genericCli: [{ name: "aider", command: "aider" }, { name: "other", command: "other" }] } };
    const project = { agents: { genericCli: [{ name: "aider", enabled: false }, { name: "extra", command: "extra" }] } };

    // The one array that is really a keyed map: a project expects to retune one shared executor or
    // add its own, not to redeclare the whole set.
    expect(mergeConfigDocuments(base, project)).toEqual({
      agents: {
        genericCli: [
          { name: "aider", command: "aider", enabled: false },
          { name: "other", command: "other" },
          { name: "extra", command: "extra" },
        ],
      },
    });
  });

  it("treats an unnamed generic entry as 'generic-cli', its registry name", () => {
    const base = { agents: { genericCli: [{ command: "base-binary" }] } };
    const project = { agents: { genericCli: [{ command: "project-binary" }] } };

    expect(mergeConfigDocuments(base, project)).toEqual({
      agents: { genericCli: [{ command: "project-binary" }] },
    });
  });

  it("passes a layer straight through when the other is absent", () => {
    expect(mergeConfigDocuments(undefined, { memo: { enabled: true } })).toEqual({ memo: { enabled: true } });
    expect(mergeConfigDocuments({ memo: { enabled: true } }, undefined)).toEqual({ memo: { enabled: true } });
  });
});

describe("the merged document is what gets validated", () => {
  it("leaves the search path ABSENT, which means 'the layers, in order'", () => {
    // Generated from `jairaPaths().roots` at load time rather than written down here, so there is
    // one source of truth for the layers and adding one cannot leave a constant behind.
    expect(parseConfig({}).workflows.path).toBeUndefined();
  });

  it("accepts a $BASE-rooted path entry", () => {
    expect(parseConfig({ workflows: { path: ["$BASE/lib"] } }).workflows.path).toEqual(["$BASE/lib"]);
  });

  it("still refuses a bare path entry, naming why", () => {
    expect(() => parseConfig({ workflows: { path: ["lib"] } })).toThrow(/\$BASE/);
  });

  it("reads the executor fields off every kind of executor", () => {
    const config = parseConfig({
      agents: {
        claudeCode: { enabled: false, credential: "ANTHROPIC_API_KEY" },
        claudeCli: { command: "/opt/claude" },
        codex: { enabled: true, sandbox: "read-only" },
        genericCli: [{ command: "aider", enabled: false }],
      },
    });

    expect(config.agents.claudeCode?.enabled).toBe(false);
    expect(config.agents.claudeCode?.credential).toBe("ANTHROPIC_API_KEY");
    expect(config.agents.claudeCli?.command).toBe("/opt/claude");
    expect(config.agents.codex?.sandbox).toBe("read-only");
    expect(config.agents.genericCli?.[0]?.enabled).toBe(false);
  });

  /**
   * The two Claude adapters take OPPOSITE settings, and each refuses the other's.
   *
   * They were one shared block, which is how the settings screen came to ask for an Anthropic key in
   * order to run a binary that signs itself in and would have ignored one. A key stored there is a
   * secret nothing ever reads, and the belief that the executor is configured is worse than the
   * missing field.
   */
  it("refuses a key for the CLI, which signs itself in, and a command for the in-process SDK", () => {
    expect(() => parseConfig({ agents: { claudeCli: { credential: "ANTHROPIC_API_KEY" } } })).toThrow(
      /authenticates itself/,
    );
    expect(() => parseConfig({ agents: { claudeCode: { command: "claude" } } })).toThrow(/no binary to point at/);
  });

  it("refuses a credential that looks like a value rather than a name", () => {
    // The single easiest way to end up with a secret committed in config.json.
    expect(() => parseConfig({ agents: { codex: { credential: "sk-ant secret value" } } })).toThrow(
      /must NAME a secret, not hold one/,
    );
  });

  /**
   * Model limits are NOT an agent's business any more.
   *
   * They live on the executor tree's route node, because that is what they are about: a limit on a
   * route, not on the binary underneath it. Two homes for one setting meant two screens, two parsers,
   * and a question with no good answer — does this apply to the route, or to the agent under it?
   */
  it("refuses model limits on an agent, which is the route's business now", () => {
    expect(() => parseConfig({ agents: { claudeCli: { models: { default: "opus" } } } })).toThrow(
      /is not a setting/,
    );
  });

  it("refuses a non-boolean enabled", () => {
    expect(() => parseConfig({ agents: { codex: { enabled: "yes" } } })).toThrow(/enabled must be a boolean/);
  });
});
