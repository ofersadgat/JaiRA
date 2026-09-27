/**
 * Finding the host, in the person's order (decision 0012 §4, ruled 2026-09-26: "we should look through
 * the process list first, then try ipc to get the info, if that doesnt work, fallback to a specific
 * port, if that doesnt work, fallback to the file solution").
 *
 * 1. **The process list** is STARTED first and awaited only when nothing answers: on Windows it costs a
 *    PowerShell start (~0.5 s; `tasklist` took 2 s and WMI can hang), and a pipe that answers makes it
 *    moot. What it adds is the verdict when nothing answers: a JaiRA process named by `engine.json` that
 *    is alive but silent is STUCK, and no second engine starts beside it.
 * 2. **The pipe**: `who` — the host's info, no token needed.
 * 3. **The loopback port**, where a host that could not create its pipe listens.
 * 4. **The file**, `engine.json`: the pipe or port it names, when they are not the ones already tried
 *    (a host started under another `XDG_RUNTIME_DIR` computes another socket path). A file whose pid is
 *    gone is stale, and removed.
 *
 * A host is only ever FOUND here; connecting to it (with the token) is `connectEngine`.
 */
import { execFile } from "node:child_process";
import { rmSync } from "node:fs";
import { describeAddress, whoAt, type EngineAddress } from "./engineClient";
import { ENGINE_PORT, engineFilePath, enginePipePath, homeHash, readEngineFile, type EngineHostInfo } from "./enginePipe";

export interface EngineProcess {
  pid: number;
  name: string;
}

export type EngineDiscovery =
  /** A host answered. */
  | { kind: "found"; host: EngineHostInfo; address: EngineAddress; via: "pipe" | "port" | "file" }
  /** `engine.json` names a process that is alive, and nothing answers for it. */
  | { kind: "stuck"; pid: number; name?: string; address: string }
  /**
   * Nobody hosts the engine. `others` (only when asked for, with `listOthers`): JaiRA-looking processes
   * that are not a host — older builds, or one still starting.
   */
  | { kind: "none"; others?: EngineProcess[] };

export interface DiscoverOptions {
  baseDir: string;
  /** Tests: a fixed process list, another pipe, another port. */
  processes?: (signal: AbortSignal) => Promise<EngineProcess[]>;
  pipe?: string;
  port?: number;
  /** Per address. */
  timeoutMs?: number;
  /** Wait for the process list to name the other JaiRA processes when nobody hosts (`jaira server status`). */
  listOthers?: boolean;
}

/** Executable names a JaiRA host runs as: the app, the Linux app, a development Electron, or Node (`jaira` from npm). */
export function looksLikeJaira(name: string): boolean {
  return /^(jaira(-app)?|electron|node)(\.exe)?$/i.test(name);
}

const LIST_DEADLINE_MS = 5000;

/**
 * Every process's id and executable name. Windows: `Get-Process`, which reads the kernel's list through
 * .NET, not WMI. Elsewhere: `ps`. A list that cannot be read is empty — it is a hint, never the answer.
 */
export function listProcesses(signal?: AbortSignal): Promise<EngineProcess[]> {
  const [command, args] =
    process.platform === "win32"
      ? ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-Process | ForEach-Object { \"$($_.Id) $($_.ProcessName)\" }"]]
      : ["ps", ["-A", "-o", "pid=,comm="]];
  return new Promise((resolve) => {
    execFile(command, args, { windowsHide: true, timeout: LIST_DEADLINE_MS, maxBuffer: 16 * 1024 * 1024, ...(signal !== undefined ? { signal } : {}) }, (error, stdout) => {
      if (error !== null) {
        resolve([]);
        return;
      }
      const rows: EngineProcess[] = [];
      for (const line of stdout.split(/\r?\n/)) {
        const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
        if (match === null) continue;
        // `ps` prints a path for some; the name is its last part.
        const name = match[2]!.split("/").pop() ?? match[2]!;
        rows.push({ pid: Number(match[1]), name });
      }
      resolve(rows);
    });
  });
}

/** Whether a process id is alive: signal 0 checks without sending anything (EPERM is alive, someone else's). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function discoverEngine(options: DiscoverOptions): Promise<EngineDiscovery> {
  // 1. Started first; awaited only if nothing answers below.
  const stopListing = new AbortController();
  const listing = (options.processes ?? listProcesses)(stopListing.signal).catch(() => [] as EngineProcess[]);
  const found = (discovery: EngineDiscovery & { kind: "found" }): EngineDiscovery => {
    stopListing.abort();
    return discovery;
  };
  const home = homeHash(options.baseDir);
  const timeoutMs = options.timeoutMs ?? 1500;
  const tried = new Set<string>();
  const ask = async (address: EngineAddress): Promise<EngineHostInfo | undefined> => {
    tried.add(describeAddress(address));
    const host = await whoAt(address, timeoutMs).catch(() => undefined);
    return host?.home === home ? host : undefined;
  };

  // 2. The pipe.
  const pipe = { pipe: options.pipe ?? enginePipePath(options.baseDir) };
  const onPipe = await ask(pipe);
  if (onPipe !== undefined) return found({ kind: "found", host: onPipe, address: pipe, via: "pipe" });

  // 3. The port.
  const port = { port: options.port ?? ENGINE_PORT };
  const onPort = await ask(port);
  if (onPort !== undefined) return found({ kind: "found", host: onPort, address: port, via: "port" });

  // 4. The file.
  const file = readEngineFile(options.baseDir);
  if (file !== undefined) {
    const named: EngineAddress[] = [{ pipe: file.pipe }, ...(file.port !== undefined ? [{ port: file.port }] : [])];
    for (const address of named) {
      if (tried.has(describeAddress(address))) continue;
      const host = await ask(address);
      if (host !== undefined) return found({ kind: "found", host, address, via: "file" });
    }
    if (pidAlive(file.pid)) {
      const processes = await listing;
      const name = processes.find((p) => p.pid === file.pid)?.name;
      // A pid reused by something that is not JaiRA is not a stuck engine; the file is stale.
      if (name === undefined || looksLikeJaira(name)) {
        return { kind: "stuck", pid: file.pid, ...(name !== undefined ? { name } : {}), address: file.port !== undefined ? `127.0.0.1:${file.port}` : file.pipe };
      }
    }
    // Stale: its host died without removing it. Only the file this read, never one written since.
    if (readEngineFile(options.baseDir)?.pid === file.pid) rmSync(engineFilePath(options.baseDir), { force: true });
  }
  // The list is a hint, and nobody hosting is the everyday answer for a command: not waited for unless asked.
  if (options.listOthers !== true) {
    stopListing.abort();
    return { kind: "none" };
  }
  const others = (await listing).filter((p) => p.pid !== process.pid && looksLikeJaira(p.name) && /jaira/i.test(p.name));
  return { kind: "none", others };
}
