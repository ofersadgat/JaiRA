/**
 * A preset's MODEL — which model a state that picks the preset runs on, and how it is chosen.
 *
 * A preset (`models.presets.<name>`, selected with `configRef`) used to be call settings only; the
 * model was whatever the state or the default executor said. That made the three presets JaiRA ships
 * (`simple`, `coder`, `planner` — `builtin/settings.json`) impossible to write down: what makes
 * `coder` coder is the model, and the model it should be depends on what this machine can reach. A
 * machine with the `claude` CLI signed in wants Opus; one with only `codex` wants GPT-5.
 *
 * So `model` is one of two things:
 *
 *  - **a model id** — `"claude-sonnet-5"`, `"claude-cli/opus"` — used as a state's own `model` is;
 *  - **candidates and a rule** — `{ "candidates": [...], "choose": … }` — one of the candidates this
 *    machine can reach answers, picked by the rule:
 *    - `first-available` — the first in the list;
 *    - `most-left` — the one whose account has the most allowance left in the window its next call
 *      would hit first, read off the limits board (`docs/engineering/contracts/usage-readings.md`).
 *      No reading ranks after a figure and before an account known to be spent; among equals the
 *      list's order decides — so with no readings at all it IS `first-available`.
 *
 * It is NAMES.md §6's `$any` / `$pick` in miniature: a list and a way to pick from it.
 *
 * ## When the choice is made, and how long it holds
 *
 * When a SESSION is created: the first call of a conversation chooses, and every later call in the
 * same conversation keeps that model — a conversation that started on Opus does not continue on GPT-5
 * because a CLI was signed out halfway through. A resumed task reads the choice off the record (the
 * model a call recorded is the model it ran on), and the next NEW session chooses again. The executor
 * that does this is `withPresetModels` in `@jaira/runtime`; everything that decides is here, pure.
 *
 * ## A preset's name where a model goes
 *
 * `executors.default.prompt.defaults.model` (the Default model) and `functions.smart.model` (the
 * judge) may name a preset: a value that is EXACTLY the name of a configured preset means that
 * preset's model — its model only; its other settings are for the states that pick it. That can only
 * be unambiguous if a preset's name can never be read as a model id, so {@link presetNameRefusal}
 * refuses every name that could: one without a dash, a slash, a dot or a colon (every model id has
 * at least one, save the few a family claims — `o3` — which are refused by family), and never
 * `default`, the word a route reads as "its own default".
 */
import type { AvailabilitySnapshot, ProbeResult } from "./executors";
import { isRoutePrefixed, servingRoutes, vendorOfModel, type JairaPromptNode } from "./executorTree";

/** The rules a candidate list may be chosen from by. See the module comment. */
export const PRESET_CHOICES = ["first-available", "most-left"] as const;
export type PresetChoice = (typeof PRESET_CHOICES)[number];

/** A candidate list: the ids to try, in order, and how one is picked. */
export interface PresetCandidates {
  candidates: string[];
  choose: PresetChoice;
}

/** What `models.presets.<name>.model` may hold. */
export type PresetModel = string | PresetCandidates;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Why `name` cannot be a preset's name, or `undefined` when it can.
 *
 * The rule that keeps a preset's name and a model id from ever being the same string — see the module
 * comment. Checked by the parser (a layer holding a preset spelled like a model is refused) and by the
 * Settings form that names a new one, so the two agree.
 */
export function presetNameRefusal(name: string): string | undefined {
  if (name.length === 0) return "a preset needs a name";
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) {
    return "a preset's name is a word — letters, digits and _, starting with a letter — so it can never be read as a model id, which always has a - / . or :";
  }
  if (name === "default") return "'default' is what a route calls its own model, so it cannot also be a preset";
  const family = vendorOfModel(name);
  if (family !== undefined) return `'${name}' reads as a model id of the ${family} family, so a model field naming it would be ambiguous`;
  return undefined;
}

/**
 * Parse one preset's `model`, strictly — `at` is the path, for the message.
 *
 * Strict about what is PRESENT, like the rest of the config parser: a misspelt rule is a preset that
 * quietly never chooses, and a candidate list with an empty id is a candidate that can never answer.
 */
export function parsePresetModel(value: unknown, at: string): PresetModel {
  if (typeof value === "string") {
    if (value.trim().length === 0) throw new Error(`${at} must be a model id, or { candidates, choose }`);
    return value;
  }
  if (!isRecord(value)) throw new Error(`${at} must be a model id, or { "candidates": [...], "choose": "first-available" }`);
  for (const key of Object.keys(value)) {
    if (key !== "candidates" && key !== "choose") throw new Error(`${at}.${key} is not a field (candidates, choose)`);
  }
  const candidates = value["candidates"];
  if (!Array.isArray(candidates) || candidates.length === 0) throw new Error(`${at}.candidates must be a non-empty list of model ids`);
  candidates.forEach((id, i) => {
    if (typeof id !== "string" || id.trim().length === 0) throw new Error(`${at}.candidates[${i}] must be a model id`);
  });
  const choose = value["choose"];
  if (!PRESET_CHOICES.includes(choose as PresetChoice)) {
    throw new Error(`${at}.choose must be ${PRESET_CHOICES.map((c) => `"${c}"`).join(" or ")}`);
  }
  return { candidates: candidates as string[], choose: choose as PresetChoice };
}

/** The model ids a preset model names, in order — one for a plain id. */
export function candidatesOf(model: PresetModel): string[] {
  return typeof model === "string" ? [model] : [...model.candidates];
}

/** A preset's `model`, when it states one that parses — for readers of a document that was already validated. */
export function presetModelOf(preset: unknown): PresetModel | undefined {
  if (!isRecord(preset) || preset["model"] === undefined) return undefined;
  try {
    return parsePresetModel(preset["model"], "model");
  } catch {
    return undefined;
  }
}

/**
 * What a MODEL FIELD's value means: a model id, or — when it is exactly the name of a configured
 * preset — that preset's model.
 *
 * `presetless` is the preset named but stating no model: nothing to resolve to, and not a model id
 * either, so the caller says so rather than sending a preset's name to a router as if it were a model.
 */
export function resolveModelField(
  value: string,
  presets: Record<string, unknown> | undefined,
): { model: PresetModel; preset?: string } | { presetless: string } {
  if (presets === undefined || !Object.prototype.hasOwnProperty.call(presets, value)) return { model: value };
  const model = presetModelOf(presets[value]);
  return model === undefined ? { presetless: value } : { model, preset: value };
}

// --- is a model available here? -----------------------------------------------------------

/** Whether a route can take a call right now — the host's probe, as far as it has one. */
export type RouteHealth = (route: string) => { ok: true } | { ok: false; why: string };

/** Can this machine run a model id, and through which route — or why not, in words for a person. */
export type ModelAvailability = { available: true; route: string } | { available: false; why: string };

/**
 * Is `model` available here?
 *
 * "Available" is the rule the person set: the id resolves to a route that is registered and enabled
 * (`routes` — every CONFIGURED route, working or not, so a route the probe marked down can still be
 * named as the reason), and the host's probe does not say that route is failing or needs a sign-in
 * (`health`). A host with no probe — the CLI — passes no `health`, and registered-and-enabled is the
 * whole answer.
 *
 * A PREFIXED id names its route and is judged by that route alone; a BARE id is available through the
 * first route that serves it and is healthy — the same order the router dispatches in, so what this
 * says is where the call would go.
 */
export function modelAvailability(
  routes: Record<string, JairaPromptNode> | undefined,
  model: string,
  health?: RouteHealth,
): ModelAvailability {
  const check = (route: string): { ok: true } | { ok: false; why: string } => health?.(route) ?? { ok: true };
  if (isRoutePrefixed(model, routes)) {
    const route = model.slice(0, model.indexOf("/"));
    if (!(route in (routes ?? {}))) return { available: false, why: `the ${route} route is not set up here` };
    const ok = check(route);
    return ok.ok ? { available: true, route } : { available: false, why: ok.why };
  }
  const serving = servingRoutes(routes, model);
  if (serving.length === 0) {
    const family = vendorOfModel(model);
    return {
      available: false,
      why: family === undefined ? "no route here recognises it" : `nothing here serves ${family} models`,
    };
  }
  const reasons: string[] = [];
  for (const route of serving) {
    const ok = check(route);
    if (ok.ok) return { available: true, route };
    reasons.push(ok.why);
  }
  return { available: false, why: reasons.join("; ") };
}

/**
 * {@link modelAvailability} against a resolved PROMPT NODE — the default executor's prompt half.
 *
 * A router is judged by its routes. A prompt half pinned to one provider or agent is not a router:
 * every call reaches that leaf whatever it names, so every model is available through it, as far as
 * its health goes — the same reading `namedModelAnswer` takes of a pinned leaf.
 */
export function modelAvailabilityIn(
  node: JairaPromptNode | undefined,
  model: string,
  health?: RouteHealth,
): ModelAvailability {
  if (node === undefined) return { available: false, why: "there is no prompt executor configured" };
  if (node.kind === "provider" || node.kind === "agent") {
    const leaf = (node as { provider?: string; agent?: string }).provider ?? (node as { agent?: string }).agent ?? node.kind;
    const ok = health?.(leaf) ?? { ok: true };
    return ok.ok ? { available: true, route: leaf } : { available: false, why: ok.why };
  }
  return modelAvailability((node as { routes?: Record<string, JairaPromptNode> }).routes, model, health);
}

/**
 * The host's probes as a {@link RouteHealth}.
 *
 * A route no check has looked at is healthy — the same optimistic reading `stateViewOptions` takes,
 * for the same reason: refusing over a check that never ran is worse than the failure it prevents.
 * `disabled` is not here either: a disabled executor is not a configured route at all.
 */
export function routeHealthOf(snapshot: Pick<AvailabilitySnapshot, "routes" | "executors" | "checkedAt"> | undefined): RouteHealth {
  const byName = new Map<string, ProbeResult>();
  for (const probe of [...(snapshot?.routes ?? []), ...(snapshot?.executors ?? [])]) byName.set(probe.name, probe);
  return (route) => {
    const probe = byName.get(route);
    if (probe === undefined) return { ok: true };
    if (probe.status === "needs-sign-in") return { ok: false, why: `${route} is not signed in` };
    if (probe.status === "failed") return { ok: false, why: `${route}: ${probe.detail}` };
    return { ok: true };
  };
}

// --- choosing ------------------------------------------------------------------------------

/** What a choice came to: the candidate and where it runs, or why none could. */
export type PresetChoiceOutcome =
  | { model: string; route: string; index: number }
  | { refused: string; unavailable: Array<{ model: string; why: string }> };

/**
 * `first-available`: the first candidate this machine can run.
 *
 * Pure over an availability predicate, so it is the same function in the app (routes and probes), in
 * the CLI (routes only) and in a test (whatever the test says). When nothing is available the refusal
 * names EVERY candidate and why — "none of these is available" with nothing after it is a message a
 * person can do nothing with.
 */
export function chooseFirstAvailable(
  candidates: readonly string[],
  availability: (model: string) => ModelAvailability,
  preset?: string,
): PresetChoiceOutcome {
  const unavailable: Array<{ model: string; why: string }> = [];
  for (const [index, model] of candidates.entries()) {
    const answer = availability(model);
    if (answer.available) return { model, route: answer.route, index };
    unavailable.push({ model, why: answer.why });
  }
  const whose = preset === undefined ? "the candidates" : `the candidates of preset '${preset}'`;
  return {
    refused:
      candidates.length === 0
        ? `${whose} name no model to choose from`
        : `none of ${whose} is available here — ${unavailable.map((u) => `${u.model}: ${u.why}`).join("; ")}`,
    unavailable,
  };
}

/**
 * `most-left`: of the candidates this machine can run, the one with the most allowance LEFT (0–100)
 * in the window its next call would hit first.
 *
 * `left` answers `null` when nothing is known about the candidate's account. Allowance left ranks
 * first, then not knowing, then an account known to be spent — a number beats a guess, and a guess
 * beats a known refusal. Among equals the list's order decides, so with no readings at all this
 * chooses exactly what `first-available` does. Every candidate spent is not a refusal here: the call
 * goes out, is refused for the limit, and waits for the reset like any other refused message.
 */
export function chooseMostLeft(
  candidates: readonly string[],
  availability: (model: string) => ModelAvailability,
  left: (model: string, route: string) => number | null,
  preset?: string,
): PresetChoiceOutcome {
  let best: { model: string; route: string; index: number; score: number } | undefined;
  const unavailable: Array<{ model: string; why: string }> = [];
  for (const [index, model] of candidates.entries()) {
    const answer = availability(model);
    if (!answer.available) {
      unavailable.push({ model, why: answer.why });
      continue;
    }
    const figure = left(model, answer.route);
    // Allowance left beats not knowing, and not knowing beats knowing there is none.
    const score = figure === null ? -1 : figure <= 0 ? -2 : figure;
    if (best === undefined || score > best.score) best = { model, route: answer.route, index, score };
  }
  if (best !== undefined) return { model: best.model, route: best.route, index: best.index };
  return chooseFirstAvailable(candidates, availability, preset);
}

/**
 * Which candidate a RECORDED model is, if any — how a resumed session keeps the model it started on.
 *
 * The record holds what the transport REPORTED, under the route it ran on: `claude-cli/claude-opus-5-5`,
 * or a dated snapshot of the id that was asked for (`claude-haiku-4-5-20251001`). So the route is
 * dropped and a candidate matches exactly, or as the stem of a dated id. Nothing looser: `gpt-5` is
 * not `gpt-5-mini`, and a session that recorded a model none of the candidates is chooses again.
 */
export function keptCandidate(candidates: readonly string[], recorded: string | undefined): string | undefined {
  if (recorded === undefined || recorded.length === 0) return undefined;
  const bare = (id: string): string => (id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id);
  const was = bare(recorded);
  const exact = candidates.find((c) => bare(c) === was);
  if (exact !== undefined) return exact;
  return candidates.find((c) => {
    const stem = bare(c);
    return was.startsWith(`${stem}-`) && /^\d{6,}$/.test(was.slice(stem.length + 1));
  });
}

// --- saying it -----------------------------------------------------------------------------

/**
 * A model id as a person says it — `claude-opus-5-5` → `opus`, `claude-cli/claude-haiku-4-5` →
 * `haiku`; anything that is not a Claude family id is itself, less its route.
 */
export function shortModelName(id: string): string {
  const bare = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
  const claude = /^claude-([a-z]+)(?:-|$)/.exec(bare);
  return claude !== null ? claude[1]! : bare;
}

/** One line for a preset's model — the Model section's summary: `first available: opus · gpt-5.6-terra`. */
export function presetModelSummary(model: PresetModel | undefined): string {
  if (model === undefined) return "not set";
  if (typeof model === "string") return model;
  return `${model.choose === "most-left" ? "most left" : "first available"}: ${model.candidates.map(shortModelName).join(" · ")}`;
}
