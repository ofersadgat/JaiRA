/**
 * The plugin store (decision 0011 §6), against a registry of real tarballs made in a temp directory.
 *
 * A plugin installs the exact packages its manifest names, each checked against its hash and stored
 * once; a dependency is found where the package looks for it; a variant is linked into its root; a
 * removal takes only what nothing else uses and never follows a link; and a root loads from the store.
 */
import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { c as tarCreate } from "tar";
import {
  entryFile,
  importPluginRoot,
  moveInto,
  platformPackageOf,
  PluginStore,
  recommendedLlamaVariant,
  removeTree,
  usePluginStore,
  type PluginManifest,
  type PluginPackage,
  type PluginPlatform,
} from "../src/plugins";

const PLATFORM: PluginPlatform = { os: "win32", arch: "x64" };
let dir: string;
let tarballs: Map<string, Buffer>;
let fetched: string[];

/** Pack `files` as npm does (`package/…`, gzipped) and record it under a registry URL. */
async function publish(name: string, version: string, files: Record<string, string>, extra: Partial<PluginPackage> = {}): Promise<PluginPackage> {
  const src = mkdtempSync(join(dir, "src-"));
  mkdirSync(join(src, "package"), { recursive: true });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(src, "package", path, ".."), { recursive: true });
    writeFileSync(join(src, "package", path), text);
  }
  const file = join(src, "pkg.tgz");
  await tarCreate({ gzip: true, file, cwd: src }, ["package"]);
  const bytes = readFileSync(file);
  const resolved = `https://registry.test/${name}/-/${version}.tgz`;
  tarballs.set(resolved, bytes);
  return { name, version, resolved, integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`, dependencies: {}, ...extra };
}

const esm = (name: string, version: string, body: string, deps: Record<string, string> = {}): Record<string, string> => ({
  "package.json": JSON.stringify({ name, version, type: "module", exports: { ".": { types: "./x.d.ts", default: "./index.js" } }, dependencies: deps }),
  "index.js": body,
});

async function manifestOf(): Promise<PluginManifest> {
  const dep = await publish("shared-dep", "1.0.0", esm("shared-dep", "1.0.0", "export const answer = 42;\n"));
  const sdk = await publish(
    "@anthropic-ai/claude-agent-sdk",
    "0.3.1",
    esm("@anthropic-ai/claude-agent-sdk", "0.3.1", 'import { answer } from "shared-dep";\nexport const query = () => answer;\n', { "shared-dep": "^1" }),
    { dependencies: { "shared-dep": "shared-dep@1.0.0" } },
  );
  const binary = await publish("@anthropic-ai/claude-agent-sdk-win32-x64", "0.3.1", { "package.json": '{"name":"@anthropic-ai/claude-agent-sdk-win32-x64","version":"0.3.1"}', "claude.exe": "MZ" }, { os: ["win32"], cpu: ["x64"] });
  const otherBinary = await publish("@anthropic-ai/claude-agent-sdk-darwin-arm64", "0.3.1", { "package.json": "{}", claude: "" }, { os: ["darwin"], cpu: ["arm64"] });
  const llama = await publish("node-llama-cpp", "3.2.1", esm("node-llama-cpp", "3.2.1", 'import { answer } from "shared-dep";\nexport const getLlama = () => answer + 1;\n'), {
    dependencies: { "shared-dep": "shared-dep@1.0.0" },
  });
  const cpu = await publish("@node-llama-cpp/win-x64", "3.2.1", { "package.json": '{"name":"@node-llama-cpp/win-x64","version":"3.2.1"}', "bins/llama.node": "cpu" }, { os: ["win32"], cpu: ["x64"] });
  const vulkan = await publish("@node-llama-cpp/win-x64-vulkan", "3.2.1", { "package.json": '{"name":"@node-llama-cpp/win-x64-vulkan","version":"3.2.1"}', "bins/llama.node": "vulkan" }, { os: ["win32"], cpu: ["x64"] });
  const key = (p: PluginPackage): string => `${p.name}@${p.version}`;
  const packages = Object.fromEntries([dep, sdk, binary, otherBinary, llama, cpu, vulkan].map((p) => [key(p), p]));
  return {
    schema: 1,
    packages,
    roots: {
      "@anthropic-ai/claude-agent-sdk": {
        version: "0.3.1",
        key: key(sdk),
        closure: [key(sdk), key(dep)],
        platforms: {
          [binary.name]: { key: key(binary), closure: [key(binary)] },
          [otherBinary.name]: { key: key(otherBinary), closure: [key(otherBinary)] },
        },
      },
      "node-llama-cpp": {
        version: "3.2.1",
        key: key(llama),
        closure: [key(llama), key(dep)],
        platforms: { [cpu.name]: { key: key(cpu), closure: [key(cpu)] }, [vulkan.name]: { key: key(vulkan), closure: [key(vulkan)] } },
      },
    },
  };
}

function storeOf(manifest: PluginManifest): PluginStore {
  return new PluginStore({
    home: join(dir, "plugins"),
    manifest,
    platform: PLATFORM,
    gpu: { cuda: false, vulkan: true },
    fetch: async (url) => {
      fetched.push(url);
      const bytes = tarballs.get(url);
      return { ok: bytes !== undefined, status: bytes !== undefined ? 200 : 404, arrayBuffer: async () => new Uint8Array(bytes ?? []).buffer };
    },
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jaira-plugins-"));
  tarballs = new Map();
  fetched = [];
});

afterEach(() => {
  usePluginStore(undefined);
  rmSync(dir, { recursive: true, force: true });
});

describe("the plugin store", () => {
  it("installs a plugin's packages and its machine's binary, and loads the root with its dependency found", async () => {
    const store = storeOf(await manifestOf());
    await store.install("claude-agent-sdk");
    // Only this platform's binary: the darwin one is never fetched.
    expect(fetched.some((u) => u.includes("darwin"))).toBe(false);
    expect(store.platformDir("@anthropic-ai/claude-agent-sdk", "@anthropic-ai/claude-agent-sdk-win32-x64")).toBeDefined();
    const sdk = (await store.load("@anthropic-ai/claude-agent-sdk")) as { query(): number };
    expect(sdk.query()).toBe(42);
    expect(store.status().find((s) => s.id === "claude-agent-sdk")).toMatchObject({ installed: "0.3.1", available: true });
  });

  it("stores a package two plugins share once, and fetches it once", async () => {
    const store = storeOf(await manifestOf());
    await store.install("claude-agent-sdk");
    await store.install("llama");
    expect(fetched.filter((u) => u.includes("shared-dep"))).toHaveLength(1);
    const llama = (await store.load("node-llama-cpp")) as { getLlama(): number };
    expect(llama.getLlama()).toBe(43);
  });

  it("refuses a download that does not match the lockfile's hash, and stores nothing", async () => {
    const manifest = await manifestOf();
    manifest.packages["shared-dep@1.0.0"]!.integrity = `sha512-${createHash("sha512").update("tampered").digest("base64")}`;
    const store = storeOf(manifest);
    await expect(store.install("claude-agent-sdk")).rejects.toThrow(/does not match the lockfile's sha512 hash/);
    expect(existsSync(join(store.packageDir("shared-dep@1.0.0"), "package.json"))).toBe(false);
    expect(store.status().find((s) => s.id === "claude-agent-sdk")?.installed).toBeUndefined();
    // The root itself was stored before the failure; a half-finished install is still never loaded.
    expect(existsSync(join(store.packageDir("@anthropic-ai/claude-agent-sdk@0.3.1"), "package.json"))).toBe(true);
    expect(store.hasRoot("@anthropic-ai/claude-agent-sdk")).toBe(false);
  });

  it("installs a variant's base first, and links the variant where its root looks for it", async () => {
    const store = storeOf(await manifestOf());
    await store.install("llama-vulkan");
    const linked = join(dir, "plugins", "store", "node-llama-cpp@3.2.1", "node_modules", "@node-llama-cpp", "win-x64-vulkan");
    expect(lstatSync(linked).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(linked, "bins", "llama.node"), "utf8")).toBe("vulkan");
    expect(store.status().filter((s) => s.installed !== undefined).map((s) => s.id).sort()).toEqual(["llama", "llama-vulkan"]);
  });

  it("removes what nothing else uses, keeps what something does, and never follows a link", async () => {
    const store = storeOf(await manifestOf());
    await store.install("claude-agent-sdk");
    await store.install("llama-cpu");
    store.remove("llama");
    // The shared dependency is still the SDK's, and the SDK still loads.
    expect(existsSync(join(store.packageDir("shared-dep@1.0.0"), "index.js"))).toBe(true);
    expect(((await store.load("@anthropic-ai/claude-agent-sdk")) as { query(): number }).query()).toBe(42);
    expect(existsSync(join(dir, "plugins", "store", "node-llama-cpp@3.2.1"))).toBe(false);
    expect(existsSync(join(dir, "plugins", "store", "@node-llama-cpp+win-x64@3.2.1"))).toBe(false);
    expect(store.status().filter((s) => s.installed !== undefined).map((s) => s.id)).toEqual(["claude-agent-sdk"]);
  });

  it("deletes a directory holding a link without touching what the link points at", () => {
    const target = join(dir, "target");
    mkdirSync(target);
    writeFileSync(join(target, "keep.txt"), "still here");
    const doomed = join(dir, "doomed");
    mkdirSync(doomed);
    symlinkSync(target, join(doomed, "link"), process.platform === "win32" ? "junction" : "dir");
    removeTree(doomed);
    expect(existsSync(doomed)).toBe(false);
    expect(readFileSync(join(target, "keep.txt"), "utf8")).toBe("still here");
  });

  it("offers only what this machine can use, and suggests the variant its hardware fits", async () => {
    const store = storeOf(await manifestOf());
    const status = Object.fromEntries(store.status().map((s) => [s.id, s]));
    expect(status["llama-vulkan"]).toMatchObject({ available: true, recommended: true });
    expect(status["llama-cpu"]).toMatchObject({ available: true });
    expect(status["llama-cpu"]?.recommended).toBeUndefined();
    expect(status["llama-cuda"]?.available).toBe(false);
    expect(status["llama-metal"]?.available).toBe(false);
  });
});

describe("the notices of what the plugins installed", () => {
  it("lists each stored package once, tagged with every plugin that holds it", async () => {
    const store = storeOf(await manifestOf());
    expect(store.notices()).toEqual([]);
    await store.install("claude-agent-sdk");
    await store.install("llama");
    const notices = Object.fromEntries(store.notices().map((n) => [n.name, n]));
    expect(notices["@anthropic-ai/claude-agent-sdk"]).toMatchObject({ kind: "package", version: "0.3.1", bundles: ["Claude Agent SDK plugin"] });
    expect(notices["shared-dep"]?.bundles).toEqual(["Claude Agent SDK plugin", "Local models plugin"]);
    expect(notices["node-llama-cpp"]?.bundles).toEqual(["Local models plugin"]);
  });
});

describe("moving a download into the store", () => {
  // Windows refuses to rename a directory while a file in it is open — what a virus scanner reading a
  // fresh `.node` binary does, and what failed the person's first CUDA download (EPERM on rename).
  it.runIf(process.platform === "win32")("copies it into place when the rename stays refused", async () => {
    const from = join(dir, "staging");
    const to = join(dir, "final");
    mkdirSync(join(from, "bins"), { recursive: true });
    writeFileSync(join(from, "bins", "llama.node"), "binary");
    const held = openSync(join(from, "bins", "llama.node"), "r");
    try {
      await moveInto(from, to, 2);
    } finally {
      closeSync(held);
    }
    expect(readFileSync(join(to, "bins", "llama.node"), "utf8")).toBe("binary");
  });

  it("renames when nothing holds it", async () => {
    const from = join(dir, "staging2");
    mkdirSync(from);
    writeFileSync(join(from, "a.txt"), "a");
    await moveInto(from, join(dir, "final2"));
    expect(existsSync(from)).toBe(false);
    expect(readFileSync(join(dir, "final2", "a.txt"), "utf8")).toBe("a");
  });
});

describe("a development checkout's own packages", () => {
  it("count as present, from the workspace, when every package a plugin adds is there", async () => {
    const present: Record<string, string> = {
      "@anthropic-ai/claude-agent-sdk": "0.3.1",
      "@anthropic-ai/claude-agent-sdk-win32-x64": "0.3.1",
      "node-llama-cpp": "3.2.1",
      "@node-llama-cpp/win-x64-vulkan": "3.2.1",
    };
    const store = new PluginStore({ home: join(dir, "plugins"), manifest: await manifestOf(), platform: PLATFORM, workspace: (name) => present[name] });
    const status = Object.fromEntries(store.status().map((s) => [s.id, s]));
    expect(status["claude-agent-sdk"]).toMatchObject({ installed: "0.3.1", from: "workspace" });
    expect(status["llama"]).toMatchObject({ installed: "3.2.1", from: "workspace" });
    expect(status["llama-vulkan"]).toMatchObject({ installed: "3.2.1", from: "workspace" });
    expect(status["llama-cpu"]?.installed).toBeUndefined();
    expect(store.outdated()).toEqual([]);
    delete present["@anthropic-ai/claude-agent-sdk-win32-x64"];
    expect(store.status().find((s) => s.id === "claude-agent-sdk")?.installed).toBeUndefined();
  });
});

describe("plugins follow the app", () => {
  it("keeps loading the version an older build installed until this build's is fetched, then drops the old one", async () => {
    const older = storeOf(await manifestOf());
    await older.install("claude-agent-sdk");

    // The app updated: its manifest names a newer SDK.
    const manifest = await manifestOf();
    const next = await publish(
      "@anthropic-ai/claude-agent-sdk",
      "0.3.2",
      esm("@anthropic-ai/claude-agent-sdk", "0.3.2", 'import { answer } from "shared-dep";\nexport const query = () => answer * 2;\n'),
      { dependencies: { "shared-dep": "shared-dep@1.0.0" } },
    );
    manifest.packages["@anthropic-ai/claude-agent-sdk@0.3.2"] = next;
    manifest.roots["@anthropic-ai/claude-agent-sdk"] = { ...manifest.roots["@anthropic-ai/claude-agent-sdk"]!, version: "0.3.2", key: "@anthropic-ai/claude-agent-sdk@0.3.2", closure: ["@anthropic-ai/claude-agent-sdk@0.3.2", "shared-dep@1.0.0"] };
    const store = storeOf(manifest);

    expect(store.outdated()).toEqual(["claude-agent-sdk"]);
    expect(store.status().find((s) => s.id === "claude-agent-sdk")).toMatchObject({ version: "0.3.2", installed: "0.3.1" });
    expect(((await store.load("@anthropic-ai/claude-agent-sdk")) as { query(): number }).query()).toBe(42);
    expect(store.platformDir("@anthropic-ai/claude-agent-sdk", "@anthropic-ai/claude-agent-sdk-win32-x64")).toBeDefined();

    await store.install("claude-agent-sdk");
    expect(store.outdated()).toEqual([]);
    expect(existsSync(join(dir, "plugins", "store", "@anthropic-ai+claude-agent-sdk@0.3.1"))).toBe(false);
    expect(existsSync(join(store.packageDir("shared-dep@1.0.0"), "index.js"))).toBe(true);
  });

  it("says what a download would fetch, counting only what is not stored yet", async () => {
    const manifest = await manifestOf();
    for (const pkg of Object.values(manifest.packages)) pkg.size = 1000;
    const store = storeOf(manifest);
    expect(store.status().find((s) => s.id === "llama")?.downloadBytes).toBe(2000); // node-llama-cpp + shared-dep
    await store.install("claude-agent-sdk"); // stores shared-dep
    expect(store.status().find((s) => s.id === "llama")?.downloadBytes).toBe(1000);
    delete manifest.packages["node-llama-cpp@3.2.1"]!.size;
    expect(storeOf(manifest).status().find((s) => s.id === "llama")?.downloadBytes).toBeUndefined();
  });
});

describe("which packages a machine gets", () => {
  it("names the platform package each plugin adds", () => {
    expect(platformPackageOf("claude-agent-sdk", { os: "linux", arch: "x64", musl: true })).toBe("@anthropic-ai/claude-agent-sdk-linux-x64-musl");
    expect(platformPackageOf("llama-cuda", { os: "win32", arch: "x64" })).toBe("@node-llama-cpp/win-x64-cuda");
    expect(platformPackageOf("llama-cpu", { os: "darwin", arch: "arm64" })).toBeUndefined();
    expect(platformPackageOf("llama-metal", { os: "darwin", arch: "arm64" })).toBe("@node-llama-cpp/mac-arm64-metal");
  });

  it("suggests Metal, then CUDA, then Vulkan, then the CPU build", () => {
    const all = () => true;
    expect(recommendedLlamaVariant({ os: "win32", arch: "x64" }, { cuda: true, vulkan: true }, (id) => id !== "llama-metal")).toBe("llama-cuda");
    expect(recommendedLlamaVariant({ os: "win32", arch: "x64" }, { cuda: false, vulkan: false }, (id) => id !== "llama-metal")).toBe("llama-cpu");
    expect(recommendedLlamaVariant({ os: "darwin", arch: "arm64" }, { cuda: false, vulkan: false }, all)).toBe("llama-metal");
  });

  it("reads a package's entry from its exports, then its main", () => {
    const pkg = join(dir, "pkg");
    mkdirSync(pkg);
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ exports: { ".": { types: "./a.d.ts", import: "./dist/index.js" } } }));
    expect(entryFile(pkg)).toBe(join(pkg, "dist", "index.js"));
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ main: "lib/main.js" }));
    expect(entryFile(pkg)).toBe(join(pkg, "lib", "main.js"));
  });
});

describe("loading a plugin's root", () => {
  it("loads from the active store when the plugin is installed there", async () => {
    const store = storeOf(await manifestOf());
    usePluginStore(store);
    await store.install("claude-agent-sdk");
    expect(((await importPluginRoot("@anthropic-ai/claude-agent-sdk")) as { query(): number }).query()).toBe(42);
  });
});
