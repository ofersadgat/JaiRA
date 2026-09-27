/**
 * The second way onto a tailnet (decision 0013 §2, ruled "Both now"): JaiRA's own helper, `jaira-tailnet`
 * (`packages/tailnet`), for a machine without the Tailscale app. It joins the tailnet as its own node and
 * forwards to the engine's loopback listener; this runs it and reads what it says (one JSON object per
 * line: `needs-login`, `running`, `error`).
 *
 * Found at `JAIRA_TAILNET_HELPER`, or beside the built-in layer: the installer ships it as
 * `resources/tailnet` next to `resources/builtin` (`packages/app/buildTailnet.mjs`), and a development
 * build puts it in `packages/app/dist/tailnet` next to `dist/builtin` (`npm run tailnet`).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { defaultBuiltInDir } from "@jaira/shared";
import type { ReachPort } from "./fleet";
import { tailscaleCli, tailscaleServe, tailscaleStatus, tailscaleUnserve } from "./tailscale";

export function helperBinary(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const named = env["JAIRA_TAILNET_HELPER"];
  if (named !== undefined && named !== "" && existsSync(named)) return named;
  const exe = process.platform === "win32" ? "jaira-tailnet.exe" : "jaira-tailnet";
  const resources = (process as { resourcesPath?: unknown }).resourcesPath;
  const candidates = [
    ...(typeof resources === "string" && resources.length > 0 ? [join(resources, "tailnet", exe)] : []),
    join(dirname(defaultBuiltInDir()), "tailnet", exe),
  ];
  return candidates.find((file) => existsSync(file));
}

/** Runs the helper while this machine is published; one process at a time. */
export class HelperReach implements ReachPort {
  private child: ChildProcess | undefined;

  constructor(
    private readonly baseDir: string,
    private readonly hostname: () => string,
    /** Tests: what runs in place of the binary, and the arguments before the helper's own. */
    private readonly command?: { exe: string; prefix: string[] },
  ) {}

  async unavailable(): Promise<string | undefined> {
    return helperBinary() === undefined ? "this build of JaiRA carries no Tailscale helper" : undefined;
  }

  publish(loopbackPort: number, progress?: (update: { signInUrl?: string }) => void): Promise<{ url: string; via: "helper" }> {
    const binary = this.command?.exe ?? helperBinary();
    if (binary === undefined) return Promise.reject(new Error("JaiRA's Tailscale plugin is not installed"));
    this.close();
    const dir = join(this.baseDir, "system", "tailnet");
    mkdirSync(dir, { recursive: true });
    const name = `jaira-${this.hostname().toLowerCase().replace(/[^a-z0-9-]/g, "-")}`;
    return new Promise((resolve, reject) => {
      const child = spawn(binary, [...(this.command?.prefix ?? []), "--dir", dir, "--hostname", name, "--target", `127.0.0.1:${loopbackPort}`], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      this.child = child;
      let settled = false;
      let buffer = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        for (;;) {
          const newline = buffer.indexOf("\n");
          if (newline < 0) break;
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line === "") continue;
          let said: { state?: string; url?: string; message?: string };
          try {
            said = JSON.parse(line) as typeof said;
          } catch {
            continue;
          }
          if (said.state === "needs-login" && said.url !== undefined) progress?.({ signInUrl: said.url });
          if (said.state === "running" && said.url !== undefined && !settled) {
            settled = true;
            resolve({ url: said.url, via: "helper" });
          }
          if (said.state === "error" && !settled) {
            settled = true;
            reject(new Error(said.message ?? "the Tailscale helper failed"));
          }
        }
      });
      child.on("exit", (code) => {
        if (this.child === child) this.child = undefined;
        if (!settled) {
          settled = true;
          reject(new Error(`the Tailscale helper stopped (exit ${code ?? "?"})`));
        }
      });
      child.on("error", (e) => {
        if (!settled) {
          settled = true;
          reject(e);
        }
      });
    });
  }

  async unpublish(): Promise<void> {
    this.close();
  }

  close(): void {
    const child = this.child;
    this.child = undefined;
    child?.kill();
  }
}

/**
 * Tailscale, whichever way this machine has it: the installed app when its CLI is there, else JaiRA's
 * helper when the plugin is, else unavailable with both named.
 */
export function autoReach(baseDir: string, hostname: () => string): ReachPort {
  const helper = new HelperReach(baseDir, hostname);
  return {
    unavailable: async () => {
      if (tailscaleCli() !== undefined) {
        const status = await tailscaleStatus();
        return status.running ? undefined : status.reason;
      }
      if (helperBinary() !== undefined) return undefined;
      // Every installer carries the helper; only a development build without `npm run tailnet` lacks it.
      return "Tailscale is not installed here, and this build of JaiRA carries no Tailscale helper";
    },
    publish: async (port, progress) => {
      if (tailscaleCli() !== undefined) return { ...(await tailscaleServe(port)), via: "tailscale" as const };
      return helper.publish(port, progress);
    },
    unpublish: async (port) => {
      if (tailscaleCli() !== undefined) await tailscaleUnserve(port);
      await helper.unpublish();
    },
    close: () => helper.close(),
  };
}
