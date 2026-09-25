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
  catalogRowForGguf,
  deriveIdentity,
  makeAnthropicModelsSource,
  makeOpenRouterSources,
  ModelInfo,
  refreshModelCatalog,
  type CatalogSource,
  type FetchText,
  type ModelInfoInterface,
  type RefreshReport,
} from "@declarative-ai/llm";
import { createHash } from "node:crypto";
import type { JairaAgentConfig, JairaModelConfig, ProbeResult } from "@jaira/shared";
import type { SecretResolver } from "./secrets";
import { sdkClaudeBinary } from "./limitsRefresh";
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
    out.push({ source: embeddedModelsSource(paths), fingerprint: digest(JSON.stringify(paths)) });
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
export class CatalogRefresher {
  private readonly table: ModelInfo;
  private readonly now: () => number;
  private readonly last = new Map<string, { fingerprint: string; at: number; ok: boolean }>();
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
    // A source that yields one row is a real answer here — a local server serving one model.
    const report = await refreshModelCatalog({ sources: due.map((p) => p.source), table: this.table, minRows: 1 });
    for (const planned of due) {
      const outcome = report.bySource.find((s) => s.name === planned.source.name);
      this.last.set(planned.source.name, { fingerprint: planned.fingerprint, at, ok: outcome !== undefined && !outcome.skipped });
    }
    if (report.changed.length > 0) this.store({ create: true })?.save(report.changed, at);
    return report;
  }
}
