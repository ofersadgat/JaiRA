/**
 * The encrypted secret store the desktop and the windowless server (`serve.ts`) hand the service: the
 * one every JaiRA process on this machine shares (`sharedSecretStore`, `<base>/system/secrets.json`,
 * its key kept by the operating system under one name — decision 0012 §6, amended 2026-11-20).
 *
 * Until then each build kept its own: Electron's `safeStorage` over `userData/secrets.json`, so the
 * installed app (`Application Support/JaiRA`) and a build run from source (`Application
 * Support/@jaira/app`) each had a store, and the key to it, that the other could not open. What a
 * build stored that way is moved across the first time it runs with this: only that build holds the
 * `safeStorage` key its file was written with, so each build moves its own. A name already in the
 * shared store is left as it is there; the old file is renamed `secrets.moved.json`, so it is moved once
 * and stays as it was if anything about the move needs looking at.
 */
import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { app, safeStorage } from "electron";
import { sharedSecretStore } from "@jaira/runtime";
import type { KeychainPort } from "@jaira/service";

export function appKeychain(baseDir: string): KeychainPort {
  const store = sharedSecretStore({ baseDir });
  let moved = false;
  // On first use, not at construction: `userData` and `safeStorage` are only settled once the app is ready.
  const moveOnce = (): void => {
    if (moved || !app.isReady()) return;
    moved = true;
    try {
      moveSafeStorage(store);
    } catch {
      // Moving is a convenience; a store that cannot be moved leaves its secrets to be entered again.
    }
  };
  return {
    available: () => {
      moveOnce();
      return store.available();
    },
    get reason() {
      return store.reason;
    },
    get: (name) => {
      moveOnce();
      return store.get(name);
    },
    set: (name, value) => {
      moveOnce();
      store.set(name, value);
    },
    remove: (name) => {
      moveOnce();
      store.remove(name);
    },
    names: () => {
      moveOnce();
      return store.names();
    },
  };
}

/** This build's own `safeStorage` secrets, into the shared store; the old file renamed once they are. */
function moveSafeStorage(store: ReturnType<typeof sharedSecretStore>): void {
  const file = join(app.getPath("userData"), "secrets.json");
  if (!existsSync(file) || !safeStorage.isEncryptionAvailable() || !store.available()) return;
  const old = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
  const have = new Set(store.names());
  for (const [name, blob] of Object.entries(old)) {
    if (have.has(name)) continue;
    try {
      store.set(name, safeStorage.decryptString(Buffer.from(blob, "base64")));
    } catch {
      // Written under another OS user or a reset keyring: it could not be read here either.
    }
  }
  renameSync(file, join(app.getPath("userData"), "secrets.moved.json"));
}
