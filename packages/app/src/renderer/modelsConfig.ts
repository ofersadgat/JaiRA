/**
 * Editing `config.models` inside one configuration layer — the settings surface DESIGN §8.3 needed.
 *
 * Until now the only way to say which model a prompt state should use was to type `models.default`
 * into `config.json` by hand, and the only way to point a provider at a key kept somewhere other than
 * the process environment was to not do it at all. That is the gap this closes: a form's values become
 * a patch against the raw document of the layer being edited.
 *
 * It follows `executorConfig.ts` exactly, because the two are the same problem and a second set of
 * rules would be a second set of surprises:
 *
 *  - **The LAYER's document is patched, never the merged one.** Saving the effective config into a
 *    project would copy every inherited value out of the shared root and freeze it there.
 *  - **An empty field REMOVES the key**, so the layer goes back to inheriting rather than pinning the
 *    value it happened to be showing. An emptied block is deleted outright.
 *
 * Pure functions over plain documents: no React, no IPC, and therefore testable without either.
 */

/** A route prefix, and what a form needs to know to render it. */
export interface RouteSpec {
  key: string;
  label: string;
  /** One line, addressed to someone deciding whether they want this route at all. */
  hint: string;
  fields: RouteField[];
  /** The variable this route's key is conventionally kept under — a suggestion, never a fallback. */
  credential?: string;
}

export type RouteField = "credential" | "baseURL" | "supportsStructuredOutputs" | "serve" | "weights";

/**
 * The four routes, in the order the settings screen offers them.
 *
 * Remote first because that is what most projects want and what a first run is most likely to need;
 * the two local ones after, because they cost nothing to run and everything to set up.
 */
export const MODEL_ROUTES: RouteSpec[] = [
  {
    key: "anthropic",
    label: "Anthropic",
    hint: "Claude models, billed to an API key. Serves every model id starting anthropic/.",
    fields: ["credential"],
    credential: "ANTHROPIC_API_KEY",
  },
  {
    key: "openrouter",
    label: "OpenRouter",
    hint: "One key for many providers. Serves every model id starting openrouter/.",
    fields: ["credential"],
    credential: "OPENROUTER_API_KEY",
  },
  {
    key: "local",
    label: "Local server",
    hint: "An OpenAI-compatible server on this machine — Ollama, LM Studio, llama-server, vLLM.",
    fields: ["baseURL", "credential", "supportsStructuredOutputs", "serve"],
  },
  {
    key: "embedded",
    label: "Embedded weights",
    hint: "GGUF weights loaded into this process. Needs the optional node-llama-cpp package.",
    fields: ["weights"],
  },
];

/** A field write. `undefined` REMOVES the key, which is how a layer goes back to inheriting. */
export type ModelPatch = Record<string, unknown>;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The `models` block of a document, or `undefined` when it says nothing. */
export function modelsBlock(doc: unknown): Record<string, unknown> | undefined {
  if (!isObject(doc)) return undefined;
  return isObject(doc["models"]) ? doc["models"] : undefined;
}

/**
 * What THIS document says about one route, or `undefined` when it says nothing.
 *
 * Used twice and for opposite purposes, exactly as `executorBlock` is: against the layer being edited
 * it supplies the form's values, and against the effective config it supplies the placeholders — which
 * is what makes "inherited from the shared root" visible as something other than an empty box.
 */
export function routeBlock(doc: unknown, route: string): Record<string, unknown> | undefined {
  const routes = modelsBlock(doc)?.["routes"];
  if (!isObject(routes)) return undefined;
  return isObject(routes[route]) ? (routes[route] as Record<string, unknown>) : undefined;
}

/** The default model id this document names, if any. */
export function defaultModel(doc: unknown): string {
  const value = modelsBlock(doc)?.["default"];
  return typeof value === "string" ? value : "";
}

/**
 * Apply a patch to `config.models` in a layer's raw document, returning a new one.
 *
 * Keys are DOTTED paths (`default`, `routes.anthropic.credential`, `routes.local.serve`), so one
 * function covers the flat field and the nested one and there is no second spelling to learn. The
 * input is never mutated: the store holds the last-read `ConfigView`, and editing it in place would
 * leave the UI showing a value the write might still be refused for.
 */
export function applyModelPatch(doc: unknown, patch: ModelPatch): unknown {
  const next = structuredClone(isObject(doc) ? doc : {}) as Record<string, unknown>;
  const models = isObject(next["models"]) ? { ...(next["models"] as Record<string, unknown>) } : {};
  next["models"] = models;

  for (const [path, value] of Object.entries(patch)) {
    const parts = path.split(".");
    // The chain of containers this write passes through, kept so an emptied one can be collapsed
    // afterwards. Each is COPIED on the way down: the document handed in must not be mutated.
    const chain: Array<{ parent: Record<string, unknown>; key: string }> = [];
    let cursor: Record<string, unknown> = models;
    for (const part of parts.slice(0, -1)) {
      cursor[part] = isObject(cursor[part]) ? { ...(cursor[part] as Record<string, unknown>) } : {};
      chain.push({ parent: cursor, key: part });
      cursor = cursor[part] as Record<string, unknown>;
    }
    const leaf = parts[parts.length - 1]!;
    if (value === undefined) delete cursor[leaf];
    else cursor[leaf] = value;

    // A container this write EMPTIED is deleted rather than left as `{}` — an empty object reads as a
    // deliberate, if inert, override, which is the opposite of what clearing the box meant.
    //
    // Only along the path just written, deliberately. Sweeping the whole block would also delete an
    // empty object somebody put there ON PURPOSE — a preset declaring no overrides is a legitimate,
    // if unusual, thing to write, and a settings form that silently discards it is a form that loses
    // work.
    for (const { parent, key } of chain.reverse()) {
      const block = parent[key];
      if (isObject(block) && Object.keys(block).length === 0) delete parent[key];
    }
  }

  if (Object.keys(models).length === 0) delete next["models"];
  return next;
}

// --- the text fields ---------------------------------------------------------

/** A server's launch command as one shell-ish line — `ollama serve`, `llama-server -m model.gguf`. */
export function formatServe(serve: unknown): string {
  if (!isObject(serve)) return "";
  const args = Array.isArray(serve["args"]) ? (serve["args"] as unknown[]).filter((a) => typeof a === "string") : [];
  return [serve["command"], ...args].filter((p) => typeof p === "string").join(" ");
}

/**
 * Parse the launch box. Blank means "do not start anything", which is different from an empty command.
 *
 * Split on whitespace, unlike the executor argv box which is one argument per line. The difference is
 * deliberate and follows what is being typed: an argv template can carry a prompt containing spaces, a
 * server launch line is `ollama serve` and splitting it any other way would be pedantry.
 */
export function parseServe(text: string): { command: string; args?: string[] } | undefined {
  const parts = text.trim().split(/\s+/).filter((p) => p.length > 0);
  const command = parts[0];
  if (command === undefined) return undefined;
  const args = parts.slice(1);
  return { command, ...(args.length > 0 ? { args } : {}) };
}

/** A JSON block (weights, presets) as pretty text. Blank when there is nothing to show. */
export function formatJson(value: unknown): string {
  return value === undefined || (isObject(value) && Object.keys(value).length === 0) ? "" : JSON.stringify(value, null, 2);
}

/**
 * Parse a JSON block.
 *
 * Throws on malformed input rather than silently keeping the old value: a settings box that accepts a
 * typo and saves nothing is the worst of both — the screen says one thing and the file says another.
 */
export function parseJsonBlock(text: string, label: string): Record<string, unknown> | undefined {
  if (text.trim().length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`${label} is not valid JSON: ${(e as Error).message}`);
  }
  if (!isObject(parsed)) throw new Error(`${label} must be a JSON object`);
  return parsed;
}

/** A model id must name its route, which is the one rule the config parser also enforces. */
export function checkModelId(id: string): void {
  if (id.length > 0 && !id.includes("/")) {
    throw new Error(
      `'${id}' must be route-prefixed — 'anthropic/claude-sonnet-5', 'openrouter/openai/gpt-5', or 'claude-cli/sonnet' to run it on the CLI agent`,
    );
  }
}
