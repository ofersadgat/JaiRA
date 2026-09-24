/**
 * Finding the local servers, without one running: `fetch` is a table of what each port does.
 */
import { describe, expect, it } from "vitest";
import { discoverLocalServers, LOCAL_SERVERS, sameServerUrl, type LocalFetch } from "../src/localServers";

type Port = { status: number; body: string } | "refused" | "hang" | Error;

/** A machine whose ports answer as the table says; anything not in it refuses, as a closed port does. */
function machine(ports: Record<string, Port>): { fetch: LocalFetch; asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    fetch: (url, init) => {
      asked.push(url);
      const port = ports[url] ?? "refused";
      if (port === "hang") {
        return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("This operation was aborted"))));
      }
      if (port === "refused") return Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED", message: "connect ECONNREFUSED 127.0.0.1:1" } }));
      if (port instanceof Error) return Promise.reject(port);
      return Promise.resolve({ status: port.status, text: () => Promise.resolve(port.body) });
    },
  };
}

const list = (...ids: string[]) => ({ status: 200, body: JSON.stringify({ object: "list", data: ids.map((id) => ({ id, object: "model" })) }) });

describe("asking the usual ports for their models", () => {
  it("asks every well-known server once, all of them, and reports what each serves", async () => {
    const box = machine({
      "http://localhost:11434/v1/models": list("llama3.2:latest", "qwen2.5-coder:7b"),
      "http://localhost:1234/v1/models": list(),
    });
    const found = await discoverLocalServers({ fetch: box.fetch, now: () => 42 });
    expect(box.asked).toEqual(LOCAL_SERVERS.map((s) => `${s.baseURL}/models`));
    expect(found.checkedAt).toBe(42);
    expect(found.configured).toBeUndefined();
    expect(found.servers).toEqual([
      { name: "Ollama", baseURL: "http://localhost:11434/v1", up: true, models: ["llama3.2:latest", "qwen2.5-coder:7b"], inUse: false },
      // Up with nothing loaded yet is still up — the list is simply empty.
      { name: "LM Studio", baseURL: "http://localhost:1234/v1", up: true, models: [], inUse: false },
      { name: "llama.cpp server", baseURL: "http://localhost:8080/v1", up: false, models: [], error: "nothing is listening", inUse: false },
      { name: "vLLM", baseURL: "http://localhost:8000/v1", up: false, models: [], error: "nothing is listening", inUse: false },
      { name: "Jan", baseURL: "http://localhost:1337/v1", up: false, models: [], error: "nothing is listening", inUse: false },
    ]);
  });

  it("gives up on a port that does not answer in time, without holding the others back", async () => {
    const box = machine({ "http://localhost:8000/v1/models": "hang", "http://localhost:11434/v1/models": list("m") });
    const found = await discoverLocalServers({ fetch: box.fetch, timeoutMs: 20 });
    expect(found.servers.find((s) => s.name === "vLLM")).toMatchObject({ up: false, error: "no answer in time" });
    expect(found.servers.find((s) => s.name === "Ollama")).toMatchObject({ up: true, models: ["m"] });
  });

  it("does not call something else on the port a server: a page, or JSON that is not a model list", async () => {
    const box = machine({
      "http://localhost:8080/v1/models": { status: 200, body: "<!doctype html><title>dev server</title>" },
      "http://localhost:8000/v1/models": { status: 200, body: JSON.stringify({ hello: "world" }) },
      "http://localhost:1337/v1/models": { status: 404, body: "Not Found" },
    });
    const { servers } = await discoverLocalServers({ fetch: box.fetch });
    expect(servers.find((s) => s.name === "llama.cpp server")).toMatchObject({ up: false, error: "something answered, but not with an OpenAI model list" });
    expect(servers.find((s) => s.name === "vLLM")).toMatchObject({ up: false, error: "something answered, but not with an OpenAI model list" });
    expect(servers.find((s) => s.name === "Jan")).toMatchObject({ up: false, error: "answered 404, not a model list" });
  });

  it("says a server behind a key wants one", async () => {
    const box = machine({ "http://localhost:8000/v1/models": { status: 401, body: JSON.stringify({ error: "Unauthorized" }) } });
    const { servers } = await discoverLocalServers({ fetch: box.fetch });
    expect(servers.find((s) => s.name === "vLLM")).toMatchObject({ up: false, error: "answered 401 — the server wants a key" });
  });

  it("marks the server the local route uses, however its URL is spelled", async () => {
    const box = machine({ "http://localhost:11434/v1/models": list("m") });
    const found = await discoverLocalServers({ fetch: box.fetch, configured: "http://127.0.0.1:11434/v1/" });
    expect(found.configured).toBe("http://127.0.0.1:11434/v1/");
    expect(found.servers.filter((s) => s.inUse).map((s) => s.name)).toEqual(["Ollama"]);
    expect(found.servers).toHaveLength(LOCAL_SERVERS.length);
  });

  it("asks the configured server too when it is none of the usual ones, as a row of its own", async () => {
    const box = machine({ "http://gpu-box:9000/v1/models": list("big-model") });
    const found = await discoverLocalServers({ fetch: box.fetch, configured: "http://gpu-box:9000/v1" });
    expect(found.servers.at(-1)).toEqual({ name: "Configured", baseURL: "http://gpu-box:9000/v1", up: true, models: ["big-model"], inUse: true });
    expect(found.servers.filter((s) => s.inUse)).toHaveLength(1);
  });

  it("never throws: an unexpected failure is the row's error", async () => {
    const box = machine({ "http://localhost:1234/v1/models": new Error("socket hang up") });
    const { servers } = await discoverLocalServers({ fetch: box.fetch });
    expect(servers.find((s) => s.name === "LM Studio")).toMatchObject({ up: false, error: "socket hang up" });
  });
});

describe("the same server under another spelling", () => {
  it("ignores case, a trailing slash and which name this machine goes by — not the port or the path", () => {
    expect(sameServerUrl("http://localhost:11434/v1", "http://LOCALHOST:11434/v1/")).toBe(true);
    expect(sameServerUrl("http://localhost:11434/v1", "http://127.0.0.1:11434/v1")).toBe(true);
    expect(sameServerUrl("http://localhost:11434/v1", "http://[::1]:11434/v1")).toBe(true);
    expect(sameServerUrl("http://localhost:11434/v1", "http://localhost:11434")).toBe(false);
    expect(sameServerUrl("http://localhost:11434/v1", "http://localhost:1234/v1")).toBe(false);
    expect(sameServerUrl("http://localhost:11434/v1", "not a url")).toBe(false);
  });
});
