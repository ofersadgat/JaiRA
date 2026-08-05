/**
 * The project's live workflows rendered as ONE document a reader can judge.
 *
 * This exists for `jaira workflow check` (DESIGN §11.1's browser, pointed at a
 * different question): a human writes `workflow.md` describing the flow they
 * want, and the check asks a model whether `.jaira/workflows/**` implements it.
 * The model can only be as right as its evidence, so two rules shape what goes in:
 *
 *  - **The authored file, verbatim.** Not a summary of it. A summariser between
 *    the files and the judge would decide, silently, which half of a state
 *    matters — and the half it dropped is exactly where a conformance gap hides.
 *    Comments in a jsonc state file are authorial intent, so the file's TEXT is
 *    used where there is one, and the loaded `source` only where there is not
 *    (an out-of-tree state, WORKFLOWS.md §2.1).
 *  - **Plus what the file does not say.** A state's operation kind, model and
 *    function can all come from an ancestor's `environment` (WORKFLOWS.md §5),
 *    and its `children`/`sequence` can be derived from the directory. A judge
 *    reading only the file would call those states empty. The `resolved:` line
 *    is the loaded view, which is what the engine will actually run.
 *
 * Nothing here is truncated silently: a state clipped by `maxStateChars` is named
 * in `truncated`, and the caller says so.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadBundle, type LoadedState, type WorkflowBundle } from "@declarative-ai/hw";
import { isUnder } from "./descriptions";
import type { Project } from "./project";
import { browseWorkflows, readWorkflowsTolerantly } from "./workflows";
import { workflowLoadOptions } from "./workflowRefs";

export interface WorkflowDigestOptions {
  /** Only these workflow roots. Absent ⇒ every root the browser derives. */
  roots?: readonly string[];
  /** Per-state cap on authored text, in characters. Default 6000. */
  maxStateChars?: number;
  /**
   * State ids to render as a CONTRACT rather than in full — the subtrees another description owns.
   *
   * Without this the digest for `feature.md` still contains every line of `feature/plan`'s states,
   * and a model reading it will propose edits inside them however the prompt is worded: what it can
   * see, it will act on. A bounded state is rendered as its interface — label, operation kind,
   * slots, children — plus, where one exists, the prose of the document that DOES describe it.
   *
   * Only the boundary state itself is named here; everything below it follows.
   */
  boundaries?: readonly DigestBoundary[];
}

/** A subtree the digest stops at, and the description that continues it. */
export interface DigestBoundary {
  /** The state id the boundary sits on. */
  stateId: string;
  /** The owning description's path, relative to the layer root — named so the model can cite it. */
  document: string;
  /** That document's text, when it could be read. The best available account of what it delegates. */
  text?: string;
}

export interface WorkflowDigest {
  /** The document itself. */
  markdown: string;
  /** The roots it covers, in the order they appear. */
  roots: string[];
  /** How many distinct states it describes. */
  states: number;
  /**
   * The PROJECT-layer state files behind those roots, relative to `.jaira/workflows/`.
   *
   * The same keys {@link stateHashes} produces, so a caller can take a baseline over exactly what
   * the digest was built from. Base-layer states are excluded for the reason the baseline excludes
   * them: a machine-wide edit must not read as drift in every project on the machine.
   */
  files: string[];
  /** Files that would not parse — the digest is incomplete while these exist. */
  unreadable: Array<{ file: string; error: string }>;
  /** Roots whose closure could not be loaded (a dangling child reference, usually). */
  loadErrors: Array<{ rootId: string; error: string }>;
  /** States whose authored text was clipped by `maxStateChars`. */
  truncated: string[];
  /** The boundaries actually reached, so the caller can say which subtrees it did not judge. */
  bounded: string[];
}

const DEFAULT_MAX_STATE_CHARS = 6000;

/** How to read what follows — addressed to the model that will judge it. */
const HEADER = `# Implemented workflows

Each section below is one workflow: a root state plus every state it reaches.
For each state there are two blocks.

- \`resolved:\` — what the engine will actually run, after \`environment\`
  inheritance and directory-derived defaults are applied.
- \`authored:\` — the state file exactly as it is written on disk.

How to read a state:

- \`operation.kind: "prompt"\` — one structured call to a model.
- \`operation.kind: "function"\` — everything else: host code, a human gate
  rendered in the app, a delegated coding agent (\`claude-cli\`, \`codex-cli\`, a
  configured generic CLI), or a sub-workflow. WHICH of those it is is decided by
  the registered function named in \`function\` / \`functionRef\`, not by the
  document.
- no \`operation\` — the state only groups its children.
- \`children\` + \`sequence\` — the order the cursor advances through children. A
  child whose inputs read a sibling's outputs waits for that sibling, so the real
  order is dataflow; two children with no dependency between them run at the same
  time.
- \`transitions\` — branching and loops. \`to\` names where control goes
  (\`terminate.success\` ends the state), \`when\` is the guard expression.
  \`limits.max_iterations\` caps a loop.
- \`inputs\` / \`outputs\` — the state's declared slots. A binding like
  \`.children.critique.outputs.outcome\` is where a value comes from.

Some states are marked **described elsewhere**. Another document is the account of
how those work inside, and you are not reading it. For such a state you are given
its CONTRACT — what it is called, what it runs, what it takes and returns, and the
prose of the document that owns it — and nothing below it. Judge the description
in front of you against that contract only: whether it says the right thing about
what this state is FOR and how it fits with its siblings. Do not report a gap
inside one, and do not propose a change to one or to anything beneath it. If the
gap you find is genuinely inside such a subtree, say so as a note naming the
document that owns it.
`;

/**
 * Render the project's workflows.
 *
 * Read-only, and tolerant in the same way the browser is: a file that will not
 * parse is reported rather than thrown, because the caller has to be able to tell
 * the user WHICH file to fix.
 */
export function workflowDigest(project: Project, options: WorkflowDigestOptions = {}): WorkflowDigest {
  const browser = browseWorkflows(project);
  const known = new Set(browser.workflows.map((w) => w.rootId));
  for (const root of options.roots ?? []) {
    if (!known.has(root)) {
      throw new Error(
        `unknown workflow '${root}'` +
          (known.size > 0 ? ` — this project has: ${[...known].join(", ")}` : " — this project has no workflows"),
      );
    }
  }
  const wanted =
    options.roots === undefined ? browser.workflows : browser.workflows.filter((w) => options.roots!.includes(w.rootId));

  const { files } = readWorkflowsTolerantly(project.paths.workflowsDir);
  const fileOf = new Map(
    browser.files.filter((f) => f.error === undefined).map((f) => [f.stateId, f.file] as const),
  );
  // Project-layer only, and keyed by state id: which FILE a state resolved from decides what the
  // baseline covers, and a state the base root supplied has no project file to hash.
  const projectFileOf = new Map(
    browser.files
      .filter((f) => f.error === undefined && f.layer === "project")
      .map((f) => [f.stateId, f.file] as const),
  );
  const maxChars = options.maxStateChars ?? DEFAULT_MAX_STATE_CHARS;

  const roots: string[] = [];
  const loadErrors: Array<{ rootId: string; error: string }> = [];
  const truncated: string[] = [];
  const covered = new Set<string>();
  const sections: string[] = [];

  const boundaryOf = new Map((options.boundaries ?? []).map((b) => [b.stateId, b] as const));
  const bounded = new Set<string>();
  /**
   * True for a state BELOW a boundary — rendered not at all.
   *
   * The boundary state itself is still rendered, as its contract: a parent has to be able to say
   * what it delegated to, and a subtree that vanished entirely would read as a workflow with a
   * missing step rather than one described elsewhere.
   */
  const isBelowBoundary = (id: string): boolean => {
    for (const stateId of boundaryOf.keys()) {
      if (id !== stateId && isUnder(id, stateId)) return true;
    }
    return false;
  };

  for (const entry of wanted) {
    if (entry.loadError !== undefined) {
      loadErrors.push({ rootId: entry.rootId, error: entry.loadError });
      continue;
    }
    let bundle: WorkflowBundle;
    try {
      bundle = loadBundle(
        files,
        entry.rootId,
        workflowLoadOptions(project.paths, { path: project.config.workflows.path }),
      );
    } catch (e) {
      loadErrors.push({ rootId: entry.rootId, error: (e as Error).message });
      continue;
    }
    roots.push(entry.rootId);
    const stateIds = Object.keys(bundle.states)
      .filter((id) => !isBelowBoundary(id))
      .sort();
    for (const id of stateIds) covered.add(id);
    const lines: string[] = [
      `## Workflow \`${entry.rootId}\`${entry.label !== undefined ? ` — ${entry.label}` : ""}`,
      "",
      `states: ${stateIds.join(", ")}`,
      "",
    ];
    for (const id of stateIds) {
      const state = bundle.states[id]!;
      const boundary = boundaryOf.get(id);
      if (boundary !== undefined) {
        bounded.add(id);
        lines.push(...contractLines(id, state, boundary, maxChars));
        continue;
      }
      const file = fileOf.get(id);
      const authored = authoredText(project.paths.workflowsDir, file, bundle.source?.[id]);
      const clipped = authored.text.length > maxChars;
      if (clipped) truncated.push(id);
      lines.push(
        `### State \`${id}\`${labelOfState(state) !== undefined ? ` — ${labelOfState(state)}` : ""}`,
        "",
        `resolved: ${resolvedLine(state)}`,
        "",
        `authored${file !== undefined ? ` (${file})` : " (resolved from outside the project)"}:`,
        "",
        "```" + authored.language,
        clipped ? `${authored.text.slice(0, maxChars)}\n… clipped: this state is longer than the digest shows` : authored.text,
        "```",
        "",
      );
    }
    sections.push(lines.join("\n"));
  }

  return {
    markdown: [HEADER, ...sections].join("\n"),
    roots,
    states: covered.size,
    files: [...covered]
      // A boundary state is described elsewhere, so it is not this digest's to hash either: the
      // baseline has to cover exactly what was judged, or accepting a sync would claim agreement
      // about a file this run only saw the outside of.
      .filter((id) => !bounded.has(id))
      .flatMap((id) => {
        const file = projectFileOf.get(id);
        return file === undefined ? [] : [file];
      })
      .sort(),
    bounded: [...bounded].sort(),
    unreadable: browser.files
      .filter((f) => f.error !== undefined)
      .map((f) => ({ file: f.file, error: f.error! })),
    loadErrors,
    truncated,
  };
}

function labelOfState(state: LoadedState): string | undefined {
  return typeof state.label === "string" ? state.label : undefined;
}

/**
 * A delegated state, as its CONTRACT.
 *
 * Deliberately not the authored file. The authored file is the account of how the state works
 * inside, and the whole point of a boundary is that another document is responsible for that — a
 * digest that showed it anyway would be inviting exactly the edits the boundary exists to prevent.
 *
 * What is shown instead is what a sibling actually needs: the resolved line (is this a prompt, an
 * agent, a gate?), the declared slots (what it takes and returns), and the owning document's PROSE.
 * That last one is the interesting choice — the best available statement of what a subtree is for
 * is the description somebody wrote of it, not a rendering of its states. Prose delegates to prose,
 * and a parent stays a document about contracts rather than a second copy of its children.
 */
function contractLines(id: string, state: LoadedState, boundary: DigestBoundary, maxChars: number): string[] {
  const label = labelOfState(state);
  const slots = (which: "inputs" | "outputs"): string => {
    const declared = state[which];
    if (declared === undefined || declared === null || typeof declared !== "object") return "none declared";
    const names = Object.keys(declared as Record<string, unknown>);
    return names.length === 0 ? "none declared" : names.join(", ");
  };
  const lines = [
    `### State \`${id}\`${label !== undefined ? ` — ${label}` : ""} — described elsewhere`,
    "",
    `resolved: ${resolvedLine(state)}`,
    "",
    `inputs: ${slots("inputs")}`,
    `outputs: ${slots("outputs")}`,
    "",
    `How this state works inside is described by \`${boundary.document}\`, not here. Its states are` +
      ` not shown, and neither this state nor anything below it is yours to change.`,
    "",
  ];
  if (boundary.text !== undefined && boundary.text.trim() !== "") {
    const clipped = boundary.text.length > maxChars;
    lines.push(
      `What \`${boundary.document}\` says it does:`,
      "",
      "```markdown",
      clipped
        ? `${boundary.text.slice(0, maxChars)}\n… clipped: that document is longer than this digest shows`
        : boundary.text.trimEnd(),
      "```",
      "",
    );
  }
  return lines;
}

/**
 * The one line the authored file cannot supply: the operation as MERGED, and the
 * child order as DERIVED. A state that inherits `kind: "function", function:
 * "claude-cli"` from its mount says nothing about agents in its own file.
 */
function resolvedLine(state: LoadedState): string {
  const parts: string[] = [];
  const op = state.operation;
  if (state.operationError !== undefined) {
    parts.push(`operation could not be built (${state.operationError})`);
  } else if (op === undefined) {
    parts.push("composite (no operation of its own)");
  } else if (op.kind === "prompt") {
    const config = op.config !== null && typeof op.config === "object" && !Array.isArray(op.config) ? op.config : {};
    parts.push(`prompt${typeof config.model === "string" ? ` on model '${config.model}'` : ""}`);
  } else {
    parts.push(`function '${op.functionRef}'`);
  }
  const sequence = state.sequence ?? [];
  const children = state.children ?? {};
  const mount = (key: string, state: string | undefined): string => `${key} [${state ?? "?"}]`;
  if (sequence.length > 0) {
    parts.push(`children in order: ${sequence.map((key) => mount(key, children[key]?.state)).join(" → ")}`);
  } else if (Object.keys(children).length > 0) {
    // `sequence: []` is authored to mean "only a transition enters these" (WORKFLOWS.md §6) —
    // a real claim about control flow, not an absence.
    parts.push(
      `children entered only by a transition: ${Object.entries(children)
        .map(([key, child]) => mount(key, child.state))
        .join(", ")}`,
    );
  }
  for (const [key, child] of Object.entries(children)) {
    if (child.async === true) parts.push(`child '${key}' runs asynchronously`);
    if (child.environment !== undefined) {
      parts.push(`child '${key}' is mounted with its own environment: ${JSON.stringify(child.environment)}`);
    }
  }
  if ((state.transitions ?? []).length > 0) parts.push(`${state.transitions!.length} transition(s)`);
  if (state.scopeSession !== undefined) parts.push(`session scope: ${JSON.stringify(state.scopeSession)}`);
  return parts.join(" · ");
}

/**
 * The file as written, or the authored state re-serialized when there is no file
 * to read (an out-of-tree reference, or one the browser could not map back).
 */
function authoredText(
  workflowsDir: string,
  file: string | undefined,
  source: unknown,
): { text: string; language: string } {
  if (file !== undefined) {
    try {
      return {
        text: readFileSync(join(workflowsDir, ...file.split("/")), "utf8").trimEnd(),
        language: /\.ya?ml$/i.test(file) ? "yaml" : "json",
      };
    } catch {
      // Deleted between the browse and now — fall through to the loaded copy.
    }
  }
  return { text: JSON.stringify(source ?? {}, null, 2), language: "json" };
}
