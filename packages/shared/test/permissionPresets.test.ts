/**
 * The composer's four permission presets — as the toolset FILES they became (decision 0007 §2).
 *
 * A preset used to be a FUNCTION of a tool, spent on the click: it wrote a mode per tool and then had
 * no further say, so what ran was the map. That half survives untouched — what runs is still the map.
 * What changed is where the four maps live: `$SYSTEM/toolsets/chat/{ask-first, read-only, auto,
 * full}.json`, data a person can read, override in a layer, and add to.
 *
 * So the functions are FROZEN HERE, exactly as they were the day they left the source, and the one
 * claim of this file is that the shipped files say what those functions wrote — for every tool a
 * conversation can be handed, and for the name no preset had ever heard of, which is what `other` is.
 * Which toolset a map IS — the old `presetOf` — is `matchToolset`, in `toolsetBuckets.test.ts`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PERMISSION_MODES, READ_ONLY_PRESET_TOOLS, type PermissionMode } from "../src/operationVocabulary";
import { TOOL_SPEC_BY_NAME, TOOL_SPECS } from "../src/toolVocabulary";
import { heldTools, offeredTools, parseToolset, toolImplementations, toolModes } from "../src/toolsets";

const TOOLSETS = join(dirname(fileURLToPath(import.meta.url)), "..", "builtin", "toolsets");

const shipped = (id: string): unknown => JSON.parse(readFileSync(join(TOOLSETS, `${id}.json`), "utf8"));

/** FROZEN — `PERMISSION_PRESETS` as it stood at a1a0581, the last commit that had it. */
const FROZEN_PRESETS: ReadonlyArray<{ id: string; file: string; modeFor: (name: string) => PermissionMode }> = [
  { id: "ask", file: "ask-first", modeFor: () => "ask" },
  { id: "read-only", file: "read-only", modeFor: (name) => (READ_ONLY_PRESET_TOOLS.includes(name) ? "allow" : "deny") },
  { id: "auto", file: "auto", modeFor: () => "smart" },
  { id: "full", file: "full", modeFor: () => "allow" },
];

/** Every tool a conversation can be HANDED — what the composer offered the presets. */
const CONVERSATION_TOOLS = TOOL_SPECS.filter((spec) => spec.nativeOnly !== true && spec.unserved !== true).map((spec) => spec.name);

/** The workflow tools (decision 0005 §3) — all of what `chat_control` holds. */
const WORKFLOW_TOOLS = ["workflows", "start", "move", "tasks", "answer", "hold", "release", "stop"];

describe("the chat bucket is the four presets, written down", () => {
  it.each(FROZEN_PRESETS)("chat/$file writes EXACTLY the map the `$id` preset wrote", ({ file, modeFor }) => {
    const { toolset, issues } = parseToolset(shipped(`chat/${file}`));
    expect(issues).toEqual([]);
    // The map the preset wrote: a mode for every offered tool, and nothing else.
    expect(toolModes(toolset)).toEqual(Object.fromEntries(CONVERSATION_TOOLS.map((name) => [name, modeFor(name)])));
    // Every line is HELD — a preset never unticked anything, and a toolset's line is its tick.
    expect(heldTools(toolset).sort()).toEqual([...CONVERSATION_TOOLS].sort());
    // …with nobody's implementation chosen, because a preset never chose one.
    expect(toolImplementations(toolset)).toEqual({});
    // "A name the preset has never heard of gets its strictest" is what `other` says.
    expect(toolset.other).toBe(modeFor("a tool nobody has heard of"));
  });

  it("read-only allows exactly the frozen list, and that list is still in the vocabulary", () => {
    const { toolset } = parseToolset(shipped("chat/read-only"));
    const allowed = Object.entries(toolModes(toolset)).filter(([, mode]) => mode === "allow").map(([name]) => name);
    expect(allowed.sort()).toEqual([...READ_ONLY_PRESET_TOOLS].sort());
    expect(READ_ONLY_PRESET_TOOLS.every((name) => TOOL_SPEC_BY_NAME.has(name))).toBe(true);
  });

  it("ships no `plan`, because a chat turn has no door out of it", () => {
    // Plan mode is an ESCALATION — read-only until the agent presents a plan and a human approves the
    // exit — and the exit gate is registered by the engine for the states it runs, not by the chat
    // path. Shipped here it would be `read-only` under a name promising a door nobody has hung.
    expect(readdirSync(join(TOOLSETS, "chat")).sort()).toEqual(["ask-first.json", "auto.json", "full.json", "read-only.json"]);
  });
});

describe("chat_control has its OWN versions of the same names", () => {
  it("ships the same four names", () => {
    expect(readdirSync(join(TOOLSETS, "chat_control")).sort()).toEqual(readdirSync(join(TOOLSETS, "chat")).sort());
  });

  it.each(["ask-first", "read-only", "auto", "full"])("chat_control/%s holds ONLY the task and workflow tools, and refuses everything else", (name) => {
    const { toolset, issues } = parseToolset(shipped(`chat_control/${name}`));
    // No warning either: the eight names are in the standard list, or each would be dropped as unknown.
    expect(issues).toEqual([]);
    expect(Object.keys(toolset.entries).sort()).toEqual([...WORKFLOW_TOOLS].sort());
    expect(toolset.other).toBe("deny");
  });

  it("holds them and HANDS NOBODY anything: they are named, and not served yet", () => {
    const { toolset } = parseToolset(shipped("chat_control/full"));
    expect(heldTools(toolset).sort()).toEqual([...WORKFLOW_TOOLS].sort());
    // What lowering writes into the engine's `tools` list, and what an agent plan calls held.
    expect(offeredTools(toolset)).toEqual([]);
    for (const name of WORKFLOW_TOOLS) expect(TOOL_SPEC_BY_NAME.get(name)).toMatchObject({ category: "tasks", unserved: true });
  });

  it("read-only may look and may not steer", () => {
    expect(toolModes(parseToolset(shipped("chat_control/read-only")).toolset)).toEqual({
      workflows: "allow",
      tasks: "allow",
      start: "deny",
      move: "deny",
      answer: "deny",
      hold: "deny",
      release: "deny",
      stop: "deny",
    });
  });
});

describe("every shipped toolset", () => {
  it("only ever writes modes the ledger knows", () => {
    for (const bucket of readdirSync(TOOLSETS)) {
      for (const file of readdirSync(join(TOOLSETS, bucket))) {
        const map = shipped(`${bucket}/${file.replace(/\.json$/, "")}`) as Record<string, unknown>;
        for (const [subject, mode] of Object.entries(map)) expect(PERMISSION_MODES, `${bucket}/${file}: ${subject}`).toContain(mode);
        // `other` is the LAST line, where a person reading the file looks for it.
        expect(Object.keys(map).at(-1), `${bucket}/${file}`).toBe("other");
      }
    }
  });
});
