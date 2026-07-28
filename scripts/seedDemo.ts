/**
 * Seed a throwaway project for manual/screenshot verification: the starter planning
 * workflow, a couple of tasks with run history, and a deliberately broken state file
 * so the workflow browser's lint surface has something to show.
 *
 * Usage: npx tsx scripts/seedDemo.mjs <dir>
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
const dir = process.argv[2];
if (!dir) {
  console.error("usage: node scripts/seedDemo.mjs <dir>");
  process.exit(2);
}

const { initProject, openProject } = await import("../packages/persistence/src/index.ts");
const { specPlanningFiles, writeWorkflowFiles, happyRules, HUMAN_REVIEW_FUNCTION } = await import(
  "../packages/runtime/src/index.ts"
);
const { AppService } = await import("../packages/app/src/main/service.ts");

const paths = initProject(dir);
writeWorkflowFiles(paths.workflowsDir, specPlanningFiles());
// A state file that will not parse: the browser must show it, not fall over.
writeFileSync(join(paths.workflowsDir, "scratch.json"), "{ half-written", "utf8");

const service = new AppService({ publish: () => {} });
await service.open(dir);

for (const title of ["Plan the widget", "Plan the gadget"]) {
  const { taskId } = service.createTask({ title, workflow: "feature/plan", inputs: { issue: `${title} issue` } });
  await service.startTask({
    taskId,
    fake: happyRules(),
    interactions: { [HUMAN_REVIEW_FUNCTION]: [{ decision: "approve" }] },
  });
}
// Let the runs settle before closing.
await new Promise((r) => setTimeout(r, 1500));
await service.close();

const project = openProject(dir);
console.log(
  "seeded:",
  project.runtime.list().map((t) => `${t.taskId}=${t.status}`).join(" "),
);
project.close();
