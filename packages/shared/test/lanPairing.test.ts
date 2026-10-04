/**
 * The code exchange a phone pairs with over the local network (decision 0013, amended 2026-10-04).
 * What it must hold: the same code, typed however, gives both sides the same keys; another code gives
 * the phone a proof that does not check, so it stops before saying anything; a share that is not a
 * point is refused; and the sealed channel opens only what was sealed for it, in order.
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { LanBox, PakePhone, announcementOf, announcementTxt, fromHex, isTailscaleLogin, lanPairingUrl, pakeMachine, phoneProofHolds, toHex } from "../src/lanPairing";

const machine = { id: "m-desk-1234", label: "desk", os: "windows" };
const rnd = (): Uint8Array => new Uint8Array(randomBytes(64));

function exchange(phoneCode: string, machineCode: string): { phone: () => ReturnType<PakePhone["finish"]>; machineKeys: ReturnType<typeof pakeMachine>["keys"] } {
  const sid = new Uint8Array(randomBytes(16));
  const phone = new PakePhone(phoneCode, { sid: toHex(sid), machine }, rnd());
  const answer = pakeMachine(machineCode, sid, machine.id, phone.share, rnd());
  return { phone: () => phone.finish({ y: answer.share, mac: toHex(answer.keys.machineMac) }), machineKeys: answer.keys };
}

describe("the code exchange", () => {
  it("agrees on one key when both hold the code, however it was typed", () => {
    const { phone, machineKeys } = exchange("amber river 7k2p", "AMBER · RIVER · 7K2P");
    const keys = phone();
    expect(toHex(keys.phone)).toBe(toHex(machineKeys.phone));
    expect(toHex(keys.machine)).toBe(toHex(machineKeys.machine));
    expect(phoneProofHolds(machineKeys, toHex(keys.phoneMac))).toBe(true);
  });

  it("stops the phone on another code: the machine's proof does not check", () => {
    const { phone } = exchange("AMBER · RIVER · 7K2Q", "AMBER · RIVER · 7K2P");
    expect(phone).toThrow("wrong code");
  });

  it("refuses the machine's proof when it is missing or forged", () => {
    const sid = new Uint8Array(randomBytes(16));
    const phone = new PakePhone("AMBER RIVER 7K2P", { sid: toHex(sid), machine }, rnd());
    const answer = pakeMachine("AMBER RIVER 7K2P", sid, machine.id, phone.share, rnd());
    expect(() => phone.finish({ y: answer.share })).toThrow("wrong code");
    expect(() => phone.finish({ y: answer.share, mac: toHex(new Uint8Array(32)) })).toThrow("wrong code");
  });

  it("binds the exchange to the machine it named: the same code for another id does not agree", () => {
    const sid = new Uint8Array(randomBytes(16));
    const phone = new PakePhone("AMBER RIVER 7K2P", { sid: toHex(sid), machine }, rnd());
    const answer = pakeMachine("AMBER RIVER 7K2P", sid, "m-other-9999", phone.share, rnd());
    expect(() => phone.finish({ y: answer.share, mac: toHex(answer.keys.machineMac) })).toThrow("wrong code");
  });

  it("refuses a share that is not a point, or is the identity", () => {
    const sid = new Uint8Array(randomBytes(16));
    expect(() => pakeMachine("A", sid, machine.id, "zz", rnd())).toThrow();
    expect(() => pakeMachine("A", sid, machine.id, toHex(new Uint8Array(32)), rnd())).toThrow();
    expect(() => pakeMachine("A", sid, machine.id, "ff".repeat(32), rnd())).toThrow();
  });

  it("checks the phone's proof without throwing on rubbish", () => {
    const { machineKeys } = exchange("A B C", "A B C");
    expect(phoneProofHolds(machineKeys, "nothex")).toBe(false);
    expect(phoneProofHolds(machineKeys, "00")).toBe(false);
  });
});

describe("the sealed channel", () => {
  it("opens what the other side sealed, in order, and nothing else", () => {
    const { phone, machineKeys } = exchange("A B C", "A B C");
    const p = LanBox.forPhone(phone());
    const m = LanBox.forMachine(machineKeys);
    const first = p.seal({ t: "device", device: { id: "d-123456789", label: "Pixel", kind: "phone" } }) as { t: "box"; n: number; d: string };
    const second = p.seal({ t: "done" }) as { t: "box"; n: number; d: string };
    expect(() => m.open(second)).toThrow("out of order");
    expect(m.open(first)).toEqual({ t: "device", device: { id: "d-123456789", label: "Pixel", kind: "phone" } });
    expect(() => m.open(first)).toThrow("out of order");
    expect(m.open(second)).toEqual({ t: "done" });
    const back = m.seal({ t: "opened" }) as { t: "box"; n: number; d: string };
    expect(p.open(back)).toEqual({ t: "opened" });
  });

  it("refuses an altered frame", () => {
    const { phone, machineKeys } = exchange("A B C", "A B C");
    const p = LanBox.forPhone(phone());
    const m = LanBox.forMachine(machineKeys);
    const frame = p.seal({ t: "done" }) as { t: "box"; n: number; d: string };
    const bytes = fromHex(frame.d);
    bytes[0] = bytes[0]! ^ 1;
    expect(() => m.open({ n: frame.n, d: toHex(bytes) })).toThrow();
  });

  it("does not open with its own direction's key: what the phone sent cannot be played back to it", () => {
    const { phone } = exchange("A B C", "A B C");
    const keys = phone();
    const p = LanBox.forPhone(keys);
    const frame = p.seal({ t: "done" }) as { t: "box"; n: number; d: string };
    expect(() => LanBox.forPhone(keys).open(frame)).toThrow();
  });
});

describe("the announcement", () => {
  it("reads back what it wrote, and the resolved host first", () => {
    const txt = announcementTxt({ id: "m-desk-1234", label: "desk", os: "mac", port: 52000, addresses: ["192.168.1.5", "10.0.0.3"], v: 1 });
    expect(announcementOf(txt)).toEqual({ id: "m-desk-1234", label: "desk", os: "mac", port: 52000, addresses: ["192.168.1.5", "10.0.0.3"], v: 1 });
    expect(announcementOf(txt, { host: "192.168.1.9" })?.addresses).toEqual(["192.168.1.9", "192.168.1.5", "10.0.0.3"]);
  });

  it("reads byte values, as Android's resolver gives them", () => {
    const enc = new TextEncoder();
    expect(announcementOf({ id: enc.encode("m-desk-1234"), port: enc.encode("52000"), addr: enc.encode("192.168.1.5"), v: enc.encode("1") })?.label).toBe("JaiRA");
  });

  it("is not one of ours without an id, a port, an address or this version", () => {
    expect(announcementOf({ port: "1", addr: "192.168.1.5", v: "1" })).toBeUndefined();
    expect(announcementOf({ id: "m-desk-1234", addr: "192.168.1.5", v: "1" })).toBeUndefined();
    expect(announcementOf({ id: "m-desk-1234", port: "1", addr: "nope", v: "1" })).toBeUndefined();
    expect(announcementOf({ id: "m-desk-1234", port: "1", addr: "192.168.1.5", v: "2" })).toBeUndefined();
  });

  it("makes a pairing URL for v4 and v6", () => {
    expect(lanPairingUrl("192.168.1.5", 52000)).toBe("ws://192.168.1.5:52000/pair");
    expect(lanPairingUrl("fe80::1", 52000)).toBe("ws://[fe80::1]:52000/pair");
  });
});

describe("the sign-in page a machine will open", () => {
  it("is Tailscale's and nothing else", () => {
    expect(isTailscaleLogin("https://login.tailscale.com/a/1a2b3c4d5e")).toBe(true);
    expect(isTailscaleLogin("https://login.tailscale.com.evil.example/a/1")).toBe(false);
    expect(isTailscaleLogin("http://login.tailscale.com/a/1")).toBe(false);
    expect(isTailscaleLogin("https://login.tailscale.com/a/1?next=https://evil")).toBe(false);
    expect(isTailscaleLogin("javascript:alert(1)")).toBe(false);
  });
});
