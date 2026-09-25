import { describe, expect, it } from "vitest";
import type { AgentQuery, AgentQueryOptions } from "@declarative-ai/agents-api";
import { SecretResolver } from "../src/secrets";
import { sdkCredential, sdkQueryOnKey } from "../src/sdkCredential";

const envOf = (found: ReturnType<typeof sdkCredential>): NodeJS.ProcessEnv => {
  if ("refused" in found) throw new Error(found.refused);
  return found.env;
};

describe("sdkCredential", () => {
  it("hands the key over and takes a subscription token out", () => {
    const env = envOf(sdkCredential(undefined, undefined, { PATH: "/bin", ANTHROPIC_API_KEY: "sk-1", CLAUDE_CODE_OAUTH_TOKEN: "oauth" }));
    expect(env).toEqual({ PATH: "/bin", ANTHROPIC_API_KEY: "sk-1" });
  });

  it("refuses with no key, rather than letting claude fall back to a subscription", () => {
    const found = sdkCredential(undefined, undefined, { PATH: "/bin", CLAUDE_CODE_OAUTH_TOKEN: "oauth" });
    expect("refused" in found && found.refused).toContain("does not allow the Agent SDK to run on a Claude subscription");
  });

  it("reads a named secret through the chain and puts it under ANTHROPIC_API_KEY", () => {
    const secrets = new SecretResolver({ env: { MY_KEY: "sk-named" } });
    const env = envOf(sdkCredential("MY_KEY", secrets, { ANTHROPIC_API_KEY: "sk-other" }));
    expect(env["ANTHROPIC_API_KEY"]).toBe("sk-named");
    expect(env["MY_KEY"]).toBeUndefined();
  });

  it("keeps an auth token under its own name, and only the one found", () => {
    const env = envOf(sdkCredential(undefined, undefined, { ANTHROPIC_AUTH_TOKEN: "tok" }));
    expect(env).toEqual({ ANTHROPIC_AUTH_TOKEN: "tok" });
  });

  it("names the configured secret when it is missing", () => {
    const found = sdkCredential("MY_KEY", new SecretResolver({ env: {} }), {});
    expect("refused" in found && found.refused).toContain("Store a key under MY_KEY");
  });
});

describe("sdkQueryOnKey", () => {
  it("runs the transport under the key's environment, asked per call", () => {
    const seen: Array<NodeJS.ProcessEnv | undefined> = [];
    const query = ((opts: AgentQueryOptions) => {
      seen.push(opts.env);
      return {} as ReturnType<AgentQuery>;
    }) as AgentQuery;
    let key: string | undefined = "sk-1";
    const held = sdkQueryOnKey(() => sdkCredential(undefined, undefined, key !== undefined ? { ANTHROPIC_API_KEY: key } : {}), query);
    held({ prompt: "hi" } as AgentQueryOptions);
    expect(seen[0]).toEqual({ ANTHROPIC_API_KEY: "sk-1" });
    key = undefined;
    expect(() => held({ prompt: "hi" } as AgentQueryOptions)).toThrow(/API key/);
    expect(seen).toHaveLength(1);
  });
});
