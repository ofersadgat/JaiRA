/**
 * A `ForgeHttp` that answers from fixtures and from nothing else.
 *
 * Two kinds of fixture sit side by side in `fixtures/forge/`, and each says which it is in `_source`:
 *
 *  - `<forge>.<what>.json` — RECORDED from the public API with an unauthenticated GET. Real bodies,
 *    real headers (GitHub's `ETag`, and the `304` it earns).
 *  - `<forge>.documented.json` — BUILT from the vendor's documented shapes, for what cannot be
 *    recorded without a token: every write, GitLab's discussions, the whole of GitHub's GraphQL.
 *
 * A request no fixture matches THROWS, naming itself. That is the property that matters: a provider
 * test can never reach the network, so it can never push, open or comment anywhere real.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ForgeHttp, ForgeRequest, ForgeResponse } from "../src/forge/http";

interface Match {
  method: string;
  path: string;
  /** Query parameters the request must carry, by value. Others are ignored. */
  query?: Record<string, string>;
  /** Headers the request must carry, by value — names lower-cased. */
  header?: Record<string, string>;
  /** A header the request must NOT carry: the unconditional twin of a conditional fixture. */
  withoutHeader?: string;
  /** A deep subset of the JSON body. */
  body?: unknown;
  /** The GraphQL operation the body's `query` names. */
  operation?: string;
}

interface Fixture {
  match: Match;
  response: ForgeResponse;
}

const DIR = fileURLToPath(new URL("./fixtures/forge", import.meta.url));

function loadAll(): Fixture[] {
  const out: Fixture[] = [];
  for (const file of readdirSync(DIR).filter((name) => name.endsWith(".json")).sort()) {
    const doc = JSON.parse(readFileSync(join(DIR, file), "utf8")) as { fixtures?: Fixture[] } & Fixture;
    out.push(...(doc.fixtures ?? [doc]));
  }
  return out;
}

function includes(actual: unknown, expected: unknown): boolean {
  if (expected === null || typeof expected !== "object") return actual === expected;
  if (actual === null || typeof actual !== "object") return false;
  return Object.entries(expected as Record<string, unknown>).every(([key, value]) =>
    includes((actual as Record<string, unknown>)[key], value),
  );
}

function matches(match: Match, request: ForgeRequest): boolean {
  const url = new URL(request.url);
  // Compared ENCODED: `gitlab-org%2Fgitlab-runner` is one path segment, and decoding it makes two.
  if (match.method !== request.method || url.pathname !== match.path) return false;
  for (const [key, value] of Object.entries(match.query ?? {})) if (url.searchParams.get(key) !== value) return false;
  const headers = Object.fromEntries(Object.entries(request.headers).map(([name, value]) => [name.toLowerCase(), value]));
  for (const [name, value] of Object.entries(match.header ?? {})) if (headers[name] !== value) return false;
  if (match.withoutHeader !== undefined && headers[match.withoutHeader] !== undefined) return false;
  if (match.body !== undefined && !includes(request.body, match.body)) return false;
  if (match.operation !== undefined) {
    const query = (request.body as { query?: string } | undefined)?.query ?? "";
    if (!new RegExp(`^(query|mutation) ${match.operation}\\b`).test(query)) return false;
  }
  return true;
}

/** How much a match says — the more specific fixture wins, so a general one can sit beside it. */
function weight(match: Match): number {
  return (
    Object.keys(match.query ?? {}).length +
    Object.keys(match.header ?? {}).length +
    (match.withoutHeader !== undefined ? 1 : 0) +
    (match.body !== undefined ? JSON.stringify(match.body).length : 0) +
    (match.operation !== undefined ? 1 : 0)
  );
}

export interface Replay {
  http: ForgeHttp;
  /** Every request made, in order — what a test asserts a provider SENT. */
  seen: ForgeRequest[];
}

export function replayForge(): Replay {
  const fixtures = loadAll().sort((a, b) => weight(b.match) - weight(a.match));
  const seen: ForgeRequest[] = [];
  return {
    seen,
    http: async (request) => {
      seen.push(request);
      const hit = fixtures.find((fixture) => matches(fixture.match, request));
      if (hit === undefined) throw new Error(`no fixture answers ${request.method} ${request.url}`);
      return structuredClone(hit.response);
    },
  };
}
