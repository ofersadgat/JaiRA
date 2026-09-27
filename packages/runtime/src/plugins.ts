/**
 * The plugin store (decision 0011 §6): downloads a plugin's packages from the npm registry, checks
 * each against the hash the lockfile recorded, stores each ONCE, and loads a plugin's root package
 * from there — with no npm on the machine and nothing downloaded until the person asks.
 *
 * Layout under `<home>` (`<base root>/plugins`, shared by stable and nightly builds and the npm CLI):
 *
 *   store/<name>@<version>/node_modules/<name>/…   the package, unpacked (`/` in a scope becomes `+`)
 *   store/<name>@<version>/node_modules/<dep>     a LINK to the version of <dep> the lockfile resolved
 *   installed.json                                which plugin versions are installed, and their packages
 *
 * pnpm's arrangement, for pnpm's reason: a package resolves its dependencies from its own real path, so
 * a link beside it pins exactly the version the lockfile named, and a package used by two plugins, or
 * by two versions of one, is on disk once. A variant plugin (`@node-llama-cpp/win-x64-vulkan`, this
 * machine's `claude` binary) is linked into its ROOT's directory, where the root looks for it.
 *
 * Links are directory junctions on Windows (no administrator needed) and symlinks elsewhere. Removal
 * never goes THROUGH one: `removeTree` unlinks a link and descends only into real directories — a
 * recursive delete that followed a junction once wiped a sibling repository.
 *
 * The manifest is `scripts/plugins/manifest.mjs`'s output, shipped as `plugins.json` beside the bundle.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Readable } from "node:stream";
import { x as untar } from "tar";
import { setLlamaModuleLoader } from "@declarative-ai/llm";
import { PLUGINS, pluginSpec, type PluginId, type PluginSpec, type PluginStatus } from "@jaira/shared";

export interface PluginPackage {
  name: string;
  version: string;
  resolved: string;
  integrity: string;
  os?: string[];
  cpu?: string[];
  libc?: string[];
  /** The tarball's size in bytes, when the build could ask the registry. */
  size?: number;
  /** Each dependency's name → the key (`name@version`) it resolves to. */
  dependencies: Record<string, string>;
}

export interface PluginManifest {
  schema: 1;
  roots: Record<string, { version: string; key: string; closure: string[]; platforms: Record<string, { key: string; closure: string[] }> }>;
  packages: Record<string, PluginPackage>;
}

/** Which operating system, architecture and C library this is, for picking packages. */
export interface PluginPlatform {
  os: NodeJS.Platform;
  arch: string;
  /** Linux only: musl rather than glibc. */
  musl?: boolean;
}

export function currentPlatform(): PluginPlatform {
  const musl =
    process.platform === "linux" &&
    !(process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header?.glibcVersionRuntime;
  return { os: process.platform, arch: process.arch, ...(musl ? { musl: true } : {}) };
}

/** Where GPU runtimes announce themselves, for suggesting a local-models variant. */
export interface GpuFacts {
  cuda: boolean;
  vulkan: boolean;
}

/** Look for the NVIDIA driver's CUDA library and a Vulkan loader where the systems keep them. */
export function detectGpu(platform: PluginPlatform = currentPlatform(), exists: (path: string) => boolean = existsSync): GpuFacts {
  if (platform.os === "win32") {
    const system = join(process.env["SystemRoot"] ?? "C:\\Windows", "System32");
    return { cuda: exists(join(system, "nvcuda.dll")), vulkan: exists(join(system, "vulkan-1.dll")) };
  }
  if (platform.os === "linux") {
    const libs = ["/usr/lib/x86_64-linux-gnu", "/usr/lib/aarch64-linux-gnu", "/usr/lib64", "/usr/lib", "/usr/lib/wsl/lib"];
    return {
      cuda: libs.some((dir) => exists(join(dir, "libcuda.so.1"))),
      vulkan: libs.some((dir) => exists(join(dir, "libvulkan.so.1"))),
    };
  }
  return { cuda: false, vulkan: false };
}

/** The package a plugin adds for this machine, beyond its root's closure; `undefined` for the root plugins' own part. */
export function platformPackageOf(id: PluginId, platform: PluginPlatform): string | undefined {
  if (id === "claude-agent-sdk") {
    const base = `@anthropic-ai/claude-agent-sdk-${platform.os}-${platform.arch}`;
    return platform.musl === true ? `${base}-musl` : base;
  }
  if (id === "llama") return undefined;
  const os = platform.os === "win32" ? "win" : platform.os === "darwin" ? "mac" : platform.os;
  const stem = `@node-llama-cpp/${os}-${platform.arch}`;
  switch (id) {
    case "llama-cpu":
      // Apple Silicon has only the Metal build.
      return platform.os === "darwin" && platform.arch === "arm64" ? undefined : stem;
    case "llama-vulkan":
      return `${stem}-vulkan`;
    case "llama-cuda":
      return `${stem}-cuda`;
    case "llama-cuda-ext":
      return `${stem}-cuda-ext`;
    case "llama-metal":
      return platform.os === "darwin" && platform.arch === "arm64" ? "@node-llama-cpp/mac-arm64-metal" : undefined;
  }
}

/** The best local-models variant for this machine: Metal, else CUDA, else Vulkan, else the CPU build. */
export function recommendedLlamaVariant(platform: PluginPlatform, gpu: GpuFacts, available: (id: PluginId) => boolean): PluginId | undefined {
  const order: PluginId[] = ["llama-metal", ...(gpu.cuda ? (["llama-cuda"] as const) : []), ...(gpu.vulkan ? (["llama-vulkan"] as const) : []), "llama-cpu"];
  return order.find((id) => available(id));
}

interface InstalledRecord {
  version: string;
  /** Every package key this plugin holds a reference to. */
  keys: string[];
  installedAt: number;
}

interface InstalledFile {
  plugins: Partial<Record<PluginId, InstalledRecord>>;
}

export interface PluginStoreOptions {
  /** `<base root>/plugins`. */
  home: string;
  manifest: PluginManifest;
  platform?: PluginPlatform;
  /** Tests hand in a registry; the default is the real `fetch`. */
  fetch?: (url: string) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;
  gpu?: GpuFacts;
}

export interface InstallProgress {
  /** The package being fetched. */
  package: string;
  /** Packages done, of `total`. */
  done: number;
  total: number;
}

const keyDir = (key: string): string => key.replace(/\//g, "+");

export class PluginStore {
  private readonly platform: PluginPlatform;

  constructor(private readonly options: PluginStoreOptions) {
    this.platform = options.platform ?? currentPlatform();
  }

  private get store(): string {
    return join(this.options.home, "store");
  }

  private read(): InstalledFile {
    try {
      return JSON.parse(readFileSync(join(this.options.home, "installed.json"), "utf8")) as InstalledFile;
    } catch {
      return { plugins: {} };
    }
  }

  private write(file: InstalledFile): void {
    mkdirSync(this.options.home, { recursive: true });
    const target = join(this.options.home, "installed.json");
    writeFileSync(`${target}.tmp`, `${JSON.stringify(file, null, 2)}\n`);
    renameSync(`${target}.tmp`, target);
  }

  /** The package keys a plugin is made of here: its root's closure, or its platform package's. */
  private keysOf(id: PluginId): string[] | undefined {
    const spec = pluginSpec(id);
    const root = this.options.manifest.roots[spec.root];
    if (root === undefined) return undefined;
    const extra = platformPackageOf(id, this.platform);
    if (spec.variantOf !== undefined) {
      if (extra === undefined) return undefined;
      return root.platforms[extra]?.closure.filter((key) => this.fits(key));
    }
    if (extra === undefined) return root.closure.filter((key) => this.fits(key));
    const platform = root.platforms[extra];
    if (platform === undefined) return undefined;
    return [...new Set([...root.closure, ...platform.closure])].filter((key) => this.fits(key));
  }

  /** Whether a package's `os`/`cpu`/`libc` limits admit this machine. */
  private fits(key: string): boolean {
    const pkg = this.options.manifest.packages[key];
    if (pkg === undefined) return false;
    const admits = (list: string[] | undefined, value: string): boolean =>
      list === undefined || (list.some((v) => v === value) && !list.includes(`!${value}`)) || (list.every((v) => v.startsWith("!")) && !list.includes(`!${value}`));
    if (!admits(pkg.os, this.platform.os)) return false;
    if (!admits(pkg.cpu, this.platform.arch)) return false;
    if (pkg.libc !== undefined && this.platform.os === "linux" && !admits(pkg.libc, this.platform.musl === true ? "musl" : "glibc")) return false;
    return true;
  }

  /** Every plugin, as this machine sees it. */
  status(): PluginStatus[] {
    const installed = this.read().plugins;
    const available = (id: PluginId): boolean => this.keysOf(id) !== undefined;
    const recommended = recommendedLlamaVariant(this.platform, this.options.gpu ?? detectGpu(this.platform), available);
    return PLUGINS.map((spec) => {
      const download = this.downloadBytes(spec.id);
      return {
        id: spec.id,
        version: this.options.manifest.roots[spec.root]?.version ?? "",
        available: available(spec.id),
        ...(installed[spec.id] !== undefined ? { installed: installed[spec.id]!.version } : {}),
        ...(spec.variantOf !== undefined && spec.id === recommended ? { recommended: true } : {}),
        ...(download !== undefined ? { downloadBytes: download } : {}),
      };
    });
  }

  /** What installing this build's version of a plugin would fetch; unknown when a size is missing. */
  private downloadBytes(id: PluginId): number | undefined {
    const keys = this.keysOf(id);
    if (keys === undefined) return undefined;
    let total = 0;
    for (const key of keys) {
      if (this.stored(key)) continue;
      const size = this.options.manifest.packages[key]?.size;
      if (size === undefined) return undefined;
      total += size;
    }
    return total;
  }

  /** The installed plugins whose version is not this build's: what an app update left behind. */
  outdated(): PluginId[] {
    const installed = this.read().plugins;
    return PLUGINS.filter((spec) => {
      const record = installed[spec.id];
      return record !== undefined && record.version !== this.options.manifest.roots[spec.root]?.version && this.keysOf(spec.id) !== undefined;
    }).map((spec) => spec.id);
  }

  private stored(key: string): boolean {
    return existsSync(join(this.packageDir(key), "package.json"));
  }

  /**
   * The key of the root package to load: this build's version when it is stored, else the version
   * installed before an app update named a newer one — kept working until the newer one is fetched.
   */
  private rootKey(root: PluginSpec["root"]): string | undefined {
    const entry = this.options.manifest.roots[root];
    if (entry !== undefined && this.stored(entry.key)) return entry.key;
    const base = PLUGINS.find((p) => p.root === root && p.variantOf === undefined);
    const record = base !== undefined ? this.read().plugins[base.id] : undefined;
    if (record === undefined) return undefined;
    const key = `${root}@${record.version}`;
    return this.stored(key) ? key : undefined;
  }

  /** Whether the root package a family is built around is installed (this build's version, or an older one). */
  hasRoot(root: PluginSpec["root"]): boolean {
    return this.rootKey(root) !== undefined;
  }

  /** Where the installed root package is, or nothing when none is installed. */
  rootDir(root: PluginSpec["root"]): string | undefined {
    const key = this.rootKey(root);
    return key !== undefined ? this.packageDir(key) : undefined;
  }

  /** Where a stored package's files are. */
  packageDir(key: string): string {
    const pkg = this.options.manifest.packages[key];
    const name = pkg?.name ?? key.slice(0, key.lastIndexOf("@"));
    return join(this.store, keyDir(key), "node_modules", name);
  }

  /** The directory of an installed platform package, found beside its root (`@anthropic-ai/claude-agent-sdk-win32-x64`). */
  platformDir(root: PluginSpec["root"], name: string): string | undefined {
    const key = this.rootKey(root);
    if (key === undefined) return undefined;
    const dir = join(this.store, keyDir(key), "node_modules", name);
    return existsSync(join(dir, "package.json")) ? dir : undefined;
  }

  /** Download, check and store a plugin (and its base, for a variant). Already-stored packages are not fetched again. */
  async install(id: PluginId, progress?: (p: InstallProgress) => void): Promise<void> {
    const spec = pluginSpec(id);
    if (spec.variantOf !== undefined && this.read().plugins[spec.variantOf] === undefined) await this.install(spec.variantOf, progress);
    const keys = this.keysOf(id);
    if (keys === undefined) throw new Error(`${spec.title} is not available for ${this.platform.os}-${this.platform.arch}`);
    const missing = keys.filter((key) => !existsSync(join(this.packageDir(key), "package.json")));
    let done = 0;
    for (const key of missing) {
      progress?.({ package: key, done, total: missing.length });
      await this.fetchPackage(key);
      done += 1;
    }
    progress?.({ package: "", done, total: missing.length });
    for (const key of keys) this.linkDependencies(key);
    const root = this.options.manifest.roots[spec.root]!;
    const extra = platformPackageOf(id, this.platform);
    if (extra !== undefined) {
      const platform = root.platforms[extra]!;
      this.link(join(this.store, keyDir(root.key), "node_modules", extra), this.packageDir(platform.key));
    }
    const file = this.read();
    file.plugins[id] = { version: root.version, keys, installedAt: Date.now() };
    this.write(file);
    // An older version this one replaced is now nobody's. Best effort: on Windows a native file the
    // running app has loaded cannot be deleted, and the next collection takes it instead.
    this.collect(file);
  }

  /** Remove a plugin (and its variants, for a base), then every stored package nothing installed still uses. */
  remove(id: PluginId): void {
    const file = this.read();
    const doomed = [id, ...PLUGINS.filter((p) => p.variantOf === id).map((p) => p.id)];
    for (const each of doomed) {
      const extra = platformPackageOf(each, this.platform);
      const rootKey = this.rootKey(pluginSpec(each).root);
      if (extra !== undefined && rootKey !== undefined && pluginSpec(each).variantOf !== undefined) {
        removeTree(join(this.store, keyDir(rootKey), "node_modules", extra));
      }
      delete file.plugins[each];
    }
    this.write(file);
    this.collect(file);
  }

  /** Delete every stored package no installed plugin lists. */
  private collect(file: InstalledFile): void {
    if (!existsSync(this.store)) return;
    const kept = new Set(Object.values(file.plugins).flatMap((r) => (r?.keys ?? []).map(keyDir)));
    for (const dir of readdirSync(this.store)) {
      if (kept.has(dir) || dir.startsWith(".")) continue;
      try {
        removeTree(join(this.store, dir));
      } catch {
        // in use (a loaded native file on Windows): left for the next collection
      }
    }
  }

  private async fetchPackage(key: string): Promise<void> {
    const pkg = this.options.manifest.packages[key];
    if (pkg === undefined) throw new Error(`the plugin manifest has no ${key}`);
    const fetcher = this.options.fetch ?? ((url: string) => fetch(url));
    const response = await fetcher(pkg.resolved);
    if (!response.ok) throw new Error(`${key}: the registry answered ${response.status} for ${pkg.resolved}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const [algorithm, expected] = pkg.integrity.split("-", 2) as [string, string];
    const actual = createHash(algorithm).update(bytes).digest("base64");
    if (actual !== expected) throw new Error(`${key}: the download does not match the lockfile's ${algorithm} hash, so it was not stored`);
    // Unpacked beside the store and renamed in: a package is either wholly there or not there at all.
    const staging = join(this.store, `.staging-${process.pid}-${keyDir(key)}`);
    removeTree(staging);
    const target = join(staging, "node_modules", pkg.name);
    mkdirSync(target, { recursive: true });
    await new Promise<void>((resolve, reject) => {
      const unpack = untar({ cwd: target, strip: 1 });
      unpack.on("error", reject);
      unpack.on("close", () => resolve());
      Readable.from([bytes]).pipe(unpack as unknown as NodeJS.WritableStream);
    });
    const final = join(this.store, keyDir(key));
    removeTree(final);
    renameSync(staging, final);
  }

  /** Link each dependency the lockfile resolved beside the package, where it will look for it. */
  private linkDependencies(key: string): void {
    const pkg = this.options.manifest.packages[key];
    if (pkg === undefined) return;
    for (const [dep, depKey] of Object.entries(pkg.dependencies)) {
      if (!existsSync(join(this.packageDir(depKey), "package.json"))) continue; // an optional one for another platform
      this.link(join(this.store, keyDir(key), "node_modules", dep), this.packageDir(depKey));
    }
  }

  private link(path: string, target: string): void {
    try {
      const existing = lstatSync(path);
      if (existing.isSymbolicLink()) return;
      removeTree(path);
    } catch {
      // not there yet
    }
    mkdirSync(dirname(path), { recursive: true });
    symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
  }

  /** Load an installed root package: `import()` of its entry, from the store. */
  async load(root: PluginSpec["root"]): Promise<unknown> {
    const dir = this.rootDir(root);
    if (dir === undefined) throw new Error(`${root} is not installed`);
    return import(/* @vite-ignore */ pathToFileURL(entryFile(dir)).href);
  }
}

/** A package's ESM entry: its `exports["."]` under the `node`/`import`/`default` conditions, else `main`. */
export function entryFile(dir: string): string {
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { exports?: unknown; main?: string };
  const pick = (value: unknown): string | undefined => {
    if (typeof value === "string") return value;
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if ("." in record) return pick(record["."]);
    for (const condition of ["node", "import", "default"]) {
      const found = pick(record[condition]);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return join(dir, pick(manifest.exports) ?? manifest.main ?? "index.js");
}

/** Delete a directory without ever following a link inside it: a link is removed, not descended into. */
export function removeTree(path: string): void {
  let info;
  try {
    info = lstatSync(path);
  } catch {
    return;
  }
  if (info.isSymbolicLink()) {
    // A junction is a directory to Windows: `rmdir` removes the link itself and never its target.
    try {
      unlinkSync(path);
    } catch {
      rmdirSync(path);
    }
    return;
  }
  if (info.isDirectory()) {
    for (const child of readdirSync(path)) removeTree(join(path, child));
    rmdirSync(path);
    return;
  }
  unlinkSync(path);
}

// ---------------------------------------------------------------------------------------------------
// The process's store: set once at startup by the app and the CLI, read by every loader below.

let active: PluginStore | undefined;

/** Make `store` the one every plugin loader in this process reads. */
export function usePluginStore(store: PluginStore | undefined): void {
  active = store;
}

export function activePluginStore(): PluginStore | undefined {
  return active;
}

/** The manifest shipped beside the bundle (`dist/plugins.json`), or nothing (tests, source runs). */
export function readBundledPluginManifest(dir: string): PluginManifest | undefined {
  try {
    return JSON.parse(readFileSync(join(dir, "plugins.json"), "utf8")) as PluginManifest;
  } catch {
    return undefined;
  }
}

/**
 * Open this process's plugin store and point the loaders at it: the app's main process and the CLI
 * call this once at startup. `bundleDir` is where the bundle and its `plugins.json` are; without a
 * manifest (tests, a run from source) there is no store, and each plugin root is imported by name.
 */
export function startPlugins(baseDir: string, bundleDir: string): PluginStore | undefined {
  const manifest = readBundledPluginManifest(bundleDir);
  const store = manifest !== undefined ? new PluginStore({ home: join(baseDir, "plugins"), manifest }) : undefined;
  usePluginStore(store);
  setLlamaModuleLoader(() => importPluginRoot("node-llama-cpp"));
  return store;
}

/** What to say when a plugin's root is needed and missing. */
export function pluginMissing(root: PluginSpec["root"]): Error {
  const spec = PLUGINS.find((p) => p.root === root && p.variantOf === undefined)!;
  return new Error(`${spec.title} is not installed: download it on the About page, or run \`jaira plugin install ${spec.id}\``);
}

/**
 * Load a family's root package: from the store when it is installed there, else by its name from
 * wherever this code is resolved — a development checkout, or an npm install that has it — else say
 * how to get it.
 */
export async function importPluginRoot(root: PluginSpec["root"]): Promise<unknown> {
  if (active?.hasRoot(root) === true) return active.load(root);
  try {
    return await import(/* @vite-ignore */ root);
  } catch {
    throw pluginMissing(root);
  }
}

/** Where a family's root package is, for a probe that must not load it: the store's copy, else by name. */
export function resolvePluginRoot(root: PluginSpec["root"], resolve: (id: string) => string): string {
  const dir = active?.rootDir(root);
  return dir !== undefined ? join(dir, "package.json") : resolve(root);
}
