/**
 * JaiRA's own node on the tailnet (decisions 0013 §2 and 0022), for a machine without the Tailscale app:
 * the bundled helper, `jaira-tailnet` (`packages/tailnet`). It runs for as long as this machine is signed
 * in, and is driven over its stdin and stdout, one JSON object per line each way (its `main.go` lists
 * them): sign in, sign out, the devices, publishing the engine, and doors to other devices.
 *
 * Found at `JAIRA_TAILNET_HELPER`, or beside the built-in layer: the installer ships it as
 * `resources/tailnet` next to `resources/builtin` (`packages/app/buildTailnet.mjs`), and a development
 * build puts it in `packages/app/dist/tailnet` next to `dist/builtin` (`npm run tailnet`).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { defaultBuiltInDir } from "@jaira/shared";
import type { TailnetEvent, TailnetPeer, TailnetPort } from "./tailnet";

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

interface HelperLine {
  state?: string;
  url?: string;
  message?: string;
  self?: { id?: string; name?: string; dnsName?: string; ips?: string[] };
  user?: { login?: string; name?: string };
  tailnet?: string;
  devices?: Array<{ id?: string; name?: string; dnsName?: string; os?: string; online?: boolean; lastSeen?: number; ips?: string[] }>;
  door?: string;
  local?: string;
  error?: string;
}

export class HelperTailnet implements TailnetPort {
  readonly via = "helper" as const;
  private child: ChildProcess | undefined;
  private hear: ((event: TailnetEvent) => void) | undefined;
  private readonly doors = new Map<string, Promise<string>>();
  private readonly doorWaits = new Map<string, Array<{ resolve: (local: string) => void; reject: (e: Error) => void }>>();
  private leaving: (() => void) | undefined;

  constructor(
    private readonly baseDir: string,
    readonly nodeName: () => string,
    /** Tests: what runs in place of the binary, and the arguments before the helper's own. */
    private readonly command?: { exe: string; prefix: string[] },
  ) {}

  private dir(): string {
    return join(this.baseDir, "system", "tailnet");
  }

  async unavailable(): Promise<{ reason: string } | undefined> {
    return this.command === undefined && helperBinary() === undefined ? { reason: "this build of JaiRA carries no Tailscale helper, and the Tailscale app is not installed" } : undefined;
  }

  async start(port: number, hear: (event: TailnetEvent) => void): Promise<void> {
    const binary = this.command?.exe ?? helperBinary();
    if (binary === undefined) throw new Error("this build of JaiRA carries no Tailscale helper");
    this.hear = hear;
    if (this.child !== undefined) {
      this.send({ cmd: "serve", target: `127.0.0.1:${port}` });
      return;
    }
    mkdirSync(this.dir(), { recursive: true });
    const child = spawn(binary, [...(this.command?.prefix ?? []), "--dir", this.dir(), "--hostname", this.nodeName(), "--target", `127.0.0.1:${port}`], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    let buffer = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line !== "") this.heard(line);
      }
    });
    child.stdin?.on("error", () => undefined);
    child.on("exit", (code) => {
      if (this.child !== child) return;
      this.child = undefined;
      this.failDoors(new Error("the Tailscale helper stopped"));
      const leaving = this.leaving;
      this.leaving = undefined;
      if (leaving !== undefined) leaving();
      else this.hear?.({ kind: "stopped", reason: `the Tailscale helper stopped (exit ${code ?? "?"})` });
    });
    child.on("error", (e) => {
      if (this.child !== child) return;
      this.child = undefined;
      this.hear?.({ kind: "stopped", reason: e.message });
    });
  }

  private heard(line: string): void {
    let said: HelperLine;
    try {
      said = JSON.parse(line) as HelperLine;
    } catch {
      return;
    }
    if (said.door !== undefined) {
      const waits = this.doorWaits.get(said.door) ?? [];
      this.doorWaits.delete(said.door);
      for (const wait of waits) {
        if (said.local !== undefined) wait.resolve(`http://${said.local}`);
        else wait.reject(new Error(said.error ?? "the Tailscale helper opened no door"));
      }
      return;
    }
    if (said.devices !== undefined) {
      const devices: TailnetPeer[] = said.devices.flatMap((d) =>
        typeof d.id === "string" && typeof d.dnsName === "string"
          ? [{ id: d.id, name: d.name ?? d.dnsName.split(".")[0] ?? d.id, dnsName: d.dnsName, os: d.os ?? "", online: d.online === true, ...(typeof d.lastSeen === "number" ? { lastSeenAt: d.lastSeen } : {}), ips: d.ips ?? [] }]
          : [],
      );
      this.hear?.({ kind: "devices", devices });
      return;
    }
    switch (said.state) {
      case "needs-login":
        if (said.url !== undefined) this.hear?.({ kind: "sign-in", url: said.url });
        return;
      case "running":
        this.hear?.({
          kind: "running",
          self: { ...(said.self?.id !== undefined ? { id: said.self.id } : {}), name: said.self?.name ?? this.nodeName(), dnsName: said.self?.dnsName ?? "", ips: said.self?.ips ?? [] },
          ...(said.user?.login !== undefined ? { user: said.user.login } : {}),
          ...(said.tailnet !== undefined ? { tailnet: said.tailnet } : {}),
          ...(said.url !== undefined ? { url: said.url } : {}),
        });
        return;
      case "dropped":
        this.hear?.({ kind: "dropped" });
        return;
      case "error":
        this.hear?.({ kind: "error", message: said.message ?? "the Tailscale helper failed" });
        return;
    }
  }

  private send(command: Record<string, unknown>): void {
    this.child?.stdin?.write(`${JSON.stringify(command)}\n`);
  }

  login(): void {
    this.send({ cmd: "login" });
  }

  logout(): Promise<void> {
    const child = this.child;
    if (child === undefined) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.leaving = undefined;
        this.kill();
        resolve();
      }, 30_000);
      this.leaving = () => {
        clearTimeout(timer);
        resolve();
      };
      this.send({ cmd: "logout" });
    });
  }

  devices(): void {
    this.send({ cmd: "devices" });
  }

  door(base: string): Promise<string> {
    if (this.child === undefined) return Promise.reject(new Error("this machine is not signed in to Tailscale"));
    const known = this.doors.get(base);
    if (known !== undefined) return known;
    const opening = new Promise<string>((resolve, reject) => {
      this.doorWaits.set(base, [...(this.doorWaits.get(base) ?? []), { resolve, reject }]);
      this.send({ cmd: "door", url: base });
    });
    this.doors.set(base, opening);
    opening.catch(() => this.doors.delete(base));
    return opening;
  }

  private failDoors(error: Error): void {
    for (const waits of this.doorWaits.values()) for (const wait of waits) wait.reject(error);
    this.doorWaits.clear();
    this.doors.clear();
  }

  async stop(): Promise<void> {
    this.kill();
  }

  forget(): void {
    this.kill();
    rmSync(this.dir(), { recursive: true, force: true });
  }

  private kill(): void {
    const child = this.child;
    this.child = undefined;
    this.failDoors(new Error("the Tailscale helper stopped"));
    child?.stdin?.end();
    child?.kill();
  }

  close(): void {
    this.hear = undefined;
    this.kill();
  }
}
