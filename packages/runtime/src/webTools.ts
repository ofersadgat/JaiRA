/**
 * `web_fetch` and `web_search` — the network, as two tools rather than as `curl`.
 *
 * The same argument as `glob` and `grep`, with more at stake. A state that grants `bash` has granted
 * the network already: `curl`, `wget`, `nc`, and a policy left to reconstruct the intent from a
 * command line. Naming the capability makes it governable — a workflow can hold `web_fetch` and no
 * shell, which is a thing a reviewer can read off the state file, and the URL reaches the approver as
 * a URL rather than as an argument somewhere inside a string.
 *
 * ## What is deliberately not here
 *
 * No cookie jar, no redirect chain the caller can steer, no POST. This is "read a page", which is
 * what a model wants the web for nine times in ten, and every one of those knobs is a way to make an
 * agent's network access mean something other than reading. A workflow that genuinely needs to POST
 * has `bash` and a policy written for it.
 */
import type { ExecServices, JsonValue, Tool } from "@declarative-ai/exec";

export const WEB_FETCH = "web_fetch";
export const WEB_SEARCH = "web_search";

/** How a search provider is reached. Absent ⇒ `web_search` says so rather than pretending. */
export interface WebSearchConfig {
  /**
   * The endpoint, with `{query}` where the query goes.
   *
   * A template rather than a provider enum on purpose: every search API is a GET with a key and a
   * query, they differ only in the spelling, and a list of hard-coded providers is a list that is
   * always missing the one somebody uses.
   */
  endpoint: string;
  /** Sent as `Authorization`, or as the named header when the provider wants its own. */
  apiKey?: string;
  headerName?: string;
  /** A JSON pointer-ish path to the results array in the response, e.g. `web.results`. */
  resultsPath?: string;
}

export interface WebToolOptions {
  search?: WebSearchConfig;
  /** Injected in tests. Defaults to the platform `fetch`. */
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  /** Cap on returned text, so one page cannot fill a context window. */
  maxChars?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_CHARS = 100_000;

/** Only these schemes. `file:` would make a network tool a file reader that skips the file policy. */
function refuseUrl(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `'${raw}' is not a URL`;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return `'${url.protocol}' is not a scheme this tool will fetch — only http and https`;
  }
  return undefined;
}

/**
 * HTML reduced to something worth reading.
 *
 * Script and style content is dropped whole rather than tag-stripped, because their TEXT is code and
 * a model handed a minified bundle in place of an article has been given the page's least useful
 * bytes. Everything else becomes its text, which is lossy and is the point: this tool exists to read
 * a page, and a caller that wants the markup can say so.
 */
export function textOfHtml(html: string): string {
  return html
    .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr|br)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t ]+/g, " ")
    // The opening tags became spaces, so every break inherited the indentation of the markup around
    // it. Stripped after the collapse rather than before: the run of whitespace has to exist first
    // to be recognised as one.
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** One fetch, with a deadline the caller cannot be talked out of. */
async function get(
  options: WebToolOptions,
  url: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<{ status: number; contentType: string; body: string } | { error: string }> {
  const doFetch = options.fetch ?? globalThis.fetch;
  if (doFetch === undefined) return { error: "this build has no fetch implementation" };
  const clock = new AbortController();
  const timer = setTimeout(() => clock.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  // The run's own cancellation and the per-call deadline both have to reach the request; whichever
  // fires first wins, which is what makes cancelling a task actually stop a slow fetch.
  const onAbort = (): void => clock.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await doFetch(url, { headers, signal: clock.signal, redirect: "follow" });
    const body = await res.text();
    return { status: res.status, contentType: res.headers.get("content-type") ?? "", body };
  } catch (e) {
    const reason = (e as Error).name === "AbortError" ? "timed out or was cancelled" : (e as Error).message;
    return { error: `could not fetch '${url}': ${reason}` };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/** `web_fetch` — a URL, read as text. */
export function createWebFetchTool(options: WebToolOptions = {}): Tool {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  return {
    description: "Fetch an http(s) URL and return its text. HTML is reduced to readable text unless `raw` is set.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "An http or https URL." },
        raw: { type: "boolean", description: "Return the body as sent, without reducing HTML to text." },
      },
      required: ["url"],
    },
    readOnly: true,
    run: async (input, ctx?: ExecServices): Promise<JsonValue> => {
      const args = (input ?? {}) as { url?: unknown; raw?: unknown };
      const url = typeof args.url === "string" ? args.url.trim() : "";
      const refusal = refuseUrl(url);
      if (refusal !== undefined) return { error: refusal };

      const got = await get(options, url, { accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.8" }, ctx?.abortSignal);
      if ("error" in got) return got;
      const isHtml = got.contentType.includes("html");
      const text = args.raw === true || !isHtml ? got.body : textOfHtml(got.body);
      return {
        url,
        status: got.status,
        contentType: got.contentType,
        text: text.length > maxChars ? `${text.slice(0, maxChars)}\n…[truncated ${text.length - maxChars} chars]` : text,
        ...(text.length > maxChars ? { truncated: true } : {}),
      };
    },
  } as Tool;
}

/** Pull the results array out of a provider's response shape — see {@link WebSearchConfig.resultsPath}. */
function resultsAt(body: unknown, path: string | undefined): unknown[] {
  if (Array.isArray(body)) return body;
  let at: unknown = body;
  for (const step of (path ?? "results").split(".")) {
    if (at === null || typeof at !== "object") return [];
    at = (at as Record<string, unknown>)[step];
  }
  return Array.isArray(at) ? at : [];
}

/**
 * `web_search` — a query, and what came back.
 *
 * Configured or refused. A search tool with no provider is the one shape this file will not take: it
 * would be a tool a workflow can grant, a permission a person can approve, and a call that always
 * fails — which is worse than not offering it, because all three of those cost something and none of
 * them buys anything. Unconfigured, it says exactly what is missing.
 */
export function createWebSearchTool(options: WebToolOptions = {}): Tool {
  return {
    description: "Search the web and return result titles, URLs and snippets.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "What to search for." } },
      required: ["query"],
    },
    readOnly: true,
    run: async (input, ctx?: ExecServices): Promise<JsonValue> => {
      const config = options.search;
      if (config === undefined || config.endpoint.trim() === "") {
        return { error: "no search provider is configured — set `config.tools.search.endpoint` (with `{query}` in it) to use web_search" };
      }
      const args = (input ?? {}) as { query?: unknown };
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (query === "") return { error: "no query given" };

      const url = config.endpoint.replace("{query}", encodeURIComponent(query));
      const refusal = refuseUrl(url);
      if (refusal !== undefined) return { error: `the configured search endpoint is unusable: ${refusal}` };
      const headers: Record<string, string> = { accept: "application/json" };
      if (config.apiKey !== undefined && config.apiKey !== "") headers[config.headerName ?? "authorization"] = config.apiKey;

      const got = await get(options, url, headers, ctx?.abortSignal);
      if ("error" in got) return got;
      if (got.status >= 400) return { error: `the search provider answered ${got.status}` };
      let body: unknown;
      try {
        body = JSON.parse(got.body);
      } catch {
        return { error: "the search provider did not answer with JSON" };
      }
      const results = resultsAt(body, config.resultsPath).slice(0, 20).map((row) => {
        const r = (row ?? {}) as Record<string, unknown>;
        const pick = (...keys: string[]): string => {
          for (const key of keys) if (typeof r[key] === "string") return r[key] as string;
          return "";
        };
        return { title: pick("title", "name"), url: pick("url", "link", "href"), snippet: pick("snippet", "description", "content") };
      });
      return { query, results: results as unknown as JsonValue, count: results.length };
    },
  } as Tool;
}

/** Register both web tools on a registry's `tools` facet. */
export function registerWebTools(registry: { tools: Map<string, Tool> }, options: WebToolOptions = {}): void {
  registry.tools.set(WEB_FETCH, createWebFetchTool(options));
  registry.tools.set(WEB_SEARCH, createWebSearchTool(options));
}
