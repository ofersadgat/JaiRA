/**
 * The machine's integrity key: 32 bytes that sign every approval row (SPEC §7.5.5).
 *
 * The key exists so that writing a row into `module_approvals` is not the same as being approved.
 * This module is about the other half of that: where the key itself lives, and how little a copy of
 * the file is worth.
 *
 * ## Wrapped by the platform where the platform offers it
 *
 * A key sitting in a file as plaintext is a key that travels — into a backup, a synced profile
 * directory, a dotfiles repository, an archive somebody mails themselves. Windows offers DPAPI
 * (`ProtectedData`, `CurrentUser` scope), which binds a blob to the logged-in account, so a copy of
 * the file taken off this machine decrypts to nothing.
 *
 * Reached through PowerShell rather than a native binding, and that is the whole reason this is not
 * Electron's `safeStorage`: the CLI approves and runs modules too, `safeStorage` needs Electron, and
 * a key the app could unwrap and the CLI could not would be two machines' worth of approvals on one
 * disk. PowerShell is reachable from both.
 *
 * ## What it is worth, stated plainly
 *
 * DPAPI does not stop a process running AS you — it can call `Unprotect` exactly as this does. It
 * stops the key being readable from a copy of the file: another account, a mounted disk, a restored
 * backup, a synced folder. That is a smaller claim than "the key is safe" and it is the true one.
 *
 * ## Read once per process
 *
 * Unwrapping is a subprocess, and the same root is opened repeatedly — every `prepareUserModules`
 * rebuild builds a store. The key is therefore memoized by path for the life of the process. A key
 * does not change under a running app; if one did, quietly picking up the new bytes is not the
 * behaviour to want from a trust store.
 *
 * ## The scheme tag, and why the file is not just bytes
 *
 * The first field says how to read the rest, so the same file can be plaintext on a platform with
 * no wrapping and wrapped on one that has it — and so a root written before wrapping existed is
 * still readable. A key that could not say what form it was in would have to be guessed at, and
 * guessing wrong about a key means every approval on the machine silently fails.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** How the payload after the colon is encoded. */
type KeyScheme = "dpapi" | "plain";

/** 32 bytes: the HMAC-SHA256 block-size sweet spot, and more entropy than the hash it tags. */
const KEY_BYTES = 32;

/**
 * Run one PowerShell one-liner, passing the secret through the ENVIRONMENT.
 *
 * Never on the command line. An argument vector is readable by any process that can list processes,
 * which on Windows is every process the user owns — so a key passed as an argument would be a key
 * published to exactly the audience this module exists to keep it from.
 */
function powershell(script: string, input: string): string {
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    env: { ...process.env, JAIRA_KEY_IO: input },
    // A wrapped key is small and the call is one round trip; a hang here would block every approval
    // check on the machine, which is worse than falling back to an unwrapped key.
    timeout: 15_000,
    windowsHide: true,
  }).trim();
}

const PROTECT = `Add-Type -AssemblyName System.Security; ` +
  `$i=[Convert]::FromBase64String($env:JAIRA_KEY_IO); ` +
  `[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($i,$null,'CurrentUser'))`;

const UNPROTECT = `Add-Type -AssemblyName System.Security; ` +
  `$i=[Convert]::FromBase64String($env:JAIRA_KEY_IO); ` +
  `[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect($i,$null,'CurrentUser'))`;

/**
 * Wrap the key if this platform can, and say which happened.
 *
 * Failure to wrap is not failure to work: a machine with no PowerShell, or a locked-down one that
 * refuses, still needs approvals. It falls back to plaintext, which is exactly where this started
 * and no worse than it was.
 */
function protect(key: Buffer): { scheme: KeyScheme; payload: string } {
  if (process.platform !== "win32") return { scheme: "plain", payload: key.toString("hex") };
  try {
    return { scheme: "dpapi", payload: powershell(PROTECT, key.toString("base64")) };
  } catch {
    return { scheme: "plain", payload: key.toString("hex") };
  }
}

/**
 * Read a wrapped key back.
 *
 * A `dpapi` blob that will not unwrap is FATAL rather than a reason to mint a new key. The two
 * readings of "cannot decrypt this" are "you are not the account that wrote it" and "the file is
 * damaged", and generating a replacement answers both by silently forgetting every approval on the
 * machine — a state that looks like JaiRA having changed its mind rather than like a fault.
 */
function unprotect(scheme: KeyScheme, payload: string, file: string): Buffer {
  if (scheme === "plain") {
    if (!/^[0-9a-f]{64}$/i.test(payload)) throw new Error(`the machine key at ${file} is not 32 bytes of hex`);
    return Buffer.from(payload, "hex");
  }
  let plain: Buffer;
  try {
    plain = Buffer.from(powershell(UNPROTECT, payload), "base64");
  } catch (e) {
    throw new Error(
      `the machine key at ${file} could not be unwrapped — it is protected for a different Windows ` +
        `account, or the file is damaged (${(e as Error).message}). Approvals signed with it cannot ` +
        `be verified. Delete the file to start over, which forgets every approval on this machine.`,
    );
  }
  if (plain.length !== KEY_BYTES) throw new Error(`the machine key at ${file} unwrapped to ${plain.length} bytes`);
  return plain;
}

/** Split a stored line, tolerating the bare-hex form written before the scheme tag existed. */
function parse(text: string): { scheme: KeyScheme; payload: string } {
  const at = text.indexOf(":");
  if (at === -1) return { scheme: "plain", payload: text };
  const scheme = text.slice(0, at);
  if (scheme !== "dpapi" && scheme !== "plain") throw new Error(`unknown machine-key scheme '${scheme}'`);
  return { scheme, payload: text.slice(at + 1) };
}

function store(file: string, wrapped: { scheme: KeyScheme; payload: string }, flag: "wx" | "w"): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${wrapped.scheme}:${wrapped.payload}\n`, { encoding: "utf8", mode: 0o600, flag });
}

/** Read once per process, by resolved path — see the header. */
const memo = new Map<string, Buffer>();

/**
 * This machine's key, generated on first use and upgraded in place when it can be.
 *
 * The upgrade is the reason this is not simply "read, or create". A root created before wrapping
 * existed — or on a machine where DPAPI was unavailable at the time — holds a plaintext key, and
 * re-wrapping it keeps the SAME BYTES: every approval already signed stays valid, and the file stops
 * being a secret in the clear. Nothing about the store changes; only what a copy of the file is
 * worth.
 */
export function machineKey(file: string): Buffer {
  const at = resolve(file);
  const known = memo.get(at);
  if (known !== undefined) return known;
  const key = read(at);
  memo.set(at, key);
  return key;
}

/**
 * Forget the memoized keys — tests only, for one that rewrites a key file it has already read.
 *
 * Nothing in a real process needs it: a key does not change under a running app, and if one did,
 * re-reading it silently would be the wrong response anyway.
 */
export function resetMachineKeys(): void {
  memo.clear();
}

function read(file: string): Buffer {
  for (let attempt = 0; attempt < 2; attempt++) {
    let text: string;
    try {
      text = readFileSync(file, "utf8").trim();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      const fresh = randomBytes(KEY_BYTES);
      try {
        store(file, protect(fresh), "wx");
        // The bytes we just generated, rather than a re-read and an unwrap of what we just wrote.
        // Unwrapping costs a second subprocess to learn something already in hand, and first run is
        // exactly when a person is waiting.
        return fresh;
      } catch (raced) {
        // EEXIST means another process created it first; read what it wrote rather than fighting.
        if ((raced as NodeJS.ErrnoException).code !== "EEXIST") throw raced;
      }
      continue;
    }
    if (text.length === 0) throw new Error(`the machine key at ${file} is empty`);
    const stored = parse(text);
    const key = unprotect(stored.scheme, stored.payload, file);
    if (stored.scheme === "plain") {
      const wrapped = protect(key);
      // Only when the platform actually wrapped it. Rewriting plaintext as plaintext is a pointless
      // write on every single open.
      if (wrapped.scheme !== "plain") store(file, wrapped, "w");
    }
    return key;
  }
  throw new Error(`could not read or create the machine key at ${file}`);
}
