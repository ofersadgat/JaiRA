/**
 * The plugin manifest (decision 0011 §6): every package a downloadable plugin is made of, at the exact
 * version the workspace's lockfile resolved, with the registry URL to fetch it from and the integrity
 * hash to check it against. Built from `package-lock.json` at package time and shipped inside the app
 * (`resources/plugins.json`) and the CLI (`dist/plugins.json`), so installing a plugin needs no npm and
 * no manifest server — only the registry.
 *
 *   node scripts/plugins/manifest.mjs [out.json]      # prints it, or writes it
 *
 * The lockfile already holds what is needed: each package's `resolved` URL and `integrity`, its `os` /
 * `cpu` / `libc` limits, and — by where it sits in the tree — which version of each dependency it uses.
 * For each ROOT (below) the manifest lists:
 *
 *  - `closure`: the root and everything it depends on, `dependencies` and, below the root, the
 *    `optionalDependencies` too (a platform limit filters those at install);
 *  - `platforms`: the root's own `optionalDependencies` — one package per platform or GPU variant
 *    (`@anthropic-ai/claude-agent-sdk-win32-x64`, `@node-llama-cpp/win-x64-vulkan`), each with its own
 *    closure. They are separate downloads, so a machine fetches only the ones it uses.
 *
 * Every package is keyed `<name>@<version>`, and its `dependencies` map each name it requires to the
 * key it resolves to — the store links exactly that (`packages/runtime/src/plugins.ts`). Peer
 * dependencies are not followed: the Agent SDK declares three and imports none of them at run time.
 *
 * The roots are the two packages resolved by name at run time and left out of the installer
 * (`packages/app/package.mjs` `RUNTIME_MODULES`). Plain Node, no dependencies.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The packages a plugin is built around. */
export const PLUGIN_ROOTS = ["@anthropic-ai/claude-agent-sdk", "node-llama-cpp"];

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The lock path a package `name` resolves to from the package at lock path `from`: Node's own walk. */
function resolveFrom(lock, from, name) {
  let base = from;
  for (;;) {
    const candidate = `${base === "" ? "" : `${base}/`}node_modules/${name}`;
    if (lock[candidate] !== undefined) return candidate;
    if (base === "") return undefined;
    const up = base.lastIndexOf("/node_modules/");
    base = up < 0 ? "" : base.slice(0, up);
  }
}

const nameAt = (path) => path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);

export function buildPluginManifest(lockFile = join(repo, "package-lock.json")) {
  const lock = JSON.parse(readFileSync(lockFile, "utf8")).packages;
  const packages = {};

  /** Record the package at `path` and everything it needs; returns its key. */
  function visit(path, includeOptional) {
    const entry = lock[path];
    const name = nameAt(path);
    const key = `${name}@${entry.version}`;
    if (packages[key] !== undefined) return key;
    if (typeof entry.resolved !== "string" || typeof entry.integrity !== "string") {
      throw new Error(`${path} has no resolved URL or integrity in the lockfile`);
    }
    const record = {
      name,
      version: entry.version,
      resolved: entry.resolved,
      integrity: entry.integrity,
      ...(entry.os !== undefined ? { os: entry.os } : {}),
      ...(entry.cpu !== undefined ? { cpu: entry.cpu } : {}),
      ...(entry.libc !== undefined ? { libc: entry.libc } : {}),
      dependencies: {},
    };
    packages[key] = record;
    const wanted = { ...(entry.dependencies ?? {}), ...(includeOptional ? (entry.optionalDependencies ?? {}) : {}) };
    for (const dep of Object.keys(wanted)) {
      const at = resolveFrom(lock, path, dep);
      // An optional dependency for another platform may be absent from the lock; a required one may not.
      if (at === undefined) {
        if (entry.dependencies?.[dep] !== undefined) throw new Error(`${path} requires ${dep}, which the lockfile does not resolve`);
        continue;
      }
      record.dependencies[dep] = visit(at, true);
    }
    return key;
  }

  const closureOf = (key) => {
    const seen = new Set();
    const stack = [key];
    while (stack.length > 0) {
      const next = stack.pop();
      if (seen.has(next)) continue;
      seen.add(next);
      stack.push(...Object.values(packages[next].dependencies));
    }
    return [...seen].sort();
  };

  const roots = {};
  for (const root of PLUGIN_ROOTS) {
    const path = `node_modules/${root}`;
    const entry = lock[path];
    if (entry === undefined) throw new Error(`${root} is not in the lockfile — it has to stay a dependency of the workspace for its plugin to be built`);
    const key = visit(path, false);
    const platforms = {};
    for (const optional of Object.keys(entry.optionalDependencies ?? {})) {
      const at = resolveFrom(lock, path, optional);
      if (at === undefined) continue;
      const platformKey = visit(at, true);
      platforms[optional] = { key: platformKey, closure: closureOf(platformKey) };
    }
    roots[root] = { version: entry.version, key, closure: closureOf(key), platforms };
  }
  return { schema: 1, roots, packages };
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const manifest = buildPluginManifest();
  const out = process.argv[2];
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  if (out === undefined) process.stdout.write(text);
  else writeFileSync(out, text);
}
