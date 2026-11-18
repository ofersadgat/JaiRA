/**
 * `execEnvironment` as settings read it: natively, a WSL distro, or a workspace's container (decision
 * 0027) — which only a workspace's own layer names, and so is the one meant when layers merged it
 * beside a machine's distro.
 */
import { describe, expect, it } from "vitest";
import { mergeConfigLayers, parseConfig } from "../src/index";

const envOf = (doc: unknown): unknown => parseConfig(doc ?? {}).execEnvironment;

describe("where commands run", () => {
  it("reads natively, a distro, and a workspace's container with who its commands run as and what made it", () => {
    expect(envOf({})).toBe("windows");
    expect(envOf({ execEnvironment: { wsl: "Ubuntu" } })).toEqual({ wsl: "Ubuntu" });
    expect(envOf({ execEnvironment: { container: "jaira-1a2b3c4d" } })).toEqual({ container: "jaira-1a2b3c4d" });
    expect(envOf({ execEnvironment: { container: "f00d", user: "node", from: "devcontainer" } })).toEqual({ container: "f00d", user: "node", from: "devcontainer" });
  });

  it("refuses a container it cannot name, a user that is not one, and an unknown maker", () => {
    expect(() => envOf({ execEnvironment: { container: "" } })).toThrow(/container must name a container/);
    expect(() => envOf({ execEnvironment: { container: "c", user: 7 } })).toThrow(/user must name a user/);
    expect(() => envOf({ execEnvironment: { container: "c", from: "podman" } })).toThrow(/from must be/);
    expect(() => envOf({ execEnvironment: "linux" })).toThrow(/"windows", \{ "wsl": "<distro>" \} or \{ "container": "<name>" \}/);
  });

  it("takes the workspace's container over a machine's distro the layers merged it beside", () => {
    const merged = mergeConfigLayers([{ execEnvironment: { wsl: "Ubuntu" } }, { execEnvironment: { container: "jaira-1a2b3c4d", from: "docker" } }]);
    expect(envOf(merged)).toEqual({ container: "jaira-1a2b3c4d", from: "docker" });
  });
});
