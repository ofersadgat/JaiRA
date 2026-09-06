/**
 * The world the pictures are taken in: a real project on disk, containing nothing the app did not
 * put there itself.
 *
 * This is what replaced `snapshot/specimens.tsx`. That file built a `BoardCard` by hand and framed
 * it in a bordered box, and the answer it gave was about the fixture rather than the app: a card
 * assembled in a source file has never been through the projection, never sat in a pane at the width
 * a pane gives it, and never had a neighbour above it. It also drifted, silently and for a long
 * time — `tsconfig.json` used to carry the confession in a comment, listing numeric instance ids and
 * a `runId` from before runs collapsed into tasks, on props nothing typechecked.
 *
 * So nothing here describes a surface. It makes a PROJECT. Every state worth photographing is then
 * produced by starting a real task in it (`run.mts`), scripted so it costs nothing and reaches no
 * provider, and whatever the app draws for that is by definition what the app draws.
 *
 * ## Thrown away and rebuilt every time
 *
 * A world that accumulates is a world whose pictures depend on how many times you have run this,
 * which is the fixture problem again wearing a different hat. The directory is deleted first, so the
 * only history in it is the history this run created.
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { initProject } from "@jaira/persistence";
import { specPlanningFiles, writeWorkflowFiles } from "@jaira/runtime";

export interface World {
  /** The shared base root — its own, so a run here cannot read or write the author's `~/.jaira`. */
  readonly home: string;
  /** The project the app opens. */
  readonly project: string;
}

/**
 * Build the world under `dir`, replacing whatever was there.
 *
 * The base root is separate from the project for the reason the app separates them: settings and
 * credentials belong to the person, and a photograph session must not inherit — or disturb — the
 * ones the author actually uses. Both live under `dir`, which is a scratch path, so neither does.
 */
export function buildWorld(dir: string): World {
  const home = join(dir, "home");
  const project = join(dir, "project");
  rmSync(dir, { recursive: true, force: true });

  const paths = initProject(project, home);
  // The SPEC planning workflow, which `@jaira/runtime` already keeps for the CLI tests, the app
  // tests and the starter a fresh project is seeded with. A fourth copy authored here would be one
  // more thing to keep true; this one is kept true by three other callers.
  writeWorkflowFiles(paths.workflowsDir, specPlanningFiles() as Record<string, unknown>);
  return { home, project };
}

/**
 * Scripted prompt replies that drive the planning workflow to its human gate.
 *
 * The critique returns `blocked`, which is the transition into `feature/plan/critique/human_review`
 * — a `function` operation on `choose_option`. Nothing answers it here on purpose: the app registers
 * every interactive function the bundle names and routes it to the renderer, so an unanswered one
 * PARKS, and a parked gate is the single most valuable thing on this list to have a picture of.
 *
 * `happyRules()` from the same module is the other half — a run that completes — and `run.mts` uses
 * it directly.
 */
export function blockedAtTheGate(): unknown[] {
  return [
    { model: "planner", promptIncludes: "Write the plan", output: { plan_doc: "# The Plan" } },
    { model: "planner", output: { goals: ["a plan that survives contact"] } },
    { model: "critic", output: { outcome: "blocked", weaknesses: [], critique_report: "stuck" } },
  ];
}
