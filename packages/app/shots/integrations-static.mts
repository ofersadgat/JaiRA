/**
 * Settings → Connections → Forges, server-rendered to one static page — the real component over the real
 * stylesheet, with no Electron and no native module in the way.
 *
 * `npx tsx packages/app/shots/integrations-static.mts <out.html>`. It exists for the case `run.mts`
 * cannot serve: looking at a pane while something else in the checkout needs the Node ABI.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseConfig, type ConfigView, type ForgeCheck } from "@jaira/shared";
import { ForgeRows } from "../src/renderer/integrationsPane";

const out = process.argv[2];
if (out === undefined) throw new Error("usage: integrations-static.mts <out.html>");

const base = { integrations: { forges: { work: { provider: "gitlab", host: "git.example.org", credential: "WORK_TOKEN", enabled: false } } } };
const config: ConfigView = {
  base: base as never,
  project: null,
  effective: parseConfig(base) as never,
  baseFile: "~/.jaira/settings.json",
  projectFile: "",
  baseDir: "~/.jaira",
};

const checks: ForgeCheck[] = [
  { name: "gitlab", provider: "gitlab", host: "gitlab.com", status: "ok", detail: "signed in as @ofer", identity: { login: "ofer" }, credential: { source: "keychain" } },
  {
    name: "github",
    provider: "github",
    host: "github.com",
    status: "failed",
    detail: "the token was refused (401)",
    fix: "replace the token; it needs the `repo` scope to open and read pull requests",
    credential: { source: "project-env-local" },
  },
  { name: "work", provider: "gitlab", host: "git.example.org", status: "disabled", detail: "turned off" },
];

const pane = (theme: string): string =>
  `<div data-theme-frame="${theme}" style="width:812px;margin:24px auto;background:var(--bg);padding:16px">` +
  renderToStaticMarkup(
    createElement(ForgeRows, {
      config,
      layer: "base",
      busy: false,
      editable: true,
      checks,
      secrets: { keychain: true } as never,
      onSave: () => undefined,
      onSaveToken: () => undefined,
      oauth: {
        signingIn: new Set(["github"]),
        pending: new Map([["github", "WDJB-MJHT"]]),
        errors: new Map(),
        viaOAuth: new Set(["gitlab"]),
        onSignIn: () => undefined,
        onCancel: () => undefined,
        onDisconnect: () => undefined,
      },
    }),
  ) +
  "</div>";

const css = pathToFileURL(join(import.meta.dirname, "..", "src", "renderer", "styles.css")).href;
writeFileSync(
  out,
  `<!doctype html><html data-theme="${process.argv[3] ?? "light"}"><head><meta charset="utf8"><link rel="stylesheet" href="${css}"></head>` +
    `<body><div class="col mid settings-body">${pane("page")}</div></body></html>`,
);
console.log(`wrote ${out}`);
