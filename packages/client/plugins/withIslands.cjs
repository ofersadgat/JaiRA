/**
 * Bundle the island pages into the app (decision 0015, S5): `dist-island/<component>/` becomes
 * `android/app/src/main/assets/island/<component>/` (read at `file:///android_asset/island/…`) and a
 * folder reference `island` in the iOS app bundle (read under `Paths.bundle`). Build them first:
 * `npm --workspace @jaira/client run build:island`.
 */
const { withDangerousMod, withXcodeProject } = require("expo/config-plugins");
const { cpSync, existsSync, mkdirSync, rmSync } = require("node:fs");
const { join } = require("node:path");

function source(projectRoot) {
  const dir = join(projectRoot, "dist-island");
  if (!existsSync(join(dir, "markdown", "index.html"))) {
    throw new Error("the island pages are not built: npm --workspace @jaira/client run build:island");
  }
  return dir;
}

function withAndroidIslands(config) {
  return withDangerousMod(config, [
    "android",
    (c) => {
      const target = join(c.modRequest.platformProjectRoot, "app", "src", "main", "assets", "island");
      rmSync(target, { recursive: true, force: true });
      mkdirSync(target, { recursive: true });
      cpSync(source(c.modRequest.projectRoot), target, { recursive: true });
      return c;
    },
  ]);
}

function withIosIslands(config) {
  const copied = withDangerousMod(config, [
    "ios",
    (c) => {
      const target = join(c.modRequest.platformProjectRoot, "island");
      rmSync(target, { recursive: true, force: true });
      cpSync(source(c.modRequest.projectRoot), target, { recursive: true });
      return c;
    },
  ]);
  return withXcodeProject(copied, (c) => {
    const project = c.modResults;
    const group = project.getFirstProject().firstProject.mainGroup;
    // A FOLDER reference, so the tree keeps its shape in the bundle (the pages' relative paths).
    if (!project.hasFile("island")) project.addResourceFile("island", { lastKnownFileType: "folder" }, group);
    return c;
  });
}

module.exports = (config) => withIosIslands(withAndroidIslands(config));
