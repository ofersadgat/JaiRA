/**
 * Where the agents JaiRA signs in keep their sign-in on this machine (decision 0026 §4), so it can follow
 * the person to their other machines: what `claude auth login` and `codex login` leave behind.
 *
 * - **Claude Code** keeps its credentials in the macOS keychain, as the generic password
 *   `Claude Code-credentials` under the user's account, and elsewhere in `~/.claude/.credentials.json`
 *   (`$CLAUDE_CONFIG_DIR` moves it). Both hold the same JSON, so a sign-in made on a Mac lands in a
 *   Linux machine's file and the other way round. A Mac with a `CLAUDE_CONFIG_DIR` of its own files it
 *   under another name, which is not followed.
 * - **Codex** keeps `~/.codex/auth.json` (`$CODEX_HOME` moves it).
 * - **Inside WSL.** Where the agents run in a WSL distro (`execEnvironment: {wsl}`), they are Linux
 *   programs and keep their sign-ins in the distro's home: the same two files, read and written there
 *   through `wsl.exe`. A distro that is not running is not started to be looked at — nothing in it can
 *   have refreshed a sign-in — but one is started to be given a sign-in another machine made.
 *
 * The keychain is read and written through `security`, the program Claude Code itself files the item
 * with, so no prompt asks whether JaiRA may. A value never goes on a command line: it is written as hex
 * through `security -i`'s standard input, or through `sh`'s inside WSL.
 *
 * Not here: Gemini CLI keeps its Google sign-in in the OS keychain through a native module (service
 * `gemini-cli-oauth`), which another program cannot read on a Mac without the person being asked, and
 * its fallback file is encrypted with a key made from the machine's host name and user; OpenCode keeps
 * its credentials in its own database, whose `auth import` never replaces one it has.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";

/** One agent's sign-in on this machine. */
export interface AgentLoginStore {
  /** The agent it signs in, by its registry name. */
  agent: string;
  /** Why this machine's sign-in for it cannot be followed, when it cannot. */
  unavailable(): string | undefined;
  /** Where it is kept, when that is worth saying: inside a WSL distro. */
  where?(): string | undefined;
  /** What it holds now and when it was last written; undefined when it is signed out. */
  read(): { value: string; at: number } | undefined;
  write(value: string): void;
  remove(): void;
}

/** Run `wsl.exe` with these arguments (and this standard input): its exit status and what it printed. */
export type WslRun = (args: string[], input?: string) => { status: number; stdout: string };

export interface AgentLoginOptions {
  platform?: NodeJS.Platform;
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** The WSL distro the agents run in, when they do — on Windows only. Asked at every use. */
  wsl?: () => string | undefined;
  /** Tests: how `wsl.exe` is run. */
  runWsl?: WslRun;
}

/** What a stored sign-in holds, read without ever saying a token. */
export interface LoginState {
  /**
   * Whether it holds something that could sign the agent in: a refresh token not yet expired, or an
   * access token (or a key) not yet expired. A sign-in an agent wiped after a refused refresh — Claude
   * Code empties both tokens and keeps the account — is not.
   */
  usable: boolean;
  /** The account it names, when it names one: Claude Code's `accountUuid`, Codex's `account_id`. */
  account?: string;
}

/**
 * Read one agent's stored sign-in (the value of its {@link AgentLoginStore}). An agent this does not
 * know is taken as usable and naming no one: its value is passed on as it is.
 *
 * - **Claude Code** (`.credentials.json`, or the keychain item, the same JSON): `claudeAiOauth` with
 *   `accessToken`, `expiresAt`, `refreshToken`, `refreshTokenExpiresAt` and `accountUuid`. Seen
 *   2026-11-19 after a refused refresh: both tokens `""`, `expiresAt` 0, the account and plan kept.
 * - **Codex** (`auth.json`): `OPENAI_API_KEY` (a key, or null) and `tokens` with `access_token`,
 *   `refresh_token` and `account_id`.
 */
export function loginStateOf(agent: string, value: string, now: number = Date.now()): LoginState {
  if (agent !== "claude-cli" && agent !== "codex-cli") return { usable: value.trim() !== "" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { usable: false };
  }
  const object = (v: unknown): Record<string, unknown> | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
  const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v : undefined);
  const time = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);
  const alive = (token: unknown, expires: unknown): boolean => text(token) !== undefined && (time(expires) === undefined || time(expires)! > now);
  const root = object(parsed);
  if (agent === "claude-cli") {
    const oauth = object(root?.["claudeAiOauth"]);
    if (oauth === undefined) return { usable: false };
    const account = text(oauth["accountUuid"]);
    const usable = alive(oauth["refreshToken"], oauth["refreshTokenExpiresAt"]) || alive(oauth["accessToken"], oauth["expiresAt"]);
    return { usable, ...(account !== undefined ? { account } : {}) };
  }
  const tokens = object(root?.["tokens"]);
  const account = text(tokens?.["account_id"]);
  const usable = text(root?.["OPENAI_API_KEY"]) !== undefined || text(tokens?.["refresh_token"]) !== undefined || text(tokens?.["access_token"]) !== undefined;
  return { usable, ...(account !== undefined ? { account } : {}) };
}

/** The keychain item Claude Code files its credentials under on a Mac. */
export const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";

/** A sign-in kept as one file, written readable by its owner alone. */
export function fileLogin(agent: string, file: () => string, because?: () => string | undefined): AgentLoginStore {
  return {
    agent,
    unavailable: () => because?.(),
    read: () => {
      try {
        const path = file();
        const value = readFileSync(path, "utf8");
        return value.trim() === "" ? undefined : { value, at: statSync(path).mtimeMs };
      } catch {
        return undefined;
      }
    },
    write: (value) => {
      const path = file();
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, value, { encoding: "utf8", mode: 0o600 });
      // A file that was there keeps its mode through a write: make it the owner's again.
      try {
        chmodSync(path, 0o600);
      } catch {
        // Windows: modes are not kept anyway.
      }
    },
    remove: () => {
      const path = file();
      if (existsSync(path)) rmSync(path, { force: true });
    },
  };
}

/** Claude Code's sign-in in the macOS keychain, through `security`. */
export function macKeychainLogin(agent: string, service: string, account: string, because?: () => string | undefined, run: typeof execFileSync = execFileSync): AgentLoginStore {
  const opts = { encoding: "utf8" as const, timeout: 10_000, stdio: ["pipe", "pipe", "ignore"] as ["pipe", "pipe", "ignore"] };
  const quoted = (text: string): string => `"${text.replace(/["\\]/g, "\\$&")}"`;
  // The keychain would not hand the item over (locked, refused, or it asked and nobody answered): not
  // asked again until JaiRA restarts, so nobody is asked about it once a minute.
  let refused: string | undefined;
  return {
    agent,
    unavailable: () => because?.() ?? refused,
    read: () => {
      let value: string;
      try {
        value = (run("security", ["find-generic-password", "-s", service, "-a", account, "-w"], opts) as string).replace(/\r?\n$/, "");
      } catch (e) {
        // Not there is exit 44: signed out. Anything else is the keychain saying no.
        if ((e as { status?: number }).status !== 44) refused = "the keychain did not let JaiRA read Claude Code's sign-in";
        return undefined;
      }
      if (value.trim() === "") return undefined;
      let at = 0;
      try {
        const attributes = run("security", ["find-generic-password", "-s", service, "-a", account], opts) as string;
        const stamp = /"mdat"<timedate>=\S+\s+"(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z/.exec(attributes);
        if (stamp !== null) at = Date.UTC(Number(stamp[1]), Number(stamp[2]) - 1, Number(stamp[3]), Number(stamp[4]), Number(stamp[5]), Number(stamp[6]));
      } catch {
        // When it was written is a nicety: unknown is the oldest.
      }
      return { value, at };
    },
    write: (value) => {
      const hex = Buffer.from(value, "utf8").toString("hex");
      run("security", ["-i"], { ...opts, input: `add-generic-password -U -a ${quoted(account)} -s ${quoted(service)} -X ${hex}\n` });
    },
    remove: () => {
      try {
        run("security", ["delete-generic-password", "-s", service, "-a", account], opts);
      } catch {
        // Already gone.
      }
    },
  };
}

/** `wsl.exe`, its output read whichever way it wrote it: its own messages are UTF-16 unless `WSL_UTF8` is heard. */
export const runWslExe: WslRun = (args, input) => {
  const decode = (out: unknown): string => {
    const buf = Buffer.isBuffer(out) ? out : Buffer.from(String(out ?? ""));
    return buf.includes(0) ? buf.toString("utf16le").replace(/\0/g, "") : buf.toString("utf8");
  };
  try {
    const out = execFileSync("wsl.exe", args, {
      ...(input !== undefined ? { input } : {}),
      env: { ...process.env, WSL_UTF8: "1" },
      timeout: 20_000,
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
    });
    return { status: 0, stdout: decode(out) };
  } catch (e) {
    const failed = e as { status?: number | null; stdout?: unknown };
    return { status: typeof failed.status === "number" ? failed.status : -1, stdout: decode(failed.stdout) };
  }
};

/**
 * A sign-in kept as one file in a WSL distro's home. `path` is a shell expression evaluated there, so
 * the distro's own `$HOME` and variables decide it (`${CODEX_HOME:-$HOME/.codex}/auth.json`).
 */
export function wslFileLogin(agent: string, distro: () => string | undefined, path: string, run: WslRun = runWslExe): AgentLoginStore {
  const sh = (d: string, script: string, input?: string): { status: number; stdout: string } => run(["-d", d, "-e", "sh", "-c", `f="${path}"; ${script}`], input);
  const running = (d: string): boolean =>
    run(["--list", "--running", "--quiet"])
      .stdout.split(/\r?\n/)
      .some((line) => line.trim().toLowerCase() === d.toLowerCase());
  return {
    agent,
    unavailable: () => undefined,
    where: () => {
      const d = distro();
      return d !== undefined ? `inside ${d} (WSL)` : undefined;
    },
    read: () => {
      const d = distro();
      // A distro that is not running is not started to look: nothing in it refreshed anything.
      if (d === undefined || !running(d)) return undefined;
      const answer = sh(d, `[ -f "$f" ] || exit 3; stat -c %Y "$f"; cat "$f"`);
      if (answer.status !== 0) return undefined;
      const newline = answer.stdout.indexOf("\n");
      if (newline < 0) return undefined;
      const value = answer.stdout.slice(newline + 1);
      const seconds = Number(answer.stdout.slice(0, newline).trim());
      return value.trim() === "" ? undefined : { value, at: Number.isFinite(seconds) ? seconds * 1000 : 0 };
    },
    write: (value) => {
      const d = distro();
      if (d === undefined) throw new Error("no WSL distro is set");
      const answer = sh(d, `umask 077; mkdir -p "$(dirname "$f")" && cat > "$f.jaira" && mv -f "$f.jaira" "$f" && chmod 600 "$f"`, value);
      if (answer.status !== 0) throw new Error(`could not write ${agent}'s sign-in inside ${d} (wsl.exe exited ${answer.status})`);
    },
    remove: () => {
      const d = distro();
      if (d !== undefined) sh(d, `rm -f "$f"`);
    },
  };
}

/** One agent's sign-in: here, or inside the WSL distro the agents run in while they do. */
function hereOrInWsl(native: AgentLoginStore, inWsl: AgentLoginStore, wsl: () => string | undefined): AgentLoginStore {
  const pick = (): AgentLoginStore => (wsl() !== undefined ? inWsl : native);
  return {
    agent: native.agent,
    unavailable: () => pick().unavailable(),
    where: () => pick().where?.(),
    read: () => pick().read(),
    write: (value) => pick().write(value),
    remove: () => pick().remove(),
  };
}

/** The sign-ins of the agents JaiRA signs in, as this machine keeps them. */
export function nativeAgentLogins(options: AgentLoginOptions = {}): AgentLoginStore[] {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const claudeDir = (): string => env["CLAUDE_CONFIG_DIR"] ?? join(home, ".claude");
  const codexHome = (): string => env["CODEX_HOME"] ?? join(home, ".codex");
  let claude: AgentLoginStore;
  if (platform === "darwin") {
    const own = env["CLAUDE_CONFIG_DIR"] !== undefined ? "Claude Code here has a CLAUDE_CONFIG_DIR of its own, whose keychain item is not followed" : undefined;
    const account = env["USER"] ?? userInfo().username;
    claude = macKeychainLogin("claude-cli", CLAUDE_KEYCHAIN_SERVICE, account, () => own);
  } else {
    claude = fileLogin("claude-cli", () => join(claudeDir(), ".credentials.json"));
  }
  const codex = fileLogin("codex-cli", () => join(codexHome(), "auth.json"));
  // WSL is Windows's: anywhere else an `execEnvironment` naming a distro reaches none.
  const wsl = options.wsl;
  if (platform !== "win32" || wsl === undefined) return [claude, codex];
  const run = options.runWsl ?? runWslExe;
  return [
    hereOrInWsl(claude, wslFileLogin("claude-cli", wsl, "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.credentials.json", run), wsl),
    hereOrInWsl(codex, wslFileLogin("codex-cli", wsl, "${CODEX_HOME:-$HOME/.codex}/auth.json", run), wsl),
  ];
}
