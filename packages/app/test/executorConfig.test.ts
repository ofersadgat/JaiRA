/**
 * Editing an executor from the settings form (DESIGN §8.1).
 *
 * The rule under test is the layer model: a form writes into the document of the layer it is
 * pointed at, and it writes only what changed. Everything else follows from that — an inherited
 * value that gets copied into a project the first time anything else is saved is a project that has
 * silently stopped tracking the shared root, which is the failure these functions exist to prevent.
 *
 * The other half is that whatever comes out must still LOAD: every document built here is run
 * through the real `parseConfig`, because a settings screen that writes an unloadable `settings.json`
 * leaves the app unable to open the project it was just configured with.
 */
import { describe, expect, it } from "vitest";
import { parseConfig } from "@jaira/shared";
import {
  addGenericExecutor,
  applyExecutorPatch,
  credentialUseOf,
  editableFields,
  executorBlock,
  formatArgs,
  formatEnv,
  parseArgs,
  parseEnv,
  removeGenericExecutor,
  checkCredentialName,
  type ExecutorTarget,
} from "../src/renderer/executorConfig";

const claudeCli: ExecutorTarget = { name: "claude-cli", kind: "cli", command: "claude" };
const codex: ExecutorTarget = { name: "codex-cli", kind: "codex", command: "codex" };
const opencode: ExecutorTarget = { name: "opencode", kind: "generic", command: "opencode" };

/** Every document these functions produce has to survive the parser the main process runs. */
function loadable(doc: unknown): unknown {
  parseConfig(doc ?? {});
  return doc;
}

describe("patching a built-in executor", () => {
  it("writes the field into the layer's own document, under the config key", () => {
    const doc = applyExecutorPatch({}, claudeCli, { command: "/usr/local/bin/claude" });

    expect(loadable(doc)).toEqual({ agents: { claudeCli: { command: "/usr/local/bin/claude" } } });
  });

  it("keeps the rest of the layer, including the other executors", () => {
    const before = { artifactDir: "out", agents: { codex: { sandbox: "read-only" } } };

    const doc = applyExecutorPatch(before, claudeCli, { command: "/opt/claude" });

    expect(loadable(doc)).toMatchObject({
      artifactDir: "out",
      agents: { codex: { sandbox: "read-only" }, claudeCli: { command: "/opt/claude" } },
    });
  });

  /**
   * A patch takes a DOTTED path, and a container the removal emptied goes with it.
   *
   * Nothing in an agent block is nested any more — model limits moved to the executor tree's route
   * node — but the mechanism stays, because it is what makes "clear it and save" mean "go back to
   * inheriting" rather than "write an inert `{}`".
   */
  it("drops a container a removal emptied instead of leaving it behind", () => {
    const before = { agents: { claudeCli: { command: "claude" } } };

    const doc = applyExecutorPatch(before, claudeCli, { command: undefined });

    expect(loadable(doc)).toEqual({});
  });

  it("does not mutate the document it was given — the store still holds the last read", () => {
    const before = { agents: { claudeCli: { command: "claude" } } };

    applyExecutorPatch(before, claudeCli, { command: "claude-next" });

    expect(before.agents.claudeCli.command).toBe("claude");
  });

  it("removes a field patched to undefined, so the layer goes back to inheriting", () => {
    const before = { agents: { claudeCli: { command: "claude", enabled: false } } };

    const doc = applyExecutorPatch(before, claudeCli, { command: undefined });

    expect(loadable(doc)).toEqual({ agents: { claudeCli: { enabled: false } } });
  });

  it("deletes an emptied block, and the agents block with it", () => {
    // "This layer overrides nothing" and "this layer overrides nothing, verbosely" are the same
    // configuration, but only one of them reads that way in the file.
    const before = { agents: { claudeCli: { command: "claude" } } };

    const doc = applyExecutorPatch(before, claudeCli, { command: undefined });

    expect(loadable(doc)).toEqual({});
  });

  it("takes codex's sandbox, which is the whole of its policy enforcement", () => {
    const doc = applyExecutorPatch({}, codex, { sandbox: "read-only" });

    expect(loadable(doc)).toEqual({ agents: { codex: { sandbox: "read-only" } } });
  });
});

describe("patching a configured CLI", () => {
  it("edits the entry in place, matched by its registry name", () => {
    const before = {
      agents: { genericCli: [{ name: "opencode", command: "opencode" }, { name: "aider", command: "aider" }] },
    };

    const doc = applyExecutorPatch(before, opencode, { args: ["run", "{prompt}"], prompt: "argument" });

    expect(loadable(doc)).toEqual({
      agents: {
        genericCli: [
          { name: "opencode", command: "opencode", args: ["run", "{prompt}"], prompt: "argument" },
          { name: "aider", command: "aider" },
        ],
      },
    });
  });

  it("carries name and command into an override the layer does not have yet", () => {
    // `genericCli` merges by name but every entry must have a command, so an override created in
    // the project layer for a CLI the base declares is only loadable if it brings the command with
    // it — a lone `credential` would be refused by the parser.
    const doc = applyExecutorPatch({}, opencode, { credential: "OPENCODE_API_KEY" });

    expect(loadable(doc)).toEqual({
      agents: { genericCli: [{ name: "opencode", command: "opencode", credential: "OPENCODE_API_KEY" }] },
    });
  });

  it("keeps the identifying pair when every other field is cleared", () => {
    const before = { agents: { genericCli: [{ name: "opencode", command: "opencode", credential: "K" }] } };

    const doc = applyExecutorPatch(before, opencode, { credential: undefined });

    // Emptying the block would delete the executor rather than an override of one.
    expect(loadable(doc)).toEqual({ agents: { genericCli: [{ name: "opencode", command: "opencode" }] } });
  });

  it("finds the entry that names itself nothing under the default registry name", () => {
    const before = { agents: { genericCli: [{ command: "aider" }] } };
    const target: ExecutorTarget = { name: "generic-cli", kind: "generic", command: "aider" };

    expect(executorBlock(before, "generic-cli")).toEqual({ command: "aider" });
    expect(loadable(applyExecutorPatch(before, target, { command: "aider2" }))).toEqual({
      agents: { genericCli: [{ name: "generic-cli", command: "aider2" }] },
    });
  });
});

describe("adding and removing a CLI executor", () => {
  it("appends the entry to the layer", () => {
    const doc = addGenericExecutor({ agents: { claudeCli: { enabled: false } } }, {
      name: "opencode",
      command: "opencode",
    });

    expect(loadable(doc)).toEqual({
      agents: { claudeCli: { enabled: false }, genericCli: [{ name: "opencode", command: "opencode" }] },
    });
  });

  it("refuses a name the layer already uses, rather than shadowing it", () => {
    const before = { agents: { genericCli: [{ name: "opencode", command: "opencode" }] } };

    expect(() => addGenericExecutor(before, { name: "opencode", command: "other" })).toThrow(/already configures/);
  });

  it("refuses a built-in's name, which would be an executor nobody could reach", () => {
    expect(() => addGenericExecutor({}, { name: "claude-cli", command: "claude" })).toThrow(/built-in/);
  });

  it("removes only the named entry, and the empty list with the last of them", () => {
    const before = {
      agents: { genericCli: [{ name: "opencode", command: "opencode" }, { name: "aider", command: "aider" }] },
    };

    expect(loadable(removeGenericExecutor(before, "opencode"))).toEqual({
      agents: { genericCli: [{ name: "aider", command: "aider" }] },
    });
    expect(loadable(removeGenericExecutor({ agents: { genericCli: [{ name: "aider", command: "aider" }] } }, "aider"))).toEqual(
      {},
    );
  });
});

describe("the fields a kind offers", () => {
  it("offers no command for the in-process adapter, which has no binary to point at", () => {
    expect(editableFields("sdk")).not.toContain("command");
    expect(editableFields("sdk")).toContain("credential");
  });

  it("offers the sandbox only for codex, whose enforcement it is", () => {
    expect(editableFields("codex")).toContain("sandbox");
    expect(editableFields("cli")).not.toContain("sandbox");
  });

  /**
   * The two Claude adapters are DIFFERENT forms, which is the whole point of the split.
   *
   * One is an API client and needs a key; the other is a program that already knows who its user is
   * and needs a path. Offering a key for the second is what made this screen ask for a secret nothing
   * would read, so `cli` not having the field is the assertion that matters here.
   */
  it("asks the CLI for a binary and the SDK for a key, and neither for the other's", () => {
    expect(editableFields("cli")).toContain("command");
    expect(editableFields("cli")).not.toContain("credential");
    expect(credentialUseOf("cli")).toBe("none");
    expect(credentialUseOf("sdk")).toBe("required");
    expect(credentialUseOf("codex")).toBe("optional");
  });

  /**
   * Model limits are NOT an executor's fields any more.
   *
   * They moved to the executor tree's route node, because that is what they are about: a limit on a
   * route, not on the binary underneath it. This block is now only what the runtime IS.
   */
  it("offers no model limits — those belong to the route, not the runtime", () => {
    for (const kind of ["sdk", "cli", "codex", "generic"] as const) {
      expect(editableFields(kind)).not.toContain("modelDefault");
      expect(editableFields(kind)).not.toContain("modelAllow");
    }
  });
});

describe("the text fields", () => {
  it("round-trips argv as one argument per line, so a space cannot split one", () => {
    const args = ["--message", "review this change", "{prompt}"];

    expect(parseArgs(formatArgs(args))).toEqual(args);
  });

  it("reads a blank box as 'say nothing', not as an empty argv", () => {
    expect(parseArgs("  \n \n")).toBeUndefined();
  });

  it("round-trips the environment as NAME=value lines", () => {
    expect(parseEnv(formatEnv({ HTTP_PROXY: "http://localhost:3128" }))).toEqual({
      HTTP_PROXY: "http://localhost:3128",
    });
  });

  it("refuses a line that is not NAME=value rather than dropping it", () => {
    // A silently dropped variable is an agent that behaves differently for no visible reason.
    expect(() => parseEnv("HTTP_PROXY http://localhost:3128")).toThrow(/is not a NAME=value line/);
  });

  it("refuses a credential field that holds a key instead of naming one", () => {
    expect(() => checkCredentialName("sk-ant api03 secret")).toThrow(/NAMES the key/);
    expect(() => checkCredentialName("ANTHROPIC_API_KEY")).not.toThrow();
  });
});
