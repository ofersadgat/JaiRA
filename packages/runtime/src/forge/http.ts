/**
 * The one way a provider talks to a forge (decision 0004 §1).
 *
 * A seam rather than a bare `fetch`, for two reasons. The providers are tested against RECORDED
 * responses, and a test that replays one needs somewhere to stand. And the polling budget is made
 * of response HEADERS — GitHub's `ETag` and `X-Poll-Interval`, a `Retry-After`, a `429` — which a
 * helper that returned only the parsed body would have thrown away before anyone could obey them.
 *
 * REST and GraphQL over plain HTTP, decided (option D was the `gh`/`glab` CLIs): two optional
 * binaries, uneven JSON, and no conditional requests — which is the whole polling budget on GitHub.
 */
import type { JsonValue } from "@declarative-ai/json";

export interface ForgeRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  headers: Record<string, string>;
  /** Sent as JSON. */
  body?: JsonValue;
  /**
   * Sent as `application/x-www-form-urlencoded` instead — what OAuth's endpoints are specified to
   * take (RFC 6749 §4.1.3, RFC 8628 §3.1). Never together with `body`.
   */
  form?: Record<string, string>;
}

export interface ForgeResponse {
  status: number;
  /** Lower-cased names. */
  headers: Record<string, string>;
  /** Parsed when the forge sent JSON, the raw text otherwise, `null` for an empty body (a `304`). */
  body: unknown;
}

export type ForgeHttp = (request: ForgeRequest) => Promise<ForgeResponse>;

/** What every provider is built from: where, as whom, and through what. */
export interface ForgeProviderOptions {
  host: string;
  /** The token's VALUE — resolved through the secret chain by the caller, held only in memory. */
  token: string;
  http: ForgeHttp;
  /** Where the API is, when the host's convention does not say — see `JairaForgeConnection.apiUrl`. */
  apiUrl?: string;
  now?: () => number;
}

/** How long a forge gets to answer. A poller behind a dead proxy must fail, not wait. */
export const FORGE_TIMEOUT_MS = 20_000;

/** The real transport: the platform `fetch`, with a deadline. */
export const fetchForgeHttp: ForgeHttp = async (request) => {
  const response = await fetch(request.url, {
    method: request.method,
    headers: {
      ...request.headers,
      ...(request.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(request.form !== undefined ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
    ...(request.form !== undefined ? { body: new URLSearchParams(request.form).toString() } : {}),
    signal: AbortSignal.timeout(FORGE_TIMEOUT_MS),
  });
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name.toLowerCase()] = value;
  });
  const text = await response.text();
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: response.status, headers, body };
};

/**
 * A forge said no, or could not be reached.
 *
 * `status` is what the caller branches on (`401` is a refused token, `404` a project the token cannot
 * see, `429` a budget spent); `retryAfterSeconds` is the forge's own word on when to come back, which
 * the poller obeys over any cadence of its own. The message never carries a header: the token is in
 * one.
 */
export class ForgeError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ForgeError";
  }
}

/** The forge's own sentence out of an error body — GitLab's `message` / `error`, GitHub's `message`. */
export function forgeMessage(body: unknown): string | undefined {
  if (typeof body === "string") return body.trim().slice(0, 200) || undefined;
  if (body === null || typeof body !== "object") return undefined;
  const record = body as Record<string, unknown>;
  for (const key of ["message", "error_description", "error"]) {
    const held = record[key];
    if (typeof held === "string" && held.length > 0) return held;
    // GitLab answers a validation failure with `{ "message": { "field": ["…"] } }` or a list.
    if (held !== undefined && held !== null && typeof held === "object") return JSON.stringify(held).slice(0, 200);
  }
  return undefined;
}

/** Seconds a response asks the caller to wait, from `Retry-After` — a number, per both forges. */
export function retryAfterOf(headers: Record<string, string>): number | undefined {
  const held = Number(headers["retry-after"]);
  return Number.isFinite(held) && held > 0 ? held : undefined;
}

/** Throw unless the response is one of `ok`. What was asked for is named; the credentials are not. */
export function expectStatus(response: ForgeResponse, ok: readonly number[], what: string): ForgeResponse {
  if (ok.includes(response.status)) return response;
  const said = forgeMessage(response.body);
  throw new ForgeError(
    `${what}: the forge answered ${response.status}${said !== undefined ? ` — ${said}` : ""}`,
    response.status,
    retryAfterOf(response.headers),
  );
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}
