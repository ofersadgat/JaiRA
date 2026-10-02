/**
 * The recording pass (decision 0016, build step 2): read-only forge calls run through the app's OWN
 * connections, with what went over the wire written out as replay fixtures.
 *
 * Started by `JAIRA_FORGE_RECORD=<spec.json>` (desktop.ts), which exists because the forge tokens
 * live in Electron's `safeStorage` and only the app can use them: a provider test that wants the answer
 * to a call only a signed-in token may make gets it from here, and nothing else ever holds the token.
 *
 * What is kept, and what is not:
 *
 *  - **no request header at all** — `Authorization` is one; a fixture matches on method, path, query
 *    and a GraphQL operation's name, which is all `forgeReplay.ts` reads;
 *  - response headers reduced to {@link KEPT_HEADERS} — the ones a provider reads;
 *  - response bodies whole. A download's bytes go to a file of their own beside the fixtures, and the
 *    fixture carries them base64 too when they are no more than {@link INLINE_BYTES}.
 *
 * Only the four CI reads and the merge-request reads are callable: a spec cannot write to a forge.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fetchForgeHttp, type ForgeHttp, type ForgeRequest, type ForgeResponse } from "@jaira/runtime";
import type { ArtifactRef, ForgeProvider, PipelineQuery, PipelineStatus } from "@jaira/shared";
import type { AppService } from "./service";

/** One read. */
export type ForgeRecordCall =
  | { op: "pipelines"; query: PipelineQuery }
  | { op: "pipeline"; id: number; jobStatus?: PipelineStatus[]; includeRetried?: boolean }
  | { op: "job"; id: number }
  | { op: "artifact"; which: ArtifactRef }
  | { op: "mergeRequest"; number: number }
  | { op: "whoami" };

export interface ForgeRecordGroup {
  /** The fixtures' file name: `<name>.fixtures.json`. */
  name: string;
  /** An open project whose configuration names the connection for `host`. */
  project: string;
  host: string;
  /** The project on the forge — `owner/repo`. */
  forgeProject: string;
  calls: ForgeRecordCall[];
}

export interface ForgeRecordSpec {
  groups: ForgeRecordGroup[];
}

/** The response headers a provider reads. */
const KEPT_HEADERS = ["content-type", "link", "x-next-page", "x-page", "x-total", "x-total-pages", "etag", "x-poll-interval", "retry-after"];

/** Past this, a download's bytes stay in their own file and the fixture says so. */
const INLINE_BYTES = 256 * 1024;

interface RecordedFixture {
  match: { method: string; path: string; query?: Record<string, string>; operation?: string };
  response: { status: number; headers: Record<string, string>; body: unknown; bodyBase64?: string; bytesFile?: string };
}

/** Run every group's calls; write `<name>.fixtures.json`, `<name>.results.json` and the downloads. */
export async function recordForge(service: AppService, spec: ForgeRecordSpec): Promise<{ dir: string; lines: string[] }> {
  const dir = join(service.forgeRecordingsDir, `forge-record-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  mkdirSync(dir, { recursive: true });
  // Renew a signed-in token that has expired while the app was closed, as a start of the app does.
  await service.refreshAvailability().catch(() => undefined);
  const lines: string[] = [];
  for (const group of spec.groups) {
    const fixtures: RecordedFixture[] = [];
    let downloads = 0;
    const http: ForgeHttp = async (request) => {
      const response = await fetchForgeHttp(request);
      fixtures.push(fixtureOf(request, response, () => {
        const file = `${group.name}.download-${++downloads}.bin`;
        writeFileSync(join(dir, file), response.body as Uint8Array);
        return file;
      }));
      return response;
    };
    const provider = service.forgeProviderOver(group.project, group.host, http);
    const results: Array<{ call: ForgeRecordCall; result?: unknown; error?: string }> = [];
    for (const call of group.calls) {
      try {
        results.push({ call, result: summarize(await run(provider, group.forgeProject, call)) });
        lines.push(`${group.name}: ${call.op} ok`);
      } catch (e) {
        results.push({ call, error: (e as Error).message });
        lines.push(`${group.name}: ${call.op} FAILED — ${(e as Error).message}`);
      }
    }
    const source = `RECORDED in the app through the ${group.host} connection on ${new Date().toISOString().slice(0, 10)} (JAIRA_FORGE_RECORD, service/forgeRecord.ts): no request headers kept; response headers reduced to ${KEPT_HEADERS.join(", ")}.`;
    writeFileSync(join(dir, `${group.name}.fixtures.json`), `${JSON.stringify({ _source: source, fixtures }, null, 2)}\n`);
    writeFileSync(join(dir, `${group.name}.results.json`), `${JSON.stringify(results, null, 2)}\n`);
  }
  writeFileSync(join(dir, "summary.txt"), `${lines.join("\n")}\n`);
  return { dir, lines };
}

function run(provider: ForgeProvider, project: string, call: ForgeRecordCall): Promise<unknown> {
  switch (call.op) {
    case "pipelines":
      return provider.pipelines(project, call.query);
    case "pipeline":
      return provider.pipeline(project, call.id, {
        ...(call.jobStatus !== undefined ? { jobStatus: call.jobStatus } : {}),
        ...(call.includeRetried !== undefined ? { includeRetried: call.includeRetried } : {}),
      });
    case "job":
      return provider.job(project, call.id);
    case "artifact":
      return provider.artifact(project, call.which);
    case "mergeRequest":
      return provider.mergeRequest(project, call.number);
    case "whoami":
      return provider.whoami();
  }
}

/** A download as its size, its type, and — when it is text — its first and last lines. */
function summarize(result: unknown): unknown {
  if (result === null || typeof result !== "object" || !("bytes" in result)) return result;
  const { bytes, contentType } = result as { bytes: Uint8Array; contentType?: string };
  const text = Buffer.from(bytes).toString("utf8");
  const printable = !text.slice(0, 4096).includes("\u0000");
  const lines = printable ? text.split("\n") : [];
  return { bytes: bytes.length, contentType, ...(printable ? { lines: lines.length, head: lines.slice(0, 40), tail: lines.slice(-25) } : {}) };
}

function fixtureOf(request: ForgeRequest, response: ForgeResponse, saveBytes: () => string): RecordedFixture {
  const url = new URL(request.url);
  const query = Object.fromEntries(url.searchParams);
  const operation = /^(?:query|mutation) (\w+)/.exec(((request.body as { query?: string } | undefined)?.query ?? "").trim())?.[1];
  const headers = Object.fromEntries(Object.entries(response.headers).filter(([name]) => KEPT_HEADERS.includes(name)));
  const bytes = response.body instanceof Uint8Array ? response.body : undefined;
  return {
    match: {
      method: request.method,
      path: url.pathname,
      ...(Object.keys(query).length > 0 ? { query } : {}),
      ...(operation !== undefined ? { operation } : {}),
    },
    response: {
      status: response.status,
      headers,
      body: bytes !== undefined ? null : response.body,
      // Every download is kept in a file of its own, to be read; a small one is in the fixture too.
      ...(bytes !== undefined ? { bytesFile: saveBytes(), ...(bytes.length <= INLINE_BYTES ? { bodyBase64: Buffer.from(bytes).toString("base64") } : {}) } : {}),
    },
  };
}
