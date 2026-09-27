/**
 * JaiRA's own way onto a tailnet (decision 0013 §2): the helper is run with the engine's loopback port,
 * its sign-in link reaches whoever asked, its address is the machine's once it runs, and it stops with
 * the engine. A script stands in for the Go binary, speaking its lines.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HelperReach } from "@jaira/service/tailnetHelper";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function standIn(lines: string[], stayUp = true): { exe: string; prefix: string[]; base: string } {
  const base = mkdtempSync(join(tmpdir(), "jaira-tailnet-"));
  dirs.push(base);
  const script = join(base, "helper.cjs");
  writeFileSync(
    script,
    `const args = process.argv.slice(2);
const target = args[args.indexOf("--target") + 1];
const host = args[args.indexOf("--hostname") + 1];
const lines = ${JSON.stringify(lines)}.map((l) => l.replace("TARGET", target).replace("HOST", host));
let i = 0;
const next = () => { if (i < lines.length) { console.log(lines[i++]); setTimeout(next, 20); } else if (!${stayUp}) process.exit(0); };
next();
setInterval(() => {}, 1000);`,
  );
  return { exe: process.execPath, prefix: [script], base };
}

describe("the Tailscale helper", () => {
  it("passes its sign-in on, and publishes its tailnet address once it runs", async () => {
    const helper = standIn([
      JSON.stringify({ state: "needs-login", url: "https://login.tailscale.com/a/abc123" }),
      JSON.stringify({ state: "running", url: "https://HOST.tail4c2e.ts.net", dnsName: "HOST.tail4c2e.ts.net" }),
    ]);
    const reach = new HelperReach(helper.base, () => "Desk", { exe: helper.exe, prefix: helper.prefix });
    const signIns: string[] = [];
    const published = await reach.publish(47318, (update) => update.signInUrl !== undefined && signIns.push(update.signInUrl));
    expect(signIns).toEqual(["https://login.tailscale.com/a/abc123"]);
    expect(published).toEqual({ url: "https://jaira-desk.tail4c2e.ts.net", via: "helper" });
    reach.close();
  });

  it("says why it could not start", async () => {
    const helper = standIn([JSON.stringify({ state: "error", message: "tailnet key expired" })], false);
    const reach = new HelperReach(helper.base, () => "desk", { exe: helper.exe, prefix: helper.prefix });
    await expect(reach.publish(47318)).rejects.toThrow("tailnet key expired");
  });
});
