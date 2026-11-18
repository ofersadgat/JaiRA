/**
 * The way from a project to its settings (the person, 2026-09-25): a ⚙ at the right end of the
 * project's row in the sidebar. It opens Settings with that project in Settings' path
 * (`settingsScope.ts`, 2026-11-17), whose crumb wears the project's NAME.
 *
 * What is held here is the path a layer door makes, and the words the crumb and a row's "from …" use.
 * The ⚙ on the row and the crumb's look are the universal tree's to draw.
 */
import { describe, expect, it } from "vitest";
import type { ProjectSummary } from "@jaira/shared/browser";
import { LAYER_LABELS, sourceWordsOf } from "../src/renderer/layerLabels";
import { crumbsOf, layerOfPath, pathOfLayer, type SettingsPathContext } from "../src/renderer/settingsScope";

const app: ProjectSummary = { project: "/work/app", label: "app", kind: "user" } as ProjectSummary;
const ctx: SettingsPathContext = { projects: [app], grouped: true, self: { id: "m1", label: "desk" }, machines: [] };

describe("a project's settings door", () => {
  it("puts the project the shell stands on in the path, named as the window names it", () => {
    const path = pathOfLayer("project", {}, "/work/app");
    expect(path).toEqual({ project: "/work/app" });
    expect(layerOfPath(path)).toBe("project");
    expect(crumbsOf(path, ctx)).toEqual([{ kind: "project", key: "/work/app", label: "app" }]);
  });

  it("has no project to name at the root, and the shared root's door is Shared", () => {
    expect(layerOfPath(pathOfLayer("project", {}, null))).toBe("base");
    expect(pathOfLayer("base", { project: "/work/app", you: true }, "/work/app")).toEqual({});
  });

  it("names the project and the machine where a sentence says where a value comes from", () => {
    expect(sourceWordsOf("project", { project: "app" })).toBe("app");
    expect(sourceWordsOf("projectMachine", { project: "app", machine: "build-01" })).toBe("app on build-01");
    expect(sourceWordsOf("projectYou", { project: "app" })).toBe("you in app");
    expect(sourceWordsOf("project")).toBe("this project");
    expect(sourceWordsOf("base", { project: "app" })).toBe("Shared");
    expect(LAYER_LABELS.machine).toBe("This machine");
  });
});
