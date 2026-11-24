/**
 * Places on a permission set line (decision 0023 §3): what kind of place a line is about, and which of
 * a line's places answers for a call — most specific first, the stricter among equals, several places
 * the strictest of their answers.
 */
import { describe, expect, it } from "vitest";
import type { PermissionSetMode } from "../src/operationVocabulary";
import { areaPlacesOf, callPlacesOf, inputPlacesOf, placeKindOf, placesMostSpecificFirst, placeWidthsOf, resolvePlace, resolvePlaces, unknownProgramPlace, type MachineFacts, type PlaceOptions } from "../src/places";
import { kindedPlace, placeOfKey, resolveResource, resourceOfCall } from "../src/resources";
import { TOOL_SPEC_BY_NAME, TOOL_SPECS } from "../src/toolVocabulary";

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
    ["list_processes", "program"],
    ["stop_process", "program"],
    ["read_process", "program"],
    ["wait_process", "program"],
    ["screenshot", "program"],
    ["list_windows", "program"],
    ["control_input", "program"],
    ["open_app", "program"],
    ["list_services", "service"],
    ["control_service", "service"],
    ["read_system", "area"],
    ["read_settings", "area"],
    ["write_settings", "area"],
    ["list_programs", "package"],
    ["install_program", "package"],
    ["write_clipboard", "path"],
    ["read_clipboard", "machine"],
    ["power", "action"],
  ])("'%s' is about a %s", (subject, kind) => {
    expect(placeKindOf(subject)).toBe(kind);
  });

  it("is nothing for a line whose calls name no place, for `other`, and for an MCP line (its configuration says)", () => {
    for (const subject of ["web_search", "list_tasks", "other", "mcp__figma", "mcp__figma__get_code"]) expect(placeKindOf(subject), subject).toBeUndefined();
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

  it("reads a process named by its pid as the program it is, and one nobody can name as matched by `**` alone", () => {
    const stop = TOOL_SPEC_BY_NAME.get("stop_process");
    const facts: MachineFacts = { process: (pid) => (pid === 4242 ? { program: "node", owner: ["session"] } : undefined) };
    expect(callPlacesOf(stop, { pid: 4242 }, undefined, { facts })).toEqual(["node"]);
    expect(callPlacesOf(stop, { pid: 9999 }, undefined, { facts })).toEqual([unknownProgramPlace(9999)]);
    expect(callPlacesOf(stop, { pid: 4242 })).toEqual(["(pid 4242)"]);
    expect(callPlacesOf(stop, {})).toEqual([]);
    // A machine that throws names nothing.
    expect(callPlacesOf(stop, { pid: 4242 }, undefined, { facts: { process: () => { throw new Error("x"); } } })).toEqual(["(pid 4242)"]);
    for (const place of ["*", "pid*", "(*", "node"]) expect(at({ [place]: "allow" }, "program", "(pid 9999)"), place).toBeUndefined();
    expect(at({ node: "allow", "**": "deny" }, "program", "(pid 9999)")!.place).toBe("**");
    expect(placeWidthsOf("program", "(pid 9999)")).toEqual([{ width: "anywhere", place: "**" }]);
  });

  it("reads one window as the program it belongs to", () => {
    const screenshot = TOOL_SPEC_BY_NAME.get("screenshot");
    const facts: MachineFacts = { window: (id) => (id === 77 ? { program: "code", owner: ["user"] } : undefined) };
    expect(callPlacesOf(screenshot, { window_id: 77 }, undefined, { facts })).toEqual(["code"]);
    expect(callPlacesOf(screenshot, { window_id: 78 }, undefined, { facts })).toEqual(["(window 78)"]);
    // `open_app` names an app to launch, or a window to focus or close.
    const open = TOOL_SPEC_BY_NAME.get("open_app");
    expect(callPlacesOf(open, { action: "launch", app: "notepad" }, undefined, { facts })).toEqual(["notepad"]);
    expect(callPlacesOf(open, { action: "close", window_id: 77 }, undefined, { facts })).toEqual(["code"]);
    expect(at({ code: "allow", "**": "ask" }, "program", "(window 78)")!.place).toBe("**");
    expect(placeWidthsOf("program", "node")).toEqual([{ width: "this", place: "node" }, { width: "anywhere", place: "**" }]);
  });

  it("reads an owner, `jaira` holding a session's", () => {
    expect(at({ jaira: "allow", session: "ask" }, "owner", "session")!.place).toBe("session");
    expect(at({ jaira: "allow", user: "deny" }, "owner", "session")!.place).toBe("jaira");
    expect(at({ jaira: "allow" }, "owner", "user")).toBeUndefined();
    expect(at({ "account:*": "deny", "account:ofer": "allow" }, "owner", "account:ofer")!.decision).toBe("allow");
    expect(at({ "account:*": "deny" }, "owner", "account:root")!.decision).toBe("deny");
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

describe("the System tools' resources (§3.1, amended 2026-11-23)", () => {
  const spec = (name: string) => TOOL_SPEC_BY_NAME.get(name)!;
  const facts: MachineFacts = {
    machine: () => "desk",
    process: (pid) => ({ 4242: { program: "node", owner: ["session"] }, 5151: { program: "python", owner: ["user", "account:ofer"] } })[pid],
    window: (id) => ({ 77: { program: "code", owner: ["user"] }, 88: { program: "keepass", owner: ["user"] } })[id],
    focused: () => 77,
    onScreen: () => [77, 88],
  };

  it("keeps a kind's places on the line as `kind=place`, the tool's own kind bare", () => {
    const stop = spec("stop_process");
    expect(kindedPlace("owner", "session")).toBe("owner=session");
    expect(placeOfKey("owner=session", stop)).toEqual({ kind: "owner", place: "session" });
    expect(placeOfKey("node", stop)).toEqual({ kind: "program", place: "node" });
    expect(placeOfKey("program=node", stop)).toEqual({ kind: "program", place: "node" });
    // A prefix that is no kind of the tool's is the tool's own kind: a path may hold `=`.
    expect(placeOfKey("a=b", TOOL_SPEC_BY_NAME.get("read_file"))).toEqual({ kind: "path", place: "a=b" });
    expect(placeOfKey("area=x", stop)).toEqual({ kind: "program", place: "area=x" });
  });

  it("reads every kind of a call's resource: what it reaches, whose it is, where, what it does", () => {
    expect(resourceOfCall(spec("stop_process"), { pid: 4242, force: true }, undefined, { facts })).toEqual({ program: ["node"], owner: ["session"], machine: ["desk"], action: ["stop", "force"] });
    expect(resourceOfCall(spec("read_process"), { pid: 9999 }, undefined, { facts })).toEqual({ program: ["(pid 9999)"], owner: ["(pid 9999)"], machine: ["desk"] });
    // A picture of a whole display shows every window on the screen.
    expect(resourceOfCall(spec("screenshot"), {}, undefined, { facts })).toEqual({ program: ["code", "keepass"], owner: ["user", "user"], machine: ["desk"] });
    expect(resourceOfCall(spec("screenshot"), { window_id: 77 }, undefined, { facts })).toEqual({ program: ["code"], owner: ["user"], machine: ["desk"] });
    // Keys go to the window that has the keyboard; a pointer to any on the screen.
    expect(resourceOfCall(spec("control_input"), { steps: [{ action: "type", text: "x" }] }, undefined, { facts })).toMatchObject({ program: ["code"], owner: ["user"], action: ["keys"] });
    expect(resourceOfCall(spec("control_input"), { steps: [{ action: "left_click" }] }, undefined, { facts })).toMatchObject({ program: ["code", "keepass"], action: ["pointer"] });
    expect(resourceOfCall(spec("open_app"), { action: "open", target: "https://example.com/x" }, undefined, { facts })).toEqual({ program: ["(the app it opens in)"], owner: ["session"], machine: ["desk"], action: ["open"], site: ["https://example.com/x"] });
    expect(resourceOfCall(spec("open_app"), { action: "open", target: "C:\\work\\a.txt" }, undefined, { facts })).toMatchObject({ path: ["C:\\work\\a.txt"] });
    expect(resourceOfCall(spec("control_service"), { name: "spooler", action: "stop" }, undefined, { facts })).toEqual({ service: ["spooler"], machine: ["desk"], action: ["stop"] });
    expect(resourceOfCall(spec("install_program"), { action: "install", id: "Git.Git" }, undefined, { facts })).toEqual({ package: ["Git.Git"], machine: ["desk"], action: ["install"], manager: ["(the default manager)"] });
    expect(resourceOfCall(spec("write_settings"), { area: "registry", key: "HKLM\\SYSTEM", name: "x", value: 1 }, undefined, { facts })).toEqual({ area: ["registry/HKLM/SYSTEM/x"], owner: ["system"], machine: ["desk"], action: ["set"] });
    expect(resourceOfCall(spec("write_settings"), { area: "environment", name: "PATH", delete: true }, undefined, { facts })).toMatchObject({ owner: ["user"], action: ["delete"] });
    expect(resourceOfCall(spec("power"), { action: "lock" }, undefined, { facts })).toEqual({ action: ["lock"], machine: ["desk"] });
    expect(resourceOfCall(spec("read_clipboard"), {}, undefined, { facts })).toEqual({ machine: ["desk"] });
    // A tool that lists is judged by its rows, not by what it asked for.
    expect(resourceOfCall(spec("list_processes"), { name: "node", scope: "all" }, undefined, { facts })).toEqual({ owner: undefined, machine: ["desk"] });
  });

  it("answers a resource by the strictest of its kinds — every kind must allow it", () => {
    const stop = spec("stop_process");
    const line = { node: "allow", "owner=session": "allow", "owner=**": "ask", "action=force": "deny" } as const;
    const answer = (resource: Parameters<typeof resolveResource>[2]) => resolveResource(line, stop, resource);
    expect(answer({ program: ["node"], owner: ["session"], action: ["stop"] })).toMatchObject({ decision: "allow" });
    expect(answer({ program: ["node"], owner: ["user"], action: ["stop"] })).toMatchObject({ decision: "ask", kind: "owner", place: "**" });
    expect(answer({ program: ["node"], owner: ["session"], action: ["stop", "force"] })).toMatchObject({ decision: "deny", kind: "action", place: "force" });
    // A program no place names says nothing of its own: the line's `**` answers it with the rest.
    expect(answer({ program: ["python"], owner: ["session"], action: ["stop"] })).toMatchObject({ decision: "allow", unmatched: true });
    // What nobody could read could be any: every place of its kind could answer.
    expect(answer({ program: ["(pid 1)"], owner: ["(pid 1)"], action: ["stop"] })).toMatchObject({ decision: "ask", unmatched: true });
    expect(resolveResource({ "owner=session": "allow", "owner=user": "deny" }, stop, { owner: ["(pid 1)"] })).toMatchObject({ decision: "deny" });
  });

  it("reads a part of the machine off what a call reads or changes", () => {
    expect(areaPlacesOf("read_system", {})).toEqual(["summary"]);
    expect(areaPlacesOf("read_system", { about: "logs", log: "Security" })).toEqual(["logs/Security"]);
    expect(areaPlacesOf("read_settings", { area: "registry", key: "HKEY_CURRENT_USER\\Software\\Foo", name: "Bar" })).toEqual(["registry/HKCU/Software/Foo/Bar"]);
    expect(areaPlacesOf("write_settings", { area: "registry", key: "HKLM:\\SYSTEM\\CurrentControlSet", name: "x", value: 1 })).toEqual(["registry/HKLM/SYSTEM/CurrentControlSet/x"]);
    expect(areaPlacesOf("read_settings", { area: "registry", key: "Registry::HKEY_USERS\\S-1-5" })).toEqual(["registry/HKU/S-1-5/**"]);
    expect(areaPlacesOf("read_settings", { area: "defaults", key: "com.apple.dock", name: "autohide" })).toEqual(["defaults/com.apple.dock/autohide"]);
    expect(areaPlacesOf("read_settings", { area: "environment" })).toEqual(["environment/**"]);
    expect(areaPlacesOf("read_settings", { area: "time" })).toEqual(["time"]);
    expect(areaPlacesOf("write_settings", { area: "time_zone", value: "UTC" })).toEqual(["time_zone"]);
  });

  it("matches an area as a path: a bare one holds what is under it, a whole read takes the strictest under it", () => {
    const map: Record<string, PermissionSetMode> = { "**": "ask", registry: "allow", "registry/HKLM": "deny", "registry/hklm/software/*/Run": "ask", "environment/PATH": "allow" };
    expect(at(map, "area", "registry/HKCU/Software/Foo/Bar")!.place).toBe("registry");
    expect(at(map, "area", "registry/HKLM/SYSTEM/x")!.decision).toBe("deny");
    expect(at(map, "area", "registry/HKLM/Software/Microsoft/Run")!.place).toBe("registry/hklm/software/*/Run");
    expect(at(map, "area", "Environment/path")!.place).toBe("environment/PATH");
    const read = spec("read_settings");
    expect(resolveResource({ "environment/PATH": "allow", "environment/API_TOKEN": "deny" }, read, { area: ["environment/**"] })).toMatchObject({ decision: "deny", place: "environment/API_TOKEN" });
    expect(resolveResource({ environment: "allow" }, read, { area: ["environment/**"] })).toMatchObject({ decision: "allow", unmatched: false });
    expect(placeWidthsOf("area", "registry/HKCU/Software/Foo/Bar")).toEqual([
      { width: "this", place: "registry/HKCU/Software/Foo/Bar" },
      { width: "folder", place: "registry/HKCU/Software/Foo" },
      { width: "anywhere", place: "**" },
    ]);
    expect(placesMostSpecificFirst("area", ["**", "registry", "registry/HKLM/SYSTEM", "registry/HKLM/*"])).toEqual(["registry/HKLM/SYSTEM", "registry/HKLM/*", "registry", "**"]);
  });

  it("reads the files write_clipboard puts on the clipboard, and nothing for text", () => {
    expect(callPlacesOf(spec("write_clipboard"), { files: ["a.txt", "b/c.png"] }, "/work")).toEqual(["a.txt", "b/c.png"]);
    expect(callPlacesOf(spec("write_clipboard"), { image_path: "shot.png" }, "/work")).toEqual(["shot.png"]);
    expect(callPlacesOf(spec("write_clipboard"), { text: "hello" }, "/work")).toEqual([]);
  });

  it("reads keys as the program that has the keyboard, and a pointer as no one program", () => {
    expect(inputPlacesOf([{ action: "type", text: "x" }, { action: "key", keys: "enter" }], { facts })).toEqual(["code"]);
    expect(inputPlacesOf([{ action: "type", text: "x" }], {})).toEqual(["(focused window)"]);
    expect(inputPlacesOf([{ action: "left_click", x: 1, y: 2 }], { facts })).toEqual(["(pointer)"]);
    expect(inputPlacesOf([{ action: "wait", seconds: 1 }, { action: "cursor_position" }], { facts })).toEqual([]);
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
