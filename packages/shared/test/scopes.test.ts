/**
 * The scope table: a table and a path go in, a mode comes out, and nothing is enforced yet.
 *
 * Almost every assertion here is about the SAFE DIRECTION. A permission table has an asymmetric
 * failure mode — resolving too strictly is an annoyance and resolving too loosely is the thing the
 * table exists to prevent — so the interesting cases are the ones where a plausible implementation
 * would widen: an unmatched path, a typo'd glob, a case difference, a call about two places at once.
 */
import { describe, expect, it } from "vitest";
import {
  absolutize,
  coversProjectPath,
  globToRegExp,
  isAbsolutePath,
  normalizePath,
  resolveScope,
  resolveScopes,
  resolveUrlScope,
  specificityOf,
  strictest,
  type Scope,
} from "../src/scopes";

/** A worked table — a sandbox at `/mnt/c/work`, widened under `app`, shut under `infra`. */
const TABLE: Scope[] = [
  { path: "/mnt/c/work/**", tools: { read_file: "allow", glob: "allow", grep: "allow" } },
  { path: "/mnt/c/work/app/**", tools: { edit: "ask", write_file: "ask" } },
  { path: "/mnt/c/work/infra/**", default: "deny" },
  { url: "https://docs.internal.example/**", tools: { web_fetch: "allow" } },
];

describe("globs", () => {
  it("keeps `*` inside one segment and lets `**` cross them", () => {
    expect(globToRegExp("src/*.ts").test("src/a.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/deep/c.ts")).toBe(false);
    expect(globToRegExp("src/**/*.ts").test("src/deep/c.ts")).toBe(true);
  });

  it("lets `**/` match zero directories, which is what everyone means by it", () => {
    expect(globToRegExp("**/*.ts").test("top.ts")).toBe(true);
  });

  it("treats a dot as a literal and reads a brace group as alternation", () => {
    expect(globToRegExp("*.ts").test("axts")).toBe(false);
    const m = globToRegExp("src/*.{ts,txt}");
    expect(m.test("src/a.ts")).toBe(true);
    expect(m.test("src/c.md")).toBe(false);
  });

  it("normalizes separators and recognises the absolute forms", () => {
    expect(normalizePath("C:\\work\\a\\")).toBe("C:/work/a");
    expect(normalizePath("./x")).toBe("x");
    expect(isAbsolutePath("/mnt/c")).toBe(true);
    expect(isAbsolutePath("C:/work")).toBe(true);
    expect(isAbsolutePath("code/app")).toBe(false);
  });

  it("joins only relative things to the root", () => {
    expect(absolutize("code/**", "/mnt/c/work")).toBe("/mnt/c/work/code/**");
    // An absolute glob names a place outright — the form that matters when the sandbox is somewhere
    // other than the checkout.
    expect(absolutize("/elsewhere/**", "/mnt/c/work")).toBe("/elsewhere/**");
    expect(absolutize("code/**")).toBe("code/**");
  });
});

describe("specificity", () => {
  it("counts leading literal segments, so the deeper entry wins", () => {
    expect(specificityOf("/mnt/c/work/app/**")).toBe(4);
    expect(specificityOf("/mnt/c/work/**")).toBe(3);
    expect(specificityOf("**/*")).toBe(0);
  });

  it("stops at the first wildcard — everything after it is a shape, not a place", () => {
    expect(specificityOf("a/*/c/d")).toBe(1);
  });
});

describe("strictest", () => {
  it("orders deny over ask over smart over allow", () => {
    expect(strictest("allow", "ask")).toBe("ask");
    expect(strictest("ask", "deny")).toBe("deny");
    // `smart` MAY escalate and is not guaranteed to, so it cannot dominate an explicit `ask`.
    expect(strictest("smart", "ask")).toBe("ask");
    expect(strictest("allow", "smart")).toBe("smart");
    expect(strictest("allow", "allow")).toBe("allow");
  });

  it("denies when asked about nothing — the same rule as an unmatched path", () => {
    expect(strictest()).toBe("deny");
  });
});

describe("resolution", () => {
  it("takes the most specific scope that NAMES the tool", () => {
    expect(resolveScope(TABLE, "edit", "/mnt/c/work/app/x.ts")).toBe("ask");
  });

  it("inherits from the parent for a tool the specific scope does not name", () => {
    // The property that makes this inheritance rather than a merge: `/mnt/c/work/app/**` says
    // nothing about `read_file`, so the read resolves at `/mnt/c/work/**`.
    expect(resolveScope(TABLE, "read_file", "/mnt/c/work/app/x.ts")).toBe("allow");
  });

  it("lets a nested `default` beat an ancestor's explicit entry — specificity dominates", () => {
    // The rule that makes "deny everything here" mean it. The plausible alternative — every scope's
    // explicit entries considered before any scope's default — leaves `default: deny` governing only
    // tools no ancestor happened to name, which is nearly inert and makes the root-deny-then-widen
    // shape unwritable.
    expect(resolveScope(TABLE, "read_file", "/mnt/c/work/infra/x.ts")).toBe("deny");
    const table: Scope[] = [{ path: "/a/**", tools: { read_file: "allow" } }, { path: "/a/b/**", default: "deny" }];
    expect(resolveScope(table, "read_file", "/a/b/c.ts")).toBe("deny");
    // …while the ancestor still governs everything outside the nested scope.
    expect(resolveScope(table, "read_file", "/a/c.ts")).toBe("allow");
  });

  it("still inherits past a scope that says nothing at all", () => {
    // A scope with neither an entry for this tool nor a `default` is fallen through — which is what
    // keeps inheritance working now that specificity dominates.
    expect(resolveScope(TABLE, "read_file", "/mnt/c/work/app/x.ts")).toBe("allow");
  });

  it("covers the base directory itself with a trailing `/**`", () => {
    // `/mnt/c/work/**` is how anybody writes "the sandbox is /mnt/c/work". A reading that excluded
    // the directory itself would put the project path outside its own sandbox, and leave a `bash`
    // cwd of exactly that directory unmatched — therefore denied.
    expect(resolveScope(TABLE, "read_file", "/mnt/c/work")).toBe("allow");
    // Non-trailing `**` keeps its ordinary meaning.
    expect(globToRegExp("a/**/b").test("a/b")).toBe(true);
    expect(globToRegExp("a/**/b").test("a/x/b")).toBe(true);
  });

  it("DENIES a path no scope matches — the sandbox, with no deny rule written", () => {
    // The whole default policy. A table naming only the sandbox IS the sandbox.
    expect(resolveScope(TABLE, "read_file", "/etc/passwd")).toBe("deny");
    expect(resolveScope(TABLE, "read_file", "/mnt/c/other/x.ts")).toBe("deny");
    expect(resolveScope([], "read_file", "/anything")).toBe("deny");
  });

  it("lets an explicit root entry widen, which is the thing you have to type", () => {
    const widened: Scope[] = [...TABLE, { path: "**/*", default: "ask" }];
    expect(resolveScope(widened, "read_file", "/etc/passwd")).toBe("ask");
    // …without disturbing the specific entries.
    expect(resolveScope(widened, "read_file", "/mnt/c/work/infra/x")).toBe("deny");
  });

  it("breaks a specificity tie with the later authored entry", () => {
    const table: Scope[] = [{ path: "/a/**", tools: { read_file: "allow" } }, { path: "/a/**", tools: { read_file: "deny" } }];
    expect(resolveScope(table, "read_file", "/a/x")).toBe("deny");
  });

  it("matches a relative glob against an absolute call through the root", () => {
    const table: Scope[] = [{ path: "code/**", tools: { read_file: "allow" } }];
    expect(resolveScope(table, "read_file", "/mnt/c/work/code/x.ts", { root: "/mnt/c/work" })).toBe("allow");
    expect(resolveScope(table, "read_file", "/mnt/c/work/other/x.ts", { root: "/mnt/c/work" })).toBe("deny");
  });

  it("ignores case by default, so a deny cannot be escaped by spelling", () => {
    // The dangerous direction is a call slipping past a `deny` on a case difference and landing on
    // some broader allow. Insensitive matching closes that.
    const table: Scope[] = [{ path: "/a/**", default: "allow" }, { path: "/a/Secrets/**", default: "deny" }];
    expect(resolveScope(table, "read_file", "/a/secrets/x")).toBe("deny");
    expect(resolveScope(table, "read_file", "/a/SECRETS/x")).toBe("deny");
    // Opt back in where the filesystem really does distinguish them.
    expect(resolveScope(table, "read_file", "/a/secrets/x", { caseSensitive: true })).toBe("allow");
  });

  it("treats an unusable glob as matching NOTHING, never everything", () => {
    // A typo has to narrow toward the deny default. Widening on a broken pattern is the one failure
    // this module must not have.
    const table: Scope[] = [{ path: "/a/{unclosed", default: "allow" }];
    expect(resolveScope(table, "read_file", "/a/x")).toBe("deny");
  });

  it("normalizes separators on both sides, so a Windows path meets a posix glob", () => {
    const table: Scope[] = [{ path: "C:/work/**", tools: { read_file: "allow" } }];
    expect(resolveScope(table, "read_file", "C:\\work\\a\\b.ts")).toBe("allow");
  });
});

describe("a call about several places", () => {
  it("takes the strictest — the multi-path rule", () => {
    const table: Scope[] = [{ path: "/mnt/c/test/**", default: "allow" }, { path: "/mnt/c/**", default: "ask" }];
    // `ls -al /mnt/c/test`, run from /mnt/c/test
    expect(resolveScopes(table, "bash", ["/mnt/c/test", "/mnt/c/test/x"])).toBe("allow");
    // `ls -al /mnt/c/test /mnt/c` — the second argument is the one that decides.
    expect(resolveScopes(table, "bash", ["/mnt/c/test", "/mnt/c/test/x", "/mnt/c/other"])).toBe("ask");
  });

  it("denies a set containing anything unmatched", () => {
    expect(resolveScopes(TABLE, "read_file", ["/mnt/c/work/a", "/etc/passwd"])).toBe("deny");
  });

  it("denies an empty set rather than permitting a call about nowhere", () => {
    expect(resolveScopes(TABLE, "read_file", [])).toBe("deny");
  });
});

describe("urls", () => {
  it("resolves a web tool against url scopes", () => {
    expect(resolveUrlScope(TABLE, "web_fetch", "https://docs.internal.example/a/b")).toBe("allow");
  });

  it("denies a url no scope matches, so the default posture is no network", () => {
    expect(resolveUrlScope(TABLE, "web_fetch", "https://evil.example/x")).toBe("deny");
  });

  it("keeps the two axes apart — a path scope says nothing about a url", () => {
    const paths: Scope[] = [{ path: "**/*", default: "allow" }];
    expect(resolveUrlScope(paths, "web_fetch", "https://anywhere.example")).toBe("deny");
    expect(resolveScope(TABLE, "web_fetch", "/mnt/c/work/x")).toBe("deny");
  });
});

describe("coversProjectPath — the misconfiguration warning", () => {
  it("is true when the table says anything about the project", () => {
    expect(coversProjectPath(TABLE, "/mnt/c/work")).toBe(true);
    expect(coversProjectPath(TABLE, "/mnt/c/work/app")).toBe(true);
  });

  it("is false when the sandbox is somewhere else entirely", () => {
    // The shape worth warning about: a path typed for another machine, or a floor left behind after
    // the project moved. Everything the run was started to do would deny.
    expect(coversProjectPath(TABLE, "/home/someone/other-project")).toBe(false);
  });

  it("asks about coverage, NOT about whether a root entry was written", () => {
    // The distinction that keeps the warning useful: a table with no `**/*` is the ordinary safe
    // case, and warning about it would train people to widen tables to silence a warning.
    const narrow: Scope[] = [{ path: "/mnt/c/work/**", default: "allow" }];
    expect(coversProjectPath(narrow, "/mnt/c/work/x")).toBe(true);
  });
});
