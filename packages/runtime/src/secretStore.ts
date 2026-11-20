/**
 * The encrypted secret store every JaiRA process on a machine shares: the app, `jaira serve`, the `jaira`
 * command line, and a build run from source (decision 0012 §6, amended 2026-11-20, the person: "it
 * sounds like the different builds are storing their secrets in different places. they shouldnt").
 *
 * It was Electron's `safeStorage` over `userData/secrets.json`, and both halves of that belong to one
 * BUILD, not to the person: the ciphertext sat in the app's own folder (`Application Support/JaiRA`
 * for the installed app, `Application Support/@jaira/app` for one run from source), and the key that
 * opens it is the app's — a Keychain entry named after the app on a Mac, a key in that folder's `Local
 * State` on Windows. So a Mac that paired with another machine while running from source kept the
 * token for it where the installed app could not read it, and the installed app knew the machine and
 * could not reach it. A plain Node process (`jaira serve` from npm, the command line) had none at all.
 *
 * Here both halves are the person's:
 *
 * - **The ciphertext** is `<base>/system/secrets.json`, beside the rest of what every build shares:
 *   `{ "v": 1, "entries": { "<name>": "<base64 iv · tag · ciphertext>" } }`, AES-256-GCM, written whole
 *   through a temporary file and a rename, so a crash mid-write leaves the last good file.
 * - **The key** is 32 random bytes kept by the operating system under one fixed name, made the first
 *   time it is needed: the login Keychain's generic password `JaiRA Secrets` (through `security`, so
 *   every build reaches it without a prompt — as any program the person runs can, which is the same
 *   reach their shell's own credentials have); Windows' DPAPI for the current user, the protected key
 *   in `<base>/system/secrets.key`; the Secret Service on Linux (`secret-tool`), where there is one.
 *   A copied `secrets.json` is not a copied credential: the key does not travel with it.
 *
 * With no key to be had — a Linux session with no keyring, a locked Keychain over ssh — the store is
 * unavailable and says why, and the secret chain starts at `.env.local`, as it always has there.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

/** What the store is: the port the service's secret chain reads (`KeychainPort`). */
export interface SharedSecretStore {
  available(): boolean;
  readonly reason?: string;
  get(name: string): string | undefined;
  set(name: string, value: string): void;
  remove(name: string): void;
  names(): string[];
}

/** Where the key comes from: read it, or make it when there is none. Undefined: there is no way to keep one here. */
export interface SecretKeySource {
  /** The key, made when `create` and there is none yet; undefined when none is kept and none was made. */
  key(create: boolean): Buffer | undefined;
  /** Why no key can be had here, in a sentence. */
  readonly reason: string;
}

export interface SharedSecretStoreOptions {
  /** The shared root (`~/.jaira`): the ciphertext is in its `system` folder. */
  baseDir: string;
  /** The key's keeper. Absent: the operating system's (`osSecretKey`). A test passes its own. */
  keySource?: SecretKeySource;
}

interface StoreFile {
  v: 1;
  entries: Record<string, string>;
}

/** How long a failure to get the key is believed before it is tried again: a keyring can appear later in a session. */
const KEY_RETRY_MS = 30_000;

export function sharedSecretStore(options: SharedSecretStoreOptions): SharedSecretStore {
  const file = join(options.baseDir, "system", "secrets.json");
  const source = options.keySource ?? osSecretKey(options.baseDir);
  let key: Buffer | undefined;
  // When a look found no key, and whether that look would have made one: believed for a while, so a
  // locked Keychain is not asked again at every read — but a read's "none yet" never stops a write making it.
  let missed: { at: number; made: boolean } | undefined;
  let parsed: { mtimeMs: number; size: number; file: StoreFile } | undefined;

  const keyOf = (create: boolean): Buffer | undefined => {
    if (key !== undefined) return key;
    if (missed !== undefined && Date.now() - missed.at < KEY_RETRY_MS && (missed.made || !create)) return undefined;
    try {
      key = source.key(create);
    } catch {
      key = undefined;
    }
    missed = key === undefined ? { at: Date.now(), made: create } : undefined;
    return key;
  };

  // Read fresh whenever the file changed — another JaiRA process may have written it — and only then.
  const read = (): StoreFile => {
    let stat;
    try {
      stat = statSync(file);
    } catch {
      return { v: 1, entries: {} };
    }
    if (parsed !== undefined && parsed.mtimeMs === stat.mtimeMs && parsed.size === stat.size) return parsed.file;
    let doc: StoreFile;
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<StoreFile>;
      doc = { v: 1, entries: raw.entries !== null && typeof raw.entries === "object" ? { ...raw.entries } : {} };
    } catch {
      doc = { v: 1, entries: {} };
    }
    parsed = { mtimeMs: stat.mtimeMs, size: stat.size, file: doc };
    return doc;
  };

  const write = (doc: StoreFile): void => {
    mkdirSync(join(options.baseDir, "system"), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
    parsed = undefined;
  };

  return {
    available: () => keyOf(true) !== undefined,
    get reason() {
      return source.reason;
    },
    get: (name) => {
      const blob = read().entries[name];
      if (blob === undefined) return undefined;
      const k = keyOf(false);
      return k === undefined ? undefined : open(k, blob);
    },
    set: (name, value) => {
      const k = keyOf(true);
      if (k === undefined) throw new Error(`no encrypted store here: ${source.reason}`);
      const doc = read();
      write({ v: 1, entries: { ...doc.entries, [name]: seal(k, value) } });
    },
    remove: (name) => {
      const doc = read();
      if (doc.entries[name] === undefined) return;
      const { [name]: _gone, ...rest } = doc.entries;
      write({ v: 1, entries: rest });
    },
    names: () => Object.keys(read().entries),
  };
}

function seal(key: Buffer, value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}

/** The value, or undefined when it cannot be opened (another key, a damaged entry): read as absent. */
function open(key: Buffer, blob: string): string | undefined {
  try {
    const bytes = Buffer.from(blob, "base64");
    const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8");
  } catch {
    return undefined;
  }
}

// --- the key, kept by the operating system ---------------------------------------------------------

/** The Keychain item's service and account, the Secret Service's attribute: one name for every build. */
const KEY_NAME = "JaiRA Secrets";
const KEY_ACCOUNT = "jaira";
const KEY_TIMEOUT_MS = 15_000;

const fresh = (): Buffer => randomBytes(32);
const asKey = (text: string | undefined): Buffer | undefined => {
  const bytes = text !== undefined ? Buffer.from(text.trim(), "base64") : undefined;
  return bytes !== undefined && bytes.length === 32 ? bytes : undefined;
};

/** The operating system's keeper of the store's key, for this platform. */
export function osSecretKey(baseDir: string, platform: NodeJS.Platform = process.platform): SecretKeySource {
  if (platform === "darwin") return macKeychainKey();
  if (platform === "win32") return windowsDpapiKey(join(baseDir, "system", "secrets.key"));
  return secretServiceKey();
}

function run(file: string, args: string[], input?: string): { ok: boolean; out: string } {
  const result = spawnSync(file, args, { input, encoding: "utf8", timeout: KEY_TIMEOUT_MS, windowsHide: true });
  return { ok: result.status === 0 && result.error === undefined, out: result.stdout ?? "" };
}

/**
 * The login Keychain, through `/usr/bin/security`. The key goes in on stdin (`security -i`), never on a
 * command line. An item `security` made opens to `security` without a prompt, whichever build asks.
 */
function macKeychainKey(): SecretKeySource {
  const find = (): Buffer | undefined => {
    const found = run("/usr/bin/security", ["find-generic-password", "-s", KEY_NAME, "-a", KEY_ACCOUNT, "-w"]);
    return found.ok ? asKey(found.out) : undefined;
  };
  return {
    reason: "the login Keychain cannot be reached (locked, or this is a session without one), so secrets must go in a .env.local file",
    key: (create) => {
      const had = find();
      if (had !== undefined || !create) return had;
      // Without -U: if another JaiRA process made one first, this fails and theirs is read back.
      run("/usr/bin/security", ["-i"], `add-generic-password -s "${KEY_NAME}" -a ${KEY_ACCOUNT} -l "${KEY_NAME}" -w ${fresh().toString("base64")}\n`);
      return find();
    },
  };
}

/**
 * Windows' DPAPI for the current user: the key, protected, in `secrets.key`. Windows PowerShell does
 * the protecting (its .NET has `ProtectedData`), once per process; the bytes go over stdin.
 */
function windowsDpapiKey(keyFile: string): SecretKeySource {
  const shell = join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const dpapi = (verb: "Protect" | "Unprotect", base64: string): string | undefined => {
    const script = `Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::${verb}($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))`;
    const result = run(shell, ["-NoProfile", "-NonInteractive", "-Command", script], base64);
    return result.ok ? result.out.trim() : undefined;
  };
  const readKey = (): Buffer | undefined => (existsSync(keyFile) ? asKey(dpapi("Unprotect", readFileSync(keyFile, "utf8").trim())) : undefined);
  return {
    reason: "Windows could not protect a key for this account (DPAPI through Windows PowerShell), so secrets must go in a .env.local file",
    key: (create) => {
      const had = readKey();
      if (had !== undefined || !create || existsSync(keyFile)) return had;
      const sealed = dpapi("Protect", fresh().toString("base64"));
      if (sealed === undefined) return undefined;
      mkdirSync(join(keyFile, ".."), { recursive: true });
      try {
        // Exclusive: if another JaiRA process made one first, theirs is read back.
        writeFileSync(keyFile, `${sealed}\n`, { flag: "wx", mode: 0o600 });
      } catch {
        // made by someone else meanwhile
      }
      return readKey();
    },
  };
}

/** The Secret Service (GNOME Keyring, KWallet), through `secret-tool`; none in a session without a keyring. */
function secretServiceKey(): SecretKeySource {
  const find = (): Buffer | undefined => {
    const found = run("secret-tool", ["lookup", "service", KEY_NAME, "account", KEY_ACCOUNT]);
    return found.ok ? asKey(found.out) : undefined;
  };
  return {
    reason: "this session has no Secret Service keyring (secret-tool), so secrets must go in a .env.local file",
    key: (create) => {
      const had = find();
      if (had !== undefined || !create) return had;
      run("secret-tool", ["store", `--label=${KEY_NAME}`, "service", KEY_NAME, "account", KEY_ACCOUNT], fresh().toString("base64"));
      return find();
    },
  };
}
