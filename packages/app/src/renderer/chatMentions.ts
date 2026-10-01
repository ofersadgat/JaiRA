/**
 * What `@` completes against and how a mentioned file is read: the questions the composer's hosts
 * (`ChatStart.tsx`, `ChatThread.tsx`) ask main.
 */
import { useMemo } from "react";
import { invoke } from "./store";

/**
 * The composer's two project-file props, or neither.
 *
 * Neither with no project open: `@` would complete against a project that is not there, and the
 * completion would answer "no project is open" per keystroke. A conversation in JaiRA's own root
 * still works — it simply has nothing to mention.
 *
 * Both NAME the project rather than letting main resolve one. `$PROJECT` and a file search are
 * project-scoped calls, and an unnamed one answers only while exactly one user project is open — so
 * with a second checkout open every keystroke of a mention answered "several projects are open, so
 * this call must name one" instead of completing.
 */
export function useMentions(hasProject: boolean, project: string | undefined): {
  mentions?: (query: string) => Promise<string[]>;
  readMention?: (path: string) => Promise<string>;
} {
  return useMemo(() => {
    if (!hasProject) return {};
    const where = project !== undefined ? { project } : {};
    return {
      mentions: (query: string) =>
        invoke("file:find", { query, limit: 20, ...where })
          .then((found) => found.paths)
          .catch(() => []),
      readMention: (path: string) =>
        invoke("uri:read", { uri: `$PROJECT/${path}`, ...where }).then((content) => content.text),
    };
  }, [hasProject, project]);
}

