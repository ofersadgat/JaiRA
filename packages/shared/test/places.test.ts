/**
 * Places on a permission set line (decision 0023 §3): what kind of place a line is about, and which of
 * a line's places answers for a call — most specific first, the stricter among equals, several places
 * the strictest of their answers.
 */
import { describe, expect, it } from "vitest";
import type { PermissionSetMode } from "../src/operationVocabulary";
import { placeKindOf, placesMostSpecificFirst, resolvePlace, resolvePlaces, type PlaceOptions } from "../src/places";
import { TOOL_SPECS } from "../src/toolVocabulary";

const ROOT = "C:/UbuntuCode/JaiRA";
const OPTIONS: PlaceOptions = { root: ROOT, named: { "~": "C:/Users/Ofer", $WORKTREE: "C:/UbuntuCode/JaiRA-wt/t1" } };
const at = (map: Record<string, PermissionSetMode>, kind: Parameters<typeof resolvePlace>[1], call: string, options: PlaceOptions = OPTIONS) => resolvePlace(map, kind, call, options);

describe("the kind of place a line is about (§3.1)", () => {
  it.each([
    ["read_file", "path"],
    ["glob", "path"],
    ["grep", "path"],
    ["edit", "path"],
    ["write_file", "path"],
    ["show_artifact", "path"],
    ["shell", "path"],
    ["script", "path"],
    ["runner:*", "path"],
    ["runner:npm", "path"],
    ["runner:ssh", "host"],
    ["npm run build", "path"],
    ["git", "path"],
    ["git push", "branch"],
    ["git push --force", "branch"],
    ["curl", "site"],
    ["wget", "site"],
    ["Invoke-WebRequest", "site"],
    ["web_fetch", "site"],
    ["git_push", "branch"],
    ["git_merge", "branch"],
    ["list_merge_requests", "repository"],
    ["read_pipeline", "repository"],
    ["start_task", "workflow"],
    ["move_task", "workflow"],
    ["stop_process", "program"],
    ["control_service", "program"],
    ["open_app", "program"],
  ])("'%s' is about a %s", (subject, kind) => {
    expect(placeKindOf(subject)).toBe(kind);
  });

  it("is nothing for a line whose calls name no place, for `other`, and for an MCP line (its configuration says)", () => {
    for (const subject of ["web_search", "screenshot", "list_tasks", "read_system", "other", "mcp__figma", "mcp__figma__get_code"]) expect(placeKindOf(subject), subject).toBeUndefined();
  });

  it("is declared on the tool beside its path and URL arguments", () => {
    for (const spec of TOOL_SPECS) if (spec.pathArgs !== undefined) expect(spec.scope, spec.name).toBe("path");
    expect(TOOL_SPECS.find((spec) => spec.name === "web_fetch")!.scope).toBe("site");
  });
});

describe("paths (§3.2)", () => {
  it("lets a place that pins the FILE beat any folder holding it — credentials need no rule of their own", () => {
    const map: Record<string, PermissionSetMode> = { "C:": "allow", $PROJECT: "allow", "**/.env": "ask", "*.pem": "ask", "~/.ssh": "ask" };
    expect(at(map, "path", `${ROOT}/.env`)).toEqual({ place: "**/.env", decision: "ask" });
    expect(at(map, "path", "C:/elsewhere/deep/.env")).toEqual({ place: "**/.env", decision: "ask" });
    // A glob with no folder in it is a name anywhere, as `.gitignore` reads one.
    expect(at(map, "path", "C:/keys/server.pem")).toEqual({ place: "*.pem", decision: "ask" });
    expect(at(map, "path", "C:/Users/Ofer/.ssh/id_rsa")).toEqual({ place: "~/.ssh", decision: "ask" });
    expect(at(map, "path", `${ROOT}/src/a.ts`)).toEqual({ place: "$PROJECT", decision: "allow" });
  });

  it("lets the deeper folder win, and `**` lose to every place", () => {
    const map: Record<string, PermissionSetMode> = { "**": "deny", "C:": "ask", $PROJECT: "allow", "docs/product": "deny" };
    expect(at(map, "path", `${ROOT}/src/a.ts`)!.place).toBe("$PROJECT");
    expect(at(map, "path", "docs/product/plan.md")).toEqual({ place: "docs/product", decision: "deny" });
    expect(at(map, "path", "C:/other/x")!.place).toBe("C:");
    expect(at(map, "path", "D:/x")).toEqual({ place: "**", decision: "deny" });
    // A folder is that folder too, not only what is under it.
    expect(at(map, "path", "docs/product")!.place).toBe("docs/product");
  });

  it("ranks file patterns by their literal leading segments", () => {
    const map: Record<string, PermissionSetMode> = { "src/**/*.ts": "allow", "src/generated/**/*.ts": "deny" };
    expect(at(map, "path", "src/generated/api/client.ts")).toEqual({ place: "src/generated/**/*.ts", decision: "deny" });
    expect(at(map, "path", "src/app/main.ts")).toEqual({ place: "src/**/*.ts", decision: "allow" });
    // A file pattern beats a deeper folder.
    expect(at({ "src/generated": "allow", "src/**/*.ts": "ask" }, "path", "src/generated/x.ts")!.place).toBe("src/**/*.ts");
  });

  it("lets a bare path that IS the file beat a pattern", () => {
    expect(at({ "**/*.json": "deny", "package.json": "allow" }, "path", `${ROOT}/package.json`)!.place).toBe("package.json");
  });

  it("takes the STRICTER answer of two different places that rank the same", () => {
    expect(at({ "**/*.ts": "allow", "**/*.test.ts": "deny" }, "path", "src/a.test.ts")).toEqual({ place: "**/*.test.ts", decision: "deny" });
    expect(at({ "**/*.test.ts": "deny", "**/*.ts": "allow" }, "path", "src/a.test.ts")!.decision).toBe("deny");
    // deny ▸ ask ▸ function ▸ allow
    expect(at({ "**/*.ts": "allow", "**/*.test.ts": { function: "smart" } }, "path", "src/a.test.ts")!.decision).toEqual({ function: "smart" });
    expect(at({ "**/*.ts": "ask", "**/*.test.ts": { function: "smart" } }, "path", "src/a.test.ts")!.decision).toBe("ask");
  });

  it("matches nothing — and says so — where no place holds the call, or a named place is not known here", () => {
    expect(at({ src: "allow" }, "path", "docs/x.md")).toBeUndefined();
    expect(at({ $TEMP: "allow" }, "path", "C:/Temp/x")).toBeUndefined();
    expect(at({ "$WORKTREE/src": "allow" }, "path", "C:/UbuntuCode/JaiRA-wt/t1/src/a.ts")!.place).toBe("$WORKTREE/src");
  });

  it("compares without case and in one slash, unless told to keep case", () => {
    expect(at({ SRC: "deny" }, "path", "c:\\UbuntuCode\\JaiRA\\src\\a.ts")!.decision).toBe("deny");
    expect(at({ SRC: "deny" }, "path", `${ROOT}/src/a.ts`, { ...OPTIONS, caseSensitive: true })).toBeUndefined();
    expect(at({ "./mode": "allow" }, "path", `${ROOT}/mode/x`)!.place).toBe("./mode");
  });
});

describe("sites (§3.3)", () => {
  const map: Record<string, PermissionSetMode> = { "github.com": "allow", "*.github.com": "ask", "github.com/anthropics/**": "deny", "**": "deny" };

  it("ranks a host with a path over the bare host, over a wildcard host, over `**`", () => {
    expect(at(map, "site", "https://github.com/anthropics/claude-code")!.place).toBe("github.com/anthropics/**");
    expect(at(map, "site", "https://github.com/openai/x")!.place).toBe("github.com");
    expect(at(map, "site", "https://api.github.com/repos")!.place).toBe("*.github.com");
    expect(at(map, "site", "https://example.com/")!.place).toBe("**");
  });

  it("reads `*.host` as its subdomains, never the host itself", () => {
    expect(at({ "*.github.com": "allow" }, "site", "https://github.com/x")).toBeUndefined();
    expect(at({ "*.github.com": "allow" }, "site", "https://a.b.github.com/x")!.decision).toBe("allow");
  });

  it("matches localhost and an address exactly or not at all", () => {
    expect(at({ "*.0.0.1": "allow" }, "site", "http://127.0.0.1:8080/")).toBeUndefined();
    expect(at({ "*.localhost": "allow" }, "site", "http://app.localhost/")).toBeUndefined();
    expect(at({ "127.0.0.1": "allow" }, "site", "http://127.0.0.1:8080/")!.decision).toBe("allow");
    expect(at({ localhost: "allow" }, "site", "http://localhost:3000/x")!.decision).toBe("allow");
    expect(at({ "localhost:4000": "allow" }, "site", "http://localhost:3000/x")).toBeUndefined();
  });

  it("matches a path place as that path and what is under it, with case", () => {
    expect(at({ "docs.example.com/api": "allow" }, "site", "https://docs.example.com/api/v1")!.decision).toBe("allow");
    expect(at({ "docs.example.com/api": "allow" }, "site", "https://docs.example.com/apix")).toBeUndefined();
    expect(at({ "docs.example.com/API": "allow" }, "site", "https://DOCS.example.com/api")).toBeUndefined();
  });
});

describe("branches (§3.3)", () => {
  it("ranks an exact name over a glob, and a longer literal prefix over a shorter", () => {
    const map: Record<string, PermissionSetMode> = { "**": "ask", main: "deny", "claude/**": "allow", "claude/release/**": "deny" };
    expect(at(map, "branch", "main")!.place).toBe("main");
    expect(at(map, "branch", "claude/fix")!.place).toBe("claude/**");
    expect(at(map, "branch", "claude/release/1")!.place).toBe("claude/release/**");
    expect(at(map, "branch", "feature")!.place).toBe("**");
  });

  it("matches a place naming a remote only on that remote, and prefers it over one that names none", () => {
    expect(at({ "upstream:main": "allow" }, "branch", "origin:main")).toBeUndefined();
    expect(at({ main: "ask", "origin:main": "deny" }, "branch", "origin:main")!.place).toBe("origin:main");
    expect(at({ main: "ask" }, "branch", "origin:main")!.place).toBe("main");
  });

  it("reads the other kinds as names: exact over a glob", () => {
    expect(at({ "anthropics/*": "allow", "anthropics/secret": "deny" }, "repository", "Anthropics/Secret")!.decision).toBe("deny");
    expect(at({ "feature/*": "allow" }, "workflow", "Feature/x")).toBeUndefined();
    expect(at({ "node*": "allow", "**": "ask" }, "program", "node.exe")!.place).toBe("node*");
  });
});

describe("a call about several places (§3.5)", () => {
  it("takes the strictest answer, and keeps the places nothing matched apart for the next line", () => {
    const map: Record<string, PermissionSetMode> = { src: "allow", infra: "deny" };
    expect(resolvePlaces(map, "path", ["src/a", "infra/b"], OPTIONS)).toMatchObject({ decision: "deny", unmatched: [] });
    const partial = resolvePlaces(map, "path", ["src/a", "docs/x"], OPTIONS);
    expect(partial.decision).toBe("allow");
    expect(partial.unmatched).toEqual(["docs/x"]);
    expect(partial.matches).toEqual([{ place: "src", decision: "allow", call: "src/a" }]);
    expect(resolvePlaces(map, "path", ["docs/x"], OPTIONS).decision).toBeUndefined();
  });
});

describe("drawing a line's places", () => {
  it("lists them most specific first, `**` last", () => {
    expect(placesMostSpecificFirst("path", ["**", "C:", "$PROJECT", "**/.env", "src/generated/**/*.ts", "src/**/*.ts"], OPTIONS)).toEqual([
      "src/generated/**/*.ts",
      "src/**/*.ts",
      "**/.env",
      "$PROJECT",
      "C:",
      "**",
    ]);
    expect(placesMostSpecificFirst("site", ["**", "*.github.com", "github.com", "github.com/anthropics/**"])).toEqual(["github.com/anthropics/**", "github.com", "*.github.com", "**"]);
  });
});
