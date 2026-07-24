/**
 * CLI test fixtures. The planning workflow and its fake-rule scripts live in
 * @jaira/runtime (shared with the app and usable as a project's starter
 * workflow); this module only adds the temp-project helper.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject } from "@jaira/persistence";
import { specPlanningFiles, writeWorkflowFiles } from "@jaira/runtime";

export { blockedRules, happyRules, HUMAN_REVIEW_FUNCTION, PLAN_ID, specPlanningFiles, writeWorkflowFiles } from "@jaira/runtime";

/** A fresh temp project with `.jaira/` initialized and the planning workflow installed. */
export function makePlanningProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "jaira-test-"));
  const paths = initProject(dir);
  writeWorkflowFiles(paths.workflowsDir, specPlanningFiles());
  return dir;
}
