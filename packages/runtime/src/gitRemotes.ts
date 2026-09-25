/**
 * A project's git remotes, and the forge connection each one picks (decision 0010 §2, "Which remotes").
 *
 * Nothing about WHERE events come from is typed by anybody: the remotes are the ones the project's
 * own `.git/config` names, and each remote's host picks its connection the way a merge request's does
 * (`parseRemoteUrl` → `connectionForHost`). This is the read the repository watcher starts from, and
 * what Settings → Events lists under each event.
 *
 * ## Read how
 *
 *  - **The CONFIGURED url, raw** — `git config remote.<name>.url`, not `git remote get-url`, which
 *    answers after `url.<base>.insteadOf` rewriting: a rewrite says where the bytes travel, the
 *    configured url says which forge the project is on (the note in `./remote`).
 *  - **`--local`** — the repository's own `.git/config` and nothing above it. A remote is a property
 *    of a repository; and outside one (the shared root, `~/.jaira`, is usually not a repository) git
 *    refuses `--local` outright, which is the "no remotes" the decision wants there rather than
 *    whatever the global config happens to carry.
 *  - **Through {@link Git}**, so a WSL project asks the distro's git about the distro's checkout.
 */
import {
  BUILTIN_OAUTH_APPS,
  connectionForHost,
  parseRemoteUrl,
  type ForgeProviderKind,
  type JairaIntegrationsConfig,
} from "@jaira/shared";
import type { Git } from "./git";

/** One git remote of a project, and where it points. */
export interface ProjectRemote {
  /** The remote's name — `origin`, `upstream`. */
  name: string;
  /** Its url as configured. */
  url: string;
  /** The forge host, lower-cased — with its port for an https remote on one. */
  host: string;
  /** The project's path on the host — `owner/repo`, `group/sub/project`, no `.git`. */
  repository: string;
  /** Which forge it is: the connection's provider, else the provider whose public host it is. */
  provider?: ForgeProviderKind;
  /** The connection its host picks (Settings → Connections → Forges); absent when none is set up and on. */
  connection?: string;
}

/** `remote.<name>.url <url>` — git prints the key lower-cased up to the name, and the name as written. */
const URL_LINE = /^remote\.(.+)\.url\s+(.*)$/;

/**
 * The project's remotes on a forge, in the order `.git/config` lists them, each mapped to its host,
 * repository and connection. A remote that is no forge — a path, a `file://` url, a bare repository
 * on disk — is left out: nothing can be watched there, so there is nothing to switch on. A remote
 * with several `url`s (git allows it; the first is the fetch url) is listed once, with its first.
 * Empty outside a repository, and for a repository with no remotes.
 */
export async function projectRemotes(git: Git, integrations: JairaIntegrationsConfig): Promise<ProjectRemote[]> {
  // `--get-regexp` exits 1 when nothing matches, which `tryRun` answers as `undefined` — no remotes.
  const listed = await git.tryRun(["config", "--local", "--get-regexp", "^remote\\..*\\.url$"]);
  if (listed === undefined) return [];
  const out: ProjectRemote[] = [];
  const seen = new Set<string>();
  for (const line of listed.split(/\r?\n/)) {
    const match = URL_LINE.exec(line.trim());
    if (match === null) continue;
    const name = match[1]!;
    const url = match[2]!.trim();
    if (seen.has(name)) continue;
    seen.add(name);
    const remote = projectRemoteOf(name, url, integrations);
    if (remote !== undefined) out.push(remote);
  }
  return out;
}

/** One remote, mapped; `undefined` when its url is no forge's. */
export function projectRemoteOf(name: string, url: string, integrations: JairaIntegrationsConfig): ProjectRemote | undefined {
  const location = parseRemoteUrl(url);
  if (location === undefined) return undefined;
  const picked = connectionForHost(integrations, location.host);
  const provider =
    picked?.connection.provider ??
    (Object.entries(BUILTIN_OAUTH_APPS).find(([, app]) => app.host === location.host)?.[0] as ForgeProviderKind | undefined);
  return {
    name,
    url,
    host: location.host,
    repository: location.project,
    ...(provider !== undefined ? { provider } : {}),
    ...(picked !== undefined ? { connection: picked.name } : {}),
  };
}
