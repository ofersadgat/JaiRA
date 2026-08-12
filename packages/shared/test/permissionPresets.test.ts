/**
 * Permission presets — a starting point for the per-tool modes, and nothing more.
 *
 * The distinction under test is the whole design. The engine's `profile` is a scope FILTER resolved
 * at call time: it runs ahead of the mode, refuses whatever it excludes, and — for a name nothing
 * recognises — refuses everything. A preset is spent on the click. It writes a mode per tool and
 * then has no further say, so what runs is the map, which is also what the reader sees and edits.
 *
 * That is not a stylistic preference. A composer that wrote profile NAMES once sent `acceptEdits`,
 * which `inProfile` resolved through its custom-predicate table, found nothing, and treated as
 * admitting nothing — every tool call refused, while the chip displayed the word that had been
 * picked. Writing modes instead makes that unrepresentable: there is no name to get wrong.
 */
import { describe, expect, it } from "vitest";
import {
  PERMISSION_MODES,
  PERMISSION_PRESETS,
  presetModes,
  presetOf,
  type PermissionMode,
  type ToolChoice,
} from "../src/operationVocabulary";

/** JaiRA's own gateable set, in the shape the plan hands the composer. */
const TOOLS: ToolChoice[] = [
  { name: "bash", readOnly: false },
  { name: "read_file", readOnly: true },
  { name: "write_file", readOnly: false },
];

const preset = (id: string) => PERMISSION_PRESETS.find((p) => p.id === id)!;

describe("what a preset writes", () => {
  it("assigns a mode to EVERY offered tool, so nothing falls through to a default", () => {
    for (const p of PERMISSION_PRESETS) {
      expect(Object.keys(presetModes(p, TOOLS)).sort(), p.id).toEqual(TOOLS.map((t) => t.name).sort());
    }
  });

  it("only ever writes modes the ledger knows", () => {
    // The failure this replaces wrote a name into the profile field that nothing could resolve. A
    // preset cannot: its whole output is drawn from the mode vocabulary.
    for (const p of PERMISSION_PRESETS) {
      for (const mode of Object.values(presetModes(p, TOOLS))) {
        expect(PERMISSION_MODES).toContain(mode);
      }
    }
  });

  it("read-only asks the TOOL what it does, rather than knowing tool names", () => {
    // Which is what makes it right for a tool nobody has written yet: a newly registered writer is
    // denied by this preset without anybody remembering to add it to a list.
    expect(presetModes(preset("read-only"), TOOLS)).toEqual({
      read_file: "allow",
      bash: "deny",
      write_file: "deny",
    });
    const invented: ToolChoice[] = [{ name: "delete_everything", readOnly: false }];
    expect(presetModes(preset("read-only"), invented)).toEqual({ delete_everything: "deny" });
  });

  it("has no `plan`, because a chat turn has no door out of it", () => {
    // Plan mode is an ESCALATION — read-only until the agent presents a plan and a human approves the
    // exit — and the exit gate is registered by the engine for the states it runs, not by the chat
    // path. Offered here it would be `read-only` under a name promising a door nobody has hung.
    expect(PERMISSION_PRESETS.map((p) => p.id)).not.toContain("plan");
  });
});

describe("which preset a map corresponds to", () => {
  it("names the preset that wrote it — round trip", () => {
    for (const p of PERMISSION_PRESETS) {
      expect(presetOf(presetModes(p, TOOLS), TOOLS)?.id, p.id).toBe(p.id);
    }
  });

  it("becomes CUSTOM when one tool is changed, and keeps every other mode", () => {
    // The reason a preset can be a starting point rather than a setting. Editing one tool must not
    // silently discard the rest, and the label must stop claiming a preset whose modes are no longer
    // what will run.
    const modes: Record<string, PermissionMode> = { ...presetModes(preset("read-only"), TOOLS), bash: "ask" };
    expect(presetOf(modes, TOOLS)).toBeUndefined();
    expect(modes.read_file).toBe("allow");
    expect(modes.write_file).toBe("deny");
  });

  it("is undefined for a map that does not cover every offered tool", () => {
    // A partial map leaves the uncovered tools to fall back, so it is not what any preset would have
    // written — saying `custom` is the honest answer.
    expect(presetOf({ bash: "allow" }, TOOLS)).toBeUndefined();
  });

  it("IGNORES a mode for a tool no longer offered — stale is not custom", () => {
    // Otherwise a key left behind by a project that once registered something would hold the label at
    // `custom` forever, and the presets would look permanently unselectable for no visible reason.
    const stale: Record<string, PermissionMode> = { ...presetModes(preset("full"), TOOLS), retired_tool: "deny" };
    expect(presetOf(stale, TOOLS)?.id).toBe("full");
  });

  it("is undefined when nothing has been set at all", () => {
    expect(presetOf(undefined, TOOLS)).toBeUndefined();
  });
});
