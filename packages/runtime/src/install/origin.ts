/**
 * How a binary was installed, read off where it really lives: a Homebrew Caskroom or Cellar, a
 * global `node_modules`, WinGet's, Chocolatey's or Scoop's folders, the vendor's own installer's —
 * and, for a language, the version manager's (`~/.nvm/versions/node/…`, `~/.pyenv/versions/…`). The
 * update, or the version a project wants, then goes back through the same installer, by the same
 * program, that put it there. A path that says nothing known is no way at all, rather than a guess.
 */
import type { InstallMethod } from "@jaira/shared";
import { managedName, type ToolPackage, type VersionManager } from "./catalog";
import { npmNames } from "./locate";

/** How a binary was installed, read off where it really lives, with what the update needs from there. */
export interface InstallOrigin {
  method: InstallMethod;
  /** The installer's own prefix, for the program that updates it: Homebrew's, npm's. */
  prefix?: string;
  /** A Homebrew cask's or formula's name, and which of the two. */
  name?: string;
  formula?: boolean;
  /** The npm package it was installed as — an old name updates as itself. */
  npmName?: string;
}

/**
 * Where each version manager keeps what it installs, and the shims it puts on the PATH — for this
 * package by the name the manager knows it by, so a pnpm npm put under mise's Node is npm's, not mise's.
 */
function managerPaths(manager: VersionManager, pkg: ToolPackage): readonly RegExp[] {
  const name = managedName(pkg, manager).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const binary = pkg.binary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  switch (manager) {
    case "nvm":
      // nvm's versions, or nvm-windows' (`%NVM_HOME%\\v22.11.0\\node.exe`).
      return [/\/\.?nvm\/versions\/node\/[^/]+\/bin\/[^/]+$/, /\/nvm\/v\d[^/]*\/[^/]+$/i];
    case "fnm":
      return [/\/fnm\/node-versions\/[^/]+\/installation\/bin\/[^/]+$/, /\/fnm_multishells\/[^/]+\/bin\/[^/]+$/, /\/fnm\/aliases\/[^/]+\/bin\/[^/]+$/];
    case "volta":
      return [new RegExp(`/\\.volta/(bin/(${binary}|volta-shim)(\\.exe)?$|tools/image/${name}/)`, "i"), /\/Volta\/bin\/volta-shim(\.exe)?$/i];
    case "mise":
      return [new RegExp(`/mise/installs/${name}/`), new RegExp(`/mise/shims/${binary}(\\.exe)?$`, "i")];
    case "asdf":
      return [new RegExp(`/\\.asdf/installs/${name}/`), new RegExp(`/\\.asdf/shims/${binary}$`)];
    case "pyenv":
      return [/\/\.pyenv\/(versions|shims)\//];
    case "uv":
      // `~/.local/share/uv/python/…`; on Windows `%APPDATA%\uv\data\python\…`.
      return [/\/uv\/(data\/)?python\//];
    case "rbenv":
      return [/\/\.rbenv\/(versions|shims)\//];
    case "rustup":
      // rustup's proxies in ~/.cargo/bin are links to rustup itself; the toolchains are its own.
      return [/\/\.rustup\/toolchains\//, /\/\.cargo\/bin\/(rustc|cargo|rustup)(\.exe)?$/i];
    case "corepack":
      return [/\/node_modules\/corepack\//];
  }
}

/** Read an install's way off the path its binary resolves to; undefined when the path says nothing known. */
export function installOriginOf(real: string, pkg: ToolPackage): InstallOrigin | undefined {
  const p = real.replace(/\\/g, "/");
  // A version manager the package is kept with: its folders say so before anything else they hold.
  const manager = pkg.managers?.find((one) => managerPaths(one, pkg).some((path) => path.test(p)));
  if (manager !== undefined) return { method: manager };
  const brew = /^(.*)\/(Caskroom|Cellar)\/([^/]+)\//.exec(p);
  if (brew !== null) return { method: "homebrew", prefix: brew[1]!, name: brew[3]!, formula: brew[2] === "Cellar" };
  if (/\/WinGet\/(Packages|Links)\//i.test(p)) return { method: "winget" };
  if (/\/chocolatey\/(lib|bin)\//i.test(p)) return { method: "chocolatey" };
  if (/\/scoop\/(apps|shims)\//i.test(p)) return { method: "scoop" };
  // Apple's own git, read where /usr/bin/git hands over to (`withoutApplePlaceholder`): the Command Line
  // Tools'. Xcode's says nothing JaiRA could install or update it by.
  if (pkg.xcode === true && /^\/Library\/Developer\/CommandLineTools\//.test(p)) return { method: "command-line-tools" };
  if (pkg.native?.paths.some((path) => path.test(p)) === true) return { method: "native" };
  const npmName = npmNames(pkg).find((name) => p.includes(`/node_modules/${name}/`) || p.endsWith(`/node_modules/${name}`));
  if (npmName === undefined) return undefined;
  if (/\/\.bun\/install\/global\//.test(p)) return { method: "bun", npmName };
  if (/\/pnpm\/global\//i.test(p) || /\/\.pnpm-global\//.test(p)) return { method: "pnpm", npmName };
  // POSIX keeps a global package in <prefix>/lib/node_modules, Windows in <prefix>\node_modules.
  const before = p.slice(0, p.indexOf(`/node_modules/${npmName}`));
  return { method: "npm", prefix: before.endsWith("/lib") ? before.slice(0, -4) : before, npmName };
}
