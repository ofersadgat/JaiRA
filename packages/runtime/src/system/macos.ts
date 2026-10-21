/**
 * The System tools on macOS (decision 0018 §2, ruling 3: right after Windows) — macOS's own programs
 * and nothing to install: `ps`, `launchctl`, `defaults`, `pbcopy`/`pbpaste`, `pmset`, `screencapture`,
 * `sips`, `brew` where it is, and JavaScript for Automation (`osascript -l JavaScript`) where a program
 * does not reach: the windows, the screen's geometry and the mouse and keyboard, through its bridge to
 * CoreGraphics and AppKit.
 *
 * Two things macOS asks the person for, once, and the tools say so rather than fail quietly:
 *  - **Screen Recording** — a screenshot, and the titles of other apps' windows;
 *  - **Accessibility** — the mouse and keyboard. Without it macOS drops the events without a word, so
 *    `input` checks first (`AXIsProcessTrusted`) and refuses with where to grant it.
 *
 * Every program is started with its arguments as an array, and a JXA script reads the call's
 * arguments as JSON from its own argv — no value a call supplied is ever spliced into a script.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, networkInterfaces, tmpdir, userInfo } from "node:os";
import { basename, join } from "node:path";
import type { JsonValue } from "@declarative-ai/exec";
import {
  SystemToolRefusal,
  type ClipboardContent,
  type ClipboardWrite,
  type InputStep,
  type InstallRequest,
  type InstallResult,
  type LogQuery,
  type OpenRequest,
  type PowerAction,
  type ProcessRow,
  type ReadSettingsRequest,
  type ScreenPicture,
  type ScreenshotRequest,
  type ServiceAction,
  type ServiceRow,
  type SoftwareKind,
  type SoftwareRow,
  type StartType,
  type SystemAbout,
  type SystemBackend,
  type WindowRow,
  type WriteSettingsRequest,
} from "./types";

/** Run a program to its end, its arguments an array; `input` on stdin. */
export function run(program: string, args: readonly string[], options: { timeoutMs?: number; input?: string | Uint8Array; signal?: AbortSignal } = {}): Promise<{ code: number; stdout: string; stderr: string; bytes: Buffer }> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, [...args], { stdio: [options.input !== undefined ? "pipe" : "ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout!.on("data", (c: Buffer) => out.push(c));
    child.stderr!.on("data", (c: Buffer) => err.push(c));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${basename(program)} did not finish within ${Math.round((options.timeoutMs ?? 30_000) / 1000)} s`));
    }, options.timeoutMs ?? 30_000);
    const onAbort = (): void => {
      child.kill("SIGKILL");
      clearTimeout(timer);
      reject(new SystemToolRefusal("stopped by the person"));
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject((e as NodeJS.ErrnoException).code === "ENOENT" ? new SystemToolRefusal(`${basename(program)} is not on this Mac`) : e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      const bytes = Buffer.concat(out);
      resolve({ code: code ?? -1, stdout: bytes.toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), bytes });
    });
    if (options.input !== undefined) child.stdin!.end(options.input);
  });
}

/** Run a program and return what it wrote, raising its error output when it fails. */
async function out(program: string, args: readonly string[], options: { timeoutMs?: number; input?: string | Uint8Array } = {}): Promise<string> {
  const done = await run(program, args, options);
  if (done.code !== 0) throw new Error(`${basename(program)} ${args[0] ?? ""} failed (${done.code}): ${firstLines(done.stderr || done.stdout)}`);
  return done.stdout;
}

const firstLines = (text: string, n = 3): string =>
  text
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .slice(0, n)
    .join(" ");

/**
 * Run a JavaScript-for-Automation script with `args` as `$A`; the script returns its answer as the
 * last expression's value, which `osascript` prints — here as JSON. `null` answers nothing.
 */
async function jxa<T>(script: string, args: unknown, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
  const program = `function run(argv) { const $A = JSON.parse(argv[0]); ObjC.import("Cocoa"); ObjC.import("CoreGraphics"); const answer = (function () { ${script} })(); return JSON.stringify(answer === undefined ? null : answer); }`;
  const done = await run("/usr/bin/osascript", ["-l", "JavaScript", "-e", program, JSON.stringify(args ?? null)], options);
  if (done.code !== 0) {
    const why = firstLines(done.stderr);
    const refused = /REFUSED: (.*)$/m.exec(done.stderr);
    if (refused !== null) throw new SystemToolRefusal(refused[1]!.trim());
    throw new Error(why.length > 0 ? why : `osascript failed (${done.code})`);
  }
  const text = done.stdout.trim();
  return (text.length === 0 ? null : JSON.parse(text)) as T;
}

/** A refusal from inside a JXA script: thrown as `REFUSED: …`, said to the model as it is. */
const REFUSE = `function refuse(message) { throw new Error("REFUSED: " + message); }`;

/** What the person grants JaiRA in System Settings, named the way the page names it. */
const GRANT = {
  screen: "Screen Recording: System Settings → Privacy & Security → Screen & System Audio Recording → turn JaiRA on, then quit and reopen JaiRA",
  input: "Accessibility: System Settings → Privacy & Security → Accessibility → turn JaiRA on",
};

/** A scratch folder for one call, removed after. */
async function withScratch<T>(use: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "jaira-system-"));
  try {
    return await use(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- reading what programs answer --------------------------------------------------------------

/** `ps -axo pid=,ppid=,rss=,time=,lstart=,comm=`: pid, parent, kB, cpu time, a five-word start, the path. */
export function parsePs(text: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d{4})\s+(.+?)\s*$/.exec(line);
    if (m === null) continue;
    const [, pid, ppid, rss, time, lstart, comm] = m;
    const started = Date.parse(lstart!);
    rows.push({
      pid: Number(pid),
      parent_pid: Number(ppid),
      name: basename(comm!),
      memory_mb: Math.round((Number(rss) / 1024) * 10) / 10,
      cpu_seconds: cpuSeconds(time!),
      ...(Number.isNaN(started) ? {} : { started: new Date(started).toISOString() }),
      ...(comm!.startsWith("/") ? { path: comm! } : {}),
    });
  }
  return rows;
}

/** `ps`'s cpu time: `MM:SS.ss`, `HH:MM:SS` or `D-HH:MM:SS`. */
function cpuSeconds(time: string): number {
  const [days, rest] = time.includes("-") ? [Number(time.split("-")[0]), time.split("-")[1]!] : [0, time];
  const parts = rest.split(":").map(Number);
  const seconds = parts.reduce((sum, part) => sum * 60 + part, 0);
  return Math.round((days * 86_400 + seconds) * 10) / 10;
}

/** `launchctl list`: `PID Status Label`, a running job's pid or `-`. */
export function parseLaunchctlList(text: string): ServiceRow[] {
  const rows: ServiceRow[] = [];
  for (const line of text.split(/\r?\n/).slice(1)) {
    const m = /^(\S+)\s+(\S+)\s+(.+)$/.exec(line.trim());
    if (m === null) continue;
    rows.push({ name: m[3]!, status: m[1] !== "-" ? "running" : "stopped" });
  }
  return rows;
}

/** `df -kP`: the mounted volumes of real disks, by where they are mounted. */
export function parseDf(text: string): JsonValue[] {
  return text
    .split(/\r?\n/)
    .slice(1)
    .flatMap((line) => {
      const m = /^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+\d+%\s+(.+)$/.exec(line.trim());
      if (m === null || !m[1]!.startsWith("/dev/")) return [];
      const gb = (kb: string): number => Math.round((Number(kb) / 1024 / 1024) * 10) / 10;
      return [{ name: m[5]!, device: m[1]!, size_gb: gb(m[2]!), free_gb: gb(m[4]!) }];
    });
}

/** `brew list --versions`: `name v1 v2`. */
export function parseBrewList(text: string, cask: boolean): SoftwareRow[] {
  return text
    .split(/\r?\n/)
    .flatMap((line) => {
      const [name, ...versions] = line.trim().split(/\s+/);
      return name !== undefined && name.length > 0 ? [{ name, id: name, ...(versions.length > 0 ? { version: versions[versions.length - 1]! } : {}), kind: "package" as const, ...(cask ? { publisher: "Homebrew cask" } : { publisher: "Homebrew" }) }] : [];
    });
}

/** A domain name `defaults` takes — reverse-DNS words, or `NSGlobalDomain`/`-g`. */
const DOMAIN = /^(-g|NSGlobalDomain|[A-Za-z0-9][A-Za-z0-9._-]*)$/;

// --- the JXA scripts -------------------------------------------------------------------------------

/** The on-screen windows, as CoreGraphics lists them: layer 0 (apps' own), with an owner. */
const WINDOWS = `
const list = ObjC.deepUnwrap($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, $.kCGNullWindowID)) || [];
const front = $.NSWorkspace.sharedWorkspace.frontmostApplication;
const frontPid = front ? front.processIdentifier : -1;
let first = true;
return list.filter(w => w.kCGWindowLayer === 0 && w.kCGWindowOwnerName).map(w => {
  const b = w.kCGWindowBounds || {};
  const focused = first && w.kCGWindowOwnerPID === frontPid;
  if (w.kCGWindowOwnerPID === frontPid) first = false;
  return { window_id: w.kCGWindowNumber, title: w.kCGWindowName || "", app: w.kCGWindowOwnerName, pid: w.kCGWindowOwnerPID, focused: focused, minimized: false, bounds: { x: b.X || 0, y: b.Y || 0, width: b.Width || 0, height: b.Height || 0 } };
});
`;

/** The displays, in the points input is measured in, main first. */
const DISPLAYS = `
const screens = ObjC.deepUnwrap($.NSScreen.screens) ? $.NSScreen.screens : null;
const ids = [];
const max = 16;
const buffer = Ref();
const count = Ref();
$.CGGetActiveDisplayList(max, buffer, count);
const main = $.CGMainDisplayID();
const out = [];
for (let i = 0; i < count[0]; i++) {
  const id = buffer[i];
  const r = $.CGDisplayBounds(id);
  out.push({ id: id, main: id === main, x: r.origin.x, y: r.origin.y, width: r.size.width, height: r.size.height });
}
out.sort((a, b) => (b.main ? 1 : 0) - (a.main ? 1 : 0));
return out;
`;

/** A window brought to the front: its app, activated. */
const FOCUS = `
${REFUSE}
const list = ObjC.deepUnwrap($.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll, $.kCGNullWindowID)) || [];
const w = list.find(x => x.kCGWindowNumber === $A.windowId);
if (!w) refuse("there is no window " + $A.windowId + " — list_windows lists them");
const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(w.kCGWindowOwnerPID);
if (!app) refuse("the app of window " + $A.windowId + " is not running");
if (app.isHidden) app.unhide;
return { focused: app.activateWithOptions($.NSApplicationActivateIgnoringOtherApps) };
`;

/**
 * Input through CoreGraphics events, in points — the computer-use action set. macOS drops posted events
 * from a process it has not been told to trust, so trust is checked first.
 */
const INPUT = `
${REFUSE}
ObjC.import("ApplicationServices");
if (!$.AXIsProcessTrusted()) refuse("macOS has not let JaiRA use the mouse and keyboard — the person grants it in ${GRANT.input}");
const guarded = $A.protected || [];
function pidAt(x, y) {
  const list = ObjC.deepUnwrap($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, $.kCGNullWindowID)) || [];
  const w = list.find(w => w.kCGWindowLayer === 0 && w.kCGWindowBounds && x >= w.kCGWindowBounds.X && y >= w.kCGWindowBounds.Y && x < w.kCGWindowBounds.X + w.kCGWindowBounds.Width && y < w.kCGWindowBounds.Y + w.kCGWindowBounds.Height);
  return w ? w.kCGWindowOwnerPID : -1;
}
function focusedPid() { const a = $.NSWorkspace.sharedWorkspace.frontmostApplication; return a ? a.processIdentifier : -1; }
function guard(pid, what) { if (guarded.indexOf(pid) >= 0) refuse("refused: " + what + " JaiRA's own window — an agent may not click or type into JaiRA. Focus another window first (open_app focus)"); }
function here() { const e = $.CGEventCreate(null); const p = $.CGEventGetLocation(e); return { x: p.x, y: p.y }; }
function post(e) { $.CGEventPost($.kCGHIDEventTap, e); delay(0.02); }
function mouse(type, x, y, button, clicks) { const e = $.CGEventCreateMouseEvent(null, type, $.CGPointMake(x, y), button); if (clicks) $.CGEventSetIntegerValueField(e, $.kCGMouseEventClickState, clicks); post(e); }
const BUTTONS = { left: [$.kCGEventLeftMouseDown, $.kCGEventLeftMouseUp, $.kCGMouseButtonLeft], right: [$.kCGEventRightMouseDown, $.kCGEventRightMouseUp, $.kCGMouseButtonRight], middle: [$.kCGEventOtherMouseDown, $.kCGEventOtherMouseUp, $.kCGMouseButtonCenter] };
function click(which, times, x, y) {
  const b = BUTTONS[which];
  for (let i = 1; i <= times; i++) { mouse(b[0], x, y, b[2], i); mouse(b[1], x, y, b[2], i); }
}
const KEYS = { a:0,s:1,d:2,f:3,h:4,g:5,z:6,x:7,c:8,v:9,b:11,q:12,w:13,e:14,r:15,y:16,t:17,"1":18,"2":19,"3":20,"4":21,"6":22,"5":23,"=":24,"9":25,"7":26,"-":27,"8":28,"0":29,"]":30,o:31,u:32,"[":33,i:34,p:35,l:37,j:38,"'":39,k:40,";":41,"\\\\":42,",":43,"/":44,n:45,m:46,".":47,"\`":50,
  enter:36, return:36, tab:48, space:49, backspace:51, delete:117, del:117, escape:53, esc:53, home:115, end:119, page_up:116, pageup:116, page_down:121, pagedown:121, left:123, right:124, down:125, up:126,
  f1:122,f2:120,f3:99,f4:118,f5:96,f6:97,f7:98,f8:100,f9:101,f10:109,f11:103,f12:111, minus:27, equal:24, plus:24, comma:43, period:47, slash:44, semicolon:41, quote:39, apostrophe:39, bracketleft:33, bracketright:30, backslash:42, grave:50 };
const FLAGS = { cmd: $.kCGEventFlagMaskCommand, command: $.kCGEventFlagMaskCommand, super: $.kCGEventFlagMaskCommand, meta: $.kCGEventFlagMaskCommand, win: $.kCGEventFlagMaskCommand, ctrl: $.kCGEventFlagMaskControl, control: $.kCGEventFlagMaskControl, shift: $.kCGEventFlagMaskShift, alt: $.kCGEventFlagMaskAlternate, option: $.kCGEventFlagMaskAlternate };
function chord(keys) {
  let flags = 0; let code = -1;
  for (const part of keys.split("+")) {
    const k = part.trim().toLowerCase();
    if (FLAGS[k] !== undefined) flags |= FLAGS[k];
    else if (KEYS[k] !== undefined) code = KEYS[k];
    else refuse("'" + part + "' is not a key this knows — use a letter, a digit, a name like enter, tab, escape, f5, page_down, or a modifier cmd, ctrl, shift, alt");
  }
  return { flags: flags, code: code };
}
function key(c, down) { const e = $.CGEventCreateKeyboardEvent(null, c.code, down); $.CGEventSetFlags(e, c.flags); post(e); }
function press(keys) { const c = chord(keys); if (c.code < 0) refuse("'" + keys + "' names no key to press, only modifiers"); key(c, true); key(c, false); }
function type(text) {
  for (const ch of Array.from(text)) {
    if (ch === "\\n") { press("enter"); continue; }
    const e = $.CGEventCreateKeyboardEvent(null, 0, true);
    $.CGEventKeyboardSetUnicodeString(e, ch.length, ch);
    post(e);
    const u = $.CGEventCreateKeyboardEvent(null, 0, false);
    $.CGEventKeyboardSetUnicodeString(u, ch.length, ch);
    post(u);
  }
}
for (const step of $A.steps) {
  const at = step.x !== undefined ? { x: step.x, y: step.y } : here();
  if (["left_click", "right_click", "middle_click", "double_click", "triple_click", "left_mouse_down", "scroll"].indexOf(step.action) >= 0) guard(pidAt(at.x, at.y), "that point is on");
  if (step.action === "left_click_drag") { guard(pidAt(step.from.x, step.from.y), "the drag starts on"); guard(pidAt(step.x, step.y), "the drag ends on"); }
  if (["type", "key", "hold_key"].indexOf(step.action) >= 0) guard(focusedPid(), "the keyboard is in");
  switch (step.action) {
    case "mouse_move": mouse($.kCGEventMouseMoved, step.x, step.y, $.kCGMouseButtonLeft, 0); break;
    case "left_click": { const c = step.keys ? chord(step.keys) : null; if (c) { const d = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseDown, $.CGPointMake(at.x, at.y), $.kCGMouseButtonLeft); $.CGEventSetFlags(d, c.flags); post(d); const u = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseUp, $.CGPointMake(at.x, at.y), $.kCGMouseButtonLeft); $.CGEventSetFlags(u, c.flags); post(u); } else click("left", 1, at.x, at.y); break; }
    case "right_click": click("right", 1, at.x, at.y); break;
    case "middle_click": click("middle", 1, at.x, at.y); break;
    case "double_click": click("left", 2, at.x, at.y); break;
    case "triple_click": click("left", 3, at.x, at.y); break;
    case "left_mouse_down": mouse($.kCGEventLeftMouseDown, at.x, at.y, $.kCGMouseButtonLeft, 1); break;
    case "left_mouse_up": mouse($.kCGEventLeftMouseUp, at.x, at.y, $.kCGMouseButtonLeft, 1); break;
    case "left_click_drag":
      mouse($.kCGEventLeftMouseDown, step.from.x, step.from.y, $.kCGMouseButtonLeft, 1); delay(0.08);
      mouse($.kCGEventLeftMouseDragged, step.x, step.y, $.kCGMouseButtonLeft, 1); delay(0.08);
      mouse($.kCGEventLeftMouseUp, step.x, step.y, $.kCGMouseButtonLeft, 1); break;
    case "scroll": {
      if (step.x !== undefined) mouse($.kCGEventMouseMoved, at.x, at.y, $.kCGMouseButtonLeft, 0);
      const n = step.amount; const dy = step.direction === "up" ? n : step.direction === "down" ? -n : 0; const dx = step.direction === "left" ? n : step.direction === "right" ? -n : 0;
      post($.CGEventCreateScrollWheelEvent(null, $.kCGScrollEventUnitLine, 2, dy * 3, dx * 3)); break;
    }
    case "type": type(step.text); break;
    case "key": press(step.keys); break;
    case "hold_key": { const c = chord(step.keys); key(c, true); delay(step.seconds); key(c, false); break; }
    case "wait": delay(step.seconds); break;
    case "cursor_position": break;
  }
  delay(0.05);
}
return { cursor: here() };
`;

// --- the backend ---------------------------------------------------------------------------------

export class MacSystem implements SystemBackend {
  readonly os = "macos" as const;
  /** A restart or shut-down counting down, which `cancel` stops. */
  private pending: ReturnType<typeof setTimeout> | undefined;

  async readSystem(about: SystemAbout, log: LogQuery): Promise<JsonValue> {
    switch (about) {
      case "summary": {
        const vers = await out("/usr/bin/sw_vers", []);
        const field = (name: string): string => new RegExp(`${name}:\\s*(.+)`).exec(vers)?.[1]?.trim() ?? "";
        const model = (await run("/usr/sbin/sysctl", ["-n", "hw.model"])).stdout.trim();
        return { os: { name: field("ProductName"), version: field("ProductVersion"), build: field("BuildVersion") }, model, elevated: process.getuid?.() === 0, time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone };
      }
      case "hardware": {
        const json = JSON.parse(await out("/usr/sbin/system_profiler", ["-json", "SPHardwareDataType", "SPDisplaysDataType"], { timeoutMs: 60_000 })) as Record<string, Array<Record<string, unknown>>>;
        const hw = json["SPHardwareDataType"]?.[0] ?? {};
        return {
          machine: { model: hw["machine_name"] ?? null, identifier: hw["machine_model"] ?? null, chip: hw["chip_type"] ?? hw["cpu_type"] ?? null, memory: hw["physical_memory"] ?? null, serial_hidden: true },
          gpus: (json["SPDisplaysDataType"] ?? []).map((gpu) => ({ name: gpu["sppci_model"] ?? gpu["_name"] ?? null, cores: gpu["sppci_cores"] ?? null })),
        } as JsonValue;
      }
      case "disks":
        return parseDf(await out("/bin/df", ["-kP"]));
      case "network": {
        const gateway = /gateway:\s*(\S+)/.exec((await run("/sbin/route", ["-n", "get", "default"])).stdout)?.[1];
        const dns = [...new Set([...(await run("/usr/sbin/scutil", ["--dns"])).stdout.matchAll(/nameserver\[\d+\]\s*:\s*(\S+)/g)].map((m) => m[1]!))];
        return Object.entries(networkInterfaces()).map(([name, addresses]) => ({
          name,
          addresses: (addresses ?? []).map((a) => a.address),
          mac: (addresses ?? []).find((a) => a.mac !== "00:00:00:00:00:00")?.mac ?? null,
          ...(name === "en0" && gateway !== undefined ? { gateways: [gateway] } : {}),
          ...(name === "en0" ? { dns } : {}),
        })) as JsonValue;
      }
      case "users": {
        const listed = await out("/usr/bin/dscl", [".", "-list", "/Users", "UniqueID"]);
        const users = listed.split(/\r?\n/).flatMap((line) => {
          const m = /^(\S+)\s+(-?\d+)$/.exec(line.trim());
          return m !== null && Number(m[2]) >= 500 ? [{ name: m[1]!, uid: Number(m[2]) }] : [];
        });
        return { current: userInfo().username, users };
      }
      case "logs": {
        const predicates = [
          ...(log.log !== undefined ? [`subsystem == ${JSON.stringify(log.log)}`] : []),
          ...(log.level === "critical" ? ["messageType == fault"] : log.level === "error" ? ["(messageType == error OR messageType == fault)"] : []),
        ];
        const args = ["show", "--style", "ndjson", "--last", `${log.sinceMinutes}m`, ...(predicates.length > 0 ? ["--predicate", predicates.join(" AND ")] : [])];
        const text = await out("/usr/bin/log", args, { timeoutMs: 120_000 });
        const entries = text
          .split(/\r?\n/)
          .flatMap((line) => {
            try {
              const e = JSON.parse(line) as Record<string, unknown>;
              return e["eventMessage"] !== undefined ? [{ time: String(e["timestamp"] ?? ""), level: String(e["messageType"] ?? ""), provider: String(e["subsystem"] || e["processImagePath"] || ""), message: String(e["eventMessage"]).slice(0, 2000) }] : [];
            } catch {
              return [];
            }
          });
        return entries.slice(-log.limit).reverse() as JsonValue;
      }
    }
  }

  async power(action: PowerAction, delaySeconds: number): Promise<JsonValue> {
    const say = async (verb: string): Promise<void> => {
      await out("/usr/bin/osascript", ["-e", `tell application "System Events" to ${verb}`]);
    };
    switch (action) {
      case "restart":
      case "shut_down": {
        if (this.pending !== undefined) clearTimeout(this.pending);
        const verb = action === "restart" ? "restart" : "shut down";
        // macOS's own restart asks each app to quit, as the Apple menu does; it waits here first.
        this.pending = setTimeout(() => {
          this.pending = undefined;
          void say(verb).catch(() => undefined);
        }, Math.max(0, delaySeconds) * 1000);
        return { done: `${action === "restart" ? "restarting" : "shutting down"} in ${Math.round(delaySeconds)} s — 'cancel' stops it until then` };
      }
      case "cancel":
        if (this.pending === undefined) throw new SystemToolRefusal("nothing is counting down — a restart or shut-down this did not start cannot be cancelled here");
        clearTimeout(this.pending);
        this.pending = undefined;
        return { done: "the pending restart or shut-down is cancelled" };
      case "sleep":
        await out("/usr/bin/pmset", ["sleepnow"]);
        return { done: "going to sleep" };
      case "hibernate":
        throw new SystemToolRefusal("a Mac does not hibernate on request — 'sleep' puts it to sleep, and macOS decides when to hibernate");
      case "sign_out":
        await say("log out");
        return { done: "signing out — apps are asked to quit first" };
      case "lock":
        await out("/usr/bin/pmset", ["displaysleepnow"]);
        return { done: "the display is asleep — it is locked when the Mac asks for the password on waking (Lock Screen settings)" };
    }
  }

  async processes(): Promise<ProcessRow[]> {
    return parsePs(await out("/bin/ps", ["-axo", "pid=,ppid=,rss=,time=,lstart=,comm="]));
  }

  async stopProcess(pid: number, options: { started?: string; tree: boolean; force: boolean }): Promise<{ stopped: boolean; how: string }> {
    const rows = await this.processes();
    const row = rows.find((r) => r.pid === pid);
    if (row === undefined) throw new SystemToolRefusal(`no process ${pid} is running`);
    if (options.started !== undefined && row.started !== options.started) throw new SystemToolRefusal(`process ${pid} is not the one listed: that one has ended, and the number is another program's now`);
    const pids = [pid];
    if (options.tree) {
      for (let i = 0; i < pids.length; i++) for (const child of rows) if (child.parent_pid === pids[i] && !pids.includes(child.pid)) pids.push(child.pid);
    }
    const signal = options.force ? "SIGKILL" : "SIGTERM";
    for (const target of pids) {
      try {
        process.kill(target, signal);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EPERM") throw new SystemToolRefusal(`process ${target} belongs to another user — stopping it needs an administrator`);
      }
    }
    if (options.force) return { stopped: true, how: `killed${pids.length > 1 ? `, with ${pids.length - 1} it started` : ""}` };
    // Asked to end; what has not in 5 s is killed.
    for (let waited = 0; waited < 5000; waited += 250) {
      if (pids.every((p) => !alive(p))) return { stopped: true, how: "asked to end, and it did" };
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    for (const target of pids) if (alive(target)) process.kill(target, "SIGKILL");
    return { stopped: true, how: "asked to end; killed when it had not in 5 s" };
  }

  async services(): Promise<ServiceRow[]> {
    return parseLaunchctlList(await out("/bin/launchctl", ["list"]));
  }

  async controlService(name: string, action: ServiceAction, startType?: StartType): Promise<ServiceRow> {
    if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new SystemToolRefusal(`'${name}' is not a service's label — list_services lists them`);
    const target = `gui/${process.getuid?.() ?? 501}/${name}`;
    const args =
      action === "start"
        ? ["kickstart", target]
        : action === "restart"
          ? ["kickstart", "-k", target]
          : action === "stop"
            ? ["kill", "SIGTERM", target]
            : action === "set_start_type"
              ? [startType === "disabled" ? "disable" : "enable", target]
              : undefined;
    if (args === undefined) throw new SystemToolRefusal(`a launchd job cannot ${action} — start, stop, restart or set_start_type`);
    const done = await run("/bin/launchctl", args);
    if (done.code !== 0) {
      if (/Operation not permitted|not privileged|Permission denied/i.test(done.stderr)) throw new SystemToolRefusal(`changing '${name}' needs an administrator — a system service is changed with sudo launchctl, by the person`);
      throw new Error(`launchctl ${args[0]} failed (${done.code}): ${firstLines(done.stderr || done.stdout)}`);
    }
    return (await this.services()).find((s) => s.name === name) ?? { name, status: "unknown" };
  }

  async software(kind: SoftwareKind): Promise<SoftwareRow[]> {
    if (kind === "apps") throw new SystemToolRefusal("on macOS the App Store's apps are among the 'programs'");
    if (kind === "modules") throw new SystemToolRefusal("'modules' are PowerShell's — on macOS: 'programs' (the applications) or 'packages' (Homebrew's)");
    if (kind === "packages") {
      const formulae = await run("brew", ["list", "--versions", "--formula"], { timeoutMs: 60_000 });
      if (formulae.code !== 0) throw new SystemToolRefusal("Homebrew is not installed on this Mac — https://brew.sh");
      const casks = await run("brew", ["list", "--versions", "--cask"], { timeoutMs: 60_000 });
      return [...parseBrewList(formulae.stdout, false), ...(casks.code === 0 ? parseBrewList(casks.stdout, true) : [])];
    }
    const rows: SoftwareRow[] = [];
    for (const folder of ["/Applications", "/Applications/Utilities", join(homedir(), "Applications")]) {
      let names: string[] = [];
      try {
        names = readdirSync(folder).filter((n) => n.endsWith(".app"));
      } catch {
        continue;
      }
      for (const name of names) {
        const info = await run("/usr/bin/plutil", ["-convert", "json", "-o", "-", join(folder, name, "Contents", "Info.plist")]);
        let plist: Record<string, unknown> = {};
        try {
          plist = JSON.parse(info.stdout) as Record<string, unknown>;
        } catch {
          // A plist JSON cannot hold (a date, data) — the app is listed by its name.
        }
        const version = plist["CFBundleShortVersionString"] ?? plist["CFBundleVersion"];
        rows.push({ name: name.replace(/\.app$/, ""), ...(typeof plist["CFBundleIdentifier"] === "string" ? { id: plist["CFBundleIdentifier"] } : {}), ...(typeof version === "string" ? { version } : {}), kind: "program" });
      }
    }
    return rows;
  }

  async installSoftware(request: InstallRequest, timeoutMs: number): Promise<InstallResult> {
    if (request.manager !== "brew") throw new SystemToolRefusal(`'${request.manager}' is not a package manager on macOS — use brew`);
    if (request.version !== undefined) throw new SystemToolRefusal("Homebrew installs the current version — name a versioned formula instead (python@3.12)");
    const args = request.action === "install" ? ["install", request.id] : request.action === "upgrade" ? ["upgrade", request.id] : ["uninstall", request.id];
    const done = await run("brew", args, { timeoutMs });
    const text = `${done.stdout}\n${done.stderr}`.split(/\r?\n/).filter((l) => l.trim().length > 0);
    return { exit_code: done.code, output: text.slice(-40).join("\n") };
  }

  async readSettings(request: ReadSettingsRequest): Promise<JsonValue> {
    switch (request.area) {
      case "registry":
        throw new SystemToolRefusal("the registry is Windows' — on macOS a program's settings are its 'defaults' domain");
      case "environment":
        throw new SystemToolRefusal("macOS keeps no store of environment variables — a shell's are in its profile (~/.zprofile, ~/.zshrc): read them with read_file");
      case "time":
        return { now: new Date().toISOString(), time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone, utc_offset_minutes: -new Date().getTimezoneOffset() };
      case "defaults": {
        const domain = request.key;
        if (domain === undefined || !DOMAIN.test(domain)) throw new SystemToolRefusal("name the domain: `key`, like com.apple.dock, or NSGlobalDomain");
        if (request.name !== undefined) {
          const one = await run("/usr/bin/defaults", ["read", domain, request.name]);
          if (one.code !== 0) throw new SystemToolRefusal(`the domain ${domain} has no key '${request.name}'`);
          const type = (await run("/usr/bin/defaults", ["read-type", domain, request.name])).stdout.replace(/^Type is\s*/i, "").trim();
          return { domain, name: request.name, type, value: one.stdout.trim() };
        }
        const exported = await run("/usr/bin/defaults", ["export", domain, "-"]);
        if (exported.code !== 0) throw new SystemToolRefusal(`there is no defaults domain '${domain}'`);
        const asJson = await run("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"], { input: exported.bytes });
        if (asJson.code === 0) return { domain, values: JSON.parse(asJson.stdout) as JsonValue };
        // It holds a date or data, which JSON cannot: as macOS writes it, then.
        return { domain, plist: exported.stdout.slice(0, 50_000) };
      }
    }
  }

  async writeSettings(request: WriteSettingsRequest): Promise<JsonValue> {
    switch (request.area) {
      case "registry":
        throw new SystemToolRefusal("the registry is Windows' — on macOS a program's settings are its 'defaults' domain");
      case "environment":
        throw new SystemToolRefusal("macOS keeps no store of environment variables — a shell's are set in its profile (~/.zprofile): edit it with the file tools");
      case "time_zone": {
        const zone = typeof request.value === "string" ? request.value : "";
        const done = await run("/usr/sbin/systemsetup", ["-settimezone", zone]);
        if (done.code !== 0 || /administrator|privilege/i.test(done.stdout + done.stderr)) throw new SystemToolRefusal("setting the time zone needs an administrator on macOS — the person sets it in System Settings → General → Date & Time");
        return { time_zone: zone };
      }
      case "defaults": {
        const domain = request.key;
        if (domain === undefined || !DOMAIN.test(domain)) throw new SystemToolRefusal("name the domain: `key`, like com.apple.dock, or NSGlobalDomain");
        const name = request.name!;
        if (request.delete === true) {
          await out("/usr/bin/defaults", ["delete", domain, name]);
          return { deleted: true, domain, name };
        }
        const value = request.value;
        const type = request.type ?? (typeof value === "boolean" ? "bool" : typeof value === "number" ? (Number.isInteger(value) ? "int" : "float") : "string");
        if (!["string", "int", "float", "bool"].includes(type)) throw new SystemToolRefusal("a defaults value is a string, int, float or bool");
        await out("/usr/bin/defaults", ["write", domain, name, `-${type}`, String(value)]);
        return { set: true, domain, name, type, note: "an app that is running may keep its old value until it is restarted" };
      }
    }
  }

  async readClipboard(): Promise<ClipboardContent> {
    const text = (await run("/usr/bin/pbpaste", [])).stdout;
    const picture = await run("/usr/bin/osascript", ["-e", "try", "-e", "return (the clipboard as «class PNGf»)", "-e", "on error", "-e", 'return ""', "-e", "end try"]);
    const hex = /«data PNGf([0-9A-Fa-f]+)»/.exec(picture.stdout)?.[1];
    const png = hex !== undefined ? Buffer.from(hex, "hex") : undefined;
    return {
      ...(text.length > 0 ? { text } : {}),
      ...(png !== undefined && png.length > 24 ? { image: { png, width: png.readUInt32BE(16), height: png.readUInt32BE(20) } } : {}),
    };
  }

  async writeClipboard(write: ClipboardWrite): Promise<void> {
    if (write.text !== undefined) {
      await out("/usr/bin/pbcopy", [], { input: write.text });
      return;
    }
    if (write.imageFile !== undefined) {
      await jxa(`${REFUSE}
        const image = $.NSImage.alloc.initWithContentsOfFile($A.file);
        if (image.isNil()) refuse("that file is no picture macOS can read");
        const board = $.NSPasteboard.generalPasteboard; board.clearContents; board.writeObjects($([image]));
        return true;`, { file: write.imageFile });
      return;
    }
    if (write.files !== undefined) {
      await jxa(`const board = $.NSPasteboard.generalPasteboard; board.clearContents;
        board.writeObjects($($A.files.map(f => $.NSURL.fileURLWithPath(f)))); return true;`, { files: write.files });
    }
  }

  windows(): Promise<WindowRow[]> {
    return jxa<WindowRow[]>(WINDOWS, null);
  }

  async openApp(request: OpenRequest): Promise<JsonValue> {
    switch (request.action) {
      case "launch":
        await out("/usr/bin/open", ["-a", request.app!]);
        return { launched: request.app! };
      case "open":
        await out("/usr/bin/open", [...(request.app !== undefined ? ["-a", request.app] : []), request.target!]);
        return { opened: request.target!, ...(request.app !== undefined ? { with: request.app } : {}) };
      case "focus":
        return jxa<JsonValue>(FOCUS, { windowId: request.windowId });
      case "close": {
        // macOS closes a window through its app: bring it forward, then Command-W — what its close button does.
        await jxa<JsonValue>(FOCUS, { windowId: request.windowId });
        await this.input([{ action: "key", keys: "cmd+w" }], []);
        return { asked_to_close: true };
      }
    }
  }

  async screenshot(request: ScreenshotRequest): Promise<ScreenPicture> {
    return withScratch(async (dir) => {
      const file = join(dir, "screen.png");
      let region: ScreenPicture["region"];
      if (request.windowId !== undefined) {
        const window = (await this.windows()).find((w) => w.window_id === request.windowId);
        if (window === undefined) throw new SystemToolRefusal(`there is no window ${request.windowId} on screen — list_windows lists them`);
        region = window.bounds;
        await this.capture(["-x", "-o", "-l", String(request.windowId), file]);
      } else {
        const displays = await jxa<Array<{ x: number; y: number; width: number; height: number }>>(DISPLAYS, null);
        const index = request.display ?? 0;
        const display = displays[index];
        if (display === undefined) throw new SystemToolRefusal(`there are ${displays.length} displays, numbered from 0`);
        region = { x: display.x, y: display.y, width: display.width, height: display.height };
        await this.capture(["-x", "-D", String(index + 1), file]);
      }
      // Scaled so the long side is at most maxSide — a Retina picture is twice the points it shows.
      await out("/usr/bin/sips", ["-Z", String(request.maxSide), file]);
      const png = readFileSync(file);
      return { png, width: png.readUInt32BE(16), height: png.readUInt32BE(20), region };
    });
  }

  /** `screencapture`, which writes nothing — or a picture of the desktop alone — where Screen Recording is not granted. */
  private async capture(args: string[]): Promise<void> {
    const done = await run("/usr/sbin/screencapture", args);
    const file = args[args.length - 1]!;
    let written = 0;
    try {
      written = readFileSync(file).length;
    } catch {
      written = 0;
    }
    if (done.code !== 0 || written === 0) throw new SystemToolRefusal(`macOS did not let JaiRA take the picture — the person grants it in ${GRANT.screen}`);
  }

  input(steps: readonly InputStep[], guarded: readonly number[], signal?: AbortSignal): Promise<{ cursor?: { x: number; y: number } }> {
    const seconds = steps.reduce((sum, step) => sum + ("seconds" in step ? step.seconds : 0), 0);
    return jxa(INPUT, { steps, protected: guarded }, { timeoutMs: 30_000 + seconds * 1000, ...(signal !== undefined ? { signal } : {}) });
  }
}

/** Is a process still there? */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** For a test: write a file a script reads. */
export function scratchFile(dir: string, name: string, text: string): string {
  const file = join(dir, name);
  writeFileSync(file, text);
  return file;
}
