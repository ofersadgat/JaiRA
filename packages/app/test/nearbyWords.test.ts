/**
 * What the phone and the desktop say about pairing nearby (decision 0013, amended 2026-10-04): the
 * phone's search — moving while it looks, for how long, what to check after a while, a dropped browse
 * looking again, local-network access refused; the desktop's address to type and what each phone did;
 * which of the machine's addresses a phone tries first; and a local address typed on the phone.
 */
import { describe, expect, it } from "vitest";
import { lanAddresses } from "@jaira/service/lanPairing";
import { LAN_PAIRING_PORT, typedLanMachine } from "@jaira/shared";
import { nearbyLogLines, nearbyWords } from "../src/renderer/machinesModel";
import { elapsedWords, nearbySearchWords, type NearbySearch } from "../../universal/src/screens/connectWords";

const search = (patch: Partial<NearbySearch>): NearbySearch => ({ machines: [], state: "browsing", since: 0, phone: ["192.168.1.23"], ...patch });

describe("the phone's search", () => {
  it("moves while it looks, and says for how long", () => {
    expect(nearbySearchWords(search({}), 42_000)).toMatchObject({ looking: true, headline: "Looking on this Wi-Fi · 0:42", trouble: false });
    expect(elapsedWords(185_000)).toBe("3:05");
  });

  it("says what to do first, and what to check once it has looked a while with nothing found", () => {
    expect(nearbySearchWords(search({}), 5_000).hint).toContain("Show a code");
    expect(nearbySearchWords(search({}), 20_000).hint).toContain("type the local address");
    expect(nearbySearchWords(search({ machines: [{ key: "desk (ab12)", label: "desk", os: "windows" }] }), 20_000).hint).toBeUndefined();
  });

  it("says a dropped browse, which looks again by itself, and refused access", () => {
    expect(nearbySearchWords(search({ state: "retrying", problem: "the phone's Bonjour connection was dropped (-65569) — looking again in 2 s" }), 0)).toMatchObject({
      looking: true,
      trouble: true,
      headline: "The phone's Bonjour connection was dropped (-65569) — looking again in 2 s.",
    });
    expect(nearbySearchWords(search({ state: "denied", problem: "denied" }), 0)).toMatchObject({ looking: false, trouble: true });
  });
});

describe("the desktop's words", () => {
  it("gives the address to type, with the port only when it is not the usual one", () => {
    expect(nearbyWords("desk", { port: LAN_PAIRING_PORT, addresses: ["192.168.1.32", "172.18.160.1"] })).toContainEqual({ code: "192.168.1.32" });
    expect(nearbyWords("desk", { port: 52000, addresses: ["192.168.1.32"] })).toContainEqual({ code: "192.168.1.32:52000" });
    expect(nearbyWords("desk", { port: LAN_PAIRING_PORT, addresses: [] }).join("")).toContain("no address on a local network");
  });

  it("says what each phone did", () => {
    const lines = nearbyLogLines([
      { from: "192.168.1.23", what: "connected", at: 0 },
      { from: "192.168.1.23", what: "wrong-code", at: 0 },
      { from: "192.168.1.23", what: "paired", detail: "Ofer's iPhone", at: 0 },
    ]);
    expect(lines.map((l) => l.slice(l.indexOf("  ") + 2))).toEqual(["192.168.1.23  connected", "192.168.1.23  typed a code that is not this one", "192.168.1.23  paired as Ofer's iPhone"]);
  });
});

describe("the machine's addresses", () => {
  it("puts a real network before a virtual machine's switch, and leaves out loopback, link-local and the tailnet", () => {
    const iface = (address: string, internal = false) => [{ address, internal, family: "IPv4" as const, netmask: "", mac: "", cidr: null }];
    expect(
      lanAddresses({
        "vEthernet (WSL (Hyper-V firewall))": iface("172.30.32.1"),
        "vEthernet (Default Switch)": iface("172.18.160.1"),
        "Ethernet 2": iface("192.168.1.32"),
        Loopback: iface("127.0.0.1", true),
        Tailscale: iface("100.101.1.2"),
        "Wi-Fi": iface("169.254.3.4"),
        docker0: iface("10.0.0.1"),
      } as never),
    ).toEqual(["192.168.1.32", "10.0.0.1", "172.30.32.1", "172.18.160.1"]);
  });
});

describe("a local address typed on the phone", () => {
  it("is a machine to pair with nearby, at the usual port unless one is given", () => {
    expect(typedLanMachine("192.168.1.32")).toMatchObject({ id: "", addresses: ["192.168.1.32"], port: LAN_PAIRING_PORT });
    expect(typedLanMachine(" 10.0.0.5:52000 ")).toMatchObject({ port: 52000 });
    expect(typedLanMachine("172.20.1.1")).toBeDefined();
  });

  it("is not a tailnet address, loopback, a public address or a name", () => {
    for (const address of ["100.101.1.2", "127.0.0.1:47318", "8.8.8.8", "desk.tail4c2e.ts.net", "192.168.1.300", "172.32.0.1"]) expect(typedLanMachine(address)).toBeUndefined();
  });
});
