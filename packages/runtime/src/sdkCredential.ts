/**
 * The key the in-process SDK route (`claude-code`) runs on: an Anthropic API key, never a Claude
 * subscription.
 *
 * Anthropic's terms for the Agent SDK make this the route's one hard rule — "Anthropic does not allow
 * third party developers to offer claude.ai login or rate limits for their products, including agents
 * built on the Claude Agent SDK" (https://code.claude.com/docs/en/agent-sdk/overview), and developers
 * building on it "should use API key authentication" (…/legal-and-compliance). The SDK's bundled
 * `claude` inherits this process's environment, and finding no key there it falls back to whatever
 * subscription the person signed `claude` into — so the route used to run on a subscription whenever
 * no key happened to be in the environment, and the key JaiRA's secret chain found (a `.env`, the
 * keychain) never reached it at all. Now the key is handed over explicitly, a subscription token in
 * the environment is taken out, and with no key the call is refused before anything starts.
 *
 * `claude-cli` is the route for a subscription: the person's own unmodified binary, signed in through
 * Anthropic's own flow, which the same terms allow.
 */
import { createSdkAgentQuery, type AgentQuery } from "@declarative-ai/agents-api";
import { importPluginRoot } from "./plugins";
import type { SecretResolver } from "./secrets";

/** The variables the SDK route reads a key from when config names none, in the order they are tried. */
export const SDK_KEY_NAMES = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] as const;

/** How `claude` would otherwise sign in on a subscription — never handed to the SDK route. */
const SUBSCRIPTION_VARS = ["CLAUDE_CODE_OAUTH_TOKEN"];

/** The environment the SDK route runs under, or why it may not run. */
export type SdkCredential = { env: NodeJS.ProcessEnv } | { refused: string };

/**
 * Find the key and build the environment around it.
 *
 * `named` is `agents.claudeCode.credential` — the secret to read, which is then put under
 * `ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN`, when that is the name), whatever it was stored as.
 * Both Anthropic variables are cleared first so the one found is the one `claude` uses.
 */
export function sdkCredential(named: string | undefined, secrets: SecretResolver | undefined, base: NodeJS.ProcessEnv = process.env): SdkCredential {
  const names: readonly string[] = named !== undefined ? [named] : SDK_KEY_NAMES;
  for (const name of names) {
    const value = secrets !== undefined ? secrets.lookup(name)?.value : base[name];
    if (value === undefined || value.length === 0) continue;
    const env: NodeJS.ProcessEnv = { ...base };
    for (const drop of [...SUBSCRIPTION_VARS, ...SDK_KEY_NAMES]) delete env[drop];
    env[name === "ANTHROPIC_AUTH_TOKEN" ? "ANTHROPIC_AUTH_TOKEN" : "ANTHROPIC_API_KEY"] = value;
    return { env };
  }
  return {
    refused:
      `claude-code runs only on an Anthropic API key, and none was found (${names.join(", ")}) — ` +
      `Anthropic does not allow the Agent SDK to run on a Claude subscription. ` +
      `Store a key under ${names[0]}, or use claude-cli, which runs on your own subscription.`,
  };
}

/**
 * The SDK transport on the SDK wherever it is: the plugin store's copy when the Claude Agent SDK plugin
 * is installed (decision 0011 §6), else the package by name (a development checkout, an npm install).
 */
const pluginSdkQuery: AgentQuery = createSdkAgentQuery({ loadSdk: () => importPluginRoot("@anthropic-ai/claude-agent-sdk") });

/**
 * The SDK transport, held to {@link sdkCredential}: asked on every call, so a key stored after the
 * route was built is used, and one removed stops the next call rather than the next restart.
 */
export function sdkQueryOnKey(credential: () => SdkCredential, query: AgentQuery = pluginSdkQuery): AgentQuery {
  return (opts) => {
    const found = credential();
    if ("refused" in found) throw new Error(found.refused);
    return query({ ...opts, env: found.env });
  };
}
