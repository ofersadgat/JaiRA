/**
 * `web_search`, with a provider out of the box.
 *
 * It used to refuse until somebody configured an endpoint, which made "grant web_search" mean "grant
 * a permission and then discover it fails". The default is scraped HTML, so the parser is the part
 * worth pinning: real markup, redirect links unwrapped, and tolerant of everything it cannot read.
 */
import { describe, expect, it } from "vitest";
import type { ExecServices, FunctionInputs, Tool } from "@declarative-ai/exec";
import { createWebSearchTool, duckDuckGoResults } from "../src/webTools";

const call = async (tool: Tool, input: unknown, ctx: ExecServices = {} as ExecServices) =>
  (await (tool.run as (i: unknown, x: unknown) => Promise<Record<string, unknown>>)(input, ctx)) ?? {};

/** A `fetch` answering one canned body, recording what it was asked. */
function fakeFetch(body: string, status = 200) {
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  const impl = (async (url: unknown, options?: unknown) => {
    const opts = (options ?? {}) as { headers?: Record<string, string> };
    seen.push({ url: String(url), headers: opts.headers ?? {} });
    return { status, headers: { get: () => "text/html" }, text: async () => body };
  }) as unknown as typeof globalThis.fetch;
  return { impl, seen };
}

/** The shape DuckDuckGo actually returns — a redirect link, `<b>` in the title, a snippet anchor. */
const PAGE = `
<div class="links_main links_deep result__body">
  <h2 class="result__title">
    <a rel="nofollow" class="result__a"
       href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.test%2Fa%2Dpage&amp;rut=deadbeef">A <b>Real</b> Page</a>
  </h2>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.test%2Fa%2Dpage">The <b>snippet</b> text.</a>
</div>
<div class="links_main links_deep result__body">
  <h2 class="result__title">
    <a rel="nofollow" class="result__a"
       href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fother.test%2Fb">Second</a>
  </h2>
</div>`;

describe("parsing the default provider", () => {
  it("unwraps the redirect to the page the model actually wants", () => {
    // The links are `//duckduckgo.com/l/?uddg=<the real url>`. Handing those back would give a model
    // a tracker to fetch instead of the page it asked for.
    const results = duckDuckGoResults(PAGE);
    expect(results[0]).toEqual({ title: "A Real Page", url: "https://example.test/a-page", snippet: "The snippet text." });
  });

  it("strips the markup around matched terms", () => {
    // Titles and snippets carry `<b>` around the query terms; the text has to come off before it is
    // worth reading.
    expect(duckDuckGoResults(PAGE)[0]!.title).not.toMatch(/<b>/);
  });

  it("keeps a result with no snippet rather than dropping it", () => {
    expect(duckDuckGoResults(PAGE)).toHaveLength(2);
    expect(duckDuckGoResults(PAGE)[1]).toMatchObject({ title: "Second", snippet: "" });
  });

  it("honours the limit", () => {
    expect(duckDuckGoResults(PAGE, 1)).toHaveLength(1);
  });

  it("degrades to nothing rather than throwing on markup it cannot read", () => {
    // The honest failure for a scraper: a markup change costs results, not an error.
    expect(duckDuckGoResults("<html><body>nothing here</body></html>")).toEqual([]);
    expect(duckDuckGoResults("")).toEqual([]);
  });
});

describe("the tool", () => {
  it("searches with no configuration at all", async () => {
    const { impl, seen } = fakeFetch(PAGE);
    const result = await call(createWebSearchTool({ fetch: impl }), { query: "a real page" });
    expect(result.count).toBe(2);
    expect(seen[0]!.url).toContain("duckduckgo.com");
    expect(seen[0]!.url).toContain("a%20real%20page");
    // The bare request gets a consent interstitial rather than results without this.
    expect(seen[0]!.headers["user-agent"]).toBeDefined();
  });

  it("prefers a configured provider, and reads its JSON", async () => {
    const { impl, seen } = fakeFetch(JSON.stringify({ results: [{ title: "T", url: "https://x.test", snippet: "S" }] }));
    const tool = createWebSearchTool({ fetch: impl, search: { endpoint: "https://api.test/s?q={query}", apiKey: "k", headerName: "x-key" } });
    expect(await call(tool, { query: "x" })).toMatchObject({ count: 1 });
    expect(seen[0]!.url).toBe("https://api.test/s?q=x");
    expect(seen[0]!.headers["x-key"]).toBe("k");
  });

  it("refuses when the scope table denies searching", async () => {
    // A search is scoped on its ENDPOINT — a query is not a place — and the endpoint is
    // configuration, so it never appears in the call's arguments for the generic extractor to find.
    const { impl, seen } = fakeFetch(PAGE);
    const ctx = { policy: { scopeOf: () => "deny" } } as unknown as ExecServices;
    expect(await call(createWebSearchTool({ fetch: impl }), { query: "x" }, ctx)).toMatchObject({
      error: expect.stringMatching(/not permitted/) as unknown as string,
    });
    // Refused BEFORE the request, which is the only refusal worth having.
    expect(seen).toHaveLength(0);
  });

  it("still reports an empty query and a provider error", async () => {
    const { impl } = fakeFetch(PAGE);
    expect(await call(createWebSearchTool({ fetch: impl }), { query: "  " })).toMatchObject({ error: "no query given" });
    const failing = fakeFetch("nope", 503);
    expect(await call(createWebSearchTool({ fetch: failing.impl }), { query: "x" })).toMatchObject({
      error: expect.stringMatching(/503/) as unknown as string,
    });
  });
});
