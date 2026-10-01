/**
 * The fleet's plain helpers (decision 0013): one identity for every spelling of a repository's remote,
 * an engine URL from whatever address a person types, pairing codes read however they are typed, and
 * the project key of a workspace on another machine.
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { engineUrlOf, hostOfUrl, normalizePairingCode, parseRemoteProjectKey, projectNameOf, remoteProjectKey, repositoryIdentity } from "../src/machines";
import { ENGINE_CONTRACT, sha256Hex } from "../src/engineFrames";
import { IPC_CHANNELS } from "../src/ipc";

describe("a repository's identity", () => {
  it("is the same for every way its remote is written", () => {
    for (const url of [
      "git@github.com:ofersadgat/JaiRA.git",
      "https://github.com/ofersadgat/JaiRA",
      "https://ofer@GitHub.com/ofersadgat/JaiRA.git/",
      "ssh://git@github.com:22/ofersadgat/JaiRA.git",
      "git://github.com/ofersadgat/JaiRA.git",
    ]) {
      expect(repositoryIdentity(url), url).toBe("github.com/ofersadgat/JaiRA");
    }
    expect(repositoryIdentity("git@gitlab.com:mistlabs/group/jaira.git")).toBe("gitlab.com/mistlabs/group/jaira");
  });

  it("is nothing for what is not a remote", () => {
    expect(repositoryIdentity("")).toBeUndefined();
    expect(repositoryIdentity("file:///c/src/jaira")).toBeUndefined();
    expect(repositoryIdentity("not a url")).toBeUndefined();
  });

  it("names a project by its last part", () => {
    expect(projectNameOf("github.com/ofersadgat/JaiRA")).toBe("JaiRA");
    expect(projectNameOf("C:\\src\\jaira-2")).toBe("jaira-2");
  });
});

describe("addresses and codes", () => {
  it("turns a typed address into the engine's WebSocket URL", () => {
    expect(engineUrlOf("mac-mini.tail4c2e.ts.net")).toBe("wss://mac-mini.tail4c2e.ts.net/engine");
    expect(engineUrlOf("https://mac-mini.tail4c2e.ts.net:8443/")).toBe("wss://mac-mini.tail4c2e.ts.net:8443/engine");
    expect(engineUrlOf("http://127.0.0.1:47318")).toBe("ws://127.0.0.1:47318/engine");
    // A bare IP address or localhost holds no certificate: plain, as an emulator reaches the loopback listener.
    expect(engineUrlOf("127.0.0.1:47318")).toBe("ws://127.0.0.1:47318/engine");
    expect(engineUrlOf("localhost:47318/")).toBe("ws://localhost:47318/engine");
    expect(engineUrlOf("100.64.0.7")).toBe("ws://100.64.0.7/engine");
    expect(engineUrlOf("https://100.64.0.7:8443")).toBe("wss://100.64.0.7:8443/engine");
    expect(engineUrlOf(" Desk.Tail4c2e.ts.net:443/x?y#z ")).toBe("wss://desk.tail4c2e.ts.net/engine");
    expect(engineUrlOf("wss://desk.tail4c2e.ts.net/engine")).toBe("wss://desk.tail4c2e.ts.net/engine");
    expect(engineUrlOf("ws://127.0.0.1:47318/engine")).toBe("ws://127.0.0.1:47318/engine");
    expect(() => engineUrlOf("")).toThrow(/not an address/);
    expect(hostOfUrl("wss://desk.tail4c2e.ts.net:8443/engine")).toBe("desk.tail4c2e.ts.net:8443");
  });

  it("hashes the contract the same with or without node:crypto", () => {
    for (const text of ["", "abc", "x".repeat(55), "x".repeat(56), "x".repeat(64), [...IPC_CHANNELS].sort().join("\n")]) {
      expect(sha256Hex(text)).toBe(createHash("sha256").update(text).digest("hex"));
    }
    expect(ENGINE_CONTRACT).toBe(createHash("sha256").update([...IPC_CHANNELS].sort().join("\n")).digest("hex").slice(0, 12));
  });

  it("reads a pairing code however it is typed", () => {
    expect(normalizePairingCode("river · maple · 7q4k")).toBe(normalizePairingCode("RIVER MAPLE 7Q4K"));
  });

  it("keys a workspace on another machine, and reads the key back", () => {
    const key = remoteProjectKey("m-1", "C:\\src\\jaira");
    expect(parseRemoteProjectKey(key)).toEqual({ machineId: "m-1", dir: "C:\\src\\jaira" });
    expect(parseRemoteProjectKey("C:\\src\\jaira")).toBeUndefined();
  });
});
