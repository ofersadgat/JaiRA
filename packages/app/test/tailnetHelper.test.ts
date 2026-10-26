/**
 * JaiRA's own node on a tailnet (decisions 0013 §2 and 0022): the helper is run with the engine's
 * loopback port and this machine's tailnet name; its sign-in page, its running, the tailnet's devices and
 * a drop all reach the fleet as events; a door is asked for and answered; signing out waits for it to
 * leave; and it stops with the engine. A script stands in for the Go binary, speaking its lines.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TailnetEvent } from "@jaira/service/tailnet";
import { HelperTailnet } from "@jaira/service/tailnetHelper";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A stand-in that says `lines` in turn, answers a door, and exits on logout as the helper does. */
function standIn(lines: string[]): { exe: string; prefix: string[]; base: string } {
  const base = mkdtempSync(join(tmpdir(), "jaira-tailnet-"));
  dirs.push(base);
  const script = join(base, "helper.cjs");
  writeFileSync(
    script,
    `const args = process.argv.slice(2);
const target = args[args.indexOf("--target") + 1];
const host = args[args.indexOf("--hostname") + 1];
const lines = ${JSON.stringify(lines)}.map((l) => l.split("TARGET").join(target).split("HOST").join(host));
let i = 0;
const next = () => { if (i < lines.length) { console.log(lines[i++]); setTimeout(next, 20); } };
next();
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let at = buffer.indexOf("\\n"); at >= 0; at = buffer.indexOf("\\n")) {
    const command = JSON.parse(buffer.slice(0, at));
    buffer = buffer.slice(at + 1);
    if (command.cmd === "door") console.log(JSON.stringify({ door: command.url, local: "127.0.0.1:5" + command.url.length }));
    if (command.cmd === "logout") { console.log(JSON.stringify({ state: "signed-out" })); process.exit(0); }
  }
});
process.stdin.on("end", () => process.exit(0));`,
  );
  return { exe: process.execPath, prefix: [script], base };
}

describe("the Tailscale helper", () => {
  it("passes its sign-in on, then says who it is and which devices share the tailnet", async () => {
    const helper = standIn([
      JSON.stringify({ state: "needs-login", url: "https://login.tailscale.com/a/abc123" }),
      JSON.stringify({ state: "running", self: { id: "nX", name: "HOST", dnsName: "HOST.tail4c2e.ts.net", ips: ["100.64.0.2"] }, user: { login: "me@example.com" }, tailnet: "tail4c2e.ts.net", url: "http://HOST.tail4c2e.ts.net" }),
      JSON.stringify({ devices: [{ id: "n1", name: "mac-mini", dnsName: "mac-mini.tail4c2e.ts.net", os: "macOS", online: true, ips: ["100.64.0.3"] }, { id: "n2", name: "nas", dnsName: "nas.tail4c2e.ts.net", os: "linux", online: false, lastSeen: 1700000000000, ips: [] }] }),
      JSON.stringify({ state: "dropped" }),
    ]);
    const tailnet = new HelperTailnet(helper.base, () => "jaira-desk", { exe: helper.exe, prefix: helper.prefix });
    const heard: TailnetEvent[] = [];
    await tailnet.start(47318, (event) => heard.push(event));
    await expect.poll(() => heard.length, { timeout: 5000 }).toBe(4);
    expect(heard).toEqual([
      { kind: "sign-in", url: "https://login.tailscale.com/a/abc123" },
      { kind: "running", self: { id: "nX", name: "jaira-desk", dnsName: "jaira-desk.tail4c2e.ts.net", ips: ["100.64.0.2"] }, user: "me@example.com", tailnet: "tail4c2e.ts.net", url: "http://jaira-desk.tail4c2e.ts.net" },
      {
        kind: "devices",
        devices: [
          { id: "n1", name: "mac-mini", dnsName: "mac-mini.tail4c2e.ts.net", os: "macOS", online: true, ips: ["100.64.0.3"] },
          { id: "n2", name: "nas", dnsName: "nas.tail4c2e.ts.net", os: "linux", online: false, lastSeenAt: 1700000000000, ips: [] },
        ],
      },
      { kind: "dropped" },
    ]);
    tailnet.close();
  });

  it("opens a door to a device, once per address", async () => {
    const helper = standIn([]);
    const tailnet = new HelperTailnet(helper.base, () => "jaira-desk", { exe: helper.exe, prefix: helper.prefix });
    await tailnet.start(47318, () => undefined);
    const door = await tailnet.door("https://mac-mini.tail4c2e.ts.net");
    expect(door).toBe(`http://127.0.0.1:5${"https://mac-mini.tail4c2e.ts.net".length}`);
    expect(await tailnet.door("https://mac-mini.tail4c2e.ts.net")).toBe(door);
    tailnet.close();
    await expect(tailnet.door("https://mac-mini.tail4c2e.ts.net")).rejects.toThrow(/not signed in/);
  });

  it("signs out and waits for it to leave, and forgets its identity on Remove", async () => {
    const helper = standIn([]);
    const tailnet = new HelperTailnet(helper.base, () => "jaira-desk", { exe: helper.exe, prefix: helper.prefix });
    const heard: TailnetEvent[] = [];
    await tailnet.start(47318, (event) => heard.push(event));
    await tailnet.logout();
    expect(heard).toEqual([]);
    mkdirSync(join(helper.base, "system", "tailnet"), { recursive: true });
    tailnet.forget();
    expect(existsSync(join(helper.base, "system", "tailnet"))).toBe(false);
  });

  it("says why it stopped when it stops unasked", async () => {
    const helper = standIn([JSON.stringify({ state: "error", message: "tailnet key expired" })]);
    const tailnet = new HelperTailnet(helper.base, () => "jaira-desk", { exe: helper.exe, prefix: helper.prefix });
    const heard: TailnetEvent[] = [];
    await tailnet.start(47318, (event) => heard.push(event));
    await expect.poll(() => heard, { timeout: 5000 }).toContainEqual({ kind: "error", message: "tailnet key expired" });
    tailnet.close();
  });
});
