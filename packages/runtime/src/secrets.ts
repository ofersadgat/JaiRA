/**
 * Where an executor's credential comes from (DESIGN §8.1).
 *
 * `config.json` names a secret; it never holds one. That split exists because project config is
 * COMMITTED source — a key written there is a key in everyone's checkout and in the history
 * forever. So the name is configuration and the value is looked up, here, at the moment it is
 * needed.
 *
 * The chain, first hit wins:
 *
 * ```text
 *   1. the OS keychain          Electron's safeStorage, encrypted at rest — app only
 *   2. <project>/.env.local     this checkout, not committed
 *   3. <project>/.env           this checkout, possibly committed
 *   4. <base>/.env.local        the machine, for every project
 *   5. <base>/.env              the machine, for every project
 *   6. the process environment  CI, a shell that exported it, a wrapper script
 * ```
 *
 * The order is narrowest-to-widest, which is the only order that lets a specific answer beat a
 * general one: a key set for one project must win over the machine-wide default, or per-project
 * credentials would be impossible to express. The keychain leads because it is the only entry that
 * is not plaintext on disk, and the environment trails because it is the one JaiRA cannot see the
 * provenance of.
 *
 * The CLI has no keychain — `safeStorage` is Electron's, and there is no way to reach it from a
 * plain Node process. That is not a gap to work around: it is why entries 2–6 exist and why the
 * app must never be the ONLY place a credential can live, or a workflow would run in the app and
 * fail on the command line for reasons nothing reports.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SecretOrigin, SecretSource } from "@jaira/shared";

// The wire shapes live in `shared` so the renderer can name them without importing this Node-only
// package; the behaviour lives here.
export type { SecretOrigin, SecretSource } from "@jaira/shared";
export { SECRET_SOURCE_LABELS } from "@jaira/shared";

export interface SecretHit extends SecretOrigin {
  value: string;
}

export interface SecretResolverOptions {
  /** The project's own directory — `.env.local` / `.env` sit directly in it. */
  projectDir?: string;
  /** The shared base root (`~/.jaira`). */
  baseDir?: string;
  /**
   * The OS keychain, when there is one. Electron's `safeStorage` is synchronous and main-process
   * only, so it is injected rather than imported: `@jaira/runtime` is shared with the CLI, and
   * importing `electron` here would make the CLI unloadable.
   */
  keychain?: (name: string) => string | undefined;
  /** The process environment. Injected so a test does not have to mutate the real one. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Parse a `.env` document.
 *
 * Deliberately small, and matching the conventions people already have in these files rather than
 * inventing a dialect: `#` comments, a `export ` prefix, optional single or double quotes, and
 * `\n` escapes inside double quotes only — which is where every `.env` format agrees. Anything it
 * does not understand is skipped rather than throwing, because a malformed line in a credentials
 * file must not stop a run from starting; the credential will simply not be found, and THAT is the
 * error the caller reports.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2]!.trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"');
    } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      // Single quotes are literal, as in a POSIX shell — no escape processing.
      value = value.slice(1, -1);
    } else {
      // Unquoted: an inline comment ends the value, which is what `KEY=v # note` is expected to mean.
      value = value.replace(/\s+#.*$/, "").trim();
    }
    out[match[1]!] = value;
  }
  return out;
}

/** One file-backed link of the chain. */
interface FileLink {
  source: SecretSource;
  file: string;
}

export class SecretResolver {
  private readonly links: FileLink[];
  /** Parsed once per resolver: a run asks for the same few names repeatedly. */
  private readonly cache = new Map<string, Record<string, string>>();

  constructor(private readonly options: SecretResolverOptions = {}) {
    const { projectDir, baseDir } = options;
    this.links = [
      ...(projectDir !== undefined
        ? ([
            { source: "project-env-local", file: join(projectDir, ".env.local") },
            { source: "project-env", file: join(projectDir, ".env") },
          ] as FileLink[])
        : []),
      ...(baseDir !== undefined
        ? ([
            { source: "base-env-local", file: join(baseDir, ".env.local") },
            { source: "base-env", file: join(baseDir, ".env") },
          ] as FileLink[])
        : []),
    ];
  }

  private read(file: string): Record<string, string> {
    const cached = this.cache.get(file);
    if (cached !== undefined) return cached;
    let parsed: Record<string, string>;
    try {
      parsed = parseEnvFile(readFileSync(file, "utf8"));
    } catch {
      // Absent or unreadable is the normal case — most projects have none of these files.
      parsed = {};
    }
    this.cache.set(file, parsed);
    return parsed;
  }

  /** The value and where it came from, or `undefined` when no link supplies it. */
  lookup(name: string): SecretHit | undefined {
    const fromKeychain = this.options.keychain?.(name);
    if (fromKeychain !== undefined && fromKeychain.length > 0) {
      return { value: fromKeychain, source: "keychain" };
    }
    for (const link of this.links) {
      const value = this.read(link.file)[name];
      if (value !== undefined && value.length > 0) return { value, source: link.source, file: link.file };
    }
    const fromEnv = (this.options.env ?? process.env)[name];
    if (fromEnv !== undefined && fromEnv.length > 0) return { value: fromEnv, source: "environment" };
    return undefined;
  }

  /**
   * Where a secret WOULD come from, without returning it.
   *
   * The whole reason this is separate from {@link lookup}: the settings UI has to tell a user
   * whether their key is found and which file it came from, and it can do that without the value
   * ever crossing the IPC boundary into the renderer.
   */
  describe(name: string): SecretOrigin | undefined {
    const hit = this.lookup(name);
    if (hit === undefined) return undefined;
    return { source: hit.source, ...(hit.file !== undefined ? { file: hit.file } : {}) };
  }
}

