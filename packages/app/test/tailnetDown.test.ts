/**
 * Tailscale going down, as the whole engine says it (decision 0022, the person, 2026-10-26: "if
 * tailscale goes down, then that should be an error that surfaces both through the logs and the error
 * badge system"): an `AppService` hosted by `hostEngine` on a Tailscale port the test drives. Stopped
 * unasked, the log has an error that names the Settings item it is also shown as — so the log's own
 * count does not count it twice — and Settings → Machines has a Tailscale error with Reconnect; back on
 * the tailnet, the item is gone.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppService, hostEngine, type HostedEngine } from "@jaira/service";
import type { TailnetEvent, TailnetPort } from "@jaira/service/tailnet";

let base: string;
let service: AppService;
let hosted: HostedEngine;
let hear: ((event: TailnetEvent) => void) | undefined;

const port: TailnetPort = {
  via: "helper",
  unavailable: async () => undefined,
  nodeName: () => "jaira-desk",
  start: async (_port, listener) => {
    hear = listener;
  },
  login: () => undefined,
  logout: async () => undefined,
  devices: () => undefined,
  door: async (b) => b,
  stop: async () => undefined,
  forget: () => undefined,
  close: () => {
    hear = undefined;
  },
};

const running = (): void => hear?.({ kind: "running", self: { name: "jaira-desk", dnsName: "jaira-desk.tail1.ts.net", ips: ["100.64.0.2"] }, user: "me@example.com", url: "http://jaira-desk.tail1.ts.net" });

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), "jaira-tailnet-down-"));
  let host: HostedEngine | undefined;
  service = new AppService({ baseDir: base, version: "0.2.0", tailnet: port, announce: false, watchWorkflows: false, publish: (m) => host?.host.broadcast(m) });
  host = (await hostEngine({ baseDir: base, kind: "desktop", version: "0.2.0", service, network: { port: 0 } }))!;
  hosted = host;
});

afterEach(async () => {
  await hosted.close();
  rmSync(base, { recursive: true, force: true });
});

describe("Tailscale going down", () => {
  it("is an error in the log and on Settings → Machines, counted once, and gone once it is back", async () => {
    await service.fleet.signIn();
    running();
    expect(service.health.list().map((i) => i.id)).not.toContain("tailnet");
    hear?.({ kind: "stopped", reason: "the Tailscale helper stopped (exit 0)" });
    expect(service.health.list()).toEqual([
      expect.objectContaining({ id: "tailnet", level: "error", page: "machines", title: "Tailscale", action: "reconnect", detail: "jaira-desk is off your tailnet: the Tailscale helper stopped (exit 0)" }),
    ]);
    await expect
      .poll(() => service.readLogs({ level: "error" }).entries.filter((e) => e.source === "machines"))
      .toEqual([expect.objectContaining({ level: "error", raised: "tailnet", message: expect.stringMatching(/^Tailscale went down: jaira-desk is off your tailnet/) })]);
    // Reconnect is a sign-in that tries now; back on the tailnet, nothing needs attention.
    await service.fleet.signIn();
    running();
    expect(service.health.list().map((i) => i.id)).not.toContain("tailnet");
  });
});
