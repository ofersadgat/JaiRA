/**
 * Settings → Machines' words (decision 0022): the Tailscale row in each of its states, with its buttons,
 * and the machine list built from the tailnet's devices and the paired machines and phones — what each
 * row is called, its icon, its state, and its button.
 */
import { describe, expect, it } from "vitest";
import type { MachinesView, TailnetView } from "@jaira/shared";
import { autoPairWords, checkedWords, machineRowsOf, settingsSyncWords, tailnetWords } from "../src/renderer/machinesModel";

function view(tailnet: TailnetView, more: Partial<MachinesView> = {}): MachinesView {
  return {
    self: { id: "me", label: "desk", os: "windows", form: "desktop", tags: [], tailnet, version: "0.1.0", copy: { mode: "nothing" }, autoPair: false },
    machines: [],
    devices: [],
    tailnetDevices: [],
    ...more,
  };
}

const ON: TailnetView = { state: "on", via: "helper", node: "jaira-desk", user: "me@example.com", tailnet: "tail1.ts.net", url: "http://jaira-desk.tail1.ts.net" };

describe("the Tailscale row", () => {
  it("offers a sign-in, then Sign out and Remove, and says who and what", () => {
    expect(tailnetWords(view({ state: "off", via: "helper", node: "jaira-desk" }))).toEqual({
      description: ["Sign in to reach your other machines and phones and pair with them.", " JaiRA joins your tailnet as ", { code: "jaira-desk" }, ".", " Nothing is opened to the internet."],
      actions: ["signIn"],
    });
    expect(tailnetWords(view({ state: "signing-in", via: "helper", signInUrl: "https://login.tailscale.com/a/x" })).actions).toEqual(["cancel"]);
    expect(tailnetWords(view(ON))).toEqual({ description: ["Signed in as me@example.com.", " This machine is ", { code: "jaira-desk" }, " on ", { code: "tail1.ts.net" }, "."], actions: ["signOut", "remove"] });
  });

  it("keeps the registration while signed out, and waits while being removed", () => {
    expect(tailnetWords(view({ state: "off", via: "helper", node: "jaira-desk", user: "me@example.com", tailnet: "tail1.ts.net" }))).toEqual({
      description: ["Signed out.", " This machine is still ", { code: "jaira-desk" }, " on ", { code: "tail1.ts.net" }, "; me@example.com signed in last."],
      actions: ["signIn", "remove"],
    });
    expect(tailnetWords(view({ ...ON, state: "removing", consoleUrl: "https://login.tailscale.com/admin/machines/100.64.0.2" }))).toEqual({
      description: ["Waiting for Tailscale to remove ", { code: "jaira-desk" }, ". ", { link: "Open it in the admin console", href: "https://login.tailscale.com/admin/machines/100.64.0.2" }],
      actions: ["removeCancel"],
    });
  });

  it("says Tailscale went down, as an error, with Reconnect — and Sign out where JaiRA signed in", () => {
    const down: TailnetView = { state: "down", via: "helper", node: "jaira-desk", reason: "the Tailscale helper stopped (exit 0)" };
    expect(tailnetWords(view(down))).toEqual({
      description: [{ error: "Tailscale went down: the Tailscale helper stopped (exit 0)." }, " ", { code: "jaira-desk" }, " is off your tailnet, so your other machines and phones cannot reach it.", " JaiRA tries again by itself."],
      actions: ["reconnect", "signOut"],
    });
    expect(tailnetWords(view({ ...down, via: "tailscale", reason: "the Tailscale app is not connected" })).actions).toEqual(["reconnect"]);
  });

  it("leaves signing in and out to the Tailscale app, and says which home cannot connect", () => {
    expect(tailnetWords(view({ ...ON, via: "tailscale" })).actions).toEqual([]);
    expect(tailnetWords(view({ state: "unavailable", via: "helper", reason: "only JaiRA's default home, ~/.jaira, connects to Tailscale", home: "C:\\rig\\home" }))).toEqual({
      description: ["Only JaiRA's default home, ", { code: "~/.jaira" }, ", connects to Tailscale. This window runs from ", { code: "C:\\rig\\home" }, "."],
      actions: [],
    });
  });
});

describe("the machine list", () => {
  const devices: MachinesView["tailnetDevices"] = [
    { id: "n1", name: "mac-mini", dnsName: "mac-mini.tail1.ts.net", os: "macOS", online: true, jaira: { kind: "machine", id: "m-mini", label: "mac-mini", version: "0.1.0", os: "mac", form: "mini", url: "https://mac-mini.tail1.ts.net" } },
    { id: "n2", name: "studio", dnsName: "studio.tail1.ts.net", os: "linux", online: true, jaira: { kind: "machine", id: "m-studio", label: "studio", version: "0.1.0", os: "linux", form: "server", url: "http://studio.tail1.ts.net" } },
    { id: "n3", name: "build-box", dnsName: "build-box.tail1.ts.net", os: "linux", online: true, noJaira: true },
    { id: "n4", name: "pixel", dnsName: "pixel.tail1.ts.net", os: "android", online: true, noJaira: true },
    { id: "n5", name: "nas", dnsName: "nas.tail1.ts.net", os: "linux", online: false, lastSeenAt: Date.UTC(2026, 8, 29) },
    { id: "n6", name: "jaira-desk", dnsName: "jaira-desk-1.tail1.ts.net", os: "windows", online: false, olderSelf: true, consoleUrl: "https://login.tailscale.com/admin/machines/100.64.0.6" },
    { id: "n7", name: "laptop", dnsName: "laptop.tail1.ts.net", os: "linux", online: true },
  ];
  const paired: MachinesView["machines"] = [
    { id: "m-mini", label: "mac-mini", os: "mac", form: "mini", tags: [], state: "online", version: "0.1.0", canReachHere: true, url: "wss://mac-mini.tail1.ts.net/engine" },
    { id: "m-gone", label: "old-box", os: "linux", form: "desktop", tags: [], state: "offline", canReachHere: true, url: "wss://old-box.elsewhere.ts.net/engine" },
  ];

  it("lists this machine first, then paired ones, then JaiRA to pair, then the rest", () => {
    const rows = machineRowsOf(view(ON, { tailnetDevices: devices, machines: paired, asking: { device: "n2", expiresAt: 1 } }));
    expect(rows.map((r) => [r.name, r.kind, r.state?.text, r.action?.kind ?? null])).toEqual([
      ["this machine", "Windows desktop", undefined, null],
      ["mac-mini", "Mac mini", "paired · connected", "unpair"],
      ["old-box", "Linux desktop", "paired · offline", "unpair"],
      ["studio", "Linux server", "JaiRA 0.1.0", "pair"],
      ["laptop", "Linux", "checking…", null],
      ["build-box", "Linux", "JaiRA isn't running", null],
      ["pixel", "Android", "JaiRA isn't open", null],
      ["jaira-desk-1", "Windows", "offline", "console"],
      ["nas", "Linux", "offline", null],
    ]);
    expect(rows.find((r) => r.name === "studio")).toMatchObject({ face: { shape: "server", mark: "linux", dot: "on" }, asking: 1 });
    expect(rows.find((r) => r.name === "build-box")).toMatchObject({ grey: true, face: { shape: "auto", mark: "linux", dot: "on" }, sub: "Start JaiRA there: it is listed within a minute." });
    expect(rows.find((r) => r.name === "pixel")).toMatchObject({ face: { shape: "phone", mark: "android" }, sub: "Open JaiRA there and sign in to Tailscale: it is listed within a minute." });
    expect(rows.find((r) => r.name === "jaira-desk-1")).toMatchObject({ sub: "An older registration of this machine.", action: { kind: "console", href: "https://login.tailscale.com/admin/machines/100.64.0.6" } });
    expect(rows.find((r) => r.name === "old-box")?.sub).toMatch(/Not on your tailnet now\.$/);
  });

  it("finds a paired machine that is offline among the devices by its address", () => {
    const rows = machineRowsOf(view(ON, { tailnetDevices: [{ id: "n1", name: "mac-mini", dnsName: "mac-mini.tail1.ts.net", os: "macOS", online: false }], machines: [{ ...paired[0]!, state: "offline" }] }));
    expect(rows.map((r) => [r.name, r.state?.text])).toEqual([
      ["this machine", undefined],
      ["mac-mini", "paired · offline"],
    ]);
  });

  it("says what Pair does with a machine that allows auto pair, and why auto pair did not pair", () => {
    const studio = (more: Partial<MachinesView["tailnetDevices"][number]>, autoPair = true): MachinesView["tailnetDevices"][number] => ({
      ...devices[1]!,
      jaira: { ...devices[1]!.jaira!, ...(autoPair ? { autoPair: true } : {}) },
      ...more,
    });
    const subOf = (d: MachinesView["tailnetDevices"][number], selfAuto = false): string | undefined => {
      const v = view(ON, { tailnetDevices: [d] });
      return machineRowsOf({ ...v, self: { ...v.self, autoPair: selfAuto } }).find((r) => r.name === "studio")?.sub;
    };
    expect(subOf(studio({ user: "me@example.com" }, false))).toBeUndefined();
    expect(subOf(studio({ user: "ME@example.com" }))).toBe("Allows auto pair: Pair pairs it with no code.");
    expect(subOf(studio({ user: "me@example.com" }), true)).toBe("Allows auto pair: pairing with this machine by itself.");
    expect(subOf(studio({ user: "them@example.com" }))).toBe("Allows auto pair, but is signed in to Tailscale as them@example.com: Pair asks for a code.");
    expect(subOf(studio({ user: "me@example.com", autoPairFailed: "studio is signed in to Tailscale as another account" }))).toBe("Auto pair did not pair: studio is signed in to Tailscale as another account.");
  });

  it("says what Allow auto pair does, on and off", () => {
    const v = view(ON);
    expect(autoPairWords(v)).toBe("Pairing takes a code shown on the other machine. On, your machines signed in to Tailscale as me@example.com pair with this one with no code.");
    expect(autoPairWords({ ...v, self: { ...v.self, autoPair: true } })).toMatch(/^Your machines signed in to Tailscale as me@example\.com pair with this one with no code, .* A machine you unpair is not paired again by itself\.$/);
  });

  it("lists a paired phone with Unpair", () => {
    const rows = machineRowsOf(
      view(ON, {
        tailnetDevices: [{ id: "n9", name: "jaira-pixel", dnsName: "jaira-pixel.tail1.ts.net", os: "android", online: true, jaira: { kind: "phone", id: "d-pixel", label: "Pixel 8", version: "0.1.0", os: "android", url: "http://jaira-pixel.tail1.ts.net" } }],
        devices: [{ id: "d-pixel", label: "Pixel 8", kind: "phone", pairedAt: 1, connected: true }],
      }),
    );
    expect(rows[1]).toMatchObject({ name: "Pixel 8", kind: "Android phone", face: { shape: "phone", mark: "android", dot: "on" }, state: { text: "paired · connected" }, action: { kind: "unpair", id: "d-pixel" } });
  });

  it("says when the list was last asked", () => {
    expect(checkedWords(undefined)).toBe("Checking…");
    expect(checkedWords(1000, 1000 + 20_000)).toBe("Checked just now");
    expect(checkedWords(0, 60_000)).toBe("Checked a minute ago");
    expect(checkedWords(0, 5 * 60_000)).toBe("Checked 5 minutes ago");
  });
});

describe("Settings on every machine (decision 0026)", () => {
  const now = Date.UTC(2026, 10, 16, 12, 0, 0);
  const counts = { settings: 3, secrets: 1, signIns: 0, logins: 1 };

  it("says what follows, when it was last in step, and how the agents' sign-ins fare here", () => {
    const words = settingsSyncWords(
      { on: true, at: now - 5 * 60_000, counts, logins: [{ agent: "claude-cli", synced: true }, { agent: "codex-cli", synced: false, why: "the keychain did not let JaiRA read it" }] },
      now,
    );
    expect(words.keep).toMatch(/^Your Shared and Just you settings with their permission sets and workflows, the keys in JaiRA's keychain, your forge sign-ins and your agents' sign-ins follow you/);
    expect(words.keep).toMatch(/Last in step 5 minutes ago\.$/);
    expect(words.logins).toBe("Claude Code follows: signed in or out on one machine, signed in or out on all. Codex does not here: the keychain did not let JaiRA read it.");
    // Kept inside a WSL distro: said where.
    expect(settingsSyncWords({ on: true, counts, logins: [{ agent: "claude-cli", synced: true, where: "inside Ubuntu (WSL)" }, { agent: "codex-cli", synced: true, where: "inside Ubuntu (WSL)" }] }, now).logins).toBe(
      "Claude Code and Codex follow, kept inside Ubuntu (WSL): signed in or out on one machine, signed in or out on all.",
    );
    expect(words.stays).toMatch(/^Where commands and agents run \(WSL\), .*; MCP servers started as a command, or reached at a loopback address; .*\.$/);
    // A machine's own layers keep their files; functions, skills and anything over the cap stay too.
    expect(words.stays).toContain("this machine's own settings, and a project's on this machine, with their permission sets and workflows");
    expect(words.stays).toContain("functions and skills, and a permission set, workflow or prompt file over 1 MB");
  });

  it("says a machine that is off keeps its own, and lists what was not taken", () => {
    expect(settingsSyncWords({ on: false, counts, logins: [] }, now).keep).toBe("This machine keeps its own settings: it neither sends its changes nor takes the other machines'.");
    expect(settingsSyncWords({ on: true, counts, logins: [], refused: [{ what: "Shared appearance.mode", why: "must be light, dark or system", at: now }] }, now).refused).toEqual([
      "Shared appearance.mode: must be light, dark or system",
    ]);
    expect(settingsSyncWords({ on: true, counts, logins: [] }, now).keep).toMatch(/Not in step with another machine yet\.$/);
  });
});
