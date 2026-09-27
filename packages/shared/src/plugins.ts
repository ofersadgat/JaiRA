/**
 * Downloadable plugins (decision 0011 §6): what the installer leaves out because it is big, and a
 * person downloads when they want what it does. A plugin is what a person installs; the packages it is
 * made of are stored once each (`@jaira/runtime` `plugins.ts`) and listed with their versions and
 * hashes in the plugin manifest the build ships (`scripts/plugins/manifest.mjs`).
 *
 * Two families, each built around one package the app loads by name at run time:
 *
 *  - `claude-agent-sdk`: the Agent SDK and this machine's `claude` binary. It is what the Claude
 *    (API key) route runs on, and its newer `claude` is what reads the claude-cli route's usage.
 *  - `llama`: `node-llama-cpp` and its dependencies, for the local-models (embedded) route, plus ONE
 *    variant plugin holding the native build for this machine — CPU, Vulkan, CUDA or Metal — each a
 *    separate download, so a machine fetches only the one it uses.
 *
 * A plugin's version is its package's version; nothing here is versioned by the app.
 */

export type PluginId = "claude-agent-sdk" | "llama" | "llama-cpu" | "llama-vulkan" | "llama-cuda" | "llama-cuda-ext" | "llama-metal";

export interface PluginSpec {
  id: PluginId;
  title: string;
  /** One line: what it makes possible. */
  purpose: string;
  /** The package it is built around: the family's root. */
  root: "@anthropic-ai/claude-agent-sdk" | "node-llama-cpp";
  /** A variant needs its family's base plugin, and is linked into it. */
  variantOf?: PluginId;
}

export const PLUGINS: readonly PluginSpec[] = [
  {
    id: "claude-agent-sdk",
    title: "Claude Agent SDK",
    purpose: "Runs the Claude route on an API key, and reads the claude-cli route's usage with its newer claude.",
    root: "@anthropic-ai/claude-agent-sdk",
  },
  { id: "llama", title: "Local models", purpose: "Loads GGUF weights into JaiRA itself (the embedded route).", root: "node-llama-cpp" },
  { id: "llama-cpu", title: "Local models: CPU", purpose: "Runs local models on the processor. Works everywhere.", root: "node-llama-cpp", variantOf: "llama" },
  { id: "llama-vulkan", title: "Local models: Vulkan", purpose: "Runs local models on any GPU with a Vulkan driver.", root: "node-llama-cpp", variantOf: "llama" },
  { id: "llama-cuda", title: "Local models: CUDA", purpose: "Runs local models on an NVIDIA GPU.", root: "node-llama-cpp", variantOf: "llama" },
  {
    id: "llama-cuda-ext",
    title: "Local models: CUDA (extended)",
    purpose: "The CUDA build compiled for more NVIDIA GPU generations; larger.",
    root: "node-llama-cpp",
    variantOf: "llama",
  },
  { id: "llama-metal", title: "Local models: Metal", purpose: "Runs local models on an Apple Silicon GPU.", root: "node-llama-cpp", variantOf: "llama" },
];

export function pluginSpec(id: PluginId): PluginSpec {
  const spec = PLUGINS.find((p) => p.id === id);
  if (spec === undefined) throw new Error(`unknown plugin '${id}'`);
  return spec;
}

export function isPluginId(value: string): value is PluginId {
  return PLUGINS.some((p) => p.id === value);
}

/** What a plugin needs, as the store reports it. */
export interface PluginStatus {
  id: PluginId;
  /** The version this build's manifest names. */
  version: string;
  /** Whether this machine can use it at all (a platform with no such package cannot). */
  available: boolean;
  /** The version installed, if one is; it may differ from `version` until the new one is fetched. */
  installed?: string;
  /** For a `llama-*` variant: the one this machine's hardware suggests. */
  recommended?: boolean;
}
