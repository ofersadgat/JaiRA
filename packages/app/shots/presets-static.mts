/**
 * Settings → Executors → Presets, server-rendered to one static page — the real component over the
 * real stylesheet, in each state it can be in, with no Electron in the way.
 *
 * `npx tsx --tsconfig packages/app/tsconfig.json packages/app/shots/presets-static.mts <out.html> [light|dark]`
 * (the flag is what gives tsx the app's JSX transform when run from the repo root). Open it in a
 * Chromium browser, and narrow the window under 720px to see the two rails become two rows of tabs.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PresetTabs, presetTabsOf, type PresetChoice, type PresetTabsProps } from "../src/renderer/presetTabs";

const out = process.argv[2];
if (out === undefined) throw new Error("usage: presets-static.mts <out.html> [light|dark]");

const here = { fast: { temperature: 0.2, maxOutputTokens: 1200 }, review: { reasoning: { effort: "high" }, maxOutputTokens: 4000 } };
const tabs = presetTabsOf(here, { ...here, thorough: { reasoning: { effort: "xhigh" }, providerOptions: { anthropic: { cacheControl: true } } } });

const stage = (caption: string, choice: PresetChoice, extra: Partial<PresetTabsProps> = {}): string =>
  `<p style="margin:26px 0 8px;font:12px sans-serif;color:var(--dim)">${caption}</p>` +
  `<div class="cfg-pane"><section class="cfg-group">` +
  renderToStaticMarkup(
    createElement(PresetTabs, {
      tabs,
      choice,
      onChoice: () => undefined,
      section: "sampling",
      onSection: () => undefined,
      drafts: {},
      onDraft: () => undefined,
      newName: "",
      onNewName: () => undefined,
      locked: false,
      originOf: () => "Shared (all projects)",
      onSave: () => undefined,
      onRemove: () => undefined,
      onOverride: () => undefined,
      onAdd: () => undefined,
      ...extra,
    }),
  ) +
  `</section></div>`;

const css = pathToFileURL(join(import.meta.dirname, "..", "src", "renderer", "styles.css")).href;
writeFileSync(
  out,
  `<!doctype html><html data-theme="${process.argv[3] ?? "light"}"><head><meta charset="utf8"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="${css}"></head>` +
    `<body style="overflow:auto;height:auto"><div class="col mid settings-body" style="max-width:860px;margin:0 auto;padding:16px;background:var(--bg)">` +
    stage("a preset this layer states, untouched", { preset: "fast" }) +
    stage("edited and not saved, on Output limits", { preset: "fast" }, { section: "limits", drafts: { fast: { temperature: 0.2, maxOutputTokens: 800 } } }) +
    stage("an inherited preset, read-only", { preset: "thorough" }, { section: "reasoning" }) +
    stage("+ preset", "new", { newName: "cheap" }) +
    stage("+ preset, a name it has to refuse", "new", { newName: "fast" }) +
    stage("nothing yet", "new", { tabs: [] }) +
    stage("while the layer is being written", { preset: "review" }, { locked: true, section: "reasoning" }) +
    `</div></body></html>`,
);
console.log(`wrote ${out}`);
