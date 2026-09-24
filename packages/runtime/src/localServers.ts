/**
 * Which OpenAI-compatible servers are running on this machine, and what they serve.
 *
 * The `local` route needs a URL, and the person setting it up usually has one server running and
 * does not know — or has forgotten — which port it took. So Settings asks every place the usual
 * servers listen, all at once, with a short deadline each, and shows what answered: the URL to use
 * and the model ids to name. The route's configured URL is compared with every row, so the one in
 * use is marked, and asked too when it is none of them.
 *
 * On demand only — the page opening, Re-check. Nothing here polls: a server coming up is something
 * the person just did, and the button is right there.
 *
 * `GET {baseURL}/models` is the one call: every server here answers it, it costs nothing, and its
 * `{ data: [{ id }] }` is the list a person picks a model from. What does not answer that shape is
 * NOT up, whatever is listening — a dev server on 8080 is common, and it is not llama.cpp.
 */
import type { LocalServerDiscovery, LocalServerProbe } from "@jaira/shared";

/** Where the usual servers listen by default — the order Settings lists them in. */
export const LOCAL_SERVERS: ReadonlyArray<{ name: string; baseURL: string }> = [
  { name: "Ollama", baseURL: "http://localhost:11434/v1" },
  { name: "LM Studio", baseURL: "http://localhost:1234/v1" },
  { name: "llama.cpp server", baseURL: "http://localhost:8080/v1" },
  { name: "vLLM", baseURL: "http://localhost:8000/v1" },
  { name: "Jan", baseURL: "http://localhost:1337/v1" },
];

/**
 * Short, and per server: a server on this machine that cannot list its models in under a second is
 * not one to point a workflow at, and five of them in parallel keep the page's wait to one deadline.
 */
export const LOCAL_PROBE_TIMEOUT_MS = 800;

/** The slice of `fetch` this needs — injected, so every outcome is tested without a server. */
export type LocalFetch = (url: string, init: { signal: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;

export interface LocalDiscoveryOptions {
  fetch?: LocalFetch;
  timeoutMs?: number;
  /** The `local` route's `baseURL`, to mark the row it names — and to ask it too when it names none. */
  configured?: string;
  now?: () => number;
}

/** Ask every well-known server (and the configured one) side by side. Never throws: a failure is a row. */
export async function discoverLocalServers(options: LocalDiscoveryOptions = {}): Promise<LocalServerDiscovery> {
  const configured = options.configured?.trim() || undefined;
  const candidates = [...LOCAL_SERVERS];
  if (configured !== undefined && !candidates.some((c) => sameServerUrl(c.baseURL, configured))) {
    candidates.push({ name: "Configured", baseURL: configured });
  }
  const servers = await Promise.all(
    candidates.map(async (candidate): Promise<LocalServerProbe> => ({
      name: candidate.name,
      baseURL: candidate.baseURL,
      ...(await askForModels(candidate.baseURL, options)),
      inUse: configured !== undefined && sameServerUrl(candidate.baseURL, configured),
    })),
  );
  return { servers, ...(configured !== undefined ? { configured } : {}), checkedAt: (options.now ?? Date.now)() };
}

/**
 * Whether two base URLs name the same server: case, a trailing slash and the four spellings of this
 * machine (`localhost`, `127.0.0.1`, `[::1]`, `0.0.0.0`) do not matter; the port and the path do —
 * `…:11434` without `/v1` is Ollama's native API, which the route cannot talk to.
 */
export function sameServerUrl(a: string, b: string): boolean {
  const key = (url: string): string | undefined => {
    try {
      const parsed = new URL(url.trim());
      const host = ["localhost", "127.0.0.1", "[::1]", "0.0.0.0"].includes(parsed.hostname.toLowerCase()) ? "localhost" : parsed.hostname.toLowerCase();
      const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
      return `${parsed.protocol}//${host}:${port}${parsed.pathname.replace(/\/+$/, "")}`;
    } catch {
      return undefined;
    }
  };
  const left = key(a);
  return left !== undefined && left === key(b);
}

async function askForModels(baseURL: string, options: LocalDiscoveryOptions): Promise<Pick<LocalServerProbe, "up" | "models" | "error">> {
  const call: LocalFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? LOCAL_PROBE_TIMEOUT_MS);
  try {
    const response = await call(`${baseURL.replace(/\/+$/, "")}/models`, { signal: controller.signal });
    const text = await response.text();
    if (response.status === 401 || response.status === 403) {
      return { up: false, models: [], error: `answered ${response.status} — the server wants a key` };
    }
    if (response.status < 200 || response.status >= 300) {
      return { up: false, models: [], error: `answered ${response.status}, not a model list` };
    }
    const models = modelIds(text);
    if (models === undefined) return { up: false, models: [], error: "something answered, but not with an OpenAI model list" };
    return { up: true, models };
  } catch (e) {
    if (controller.signal.aborted) return { up: false, models: [], error: "no answer in time" };
    return { up: false, models: [], error: refusedOrMessage(e) };
  } finally {
    clearTimeout(timer);
  }
}

/** `{ data: [{ id }] }` → the ids; `undefined` for anything that is not that shape. */
function modelIds(text: string): string[] | undefined {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return undefined;
  }
  const data = body !== null && typeof body === "object" ? (body as { data?: unknown }).data : undefined;
  if (!Array.isArray(data)) return undefined;
  return data
    .map((entry) => (entry !== null && typeof entry === "object" ? (entry as { id?: unknown }).id : undefined))
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

/** Node's `fetch` says only "fetch failed" and hides the reason in `cause` — which is the useful half. */
function refusedOrMessage(error: unknown): string {
  const cause = (error as { cause?: { code?: unknown; message?: unknown } }).cause;
  if (cause?.code === "ECONNREFUSED") return "nothing is listening";
  if (typeof cause?.message === "string" && cause.message.length > 0) return cause.message;
  return (error as Error).message;
}
