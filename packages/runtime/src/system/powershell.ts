/**
 * Running a script in Windows PowerShell for a System tool, and reading back what it answers.
 *
 * Windows PowerShell 5.1 because every Windows has it, and `-EncodedCommand` because base64 is the one
 * spelling of a script no layer of Windows argument quoting can reinterpret (`killTree.ts` learnt
 * that first). The script is OURS and never holds a value a call supplied: the call's arguments travel
 * on stdin as JSON, read into `$A`, so nothing the model wrote is ever parsed as PowerShell.
 *
 * The answer is one JSON value on stdout, written by `Out-Result`. A script that throws answers
 * `{ "$error": "<message>" }` instead, which {@link runPowerShell} raises as an `Error` with that
 * message — the tool layer hands it to the model.
 *
 * Both streams are UTF-8 by construction rather than by the console's code page: the reader and the
 * writer are made over the raw standard handles, so a process name or a window title in any script
 * comes back as it is.
 */
import { spawn } from "node:child_process";

/** What every script starts with: `$A`, the call's arguments, and `Out-Result`. */
const PRELUDE = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$JairaIn = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), (New-Object System.Text.UTF8Encoding($false)))
$JairaRaw = $JairaIn.ReadToEnd()
$A = if ($JairaRaw.Length -gt 0) { $JairaRaw | ConvertFrom-Json } else { $null }
$JairaOut = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), (New-Object System.Text.UTF8Encoding($false)))
function Out-Result($value) { $JairaOut.Write((ConvertTo-Json -InputObject $value -Depth 8 -Compress)); $JairaOut.Flush() }
function Out-Refusal([string]$message) { Out-Result @{ '$refusal' = $message } }
`;

export interface PowerShellOptions {
  timeoutMs?: number;
  /** Run in a single-threaded apartment — what the clipboard and the window calls need. Windows PowerShell's default, said out loud. */
  sta?: boolean;
  /** The program; a test points it elsewhere. Default `powershell.exe`. */
  program?: string;
  /** Ends the script early — killed, and answered as stopped. */
  signal?: AbortSignal;
}

/** A script's answer that is a refusal of its own (`Out-Refusal`): said to the model as it is. */
export class PowerShellRefusal extends Error {}

export const DEFAULT_POWERSHELL_TIMEOUT_MS = 30_000;

/** The arguments `powershell.exe` is started with for `script`. */
export function powershellArgs(script: string, sta = true): string[] {
  return ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", ...(sta ? ["-STA"] : ["-MTA"]), "-EncodedCommand", Buffer.from(`${PRELUDE}\ntry {\n${script}\n} catch {\n  Out-Result @{ '$error' = $_.Exception.Message }\n}\n`, "utf16le").toString("base64")];
}

/**
 * Run `script` with `args` as `$A`, and return what it wrote with `Out-Result`.
 *
 * Raises {@link PowerShellRefusal} for an `Out-Refusal`, an `Error` for a script that threw (its
 * message), wrote nothing, or ran past its deadline — in which case it is killed.
 */
export function runPowerShell<T = unknown>(script: string, args: unknown, options: PowerShellOptions = {}): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_POWERSHELL_TIMEOUT_MS;
  return new Promise<T>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(options.program ?? "powershell.exe", powershellArgs(script, options.sta ?? true), { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const kill = (): void => {
      try {
        child.kill();
      } catch {
        // Already gone.
      }
    };
    const timer = setTimeout(() => {
      kill();
      settle(() => reject(new Error(`it did not finish within ${Math.round(timeoutMs / 1000)} s`)));
    }, timeoutMs);
    const onAbort = (): void => {
      kill();
      settle(() => reject(new PowerShellRefusal("stopped by the person")));
    };
    if (options.signal?.aborted === true) onAbort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout!.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr!.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", (e) => settle(() => reject(e)));
    child.on("close", (code) => {
      const text = Buffer.concat(out).toString("utf8").trim();
      if (text.length === 0) {
        const why = Buffer.concat(err).toString("utf8").trim().split(/\r?\n/).filter((line) => line.trim().length > 0).slice(0, 3).join(" ");
        settle(() => reject(new Error(why.length > 0 ? why : `PowerShell exited with ${code ?? "no code"} and wrote nothing`)));
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        settle(() => reject(new Error(`PowerShell answered something that is not JSON: ${text.slice(0, 200)}`)));
        return;
      }
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        const record = value as Record<string, unknown>;
        if (typeof record["$refusal"] === "string") return settle(() => reject(new PowerShellRefusal(record["$refusal"] as string)));
        if (typeof record["$error"] === "string") return settle(() => reject(new Error(record["$error"] as string)));
      }
      settle(() => resolve(value as T));
    });
    child.stdin!.on("error", () => {
      // A script that exits before reading its input closes the pipe; what it answered still counts.
    });
    child.stdin!.end(JSON.stringify(args ?? null), "utf8");
  });
}

/** PowerShell's `ConvertTo-Json` writes a one-element array as the element: read either as a list. */
export function listOf<T>(value: unknown): T[] {
  if (value === null || value === undefined) return [];
  return (Array.isArray(value) ? value : [value]) as T[];
}
