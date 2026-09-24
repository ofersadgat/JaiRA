/**
 * The settings page head — the layer switch at its top-right, the sentence beside it, and on Just you
 * the "What you changed | Every row" choice under it — server-rendered over a real page (Runs) into the
 * catalog mockups of `ui/components/settings-header`.
 *
 * `npx tsx --tsconfig packages/app/tsconfig.json packages/app/shots/settings-header-static.mts [<dir>]`
 *
 * With no `<dir>` it rewrites `docs/ui/assets/settings-header/*.html`. The head is `SettingsPage`, the
 * switch `LayerPicker` over `settingsLayersFor`, and the page `RunsPane` under the same two contexts
 * `App.tsx` provides; only the sentence is spelled here, because `settingsLeadOf` is App's own.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createElement, Fragment, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mergeConfigLayers, parseConfig, type ConfigLayer, type ConfigView } from "@jaira/shared";
import { SettingsLayerContext, SettingsRowsContext } from "../src/renderer/controls";
import { LayerPicker } from "../src/renderer/panes";
import { RunsPane } from "../src/renderer/settingsPages";
import { Segmented, SettingsPage } from "../src/renderer/settingsLayout";
import { SECTIONS, settingsLayersFor } from "../src/renderer/settingsSections";

const REPO = join(import.meta.dirname, "..", "..", "..");
const outDir = process.argv[2] ?? join(REPO, "docs", "ui", "assets", "settings-header");
const DOC = "ui/components/settings-header";

/** Shared asks below 0.8, the project runs in WSL, and Just you asks below 0.95. */
const SHARED = { autopilot: { askBelow: 0.8 } };
const PROJECT = { execEnvironment: { wsl: "Ubuntu" } };
const YOU = { autopilot: { askBelow: 0.95 } };

const viewOf = (project: boolean, you: Record<string, unknown> | null): ConfigView => ({
  base: SHARED,
  project: project ? PROJECT : null,
  system: null,
  you: you as never,
  effective: parseConfig(mergeConfigLayers([SHARED, project ? PROJECT : null, you].filter((doc) => doc !== null)) ?? {}) as never,
  baseFile: "~/.jaira/settings.json",
  projectFile: project ? "notes-api/.jaira/settings.json" : "",
  youFile: "~/.jaira/personal-settings.json",
  baseDir: "~/.jaira",
});

/** `settingsLeadOf` in `App.tsx`, for Runs. */
function leadOf(layer: ConfigLayer): ReactNode {
  const purpose = SECTIONS.find((s) => s.id === "runs")!.purpose;
  const b = (text: string): ReactNode => createElement("b", null, text);
  if (layer === "you") return createElement(Fragment, null, `${purpose} Showing `, b("Just you"), ": kept on this machine in ", b("personal-settings.json"), ", never shared, and read after every other layer.");
  if (layer === "project") return createElement(Fragment, null, `${purpose} Editing `, b("notes-api"), "; anything left unset comes from ", b("~/.jaira"), ", and yours override both.");
  return createElement(Fragment, null, `${purpose} Editing `, b("~/.jaira"), ", shared by every project on this machine; a project's own settings override it, and yours override both.");
}

interface Stage {
  name: string;
  layer: ConfigLayer;
  project: boolean;
  you: Record<string, unknown> | null;
  busy?: boolean;
  justYou?: "changed" | "every";
}

const STAGES: Stage[] = [
  { name: "layered", layer: "base", project: true, you: YOU },
  { name: "project", layer: "project", project: true, you: YOU },
  { name: "just-you", layer: "you", project: true, you: YOU, justYou: "changed" },
  { name: "nothing-yours", layer: "you", project: true, you: null, justYou: "changed" },
  { name: "no-project", layer: "base", project: false, you: YOU },
  { name: "disabled", layer: "base", project: true, you: YOU, busy: true },
];

function render(stage: Stage): string {
  const view = viewOf(stage.project, stage.you);
  const onlyStated = stage.layer === "you" && stage.justYou === "changed";
  const runs = createElement(RunsPane, { config: view, layer: stage.layer, busy: stage.busy === true, editable: stage.layer !== "project" || stage.project, onSave: () => undefined });
  const page = createElement(
    SettingsPage,
    {
      title: "Runs",
      children: runs,
      lead: leadOf(stage.layer),
      aside: createElement(LayerPicker, { value: stage.layer, layers: settingsLayersFor(stage.project), onChange: () => undefined, disabled: stage.busy === true }),
      onlyStated,
      ...(stage.layer === "you"
        ? {
            under: createElement(Segmented<"changed" | "every">, {
              label: "Which rows",
              value: stage.justYou ?? "changed",
              options: [
                ["What you changed", "changed"],
                ["Every row", "every"],
              ],
              onChange: () => undefined,
            }),
          }
        : {}),
    },
  );
  return renderToStaticMarkup(
    createElement(SettingsRowsContext.Provider, { value: true }, createElement(SettingsLayerContext.Provider, { value: { layer: stage.layer, view, onlyStated } }, page)),
  );
}

const today = new Date().toISOString().slice(0, 10);
mkdirSync(outDir, { recursive: true });
for (const stage of STAGES) {
  writeFileSync(
    join(outDir, `${stage.name}.html`),
    `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="doc" content="${DOC}">\n<meta name="state" content="${stage.name}">\n` +
      `<meta name="captured" content="${today}">\n<meta name="reflects" content="shipped">\n<title>settings-header · ${stage.name}</title>\n` +
      `<link rel="stylesheet" href="../../../../packages/app/src/renderer/styles.css">\n<link rel="stylesheet" href="../mockup.css">\n` +
      `<script>if (location.hash === "#dark") document.documentElement.dataset.theme = "dark";</script>\n</head>\n<body class="mockup">\n` +
      `<p class="mockup-caption">${DOC} · ${stage.name}</p>\n` +
      `<div class="mockup-stage" style="width: 900px; background: var(--bg)">\n<div class="view settings-view"><div class="col mid settings-body">${render(stage)}</div></div>\n</div>\n</body>\n</html>\n`,
    "utf8",
  );
}
console.log(`wrote ${STAGES.length} mockups to ${outDir}`);
