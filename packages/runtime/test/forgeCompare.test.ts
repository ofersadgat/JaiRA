/**
 * `compare` on both providers — the commits a push brought, for the repository watcher's `git.pushed`
 * (decision 0010 §2). Against the documented shapes, through a transport that answers inline.
 */
import { describe, expect, it } from "vitest";
import { forgeProvider, type ForgeHttp, type ForgeRequest } from "../src/forge";

const answering = (routes: Record<string, unknown>, seen: ForgeRequest[] = []): ForgeHttp => async (request) => {
  seen.push(request);
  const url = new URL(request.url);
  const body = routes[url.pathname + url.search] ?? routes[url.pathname];
  return body === undefined ? { status: 404, headers: {}, body: { message: "Not Found" } } : { status: 200, headers: {}, body };
};

describe("GitHub compare", () => {
  const commit = (sha: string, login: string | null, name: string) => ({ sha, commit: { message: `${sha} message`, author: { name } }, author: login === null ? null : { login } });

  it("reads base...head's commits, oldest first, by login where GitHub knows one", async () => {
    const seen: ForgeRequest[] = [];
    const github = forgeProvider({ provider: "github", host: "github.com" }, "t", {
      http: answering({ "/repos/acme/app/compare/aaa...ccc": { commits: [commit("bbb", "mara", "Mara"), commit("ccc", null, "Sam Local")] } }, seen),
    });
    expect(await github.compare!("acme/app", "aaa", "ccc")).toEqual([
      { sha: "bbb", message: "bbb message", author: "mara" },
      { sha: "ccc", message: "ccc message", author: "Sam Local" },
    ]);
    expect(seen[0]!.method).toBe("GET");
  });

  it("reads the head commit alone for a branch new to the watcher", async () => {
    const github = forgeProvider({ provider: "github", host: "github.com" }, "t", { http: answering({ "/repos/acme/app/commits/ccc": commit("ccc", "mara", "Mara") }) });
    expect(await github.compare!("acme/app", undefined, "ccc")).toEqual([{ sha: "ccc", message: "ccc message", author: "mara" }]);
  });

  it("throws a ForgeError when the base is gone — the watcher falls back to the head", async () => {
    const github = forgeProvider({ provider: "github", host: "github.com" }, "t", { http: answering({}) });
    await expect(github.compare!("acme/app", "gone", "ccc")).rejects.toMatchObject({ status: 404 });
  });
});

describe("GitLab compare", () => {
  const commit = (id: string, when: string) => ({ id, message: `${id} message`, author_name: "Mara", committed_date: when });

  it("reads from..to, sorted oldest first with the head last", async () => {
    const gitlab = forgeProvider({ provider: "gitlab", host: "gitlab.com" }, "t", {
      http: answering({
        "/api/v4/projects/team%2Fapp/repository/compare?from=aaa&to=ccc": { commits: [commit("ccc", "2026-09-25T10:02:00Z"), commit("bbb", "2026-09-25T10:01:00Z")] },
      }),
    });
    expect((await gitlab.compare!("team/app", "aaa", "ccc")).map((c) => c.sha)).toEqual(["bbb", "ccc"]);
  });

  it("reads the head commit alone for a new branch", async () => {
    const gitlab = forgeProvider({ provider: "gitlab", host: "gitlab.com" }, "t", { http: answering({ "/api/v4/projects/team%2Fapp/repository/commits/ccc": commit("ccc", "2026-09-25T10:02:00Z") }) });
    expect(await gitlab.compare!("team/app", undefined, "ccc")).toEqual([{ sha: "ccc", message: "ccc message", author: "Mara" }]);
  });
});
