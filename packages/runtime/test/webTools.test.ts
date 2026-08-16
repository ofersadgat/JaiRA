/**
 * `web_fetch` and `web_search` — the network as two named capabilities.
 *
 * `fetch` is injected throughout: these tests are about what the tools DO with a response and what
 * they refuse before there is one, and a suite that reached the real network would be testing
 * somebody else's uptime.
 */
import { describe, expect, it } from "vitest";
import type { ExecServices, Tool } from "@declarative-ai/exec";
import { createWebFetchTool, createWebSearchTool, registerWebTools, textOfHtml } from "../src/webTools";
import { newRegistry } from "../src/wiring";

const call = async (tool: Tool, input: unknown, ctx: ExecServices = {} as ExecServices) =>
  (await (tool.run as (i: unknown, x: unknown) => Promise<Record<string, unknown>>)(input, ctx)) ?? {};

/** A `fetch` that answers one canned response and records what it was asked. */
function fakeFetch(body: string, init: { status?: number; contentType?: string } = {}) {
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  const impl = (async (url: unknown, options?: unknown) => {
    const opts = (options ?? {}) as { headers?: Record<string, string> };
    seen.push({ url: String(url), headers: opts.headers ?? {} });
    return {
      status: init.status ?? 200,
      headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? (init.contentType ?? "text/plain") : null) },
      text: async () => body,
    };
  }) as unknown as typeof globalThis.fetch;
  return { impl, seen };
}

describe("textOfHtml", () => {
  it("drops script and style CONTENT rather than only their tags", () => {
    // Tag-stripping alone hands a model a minified bundle in place of an article — the page's least
    // useful bytes, and enough of them to crowd out the ones it asked for.
    const text = textOfHtml("<html><style>.a{color:red}</style><script>var x=1</script><p>Hello</p></html>");
    expect(text).toContain("Hello");
    expect(text).not.toContain("color:red");
    expect(text).not.toContain("var x");
  });

  it("turns block ends into line breaks and decodes the common entities", () => {
    expect(textOfHtml("<p>one</p><p>two</p>")).toBe("one\ntwo");
    expect(textOfHtml("<p>a &amp; b &lt;c&gt;</p>")).toContain("a & b <c>");
  });
});

describe("web_fetch", () => {
  it("reduces HTML to readable text, and returns other types as sent", async () => {
    const html = fakeFetch("<html><p>Read me</p></html>", { contentType: "text/html; charset=utf-8" });
    expect(await call(createWebFetchTool({ fetch: html.impl }), { url: "https://example.test/a" })).toMatchObject({
      status: 200,
      text: "Read me",
    });
    const json = fakeFetch('{"a":1}', { contentType: "application/json" });
    expect(await call(createWebFetchTool({ fetch: json.impl }), { url: "https://example.test/a" })).toMatchObject({
      text: '{"a":1}',
    });
  });

  it("returns the body untouched when asked for raw", async () => {
    const html = fakeFetch("<p>x</p>", { contentType: "text/html" });
    expect(await call(createWebFetchTool({ fetch: html.impl }), { url: "https://example.test/a", raw: true })).toMatchObject({
      text: "<p>x</p>",
    });
  });

  it("refuses a scheme that is not http(s)", async () => {
    // `file:` would make a network tool a file reader that skips the file policy entirely.
    const { impl, seen } = fakeFetch("secret");
    const tool = createWebFetchTool({ fetch: impl });
    expect(await call(tool, { url: "file:///etc/passwd" })).toMatchObject({
      error: expect.stringMatching(/only http and https/) as unknown as string,
    });
    expect(await call(tool, { url: "not a url" })).toMatchObject({ error: expect.stringMatching(/not a URL/) as unknown as string });
    // Refused BEFORE the request, which is the only refusal worth having.
    expect(seen).toHaveLength(0);
  });

  it("truncates a large page rather than returning all of it", async () => {
    const big = fakeFetch("x".repeat(500));
    const result = await call(createWebFetchTool({ fetch: big.impl, maxChars: 100 }), { url: "https://example.test/a" });
    expect(result.truncated).toBe(true);
    expect(String(result.text).length).toBeLessThan(200);
  });

  it("is read-only — fetching changes nothing here", () => {
    expect(createWebFetchTool().readOnly).toBe(true);
  });
});

describe("web_search", () => {
  it("says what is missing when no provider is configured", async () => {
    // The one shape this tool will not take: grantable, approvable, and always failing.
    expect(await call(createWebSearchTool(), { query: "anything" })).toMatchObject({
      error: expect.stringMatching(/no search provider is configured/) as unknown as string,
    });
  });

  it("puts the query in the endpoint and the key in a header", async () => {
    const { impl, seen } = fakeFetch(JSON.stringify({ results: [{ title: "T", url: "https://x.test", snippet: "S" }] }));
    const tool = createWebSearchTool({
      fetch: impl,
      search: { endpoint: "https://api.test/s?q={query}", apiKey: "k", headerName: "x-key" },
    });
    expect(await call(tool, { query: "a b" })).toMatchObject({ count: 1 });
    expect(seen[0]!.url).toBe("https://api.test/s?q=a%20b");
    expect(seen[0]!.headers["x-key"]).toBe("k");
  });

  it("reads the results out of whatever shape the provider uses", async () => {
    const { impl } = fakeFetch(JSON.stringify({ web: { results: [{ name: "N", link: "https://y.test", description: "D" }] } }));
    const tool = createWebSearchTool({ fetch: impl, search: { endpoint: "https://api.test/?q={query}", resultsPath: "web.results" } });
    const result = await call(tool, { query: "x" });
    expect(result.results).toEqual([{ title: "N", url: "https://y.test", snippet: "D" }]);
  });

  it("reports a provider error rather than returning nothing", async () => {
    const { impl } = fakeFetch("nope", { status: 503 });
    const tool = createWebSearchTool({ fetch: impl, search: { endpoint: "https://api.test/?q={query}" } });
    expect(await call(tool, { query: "x" })).toMatchObject({ error: expect.stringMatching(/503/) as unknown as string });
  });
});

describe("registerWebTools", () => {
  it("registers both under the names the vocabulary uses", () => {
    const registry = newRegistry();
    registerWebTools(registry);
    expect(registry.tools.get("web_fetch")?.readOnly).toBe(true);
    expect(registry.tools.get("web_search")?.readOnly).toBe(true);
  });
});
