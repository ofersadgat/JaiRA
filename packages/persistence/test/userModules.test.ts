/**
 * The approval store and the freeze (SPEC §7.5.5), which are JaiRA's half of calling a `.ts`
 * function. hw owns hashing, the index and the transpile; what is tested here is the POLICY those
 * seams were left open for.
 *
 * The property that matters most is the strong form of the rule — an unknown file is an unapproved
 * file — because the weak one looks identical until the day somebody drops a new module earlier on
 * the search path.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { moduleHash, type WorkflowBundle } from "@declarative-ai/hw";
import { approvalsIn, canonicalModulePath, moduleEntriesOf, type ApprovalPaths, type Approvals } from "../src/userModules";
import { openDb } from "../src/db";

const dirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "jaira-modules-"));
  dirs.push(dir);
  return dir;
}
/** Every store opened by a test, closed before its directory goes — Windows will not delete an
 *  open SQLite file, and a leaked handle turns a later `rmSync` into a confusing EBUSY. */
const stores: Approvals[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      // Already closed by the test itself, which several do on purpose.
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A scratch base root: the two paths the store takes, under one temp directory. */
const base = (dir = scratch()): ApprovalPaths => ({
  dbFile: join(dir, "jaira.db"),
  machineKeyFile: join(dir, "machine.key"),
});

/** Put a row straight into the table, as another process (or another application) would. */
const seed = (paths: ApprovalPaths, path: string, hash: string, mac = "0".repeat(64)): void => {
  const db = openDb(paths.dbFile);
  db.prepare(`INSERT OR REPLACE INTO module_approvals (path, hash, mac, approved_at) VALUES (?, ?, ?, ?)`).run(
    path,
    hash,
    mac,
    Date.now(),
  );
  db.close();
};

/** Open a store and register it for closing — see the `stores` note above. */
const open = (paths: ApprovalPaths): Approvals => {
  const store = approvalsIn(paths);
  stores.push(store);
  return store;
};

describe("the approval store", () => {
  it("answers `undefined` for a file it has never seen — unknown IS unapproved", () => {
    expect(open(base()).approved("/anywhere/never-seen.ts")).toBeUndefined();
  });

  it("round-trips an approval through the database, so a second process sees it", () => {
    const paths = base();
    const target = "/p/functions/confidence.ts";
    open(paths).approve(target, moduleHash("export const x = 1;"));
    // A FRESH store over the same root: this is the read a later `jaira` invocation does.
    expect(open(paths).approved(target)).toBe(moduleHash("export const x = 1;"));
  });

  it("keys on the canonical path, so two spellings of one file are one approval", () => {
    const approvals = open(base());
    approvals.approve("C:\\p\\functions\\x.ts", "h");
    expect(approvals.approved("C:/p/functions/x.ts")).toBe("h");
  });

  it("forgets a revoked file entirely rather than recording a refusal", () => {
    const approvals = open(base());
    approvals.approve("/p/x.ts", "h");
    approvals.revoke("/p/x.ts");
    // Absent, not `false` — there is one representation of "may not run", and it is absence.
    expect(approvals.approved("/p/x.ts")).toBeUndefined();
    expect([...approvals.all().keys()]).toEqual([]);
  });

  it("creates its directory on first write", () => {
    const paths = base(join(scratch(), "nested", "deeper"));
    expect(() => open(paths).approve("/p/x.ts", "h")).not.toThrow();
    expect(open(paths).approved("/p/x.ts")).toBe("h");
  });
});

describe("the machine key", () => {
  it("is generated on first use and reused after, so approvals survive a restart", () => {
    const paths = base();
    const first = approvalsIn(paths);
    first.approve("/p/x.ts", "h");
    first.close();
    const stored = readFileSync(paths.machineKeyFile, "utf8").trim();
    // A scheme tag and a payload. Which scheme depends on the platform — Windows wraps with DPAPI,
    // everywhere else is plaintext hex — so the assertion is on the SHAPE, not on the mechanism.
    expect(stored).toMatch(/^(dpapi|plain):.+$/);

    const second = approvalsIn(paths);
    stores.push(second);
    // Same key ⇒ the MAC still verifies ⇒ the approval is still an approval.
    expect(second.approved("/p/x.ts")).toBe("h");
    expect(readFileSync(paths.machineKeyFile, "utf8").trim()).toBe(stored);
  });

  it("wraps with the platform's own protection where there is one", () => {
    const paths = base();
    const store = open(paths);
    store.approve("/p/x.ts", "h");
    const stored = readFileSync(paths.machineKeyFile, "utf8").trim();
    // The point of the whole module: on Windows the key on disk is not the key. A copy of this file
    // taken to another account or another machine decrypts to nothing.
    if (process.platform === "win32") {
      expect(stored.startsWith("dpapi:")).toBe(true);
      expect(stored).not.toMatch(/^[0-9a-f]{64}$/);
    } else {
      expect(stored.startsWith("plain:")).toBe(true);
    }
  });

  it("upgrades a plaintext key in place, keeping the bytes so approvals stay valid", () => {
    // A root written before wrapping existed. Re-wrapping must not invalidate what it already
    // signed — the key is the same 32 bytes, only what a copy of the file is worth changes.
    const paths = base();
    const raw = "ab".repeat(32);
    mkdirSync(dirname(paths.machineKeyFile), { recursive: true });
    writeFileSync(paths.machineKeyFile, `plain:${raw}\n`, "utf8");

    const store = open(paths);
    store.approve("/p/x.ts", "h");
    expect(store.approved("/p/x.ts")).toBe("h");

    if (process.platform === "win32") {
      expect(readFileSync(paths.machineKeyFile, "utf8").trim().startsWith("dpapi:")).toBe(true);
      // And the approval signed before the upgrade still verifies, which is the whole claim.
      const after = approvalsIn(paths);
      stores.push(after);
      expect(after.approved("/p/x.ts")).toBe("h");
    }
  });

  it("reads a bare-hex key written before the scheme tag existed", () => {
    const paths = base();
    mkdirSync(dirname(paths.machineKeyFile), { recursive: true });
    writeFileSync(paths.machineKeyFile, `${"cd".repeat(32)}\n`, "utf8");
    const store = open(paths);
    expect(() => store.approve("/p/x.ts", "h")).not.toThrow();
    expect(store.approved("/p/x.ts")).toBe("h");
  });

  it("refuses to run on a key that is not a key, rather than minting a new one", () => {
    // Silently replacing it would invalidate every approval on the machine, which reads as JaiRA
    // having forgotten what you agreed to. Loudly is the only honest option.
    const paths = base();
    mkdirSync(dirname(paths.machineKeyFile), { recursive: true });
    writeFileSync(paths.machineKeyFile, "plain:not-a-key", "utf8");
    const store = open(paths);
    // The key is read LAZILY and only when it is actually needed, so the refusal lands on the first
    // operation that needs it rather than at open. Approving needs it — nothing can be signed
    // without it — so this is where a person meets the problem.
    expect(() => store.approve("/p/x.ts", "h")).toThrow(/machine key/);
    // And a READ over a non-empty table needs it too. An empty table is the one case that answers
    // without the key, and answering "nothing is approved" there is correct whatever the key says.
    expect(store.approved("/p/x.ts")).toBeUndefined();
    seed(paths, "/p/other.ts", "h");
    expect(() => store.approved("/p/x.ts")).toThrow(/machine key/);
  });

  it("refuses an unknown scheme rather than guessing at the bytes", () => {
    const paths = base();
    mkdirSync(dirname(paths.machineKeyFile), { recursive: true });
    writeFileSync(paths.machineKeyFile, "rot13:abcdef", "utf8");
    const store = open(paths);
    expect(() => store.approve("/p/x.ts", "h")).toThrow(/scheme/);
  });
});

describe("a row nobody signed", () => {
  /** What another application or an agent can do: reach the database and write into it. */
  const forge = (paths: ApprovalPaths, path: string, hash: string, mac = "0".repeat(64)): void => {
    const db = openDb(paths.dbFile);
    db.prepare(`INSERT INTO module_approvals (path, hash, mac, approved_at) VALUES (?, ?, ?, ?)`).run(
      path,
      hash,
      mac,
      Date.now(),
    );
    db.close();
  };

  it("is not an approval, however well-formed the row is", () => {
    const paths = base();
    open(paths).close();
    forge(paths, "/p/evil.ts", "h");

    const approvals = approvalsIn(paths);
    stores.push(approvals);
    expect(approvals.approved("/p/evil.ts")).toBeUndefined();
    expect([...approvals.all().keys()]).toEqual([]);
  });

  it("is reported as unverified rather than swallowed, so a UI can say so", () => {
    const paths = base();
    open(paths).close();
    forge(paths, "/p/evil.ts", "h");

    const approvals = approvalsIn(paths);
    stores.push(approvals);
    expect(approvals.unverified()).toEqual(["/p/evil.ts"]);
  });

  it("cannot be made by moving a REAL approval onto another path", () => {
    // The reason the MAC covers the path as well as the hash: approve something harmless, then
    // point that signature at the module a workflow actually calls.
    const paths = base();
    const approvals = open(paths);
    approvals.approve("/p/harmless.ts", "h");
    const reader = openDb(paths.dbFile);
    const stolen = (reader.prepare(`SELECT mac FROM module_approvals`).get() as { mac: string }).mac;
    reader.close();
    forge(paths, "/p/called-by-the-workflow.ts", "h", stolen);

    const reopened = approvalsIn(paths);
    stores.push(reopened);
    expect(reopened.approved("/p/called-by-the-workflow.ts")).toBeUndefined();
    expect(reopened.approved("/p/harmless.ts")).toBe("h");
  });

  it("cannot be made by editing the hash under a real path", () => {
    const paths = base();
    const approvals = open(paths);
    approvals.approve("/p/x.ts", "the-hash-that-was-reviewed");
    const db = openDb(paths.dbFile);
    db.prepare(`UPDATE module_approvals SET hash = ?`).run("a-different-build");
    db.close();

    const reopened = approvalsIn(paths);
    stores.push(reopened);
    expect(reopened.approved("/p/x.ts")).toBeUndefined();
  });
});

describe("which modules a bundle reaches", () => {
  const bundleWith = (refs: readonly string[]): WorkflowBundle =>
    ({
      rootId: "root",
      states: {
        root: {
          id: "root",
          outputs: Object.fromEntries(refs.map((ref, i) => [`o${i}`, { binding: { op: { functionRef: ref } } }])),
        },
      },
    }) as unknown as WorkflowBundle;

  it("finds the file behind each `user:` ref and ignores everything else", () => {
    const bundle = bundleWith(["op.and", "user:/p/functions/lib.ts#confidence.score", "run_command"]);
    expect(moduleEntriesOf(bundle)).toEqual(["/p/functions/lib.ts"]);
  });

  it("reports one entry per FILE, however many symbols are called in it", () => {
    const bundle = bundleWith([
      "user:/p/functions/lib.ts#confidence.score",
      "user:/p/functions/lib.ts#confidence.reasons",
      "user:/p/functions/other.ts#thing",
    ]);
    expect(moduleEntriesOf(bundle)).toEqual(["/p/functions/lib.ts", "/p/functions/other.ts"]);
  });

  it("excludes an EMBEDDED body, which has no file to hash and needs none", () => {
    // Its pseudo-path names nothing on disk. The body is part of the document, so it is already
    // inside the snapshot hash — freezing it would be hashing the same bytes twice.
    expect(moduleEntriesOf(bundleWith(["user:<body>/score.abc123.ts#default"]))).toEqual([]);
  });

  it("says nothing about a workflow that calls no module", () => {
    expect(moduleEntriesOf(bundleWith(["op.and", "op.member"]))).toEqual([]);
  });
});

describe("canonicalModulePath", () => {
  it("is absolute and forward-slashed, which is what the hash and the require path agree on", () => {
    const dir = scratch();
    mkdirSync(join(dir, "functions"), { recursive: true });
    const canonical = canonicalModulePath(join(dir, "functions", "x.ts"));
    expect(canonical).not.toContain("\\");
    expect(canonical.endsWith("/functions/x.ts")).toBe(true);
  });
});

describe("what the signature actually binds", () => {
  /**
   * The MAC input is the path and the CONTENT HASH, and `moduleHash` is SHA-256 of the source
   * (hw's `integrity.ts`) — so the signed pair is a path and a cryptographic commitment to the
   * bytes. These are the three substitutions that commitment has to refuse, stated as the attacks
   * rather than as the algorithm.
   */
  it("refuses content that is not what was approved", () => {
    const paths = base();
    const store = open(paths);
    const reviewed = "export const rate = 0.1;";
    store.approve("/p/x.ts", moduleHash(reviewed));

    // The file is edited after approval. Nothing in the database changed, and nothing needed to:
    // the stored hash no longer describes the bytes, which is what every gate compares.
    const tampered = "export const rate = 0.1; require('child_process').exec('curl evil');";
    expect(moduleHash(tampered)).not.toBe(store.approved("/p/x.ts"));
    expect(moduleHash(reviewed)).toBe(store.approved("/p/x.ts"));
  });

  it("refuses a hash swapped under a path, even to another file's real hash", () => {
    // The interesting version of the attack: not a made-up hash, but the genuine hash of some other
    // module that WAS approved. The MAC covers the pair, so a real hash under the wrong path is as
    // dead as an invented one.
    const paths = base();
    const store = open(paths);
    store.approve("/p/harmless.ts", moduleHash("export const x = 1;"));
    store.approve("/p/called.ts", moduleHash("export const y = 2;"));

    const db = openDb(paths.dbFile);
    try {
      // Canonicalized on the way in — a row is keyed by the absolute, forward-slashed spelling, so
      // raw SQL has to ask the same question the store would.
      const harmless = db
        .prepare(`SELECT hash, mac FROM module_approvals WHERE path = ?`)
        .get(canonicalModulePath("/p/harmless.ts")) as { hash: string; mac: string };
      db.prepare(`UPDATE module_approvals SET hash = ?, mac = ? WHERE path = ?`).run(
        harmless.hash,
        harmless.mac,
        canonicalModulePath("/p/called.ts"),
      );
    } finally {
      db.close();
    }

    const reopened = approvalsIn(paths);
    stores.push(reopened);
    expect(reopened.approved("/p/called.ts")).toBeUndefined();
    expect(reopened.unverified()).toEqual([canonicalModulePath("/p/called.ts")]);
  });

  it("cannot be satisfied by a second file with the same contents at another path", () => {
    // Approving content does not approve the content ANYWHERE. Same bytes, different path, no
    // approval — which is the property that stops a copy of an approved module being dropped
    // earlier on the search path to capture a symbol.
    const paths = base();
    const store = open(paths);
    const source = "export const x = 1;";
    store.approve("/p/functions/lib.ts", moduleHash(source));
    expect(store.approved("/p/other/lib.ts")).toBeUndefined();
  });
});
