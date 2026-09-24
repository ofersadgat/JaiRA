/**
 * OpenRouter's credit (usage-readings contract, "API keys") — the one provider that says how much
 * credit there is. A management key reads the account's; an ordinary key its own limit; a key with
 * neither has no credit to draw against.
 */
import { describe, expect, it } from "vitest";
import { readOpenRouterCredit } from "../src/limitsRefresh";

const answer = (routes: Record<string, { status: number; body?: unknown }>): typeof fetch =>
  (async (url: string | URL) => {
    const path = String(url).replace("https://openrouter.ai/api/v1", "");
    const r = routes[path] ?? { status: 404 };
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status });
  }) as typeof fetch;

describe("readOpenRouterCredit", () => {
  it("reads the account's credit with a management key", async () => {
    const credit = await readOpenRouterCredit("k", undefined, answer({ "/credits": { status: 200, body: { data: { total_credits: 20, total_usage: 11.6 } } } }));
    expect(credit).toEqual({ usedUsd: 11.6, totalUsd: 20, source: "account" });
  });

  it("falls back to the key's own limit when the account's is refused", async () => {
    const credit = await readOpenRouterCredit(
      "k",
      undefined,
      answer({ "/credits": { status: 403 }, "/key": { status: 200, body: { data: { limit: 10, limit_remaining: 2.5, usage: 40 } } } }),
    );
    // Used is what the LIMIT has taken — not the key's lifetime usage.
    expect(credit).toEqual({ usedUsd: 7.5, totalUsd: 10, source: "key" });
  });

  it("has nothing to say for a key with no limit on an account it cannot read", async () => {
    expect(await readOpenRouterCredit("k", undefined, answer({ "/credits": { status: 403 }, "/key": { status: 200, body: { data: { limit: null, usage: 3 } } } }))).toBeUndefined();
  });
});
