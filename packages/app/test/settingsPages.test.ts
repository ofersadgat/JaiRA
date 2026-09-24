/**
 * The reorganised Settings pages (the person's rulings, 2026-09-23), rendered on the server:
 *
 *  1. Tools → Functions is the permission sets keyed by the FUNCTION — one row per tool, one column per
 *     set, the mode in each cell, a dash where a set does not offer it — with a set's commands as rows
 *     under `bash`, and `smart`'s users being the sets that hand calls to it.
 *  2. Connections → Forges draws who a connection acts as as a box — tagged OAuth or token — and the +
 *     box offers the forge's own sign-in with a pasted token under it; while a sign-in waits, the box
 *     shows the code to type.
 *  3. Connections → Local models marks the server the route points at "in use", offers every other
 *     one that answered, and draws each weights file's state.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { parseConfig, type ConfigView, type ForgeCheck, type PermissionSetsView } from "@jaira/shared";
import { FunctionsSections } from "../src/renderer/functionsPane";
import { ForgeRows } from "../src/renderer/integrationsPane";
import { LocalServers, WeightsRows } from "../src/renderer/providersPane";

const text = (html: string): string => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

const config = (doc: Record<string, unknown>): ConfigView => ({
  base: doc as never,
  project: null,
  system: null,
  you: null,
  effective: parseConfig(doc) as never,
  baseFile: "~/.jaira/settings.json",
  projectFile: "",
  youFile: "~/.jaira/personal-settings.json",
  baseDir: "~/.jaira",
});

const view = (sets: Record<string, Record<string, unknown>>): PermissionSetsView => ({
  records: Object.entries(sets).map(([id, decl]) => ({
    id,
    bucket: id.split("/")[0]!,
    name: id.split("/")[1]!,
    files: [{ layer: "system", file: `builtin/${id}.json`, format: "json", decl: decl as never }],
  })),
  usedBy: {},
  tools: [],
  layers: ["base", "system"],
});

describe("Tools → Functions", () => {
  const data = view({
    "chat/ask-first": { read_file: "ask", bash: "ask", other: "ask" },
    "chat/auto": { read_file: { function: "smart" }, bash: { function: "smart" }, other: { function: "smart" } },
    "chat/read-only": { read_file: "allow", bash: "deny", "git status": "allow", other: "deny" },
  });
  const render = (open?: string): string =>
    renderToStaticMarkup(
      createElement(FunctionsSections, {
        data,
        layer: "base",
        config: config({}),
        busy: false,
        onSave: () => undefined,
        agents: ["claude-cli"],
        rules: ["everything", "-claude-cli"],
        onRules: () => undefined,
        onOpenSet: () => undefined,
      }),
    ) + (open ?? "");

  it("draws one row per function and one column per set, with each set's mode in the cell", () => {
    const html = render();
    const readRow = html.slice(html.indexOf(">read_file<"), html.indexOf("</tr>", html.indexOf(">read_file<")));
    expect(text(readRow)).toContain("ask ☆ smart allow");
    // a set that does not offer a tool draws a dash, not a mode
    const fetchRow = html.slice(html.indexOf(">web_fetch<"), html.indexOf("</tr>", html.indexOf(">web_fetch<")));
    expect((fetchRow.match(/fx-cell none/g) ?? []).length).toBe(3);
  });

  it("lists a set's commands as rows under bash", () => {
    const html = render();
    const at = html.indexOf(">git status<");
    expect(at).toBeGreaterThan(html.indexOf(">bash<"));
    expect(text(html.slice(at, html.indexOf("</tr>", at)))).toContain("— — allow");
  });

  it("says which functions a run may reach from the default executor's rules", () => {
    const html = render();
    const agent = html.slice(html.indexOf(">claude-cli<"), html.indexOf("</li>", html.indexOf(">claude-cli<")));
    expect(agent).toContain("not reachable");
    const gate = html.slice(html.indexOf(">choose_option<"), html.indexOf("</li>", html.indexOf(">choose_option<")));
    expect(gate).toContain("available");
  });
});

describe("Connections → Forges", () => {
  const forges = config({});
  const checks: ForgeCheck[] = [
    { name: "gitlab", provider: "gitlab", host: "gitlab.com", status: "ok", detail: "signed in as @ofer", identity: { login: "ofer" }, credential: { source: "keychain" }, via: "oauth" },
    { name: "github", provider: "github", host: "github.com", status: "unconfigured", detail: "no token stored under GITHUB_TOKEN" },
  ];
  const render = (oauth: boolean, waiting = false): string =>
    renderToStaticMarkup(
      createElement(ForgeRows, {
        config: forges,
        layer: "base",
        busy: false,
        editable: true,
        checks,
        secrets: { keychain: true } as never,
        onSave: () => undefined,
        onSaveToken: () => undefined,
        ...(oauth
          ? {
              oauth: {
                signingIn: new Set(waiting ? ["github"] : []),
                pending: new Map(waiting ? [["github", "WDJB-MJHT"]] : []),
                errors: new Map(),
                viaOAuth: new Set(["gitlab"]),
                onSignIn: () => undefined,
                onCancel: () => undefined,
                onDisconnect: () => undefined,
              },
            }
          : {}),
      }),
    );

  it("draws the account a connection acts as, tagged by how it signed in, and the + box's two ways in", () => {
    const html = text(render(true));
    expect(html).toContain("OAuth ofer");
    expect(html).toContain("Disconnect");
    expect(html).toContain("Sign in with GitHub or paste a token");
  });

  it("shows the code to type while a sign-in waits on the browser", () => {
    expect(text(render(true, true))).toContain("Finish in your browser Enter WDJB-MJHT");
  });

  it("offers a pasted token alone when forge sign-in is not wired", () => {
    const html = text(render(false));
    expect(html).not.toContain("Sign in with");
    expect(html).toContain("Add a token");
  });
});

describe("Connections → Local models", () => {
  it("marks the server the route points at, and offers every other one that answered", () => {
    const html = renderToStaticMarkup(
      createElement(LocalServers, {
        found: [
          { name: "Ollama", baseURL: "http://localhost:11434/v1", up: true, models: ["qwen2.5-coder"], inUse: true },
          { name: "LM Studio", baseURL: "http://localhost:1234/v1", up: true, models: ["phi-4"], inUse: false },
          { name: "vLLM", baseURL: "http://localhost:8000/v1", up: false, models: [], inUse: false },
        ],
        locked: false,
        onUse: () => undefined,
      }),
    );
    const rows = html.split("conn-probe-row").slice(1);
    expect(text(rows[0]!)).toContain("in use");
    expect(text(rows[1]!)).toContain("Use");
    expect(text(rows[2]!)).toContain("not running");
  });

  it("draws each weights file as found or missing", () => {
    const html = text(
      renderToStaticMarkup(
        createElement(WeightsRows, {
          weights: { "qwen2.5-7b": { modelPath: "/models/qwen.gguf" }, "phi-4": { modelPath: "/models/phi.gguf" } },
          checks: [
            { id: "qwen2.5-7b", modelPath: "/models/qwen.gguf", exists: true, sizeBytes: 4_700_000_000 },
            { id: "phi-4", modelPath: "/models/phi.gguf", exists: false, error: "file missing" },
          ],
          locked: false,
          onChange: () => undefined,
        }),
      ),
    );
    expect(html).toContain("found · 4.7 GB");
    expect(html).toContain("file missing");
  });
});
