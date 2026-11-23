/**
 * The composer's four permission presets — as the permission set FILES they became (decision 0007 §2).
 *
 * A preset used to be a FUNCTION of a tool, spent on the click: it wrote a mode per tool and then had
 * no further say, so what ran was the map. That half survives untouched — what runs is still the map.
 * What changed is where the four maps live: `$SYSTEM/permission-sets/{ask-first, read-only, auto,
 * full}.json`, data a person can read, override in a layer, and add to.
 *
 * So the functions are FROZEN HERE, exactly as they were the day they left the source, and the one
 * claim of this file is that the shipped files say what those functions wrote — for every tool a
 * conversation can be handed, and for the name no preset had ever heard of, which is what `other` is.
 * Which permission set a map IS — the old `presetOf` — is `matchPermissionSet`, in `permissionSetBuckets.test.ts`.
 *
 * ## The workflow tools joined the conversation presets (decision 0005 step 6)
 *
 * A session holds the project's tools AND the workflow tools, so the four top-level files grew eight
 * entries the four functions had never seen. The frozen functions are therefore held to the tools
 * they were written about — the nine a conversation had then — and the eight new ones are held to a
 * table instead ({@link WORKFLOW_MODES}): what the control conversation's own sets gave them, until
 * there was no control conversation (decision 0005, amended 2026-11-19).
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { READ_ONLY_PRESET_TOOLS, SMART_MODE, type PermissionSetMode } from "../src/operationVocabulary";
import { TOOL_SPEC_BY_NAME, TOOL_SPECS } from "../src/toolVocabulary";
import { heldTools, isPermissionSetInstructionKey, linePlaces, offeredTools, parsePermissionSet, toolImplementations, toolModes, type PermissionSet } from "../src/permissionSets";
import { resolvePlace } from "../src/places";
import { composePermissionSetLayers } from "../src/permissionLayers";

/**
 * Each tool's mode IN THE PROJECT — what the frozen presets were about. Since decision 0023 §7.1 a
 * shipped line may be a place map (`read_file`: the set's mode in `$PROJECT` and `$WORKTREE`, `ask`
 * elsewhere, credentials asking), so the preset's word is the line's answer at `$PROJECT` where it
 * names one, and its own mode otherwise. What the places add is held to §7.1 below.
 */
const projectModes = (permissionSet: PermissionSet): Record<string, PermissionSetMode> => {
  const places = linePlaces(permissionSet);
  return Object.fromEntries(Object.entries(toolModes(permissionSet)).map(([name, mode]) => [name, places[name]?.["$PROJECT"] ?? mode]));
};

const PERMISSION_SETS = join(dirname(fileURLToPath(import.meta.url)), "..", "builtin", "permission-sets");

/** The top level's set files — the conversation presets. */
const topLevel = (): string[] => readdirSync(PERMISSION_SETS, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name);

const shipped = (id: string): unknown => JSON.parse(readFileSync(join(PERMISSION_SETS, `${id}.json`), "utf8"));

/** FROZEN — `PERMISSION_PRESETS` as it stood at a1a0581, the last commit that had it. */
const FROZEN_PRESETS: ReadonlyArray<{ id: string; file: string; modeFor: (name: string) => PermissionSetMode }> = [
  { id: "ask", file: "ask-first", modeFor: () => "ask" },
  { id: "read-only", file: "read-only", modeFor: (name) => (READ_ONLY_PRESET_TOOLS.includes(name) ? "allow" : "deny") },
  // The preset wrote the word `smart`; the word became the shipped FUNCTION of that name (decision 0007,
  // amended 2026-09-22), so what `auto` wrote is read as that function — the one change to the frozen map.
  { id: "auto", file: "auto", modeFor: () => SMART_MODE },
  { id: "full", file: "full", modeFor: () => "allow" },
];

/** The workflow tools (decision 0005 §3) — part of every top-level set. */
const WORKFLOW_TOOLS = ["list_workflows", "start_task", "move_task", "list_tasks", "answer_question", "hold_task", "release_task", "stop_task"];

/** What each top-level set gives the workflow tools: one word for all eight, or — read-only — look and never steer. */
const WORKFLOW_MODES: Record<string, Record<string, PermissionSetMode>> = {
  "ask-first": Object.fromEntries(WORKFLOW_TOOLS.map((name) => [name, "ask"])),
  auto: Object.fromEntries(WORKFLOW_TOOLS.map((name) => [name, SMART_MODE])),
  full: Object.fromEntries(WORKFLOW_TOOLS.map((name) => [name, "allow"])),
  "read-only": Object.fromEntries(WORKFLOW_TOOLS.map((name) => [name, name === "list_workflows" || name === "list_tasks" ? "allow" : "deny"])),
};

/**
 * The Git tools (decision 0010 §1), with the decision's table of modes — not the frozen functions':
 * the readers are allowed wherever a set lets anything look, and what leaves the machine is asked,
 * judged or refused by how far the set trusts the agent.
 */
const GIT_TOOLS: Record<string, Record<string, PermissionSetMode>> = {
  list_merge_requests: { "ask-first": "ask", auto: "allow", full: "allow", "read-only": "allow" },
  read_merge_request: { "ask-first": "ask", auto: "allow", full: "allow", "read-only": "allow" },
  open_merge_request: { "ask-first": "ask", auto: SMART_MODE, full: "allow", "read-only": "deny" },
  comment_merge_request: { "ask-first": "ask", auto: SMART_MODE, full: "allow", "read-only": "deny" },
  git_merge: { "ask-first": "ask", auto: "ask", full: "allow", "read-only": "deny" },
  close_merge_request: { "ask-first": "ask", auto: "ask", full: "allow", "read-only": "deny" },
  git_push: { "ask-first": "ask", auto: SMART_MODE, full: "allow", "read-only": "deny" },
};

/** The CI tools (decision 0016): reads only, so modes like the Git readers'. */
const CI_TOOLS: Record<string, Record<string, PermissionSetMode>> = {
  list_pipelines: { "ask-first": "ask", auto: "allow", full: "allow", "read-only": "allow" },
  read_pipeline: { "ask-first": "ask", auto: "allow", full: "allow", "read-only": "allow" },
  read_pipeline_job: { "ask-first": "ask", auto: "allow", full: "allow", "read-only": "allow" },
  download_pipeline_artifact: { "ask-first": "ask", auto: "allow", full: "allow", "read-only": "allow" },
};

/** Every tool that reaches the forge, in the order the top-level files write them. */
const FORGE_TOOLS = { ...GIT_TOOLS, ...CI_TOOLS };

/** `wait_for_event` (decision 0016 §5): any event, so a task tool — the readers' modes, before the workflow tools. */
const EVENT_TOOLS: Record<string, Record<string, PermissionSetMode>> = {
  wait_for_event: { "ask-first": "ask", auto: "allow", full: "allow", "read-only": "allow" },
};

/** The skill tools (decision 0029 §10): readers, so allowed wherever a set lets anything look. */
const SKILL_TOOLS: Record<string, Record<string, PermissionSetMode>> = {
  list_skills: { "ask-first": "ask", auto: "allow", full: "allow", "read-only": "allow" },
  load_skill: { "ask-first": "ask", auto: "allow", full: "allow", "read-only": "allow" },
};

/**
 * The System tools (decision 0019 §5, as ruled 2026-10-20): "system should default to ask" — every one
 * asks, except that read-only lets the looks go ahead (the clipboard and the screen too: they only
 * read) and refuses the changes, and full allows all sixteen.
 */
const SYSTEM_LOOKS = ["read_system", "list_processes", "list_services", "list_software", "read_settings", "read_clipboard", "list_windows", "screenshot"];
const SYSTEM_CHANGES = ["power", "stop_process", "control_service", "install_software", "write_settings", "write_clipboard", "open_app", "control_input"];
const SYSTEM_TOOLS: Record<string, Record<string, PermissionSetMode>> = Object.fromEntries([
  ...SYSTEM_LOOKS.map((name) => [name, { "ask-first": "ask", auto: "ask", full: "allow", "read-only": "allow" }] as const),
  ...SYSTEM_CHANGES.map((name) => [name, { "ask-first": "ask", auto: "ask", full: "allow", "read-only": "deny" }] as const),
]);

/**
 * The process tools decision 0032 added (ruling 4): `wait_process` is a look, as 0019 rules them, and
 * `read_process` a look that asks in every set but `full` — another program's output can hold what the
 * person did not mean to show. What a session started is the `--scope=session` lines', below.
 */
const PROCESS_TOOLS: Record<string, Record<string, PermissionSetMode>> = {
  read_process: { "ask-first": "ask", auto: "ask", full: "allow", "read-only": "ask" },
  wait_process: { "ask-first": "ask", auto: "ask", full: "allow", "read-only": "allow" },
};

/** The tools with a table of their own here rather than a frozen preset's mode. */
const TABLED = { ...FORGE_TOOLS, ...EVENT_TOOLS, ...SYSTEM_TOOLS, ...PROCESS_TOOLS, ...SKILL_TOOLS };

/** Every tool a conversation can be HANDED today — the nine the presets knew, the eight since, and the Git tools. */
const CONVERSATION_TOOLS = TOOL_SPECS.filter((spec) => spec.nativeOnly !== true && spec.unserved !== true).map((spec) => spec.name);

/** The tools the frozen FUNCTIONS were written about: everything a conversation held before step 6. */
const PRESET_TOOLS = CONVERSATION_TOOLS.filter((name) => !WORKFLOW_TOOLS.includes(name) && TABLED[name] === undefined);

describe("the top level is the four presets, written down, and read-only-scratch", () => {
  it.each(FROZEN_PRESETS)("$file writes EXACTLY the map the `$id` preset wrote", ({ file, modeFor }) => {
    const { permissionSet, issues } = parsePermissionSet(shipped(file));
    expect(issues).toEqual([]);
    // The map the preset wrote for the tools it knew, the table's answer for the workflow tools, and
    // decision 0010's table for the Git tools.
    expect(projectModes(permissionSet)).toEqual({
      ...Object.fromEntries(PRESET_TOOLS.map((name) => [name, modeFor(name)])),
      ...WORKFLOW_MODES[file],
      ...Object.fromEntries(Object.entries(TABLED).map(([name, modes]) => [name, modes[file]!])),
    });
    // Every line is HELD — a preset never unticked anything, and a permission set's line is its tick —
    // including any tool named and not yet served, whose mode is inert until it is.
    expect(heldTools(permissionSet).sort()).toEqual([...CONVERSATION_TOOLS, ...TOOL_SPECS.filter((s) => s.unserved === true).map((s) => s.name)].sort());
    // …and every forge tool is handed on, and wait_for_event, which the event hub serves.
    for (const name of Object.keys(TABLED)) if (TOOL_SPEC_BY_NAME.get(name)?.unserved !== true) expect(offeredTools(permissionSet), name).toContain(name);
    // …with nobody's implementation chosen, because a preset never chose one.
    expect(toolImplementations(permissionSet)).toEqual({});
    // "A name the preset has never heard of gets its strictest" is what `other` says.
    expect(permissionSet.other).toEqual(modeFor("a tool nobody has heard of"));
  });

  it("read-only allows exactly the frozen list, and that list is still in the vocabulary", () => {
    const { permissionSet } = parsePermissionSet(shipped("read-only"));
    const allowed = Object.entries(projectModes(permissionSet))
      .filter(([name, mode]) => mode === "allow" && !WORKFLOW_TOOLS.includes(name) && TABLED[name] === undefined)
      .map(([name]) => name);
    expect(allowed.sort()).toEqual([...READ_ONLY_PRESET_TOOLS].sort());
    expect(READ_ONLY_PRESET_TOOLS.every((name) => TOOL_SPEC_BY_NAME.has(name))).toBe(true);
  });

  it("ships no `plan`, because a chat turn has no door out of it", () => {
    // Plan mode is an ESCALATION — read-only until the agent presents a plan and a human approves the
    // exit — and the exit gate is registered by the engine for the states it runs, not by the chat
    // path. Shipped here it would be `read-only` under a name promising a door nobody has hung.
    expect(topLevel().sort()).toEqual(["ask-first.json", "auto.json", "full.json", "read-only-scratch.json", "read-only.json"]);
  });
});

describe("the workflow tools", () => {
  it("are held and HANDED OVER by the top-level sets: named, and served since step 6", () => {
    const { permissionSet } = parsePermissionSet(shipped("full"));
    for (const name of WORKFLOW_TOOLS) {
      expect(heldTools(permissionSet)).toContain(name);
      expect(offeredTools(permissionSet)).toContain(name);
      expect(TOOL_SPEC_BY_NAME.get(name)).toMatchObject({ category: "tasks" });
      expect(TOOL_SPEC_BY_NAME.get(name)!.unserved).toBeUndefined();
    }
  });
});

describe("the Git tools (decision 0010 §1)", () => {
  it("are the whole of the git category, in the decision's order", () => {
    expect(TOOL_SPECS.filter((spec) => spec.category === "git").map((spec) => spec.name)).toEqual(Object.keys(GIT_TOOLS));
  });

  it("leave CI to the ci category (decision 0016)", () => {
    expect(TOOL_SPECS.filter((spec) => spec.category === "ci").map((spec) => spec.name)).toEqual(Object.keys(CI_TOOLS));
  });

  it("sit after the web tools in every top-level file, the CI tools after them, as the menu draws them", () => {
    const forge = Object.keys(FORGE_TOOLS);
    for (const name of ["ask-first", "read-only", "read-only-scratch", "auto", "full"]) {
      const keys = Object.keys(shipped(name) as Record<string, unknown>);
      expect(keys.slice(keys.indexOf("web_search") + 1, keys.indexOf("web_search") + 1 + forge.length), name).toEqual(forge);
    }
  });
});

describe("a start that keeps running, and what a session started (decision 0032)", () => {
  /** Ruling 1's table. */
  const BACKGROUND: Record<string, PermissionSetMode> = { "ask-first": "ask", "read-only": "deny", "read-only-scratch": "deny", auto: "ask", full: "allow" };
  /**
   * Ruling 4's table: the agent may always see, read, wait on and stop what it started, wherever it may
   * run — written since 2026-11-23 as the process tools' OWNER rule for `session` (decision 0023 §3.1).
   */
  const SESSION: Record<string, Record<string, PermissionSetMode>> = {
    list_processes: { "ask-first": "allow", "read-only": "allow", "read-only-scratch": "allow", auto: "allow", full: "allow" },
    read_process: { "ask-first": "allow", "read-only": "allow", "read-only-scratch": "allow", auto: "allow", full: "allow" },
    wait_process: { "ask-first": "allow", "read-only": "allow", "read-only-scratch": "allow", auto: "allow", full: "allow" },
    stop_process: { "ask-first": "allow", "read-only": "deny", "read-only-scratch": "deny", auto: "allow", full: "allow" },
  };

  it.each(["ask-first", "read-only", "read-only-scratch", "auto", "full"])("%s writes them at the ruled mode — a start as a flag line, the session's own as an owner rule", (file) => {
    const { permissionSet, issues } = parsePermissionSet(shipped(file));
    expect(issues).toEqual([]);
    expect(permissionSet.entries["shell --run_in_background"], file).toEqual({ kind: "tool-flag", mode: BACKGROUND[file] });
    for (const [tool, modes] of Object.entries(SESSION)) {
      const entry = permissionSet.entries[tool]!;
      expect(entry.places?.["owner=session"] ?? entry.mode, `${file} ${tool}`).toBe(modes[file]);
      expect(Object.keys(permissionSet.entries).some((key) => key.startsWith(`${tool} `)), `${file} ${tool}`).toBe(false);
    }
  });

  it("a simulation's pass never starts what keeps running", () => {
    expect(parsePermissionSet(shipped("improve/simulation")).permissionSet.entries["shell --run_in_background"]).toEqual({ kind: "tool-flag", mode: "deny" });
  });
});

describe("every shipped permission set", () => {
  it("only ever writes a decision a permission set takes — one of the three words, or a function by its name", () => {
    // The top level, then each bucket.
    const files = [...topLevel().map((file) => ({ bucket: ".", file })), ...readdirSync(PERMISSION_SETS, { withFileTypes: true }).filter((entry) => entry.isDirectory()).flatMap((entry) => readdirSync(join(PERMISSION_SETS, entry.name)).map((file) => ({ bucket: entry.name, file })))];
    for (const { bucket, file } of files) {
      {
        const map = shipped(bucket === "." ? file.replace(/.json$/, "") : `${bucket}/${file.replace(/.json$/, "")}`) as Record<string, unknown>;
        for (const [subject, mode] of Object.entries(map)) {
          // What a file says about itself — its description, its icon — is no line.
          if (isPermissionSetInstructionKey(subject)) continue;
          // A plain string, or a map of places (decision 0023 §7.1) — and none says `unavailable`, which
          // is a statement about a layer below.
          expect(typeof mode === "string" || (typeof mode === "object" && mode !== null), `${bucket}/${file}: ${subject}`).toBe(true);
          expect(mode, `${bucket}/${file}: ${subject}`).not.toBe("unavailable");
          expect(parsePermissionSet({ [subject]: mode }).issues, `${bucket}/${file}: ${subject}`).toEqual([]);
        }
        // `other` is the LAST line, where a person reading the file looks for it.
        expect(Object.keys(map).at(-1), `${bucket}/${file}`).toBe("other");
      }
    }
  });
});

describe("what ships gains places (decision 0023 §7.1)", () => {
  const ROOT = "C:/work/app";
  const options = { root: ROOT, named: { $PROJECT: ROOT, $WORKTREE: "C:/work/app-wt", $AGENT_WORKSPACE: "C:/Users/me/.claude/projects/C--work-app-wt", $TEMP: "C:/tmp", "~": "C:/Users/me" } };
  const CREDENTIALS = ["**/.env", "**/.env.*", "**/*.pem", "**/id_rsa*", "~/.ssh", "~/.aws", "~/.claude/.credentials.json", "~/.codex/auth.json"];
  /** A line's answer at one path, as a call's place is judged: the most specific place, else the line's own mode. */
  const at = (file: string, tool: string, path: string): PermissionSetMode | undefined => {
    const { permissionSet } = parsePermissionSet(shipped(file));
    const entry = permissionSet.entries[tool]!;
    const place = resolvePlace({ ...(entry.mode !== undefined ? { "**": entry.mode } : {}), ...entry.places }, "path", path, options);
    return place?.decision ?? entry.mode;
  };

  it.each([
    ["read-only", "allow"],
    ["ask-first", "ask"],
    ["auto", SMART_MODE],
  ] as const)("%s reads, globs and greps at its own mode in the project, the worktree and the agent's own folder, and ASKS elsewhere", (file, mode) => {
    for (const tool of ["read_file", "glob", "grep"]) {
      expect(at(file, tool, `${ROOT}/src/index.ts`), `${file} ${tool}`).toEqual(mode);
      expect(at(file, tool, "C:/work/app-wt/src/index.ts"), `${file} ${tool}`).toEqual(mode);
      // The agent's memory and transcripts: neither the project nor the worktree, and its own.
      expect(at(file, tool, "C:/Users/me/.claude/projects/C--work-app-wt/memory/notes.md"), `${file} ${tool}`).toEqual(mode);
      // Not the rest of the agent's folder, where its sign-in is.
      expect(at(file, tool, "C:/Users/me/.claude/.credentials.json"), `${file} ${tool}`).toBe("ask");
      // A read outside the project asks — under ask-first, as everywhere.
      expect(at(file, tool, "C:/Users/me/Documents/notes.txt"), `${file} ${tool}`).toBe("ask");
    }
  });

  it("full keeps allow — and still asks at a credential", () => {
    expect(at("full", "read_file", "C:/Users/me/Documents/notes.txt")).toBe("allow");
    expect(at("full", "read_file", `${ROOT}/src/index.ts`)).toBe("allow");
    // `.env` asks under full: a place that pins the file beats any folder that holds it (ruling 3).
    expect(at("full", "read_file", `${ROOT}/.env`)).toBe("ask");
    expect(at("full", "write_file", `${ROOT}/.env.local`)).toBe("ask");
    expect(at("full", "edit", "C:/Users/me/.ssh/config")).toBe("ask");
  });

  it.each(["read-only", "read-only-scratch", "ask-first", "auto", "full"])("%s asks at every credential place, inside the project too", (file) => {
    const { permissionSet } = parsePermissionSet(shipped(file));
    for (const tool of ["read_file", "glob", "grep"]) for (const place of CREDENTIALS) expect(linePlaces(permissionSet)[tool]?.[place], `${file} ${tool} ${place}`).toBe("ask");
    expect(at(file, "read_file", `${ROOT}/config/server.pem`)).toBe("ask");
    expect(at(file, "read_file", "C:/Users/me/.aws/credentials")).toBe("ask");
    expect(at(file, "grep", `${ROOT}/packages/app/.env.production`)).toBe("ask");
  });

  it.each(["read-only", "read-only-scratch"])("never loosens a refusal into a question: %s's writers still refuse a credential", (file) => {
    expect(at(file, "write_file", `${ROOT}/.env`)).toBe("deny");
    expect(at(file, "edit", "C:/Users/me/.ssh/config")).toBe("deny");
    expect(at(file, "write_file", "C:/Users/me/.claude/.credentials.json")).toBe("deny");
  });

  it("read-only-scratch is read-only, except that it writes and edits in the agent's own folder", () => {
    const scratch = shipped("read-only-scratch") as Record<string, unknown>;
    const readOnly = shipped("read-only") as Record<string, unknown>;
    expect(parsePermissionSet(scratch).issues).toEqual([]);
    // Every other line, in the same order, is read-only's.
    expect(Object.keys(scratch)).toEqual(Object.keys(readOnly));
    for (const key of Object.keys(readOnly)) if (key !== "edit" && key !== "write_file") expect(scratch[key], key).toEqual(readOnly[key]);
    const memory = "C:/Users/me/.claude/projects/C--work-app-wt/memory/notes.md";
    for (const tool of ["write_file", "edit"]) {
      expect(at("read-only-scratch", tool, memory), tool).toBe("allow");
      expect(at("read-only-scratch", tool, `${ROOT}/src/index.ts`), tool).toBe("deny");
      expect(at("read-only-scratch", tool, "C:/work/app-wt/src/index.ts"), tool).toBe("deny");
      expect(at("read-only-scratch", tool, "C:/tmp/x.txt"), tool).toBe("deny");
      // A credential pinned by name is refused even inside the agent's folder (ruling 3).
      expect(at("read-only-scratch", tool, "C:/Users/me/.claude/projects/C--work-app-wt/.env"), tool).toBe("deny");
      expect(at("read-only", tool, memory), tool).toBe("deny");
    }
  });

  /**
   * A preset laid on another REPLACES it, line for line (2026-11-13). A newer layer's place map keeps
   * every place below that it does not name (§2.1, §2.2), so a preset that leaves out a place another
   * preset names lets that one speak through it: `full` laid on `ask-first` still asked before every
   * read, glob and grep in the project, because only ask-first named `$PROJECT`. So every top-level
   * preset names every place another one names, on every line they both write as a map.
   */
  it("each one laid on any other says, on every line it writes, exactly what it says alone", () => {
    const presets = topLevel().map((name) => name.replace(/\.json$/, ""));
    expect(presets.length).toBeGreaterThan(1);
    for (const lower of presets) {
      for (const upper of presets) {
        if (lower === upper) continue;
        const composed = composePermissionSetLayers([
          { id: lower, decl: shipped(lower) as Record<string, unknown> },
          { id: upper, decl: shipped(upper) as Record<string, unknown> },
        ]).permissionSet;
        const alone = parsePermissionSet(shipped(upper)).permissionSet;
        for (const [subject, entry] of Object.entries(alone.entries)) {
          const got = composed.entries[subject];
          expect({ mode: got?.mode, places: got?.places }, `${upper} over ${lower}: ${subject}`).toEqual({ mode: entry.mode, places: entry.places });
        }
      }
    }
  });

  it("full laid on ask-first reads, globs and greps in the project without asking", () => {
    const composed = composePermissionSetLayers([
      { id: "ask-first", decl: shipped("ask-first") as Record<string, unknown> },
      { id: "full", decl: shipped("full") as Record<string, unknown> },
    ]).permissionSet;
    for (const tool of ["read_file", "glob", "grep"]) {
      const entry = composed.entries[tool]!;
      const map = { ...(entry.mode !== undefined ? { "**": entry.mode } : {}), ...entry.places };
      expect(resolvePlace(map, "path", `${ROOT}/packages`, options)?.decision, tool).toBe("allow");
      expect(resolvePlace(map, "path", `${ROOT}/.env`, options)?.decision, tool).toBe("ask");
    }
  });

  /**
   * `.jaira/` is a DEFAULT, not a rule (2026-11-17): "if we want an agent to modify the jaira files, that
   * should be a permission layer". Nothing in the code refuses it; every line that can write does, at the
   * project's and the worktree's — the folder itself (a bare path, deeper than `$PROJECT`) and every file
   * in it (`/**​/*`, a FILE pattern with a literal prefix, which outranks `**​/.env.*` so that
   * `.jaira/.env.local` is refused rather than asked about). The key that signs this machine's approvals
   * is refused to the readers too: the one part of `.jaira/` no agent reads.
   */
  describe("the .jaira/ lines", () => {
    const WRITERS = ["write_file", "edit", "shell", "script", "runner:*"];
    const KEY = "C:/Users/me/.jaira/system/machine.key";
    const REFUSED = [
      `${ROOT}/.jaira`,
      `${ROOT}/.jaira/settings.json`,
      `${ROOT}/.jaira/workflows/feature/plan.json`,
      `${ROOT}/.jaira/.env.local`,
      `${ROOT}/.jaira/certs/server.pem`,
      "C:/work/app-wt/.jaira",
      "C:/work/app-wt/.jaira/setup.json",
      KEY,
    ];

    it.each(["read-only", "read-only-scratch", "ask-first", "auto", "full"])("%s refuses every writer the project's and the worktree's .jaira/, and the machine key", (file) => {
      for (const tool of WRITERS) for (const path of REFUSED) expect(at(file, tool, path), `${file} ${tool} ${path}`).toBe("deny");
    });

    it("refuses nothing beside them: a name that only starts like it, and the worktrees' own folder, answer as before", () => {
      for (const tool of WRITERS) {
        const own = at("full", tool, `${ROOT}/src/index.ts`);
        expect(own, tool).toBe("allow");
        for (const path of [`${ROOT}/.jaira-notes/x.md`, `${ROOT}/docs/.jaira.md`, "C:/work/.jaira-worktrees/app/t-1/src/x.ts", "C:/Users/me/.jaira/settings.json"]) {
          expect(at("full", tool, path), `${tool} ${path}`).toBe("allow");
        }
      }
    });

    it.each([
      ["read-only", "allow"],
      ["ask-first", "ask"],
      ["auto", SMART_MODE],
      ["full", "allow"],
    ] as const)("%s reads, globs and greps .jaira/ as any of the project — but never the machine key", (file, mode) => {
      for (const tool of ["read_file", "glob", "grep"]) {
        expect(at(file, tool, `${ROOT}/.jaira/settings.json`), `${file} ${tool}`).toEqual(mode);
        expect(at(file, tool, `${ROOT}/.jaira/system/logs/run.log`), `${file} ${tool}`).toEqual(mode);
        expect(at(file, tool, KEY), `${file} ${tool}`).toBe("deny");
      }
    });

    it("is a line like any other: a layer above opens what it names, and the rest stays shut", () => {
      const over = (layer: Record<string, unknown>) => {
        const entry = composePermissionSetLayers([
          { id: "full", decl: shipped("full") as Record<string, unknown> },
          { id: "project", decl: layer },
        ]).permissionSet.entries["write_file"]!;
        const map = { ...(entry.mode !== undefined ? { "**": entry.mode } : {}), ...entry.places };
        return (path: string) => resolvePlace(map, "path", path, options)?.decision;
      };
      // A file pattern under it outranks the line's own (more literal segments)…
      const workflows = over({ write_file: { "$PROJECT/.jaira/workflows/**/*": "allow" } });
      expect(workflows(`${ROOT}/.jaira/workflows/plan.json`)).toBe("allow");
      expect(workflows(`${ROOT}/.jaira/settings.json`)).toBe("deny");
      // …a FOLDER does not: a file pattern beats every folder that holds the file (decision 0023 ruling 3).
      expect(over({ write_file: { "$PROJECT/.jaira/workflows": "allow" } })(`${ROOT}/.jaira/workflows/plan.json`)).toBe("deny");
      // The same places, said again, replace them.
      const reopened = over({ write_file: { "$PROJECT/.jaira": "allow", "$PROJECT/.jaira/**/*": "allow" } });
      expect(reopened(`${ROOT}/.jaira/settings.json`)).toBe("allow");
      // A plain decision covers everywhere and clears the places below it — the person's own choice.
      expect(over({ write_file: "allow" })(`${ROOT}/.jaira/settings.json`)).toBe("allow");
    });
  });

  it("auto judges a push with smart, and asks before pushing main, master or a release branch", () => {
    const { permissionSet } = parsePermissionSet(shipped("auto"));
    const push = permissionSet.entries["git_push"]!;
    expect(push.mode).toEqual(SMART_MODE);
    const map = { "**": push.mode!, ...push.places };
    for (const branch of ["main", "origin:main", "master", "release/1.2"]) expect(resolvePlace(map, "branch", branch, {})?.decision, branch).toBe("ask");
    expect(resolvePlace(map, "branch", "claude/fix-1", {})?.decision).toEqual(SMART_MODE);
  });
});
