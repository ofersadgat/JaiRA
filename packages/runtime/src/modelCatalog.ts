/**
 * The model catalog, kept current by this machine (decision 0009).
 *
 * Two halves. {@link catalogSources} decides WHAT to ask on this machine — every route this
 * configuration can reach, each as a source with a fingerprint of the inputs its answer depends on.
 * {@link CatalogRefresher} decides WHEN: a source runs again when its fingerprint changed (a key was
 * set, an agent was updated or signed in as someone else, a local server moved), when its last answer
 * is a day old, or when a person asked for a re-check — and whatever changed is saved for the next
 * start.
 *
 * Asking is cheap and spends nothing: two HTTP GETs, a `claude` started only to answer `initialize`,
 * `codex app-server` asked for `model/list`, a local server's `/models`, a GGUF's header.
 */
import { claudeModelsSource, codexModelsSource } from "@declarative-ai/agents-cli";
import {
  acceptanceOf,
  canonicalIdFor,
  catalogRowForGguf,
  deriveIdentity,
  makeAnthropicModelsSource,
  makeOpenRouterSources,
  ModelInfo,
  REASONING_EFFORTS,
  refreshModelCatalog,
  type CatalogSource,
  type FetchText,
  type ModelInfoInterface,
  type RefreshReport,
} from "@declarative-ai/llm";
import type { JsonValue } from "@declarative-ai/json";
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import type {
  CatalogModelView,
  CatalogSourceView,
  CatalogStatusView,
  JairaAgentConfig,
  JairaModelConfig,
  ModelParametersView,
  ProbeResult,
} from "@jaira/shared";
import type { SecretResolver } from "./secrets";
import { sdkClaudeBinary } from "./limitsRefresh";
import { levelsSummary } from "./modelLevels";
import { modelRouterOptions } from "./modelRoutes";

/** A source, and what its answer depends on — a changed fingerprint is a reason to ask again. */
export interface PlannedSource {
  source: CatalogSource;
  fingerprint: string;
}

export interface CatalogInputs {
  models?: JairaModelConfig;
  agents?: JairaAgentConfig;
  secrets?: SecretResolver;
  /** The last executor check: an agent is asked only once it answered, and its version and sign-in
   *  are what its answer depends on. */
  executors: readonly ProbeResult[];
}

export interface CatalogSourceDeps {
  fetchText?: FetchText;
  /** The SDK's bundled claude, which the `claude-code` route runs. Default {@link sdkClaudeBinary}. */
  sdkClaude?: () => string | undefined;
}

/** A file's size and modification time, or `missing` — what tells a weights file arrived or changed. */
function fileMark(path: string): string {
  try {
    const stat = statSync(path);
    return `${stat.size}:${Math.round(stat.mtimeMs)}`;
  } catch {
    return "missing";
  }
}

/** A value's fingerprint, never the value — a key must not end up in a comparison string. */
function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/** `fetch` as the catalog sources want it: the body, or an error naming the status. */
export const fetchCatalogText: FetchText = async (url, init) => {
  const res = await fetch(url, { headers: { "user-agent": "JaiRA model catalog", ...init?.headers } });
  if (!res.ok) throw new Error(`${url} answered HTTP ${res.status}`);
  return res.text();
};

/**
 * Every route this configuration can reach, as sources in the order they MERGE — a later source's
 * fields win where two state one (decision 0009 §3):
 *
 *  1. OpenRouter, and its mirrors of the native routes (which only fill, never overwrite);
 *  2. Anthropic's `/v1/models`, when the anthropic route has a key;
 *  3. each agent a check found working — `claude-cli` asks the configured binary, `claude-code` the SDK's
 *     bundled one, `codex-cli` its own;
 *  4. the `local` server's `/models`, and the `embedded` route's GGUF headers.
 */
export function catalogSources(inputs: CatalogInputs, deps: CatalogSourceDeps = {}): PlannedSource[] {
  const fetchText = deps.fetchText ?? fetchCatalogText;
  const routes = inputs.models?.routes ?? {};
  const out: PlannedSource[] = makeOpenRouterSources(fetchText).map((source) => ({ source, fingerprint: "openrouter" }));

  const anthropicKey = modelRouterOptions(inputs.models, inputs.secrets).anthropicApiKey;
  if (anthropicKey !== undefined) out.push({ source: makeAnthropicModelsSource(fetchText, anthropicKey), fingerprint: digest(anthropicKey) });

  const ok = new Map(inputs.executors.filter((p) => p.status === "ok").map((p) => [p.name, p]));
  const agentPrint = (probe: ProbeResult, command: string): string =>
    digest(JSON.stringify([command, probe.version ?? "", (probe.accounts ?? []).map((a) => [a.label, a.active])]));
  const claudeCli = ok.get("claude-cli");
  if (claudeCli !== undefined) {
    const command = inputs.agents?.claudeCli?.command ?? "claude";
    out.push({ source: claudeModelsSource({ command, route: "claude-cli" }), fingerprint: agentPrint(claudeCli, command) });
  }
  const claudeCode = ok.get("claude-code");
  const bundled = (deps.sdkClaude ?? sdkClaudeBinary)();
  if (claudeCode !== undefined && bundled !== undefined) {
    out.push({ source: claudeModelsSource({ command: bundled, route: "claude-code" }), fingerprint: agentPrint(claudeCode, bundled) });
  }
  const codex = ok.get("codex-cli");
  if (codex !== undefined) {
    const command = inputs.agents?.codex?.command ?? "codex";
    out.push({ source: codexModelsSource({ command, route: "codex-cli" }), fingerprint: agentPrint(codex, command) });
  }

  const local = routes["local"];
  if (local !== undefined && local.enabled !== false && local.baseURL !== undefined) {
    out.push({ source: localModelsSource(local.baseURL, fetchText, local.headers), fingerprint: digest(local.baseURL) });
  }
  const weights = routes["embedded"]?.enabled !== false ? routes["embedded"]?.weights : undefined;
  if (weights !== undefined && Object.keys(weights).length > 0) {
    const paths = Object.fromEntries(Object.entries(weights).map(([id, w]) => [id, w.modelPath]));
    // The FILES, not only their paths: weights are put in place by hand (or a download finishing), and a
    // file that arrives or changes at a configured path is an input that changed — so the next pass
    // reads its header rather than waiting out a day, or an hour after the miss it last reported.
    const files = Object.entries(paths).map(([id, path]) => [id, path, fileMark(path)]);
    out.push({ source: embeddedModelsSource(paths), fingerprint: digest(JSON.stringify(files)) });
  }
  return out;
}

/**
 * What a local OpenAI-compatible server serves — `GET {baseURL}/models`, the one call every such server
 * answers (see `localServers.ts`). Its rows are FREE, which is a claim rather than a gap: inference on
 * this machine costs no money. What each model accepts, no such server says, so `parameters` is left
 * unknown and the call sends what it is given.
 */
export function localModelsSource(baseURL: string, fetchText: FetchText = fetchCatalogText, headers?: Record<string, string>): CatalogSource {
  return {
    name: "local-models",
    async fetchRows() {
      const body = JSON.parse(await fetchText(`${baseURL.replace(/\/+$/, "")}/models`, headers !== undefined ? { headers } : undefined)) as { data?: unknown };
      if (!Array.isArray(body.data)) throw new Error(`${baseURL}/models did not answer a model list`);
      return body.data
        .map((m) => (m !== null && typeof m === "object" ? (m as { id?: unknown }).id : undefined))
        .filter((id): id is string => typeof id === "string" && id.length > 0)
        .map((id) => deriveIdentity({ route: "local", model: id, inputPerMillion: 0, outputPerMillion: 0, source: "local-models" }));
    },
  };
}

/**
 * The `embedded` route's models, each read from its own GGUF header (`catalogRowForGguf`): context
 * length, quantization, size — generated from the weights rather than written by hand.
 */
export function embeddedModelsSource(weights: Record<string, string>, readRow: typeof catalogRowForGguf = catalogRowForGguf): CatalogSource {
  return {
    name: "embedded-models",
    async fetchRows() {
      const rows: ModelInfoInterface[] = [];
      for (const [model, source] of Object.entries(weights)) rows.push(deriveIdentity(await readRow({ model, source })));
      return rows;
    },
  };
}

/** Where refreshed rows are kept between starts — the `models` table (`@jaira/persistence`). */
export interface CatalogStore {
  load(): ModelInfoInterface[];
  save(rows: readonly ModelInfoInterface[], at?: number): void;
}

/**
 * Load what earlier refreshes kept over the shipped snapshot — for a process that runs models but
 * does not refresh (the CLI), so it sees the same catalog the app last learned. Returns how many rows.
 */
export function loadCatalogFrom(store: Pick<CatalogStore, "load"> | undefined, table: ModelInfo = ModelInfo.instance): number {
  const rows = store?.load() ?? [];
  table.load(rows);
  return rows.length;
}

/** A day: how old a source's answer may get before it is asked again with nothing else changed. */
export const CATALOG_STALE_MS = 24 * 60 * 60 * 1000;

/** How long a source that FAILED waits before it is asked again — sooner than a day, not every pass. */
export const CATALOG_RETRY_MS = 60 * 60 * 1000;

/**
 * Keeps one catalog table current: loads what was learned before, and refreshes a source when its
 * inputs changed or its answer went stale.
 *
 * One refresh at a time. A request that arrives while one runs is answered by a single follow-up —
 * the same coalescing the availability check uses, for the same reason: it was asked because
 * something changed, and a pass that started before the change cannot answer for it.
 */
/** What one source's last refresh came to — the Catalog section's row. */
export interface CatalogSourceStatus {
  name: string;
  /** When it was last asked (ms), and how long the pass it ran in took. */
  at: number;
  tookMs: number;
  ok: boolean;
  /** Rows it answered, and how many of them changed the table. */
  fetched: number;
  applied: number;
  /** Why it was skipped: the fetch's error, or the validation's problems. */
  error?: string;
  /** The `{route}/{model}` keys it answered with — what its Catalog row lists. A failed source keeps
   *  the ones it answered last time: the table still holds them. */
  models: string[];
}

export class CatalogRefresher {
  private readonly table: ModelInfo;
  private readonly now: () => number;
  private readonly last = new Map<string, { fingerprint: string; at: number; ok: boolean }>();
  private readonly outcomes = new Map<string, CatalogSourceStatus>();

  /** Each source's last outcome, in the order they were last planned — for a person to read. */
  status(): CatalogSourceStatus[] {
    return [...this.outcomes.values()];
  }

  /** Whether a pass is running now. */
  get refreshing(): boolean {
    return this.running !== undefined;
  }
  private running?: Promise<RefreshReport | undefined>;
  private again?: { sources: PlannedSource[]; force: boolean; promise: Promise<RefreshReport | undefined> };

  constructor(
    /** Where rows persist; a getter, so a store that does not exist yet can come into being later. */
    private readonly store: (opts: { create: boolean }) => CatalogStore | undefined,
    opts: { table?: ModelInfo; now?: () => number } = {},
  ) {
    this.table = opts.table ?? ModelInfo.instance;
    this.now = opts.now ?? Date.now;
  }

  /** Load what earlier refreshes learned over the shipped snapshot. Returns how many rows. */
  loadStored(): number {
    return loadCatalogFrom(this.store({ create: false }), this.table);
  }

  /** The sources due now — see the class comment. */
  due(sources: readonly PlannedSource[], force = false): PlannedSource[] {
    const now = this.now();
    return sources.filter(({ source, fingerprint }) => {
      const seen = this.last.get(source.name);
      if (force || seen === undefined || seen.fingerprint !== fingerprint) return true;
      return now - seen.at >= (seen.ok ? CATALOG_STALE_MS : CATALOG_RETRY_MS);
    });
  }

  /** Refresh the sources that are due, merge them in, and save what changed. `undefined` when none was. */
  refresh(sources: PlannedSource[], opts: { force?: boolean } = {}): Promise<RefreshReport | undefined> {
    const force = opts.force === true;
    if (this.running !== undefined) {
      // The follow-up takes the LATEST inputs, and is forced if any request for it was.
      if (this.again !== undefined) {
        this.again.sources = sources;
        this.again.force ||= force;
        return this.again.promise;
      }
      const again = { sources, force, promise: undefined as unknown as Promise<RefreshReport | undefined> };
      again.promise = this.running
        .catch(() => undefined)
        .then(() => {
          this.again = undefined;
          return this.refresh(again.sources, { force: again.force });
        });
      this.again = again;
      return again.promise;
    }
    const run = this.run(sources, force).finally(() => {
      this.running = undefined;
    });
    this.running = run;
    return run;
  }

  private async run(sources: PlannedSource[], force: boolean): Promise<RefreshReport | undefined> {
    const due = this.due(sources, force);
    if (due.length === 0) return undefined;
    const at = this.now();
    // Which keys each source answered with, caught on the way through — the report counts rows, and a
    // person opening a source's row wants to see WHICH models it said.
    const answered = new Map<string, string[]>();
    const watched = due.map(({ source }): CatalogSource => ({
      ...source,
      fetchRows: async () => {
        const rows = await source.fetchRows();
        answered.set(source.name, rows.map((row) => `${row.route}/${row.model}`));
        return rows;
      },
    }));
    // A source that yields one row is a real answer here — a local server serving one model.
    const report = await refreshModelCatalog({ sources: watched, table: this.table, minRows: 1 });
    const tookMs = this.now() - at;
    for (const planned of due) {
      const outcome = report.bySource.find((s) => s.name === planned.source.name);
      const ok = outcome !== undefined && !outcome.skipped;
      this.last.set(planned.source.name, { fingerprint: planned.fingerprint, at, ok });
      const error = outcome?.error ?? (outcome?.skipped === true ? (outcome.problems ?? ["no usable rows"]).join("; ") : undefined);
      this.outcomes.set(planned.source.name, {
        name: planned.source.name,
        at,
        tookMs,
        ok,
        fetched: outcome?.fetched ?? 0,
        applied: outcome?.applied ?? 0,
        ...(error !== undefined ? { error } : {}),
        models: ok ? (answered.get(planned.source.name) ?? []) : (this.outcomes.get(planned.source.name)?.models ?? []),
      });
    }
    if (report.changed.length > 0) this.store({ create: true })?.save(report.changed, at);
    return report;
  }
}

// --- what the renderer is shown ----------------------------------------------------------------

/** A binary's version, as a person reads it: the first `x.y.z` in what `--version` printed. */
export function versionOf(probe: ProbeResult | undefined): string | undefined {
  return probe?.version?.match(/\d+\.\d+\.\d+/)?.[0];
}

/**
 * Where a row's facts come from, for a person — the footer under a level list. A row that describes
 * a model for ANOTHER route (an agent running a model its own list does not carry) names itself.
 */
export function describedFrom(row: ModelInfoInterface, key: string, executors: readonly ProbeResult[]): string {
  if (!key.startsWith(`${row.route}/`)) return `${row.route}/${row.model}`;
  const version = (route: string): string => {
    const v = versionOf(executors.find((p) => p.name === route));
    return v === undefined ? "" : ` ${v}`;
  };
  switch (row.source) {
    case "claude-models":
      return row.route === "claude-code" ? `the SDK's claude${version("claude-code")}` : `claude${version(row.route)}`;
    case "codex-models":
      return `codex${version(row.route)}`;
    case "anthropic-models":
      return "Anthropic's model list";
    case "openrouter-models":
      return "OpenRouter's model list";
    case "local-models":
      return "the local server";
    case "gguf":
      return "the weights file";
    default:
      return "the catalog JaiRA shipped with";
  }
}

/** A model's reasoning as the Thinking chip and the effort fields draw it — everything but how it resolved. */
export function reasoningViewOf(
  key: string,
  executors: readonly ProbeResult[],
  table: ModelInfo = ModelInfo.instance,
): Pick<ModelParametersView, "reasoning" | "levels" | "defaultLevel" | "budget" | "reasoningSchema" | "from"> {
  const schema = table.parameters(key);
  if (schema === undefined) return {};
  const row = table.describedBy(key);
  const gate = acceptanceOf(schema);
  const reasoning = (schema["properties"] as Record<string, JsonValue> | undefined)?.["reasoning"];
  return {
    reasoning: gate.acceptsReasoning,
    ...(gate.efforts !== undefined
      ? {
          levels: gate.efforts.map((level) => {
            const description = gate.effortDescriptions?.[level];
            return { level, ...(description !== undefined ? { description } : {}) };
          }),
        }
      : {}),
    ...(gate.defaultEffort !== undefined ? { defaultLevel: gate.defaultEffort } : {}),
    ...(gate.acceptsBudget === false ? { budget: false as const } : gate.acceptsBudget === true ? { budget: budgetRange(reasoning) } : {}),
    ...(reasoning !== undefined ? { reasoningSchema: reasoning } : {}),
    ...(row !== undefined ? { from: describedFrom(row, key, executors) } : {}),
  };
}

function budgetRange(reasoning: JsonValue | undefined): { minimum?: number; maximum?: number } {
  const properties = (reasoning as { properties?: Record<string, { minimum?: unknown; maximum?: unknown }> } | undefined)?.properties;
  const budget = properties?.["budgetTokens"];
  return {
    ...(typeof budget?.minimum === "number" ? { minimum: budget.minimum } : {}),
    ...(typeof budget?.maximum === "number" ? { maximum: budget.maximum } : {}),
  };
}

/** Every source this machine could ask, in the order they merge — the Catalog section's rows. */
export const CATALOG_SOURCE_NAMES = [
  "openrouter-models",
  "openrouter-native-mirrors",
  "anthropic-models",
  "claude-cli-models",
  "claude-code-models",
  "codex-cli-models",
  "local-models",
  "embedded-models",
] as const;

/** What each source asks, what else re-asks it, why it may be missing, and what fixes a failure. */
const SOURCE_TEXT: Record<(typeof CATALOG_SOURCE_NAMES)[number], { asks: string; changesWith?: string; missing: string; fix: string; agent?: string }> = {
  "openrouter-models": { asks: "OpenRouter's public model list", missing: "", fix: "check this machine can reach openrouter.ai, then Refresh" },
  "openrouter-native-mirrors": {
    asks: "the native routes' rows, filled from OpenRouter's",
    missing: "",
    fix: "check this machine can reach openrouter.ai, then Refresh",
  },
  "anthropic-models": {
    asks: "Anthropic's /v1/models with the anthropic route's key",
    changesWith: "the key changes",
    missing: "no Anthropic key is set",
    fix: "replace the Anthropic key under Connections, then Refresh",
  },
  "claude-cli-models": {
    asks: "the installed claude for its model menu",
    changesWith: "the agent is updated or signs in as someone else",
    missing: "claude-cli is not available here",
    fix: "check claude-cli under Connections",
    agent: "claude-cli",
  },
  "claude-code-models": {
    asks: "the claude bundled with the SDK",
    changesWith: "the agent is updated or signs in as someone else",
    missing: "claude-code is not available here",
    fix: "check claude-code under Connections",
    agent: "claude-code",
  },
  "codex-cli-models": {
    asks: "codex app-server for model/list",
    changesWith: "the agent is updated or signs in as someone else",
    missing: "codex-cli is not available here",
    fix: "check codex-cli under Connections",
    agent: "codex-cli",
  },
  "local-models": {
    asks: "the local server's /models",
    changesWith: "its URL changes",
    missing: "no local server URL is set",
    fix: "check the local server is running, then Refresh",
  },
  "embedded-models": {
    asks: "each configured weights file's header",
    changesWith: "its weights change",
    missing: "no weights paths are set",
    fix: "check the weights paths under Models",
  },
};

/**
 * The Catalog section as the renderer draws it: one row per source this machine could ask — asked
 * (ok or failed), planned but not asked yet, or not configured — each with the models it answered.
 */
export function catalogStatusView(opts: {
  status: readonly CatalogSourceStatus[];
  planned: readonly PlannedSource[];
  executors: readonly ProbeResult[];
  refreshing: boolean;
  table?: ModelInfo;
}): CatalogStatusView {
  const table = opts.table ?? ModelInfo.instance;
  const byName = new Map(opts.status.map((s) => [s.name, s]));
  const planned = new Set(opts.planned.map((p) => p.source.name));
  const sources = CATALOG_SOURCE_NAMES.map((name): CatalogSourceView => {
    const text = SOURCE_TEXT[name];
    const seen = byName.get(name);
    const version = text.agent !== undefined ? versionOf(opts.executors.find((p) => p.name === text.agent)) : undefined;
    const base = {
      name,
      asks: text.asks,
      ...(version !== undefined ? { version } : {}),
      ...(text.changesWith !== undefined ? { changesWith: text.changesWith } : {}),
    };
    if (seen === undefined) {
      return planned.has(name) ? { ...base, state: "not asked yet", models: [] } : { ...base, state: "not configured", error: text.missing, models: [] };
    }
    return {
      ...base,
      state: seen.ok ? "ok" : "failed",
      at: seen.at,
      nextAt: seen.at + (seen.ok ? CATALOG_STALE_MS : CATALOG_RETRY_MS),
      fetched: seen.fetched,
      ...(seen.error !== undefined ? { error: seen.error, fix: text.fix } : {}),
      models: seen.models.map((key): CatalogModelView => {
        const row = table.lookup(key);
        const levels = levelsSummary(key, table);
        // An alias (`default`, `sonnet`) names the model it resolves to — by that model's own spelling
        // when the same source listed it too (`gpt-5.6-sol`), else by its canonical id.
        const alias =
          row?.canonicalId !== undefined && row.canonicalId !== canonicalIdFor(row.model)
            ? `→ ${
                seen.models
                  .map((k) => table.lookup(k))
                  .find((r) => r !== undefined && r.model !== row.model && canonicalIdFor(r.model) === row.canonicalId)?.model ?? row.canonicalId
              }`
            : undefined;
        return {
          id: key.slice(key.indexOf("/") + 1),
          ...(levels !== undefined ? { levels } : {}),
          ...(alias !== undefined ? { alias } : {}),
          ...(row?.available === false ? { hidden: true } : {}),
        };
      }),
    };
  });
  const last = opts.status.reduce<CatalogSourceStatus | undefined>((a, s) => (a === undefined || s.at > a.at ? s : a), undefined);
  return {
    refreshing: opts.refreshing,
    ...(last !== undefined ? { lastAt: last.at, tookMs: last.tookMs } : {}),
    sources,
    modelIds: nativeModelIds(table),
  };
}

/**
 * The bare ids the catalog knows on the native routes, newest first — what a preset candidate's box
 * suggests (a candidate is a bare id, routed by its vendor). A snapshot DATE (`…-20251001`) is left out
 * when its alias is listed too: the alias is what a person writes.
 */
export function nativeModelIds(table: ModelInfo = ModelInfo.instance): string[] {
  const rows = table.list().filter((row) => (row.route === "anthropic" || row.route === "openai") && row.available !== false);
  const ids = new Set(rows.map((row) => row.model));
  return rows
    .filter((row) => !(/-\d{8}$/.test(row.model) && ids.has(row.model.replace(/-\d{8}$/, ""))))
    .sort((a, b) => (b.releasedAt ?? 0) - (a.releasedAt ?? 0) || a.model.localeCompare(b.model))
    .map((row) => row.model)
    .filter((id, i, all) => all.indexOf(id) === i);
}
