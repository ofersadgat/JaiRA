/**
 * Presets, applied BEFORE a call is routed — and a preset's model chosen when its session is created.
 *
 * `@jaira/shared`'s `presetModels.ts` says what a preset's model is and decides every choice, purely;
 * this is the executor that asks it, on the way into the prompt tree.
 *
 * ## Why here and not in the provider leaf
 *
 * `configRef` used to be resolved by upstream's prompt lowering, inside the PROVIDER leaf — after the
 * router had already dispatched on `op.config.model`. That is the ordering bug `withPromptDefaults`
 * exists to close, a second time: a preset's model could never choose a route, a state picking a
 * preset on an AGENT route had the preset ignored outright (agents never read `configRef`), and a
 * default model filled in before the leaf beat the preset it should have lost to. So the preset is
 * expanded here, outside the whole tree, in the documented order — the default executor's defaults,
 * then the preset, then the state's own config — and `configRef` goes no further.
 *
 * ## The choice, and how long it holds
 *
 * A candidate list (`{ candidates, choose: "first-available" }`) is chosen from when a SESSION is
 * created — the first call of a conversation — and every later call in that conversation keeps it:
 *
 *  1. this executor remembers what it chose for each session, for as long as it lives;
 *  2. failing that — a resumed task, a chat turn built afresh — the session's RECORD says which model
 *     answered it last (`recorded`), and a candidate that matches is kept (`keptCandidate`);
 *  3. failing that, the first available candidate answers (`chooseFirstAvailable`).
 *
 * A call with no session (the `smart` judge, a one-off) chooses every time. The chosen id is written
 * into `model`, so the record — and the conversation drawn from it — shows the model actually used.
 */
import {
  finishedHandle,
  permanentFailure,
  type ExecServices,
  type InlineFamily,
  type JsonValue,
  type Operation,
} from "@declarative-ai/exec";
import type { WorkflowMetrics } from "@declarative-ai/hw";
import {
  chooseFirstAvailable,
  keptCandidate,
  resolveModelField,
  presetModelOf,
  type ModelAvailability,
  type PresetModel,
} from "@jaira/shared";
import type { StackedExecutor } from "./executorStack";

export interface PresetModelOptions {
  /** `config.models.presets`, every layer merged. */
  presets: Record<string, Record<string, JsonValue>>;
  /** Can this machine run a model id — the host's answer (`modelAvailability` over its routes and probes). */
  available: (model: string) => ModelAvailability;
  /**
   * The model the session's last call RECORDED before position `at` — how a resumed session keeps
   * its choice. Absent ⇒ only this executor's own memory of what it chose.
   */
  recorded?: (at: { id: string; seq: number }) => string | undefined;
}

/** What one call's config comes to: the config to run with, or why it cannot run. */
export type PresetResolution = { config: Record<string, JsonValue> } | { refused: string };

function isObject(value: unknown): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Resolve one call's config: expand its preset, and turn a preset's model into a model id.
 *
 * `keep` is the session's standing choice for a candidate list, when it has one (see the module
 * comment); `undefined` chooses afresh. Pure apart from what `options` answers, which is what the tests
 * drive it through.
 */
export function resolvePresetCall(
  config: Record<string, JsonValue>,
  options: PresetModelOptions,
  defaults: Record<string, JsonValue> | undefined,
  keep?: (candidates: readonly string[]) => string | undefined,
): PresetResolution & { chose?: { candidates: string[]; model: string } } {
  const { configRef, ...inline } = config;
  let preset: Record<string, JsonValue> | undefined;
  if (typeof configRef === "string") {
    preset = options.presets[configRef];
    if (preset === undefined) {
      const known = Object.keys(options.presets);
      return {
        refused:
          `configRef '${configRef}' names no preset — ` +
          (known.length === 0 ? "none is configured" : `configured presets are ${known.map((n) => `'${n}'`).join(", ")}`),
      };
    }
  }
  const { model: _presetModel, ...presetSettings } = preset ?? {};
  const merged: Record<string, JsonValue> = { ...presetSettings, ...inline };

  // Whose model this call runs on, strongest first: the state's own, its preset's, the default
  // executor's. A model FIELD naming a preset means that preset's model.
  const field = (value: JsonValue | undefined): { model: PresetModel; preset?: string } | { refused: string } | undefined => {
    if (typeof value !== "string" || value === "") return undefined;
    const meant = resolveModelField(value, options.presets);
    return "presetless" in meant ? { refused: `the model '${value}' names the preset '${value}', which sets no model` } : meant;
  };
  const presetOwn = preset === undefined ? undefined : presetModelOf(preset);
  // The default's model only when it names a PRESET: a plain id is the tree's to fill, as it always was.
  const fallback = field(defaults?.["model"]);
  const source =
    field(inline["model"]) ??
    (presetOwn !== undefined ? { model: presetOwn, ...(typeof configRef === "string" ? { preset: configRef } : {}) } : undefined) ??
    (fallback !== undefined && ("refused" in fallback || fallback.preset !== undefined) ? fallback : undefined);
  if (source === undefined) return { config: merged };
  if ("refused" in source) return source;
  const model = source.model;
  if (typeof model === "string") return { config: { ...merged, model } };

  const candidates = model.candidates;
  const standing = keep?.(candidates);
  if (standing !== undefined) return { config: { ...merged, model: standing } };
  const choice = chooseFirstAvailable(candidates, options.available, source.preset);
  if ("refused" in choice) return { refused: choice.refused };
  return { config: { ...merged, model: choice.model }, chose: { candidates: [...candidates], model: choice.model } };
}

/**
 * Put the preset layer in front of a prompt executor — see the module comment.
 *
 * `defaults` are the default executor's own (`tree.defaults`), read only to know which model a call
 * that names none will be filled in with; the tree's own `withPromptDefaults` still fills the rest.
 */
export function withPresetModels(
  options: PresetModelOptions,
  defaults: Record<string, JsonValue> | undefined,
  inner: StackedExecutor,
): StackedExecutor {
  const executor = inner;
  /** What each session chose, by session id and candidate list — a session keeps its model. */
  const chosen = new Map<string, string>();
  const keyOf = (session: string, candidates: readonly string[]): string => `${session}\u0000${candidates.join("\u0000")}`;

  const resolve = (op: Operation<InlineFamily>, ctx?: ExecServices): { op: Operation<InlineFamily> } | { refused: string } => {
    if (op.kind !== "prompt") return { op };
    const config = isObject(op.config) ? op.config : {};
    const session = ctx?.session;
    const keep =
      session === undefined
        ? undefined
        : (candidates: readonly string[]): string | undefined => {
            const held = chosen.get(keyOf(session.id, candidates));
            if (held !== undefined) return held;
            // The first call of a session has nothing behind it to keep.
            const at = session.at;
            if (at === undefined || at.seq <= 0 || options.recorded === undefined) return undefined;
            return keptCandidate(candidates, options.recorded(at));
          };
    const resolved = resolvePresetCall(config, options, defaults, keep);
    if ("refused" in resolved) return { refused: resolved.refused };
    if (session !== undefined && resolved.chose !== undefined) chosen.set(keyOf(session.id, resolved.chose.candidates), resolved.chose.model);
    return { op: { ...op, config: resolved.config as JsonValue } };
  };

  return {
    capabilities: executor.capabilities,
    metrics: executor.metrics,
    ...(executor.capabilitiesFor !== undefined
      ? {
          // Asked about the call as it will RUN, without choosing on its behalf: a question about a call
          // must not become the session's standing choice.
          capabilitiesFor: (op: Operation<InlineFamily>) => {
            const picked = resolve(op);
            return executor.capabilitiesFor!("op" in picked ? picked.op : op);
          },
        }
      : {}),
    start: (op: Operation<InlineFamily>, ctx: ExecServices) => {
      const picked = resolve(op, ctx);
      if ("refused" in picked) return finishedHandle(permanentFailure<WorkflowMetrics>(picked.refused));
      return executor.start(picked.op, ctx);
    },
  };
}
