/**
 * The encrypted secret store, backed by Electron's `safeStorage` — shared by the desktop and the
 * windowless server (`serve.ts`), which run the same Electron binary so they read the same keychain
 * (decision 0012 §6).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { app, safeStorage } from "electron";
import type { KeychainPort } from "@jaira/service";

/**
 * `safeStorage` encrypts and decrypts but stores nothing, so the ciphertext needs a home: one JSON
 * file in the app's own userData directory, holding base64 blobs. That file is useless without the
 * OS keyring entry that unlocks it, which is the whole point — a copied file is not a copied
 * credential.
 *
 * Availability is checked on every call rather than once at startup. On Linux it depends on a
 * keyring being present in the session, and answering from a cached "yes" would mean writing
 * plaintext when it later turns out to be no.
 */
export function electronKeychain(): KeychainPort {
  // Resolved per call, not at module load: this runs while the module graph is still being
  // evaluated, and `userData` is only guaranteed once the app has settled its paths.
  const fileOf = (): string => join(app.getPath("userData"), "secrets.json");
  const load = (): Record<string, string> => {
    try {
      return JSON.parse(readFileSync(fileOf(), "utf8")) as Record<string, string>;
    } catch {
      return {};
    }
  };
  const save = (all: Record<string, string>): void => {
    const file = fileOf();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(all, null, 2)}\n`, "utf8");
  };
  return {
    available: () => safeStorage.isEncryptionAvailable(),
    reason: "this system provides no OS-backed encrypted store, so secrets must go in a .env.local file",
    get: (name) => {
      const blob = load()[name];
      if (blob === undefined) return undefined;
      try {
        return safeStorage.decryptString(Buffer.from(blob, "base64"));
      } catch {
        // A blob written under a different OS user or a reset keyring cannot be read back. Treating
        // it as absent lets the chain fall through instead of failing the run outright.
        return undefined;
      }
    },
    set: (name, value) => {
      const all = load();
      all[name] = safeStorage.encryptString(value).toString("base64");
      save(all);
    },
    remove: (name) => {
      const all = load();
      delete all[name];
      save(all);
    },
  };
}
