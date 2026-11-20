/**
 * The secret store every JaiRA process on a machine shares (decision 0012 §6, amended 2026-11-20): one
 * file under the shared root, one key kept by the operating system under one name. The key here is a
 * stand-in; the operating system's keepers are checked by hand on each platform.
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sharedSecretStore, type SecretKeySource } from "../src/secretStore";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jaira-secret-store-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** One operating system's keeper: one key for every process that asks, made on the first ask that may make it. */
function keeper(): SecretKeySource & { asked: number } {
  let key: Buffer | undefined;
  const source = {
    asked: 0,
    reason: "no keyring",
    key(create: boolean): Buffer | undefined {
      source.asked += 1;
      if (key === undefined && create) key = randomBytes(32);
      return key;
    },
  };
  return source;
}

describe("the shared secret store", () => {
  it("is one store for every process: what one stores, another reads", () => {
    const os = keeper();
    const app = sharedSecretStore({ baseDir: dir, keySource: os });
    const fromSource = sharedSecretStore({ baseDir: dir, keySource: os });
    app.set("jaira.machine.fc7b", "token-for-windows");
    app.set("GITHUB_TOKEN", "gho_secret");
    expect(fromSource.get("jaira.machine.fc7b")).toBe("token-for-windows");
    expect(fromSource.names().sort()).toEqual(["GITHUB_TOKEN", "jaira.machine.fc7b"]);
    fromSource.remove("GITHUB_TOKEN");
    expect(app.get("GITHUB_TOKEN")).toBeUndefined();
    expect(app.names()).toEqual(["jaira.machine.fc7b"]);
  });

  it("keeps no value in the clear, and the file only its owner reads", () => {
    const store = sharedSecretStore({ baseDir: dir, keySource: keeper() });
    store.set("GITLAB_TOKEN", "glpat-very-secret");
    const file = join(dir, "system", "secrets.json");
    expect(readFileSync(file, "utf8")).not.toContain("glpat-very-secret");
    if (process.platform !== "win32") expect(statSync(file).mode & 0o077).toBe(0);
  });

  it("reads a value as absent under another key — a copied file is not a copied credential", () => {
    sharedSecretStore({ baseDir: dir, keySource: keeper() }).set("GITHUB_TOKEN", "gho_secret");
    const elsewhere = sharedSecretStore({ baseDir: dir, keySource: keeper() });
    expect(elsewhere.names()).toEqual(["GITHUB_TOKEN"]);
    expect(elsewhere.get("GITHUB_TOKEN")).toBeUndefined();
  });

  it("makes the key only when something is stored, and reads an empty store without asking for it", () => {
    const os = keeper();
    const store = sharedSecretStore({ baseDir: dir, keySource: os });
    expect(store.get("ANYTHING")).toBeUndefined();
    expect(store.names()).toEqual([]);
    expect(os.asked).toBe(0);
    store.set("A", "1");
    expect(store.get("A")).toBe("1");
  });

  it("is unavailable, says why, and refuses a write, where no key can be kept", () => {
    const none: SecretKeySource = { reason: "this session has no keyring", key: () => undefined };
    const store = sharedSecretStore({ baseDir: dir, keySource: none });
    expect(store.available()).toBe(false);
    expect(store.reason).toBe("this session has no keyring");
    expect(() => store.set("A", "1")).toThrow(/no encrypted store here: this session has no keyring/);
  });

  it("does not let a read's 'no key yet' stop a write from making one", () => {
    const os = keeper();
    const store = sharedSecretStore({ baseDir: dir, keySource: os });
    // Another process wrote an entry under a key this one has not seen; this process has no key yet.
    sharedSecretStore({ baseDir: dir, keySource: keeper() }).set("B", "2");
    expect(store.get("B")).toBeUndefined();
    store.set("A", "1");
    expect(store.get("A")).toBe("1");
  });
});
