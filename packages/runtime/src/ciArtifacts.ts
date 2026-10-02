/**
 * Where a downloaded CI artifact goes (decision 0016 §2): the task's central artifact folder —
 * `$CENTRAL`, `<project>/.jaira/system/<artifacts dir>/<task>/…` — recorded in the task's artifact
 * store under a LOGICAL path, `ci-artifacts/<job_id>/job.log`.
 *
 * The record is what makes the file readable. `read_file` looks a path up in the store before the
 * workspace, so an agent reads the log by its logical path even though it lives outside the
 * worktree; the artifacts pane lists it like any other. Nothing lands in the worktree, so nothing
 * shows in `git status`.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseDestination, resolveDestination, type DestinationVars } from "./artifactPath";
import type { ArtifactStore } from "./artifacts";

/** Where every CI download's logical path starts. */
export const CI_ARTIFACTS_ROOT = "ci-artifacts";

export interface SavedArtifact {
  /** The logical path — what `read_file` takes. */
  path: string;
  /** Where it is on disk — what a shell command takes. */
  file: string;
  bytes: number;
}

export interface CiArtifactSink {
  /** Keep these bytes as the task's artifact at `logical`, replacing any earlier one there. */
  save(logical: string, bytes: Uint8Array): SavedArtifact;
}

export interface CentralSinkOptions {
  store: ArtifactStore;
  /** What `$CENTRAL` resolves from — the file tools' own. */
  vars: Omit<DestinationVars, "relPath">;
  now?: () => number;
}

const CENTRAL = parseDestination("$CENTRAL");

export function centralArtifactSink(options: CentralSinkOptions): CiArtifactSink {
  const now = options.now ?? Date.now;
  return {
    save(logical, bytes) {
      const resolved = resolveDestination(CENTRAL, { ...options.vars, relPath: logical }, logical);
      if (resolved.path === undefined) throw new Error(`$CENTRAL resolved to no file for ${logical}`);
      mkdirSync(dirname(resolved.path), { recursive: true });
      writeFileSync(resolved.path, bytes);
      options.store.put({
        taskId: options.vars.taskId,
        logicalPath: logical,
        physicalPath: resolved.path,
        hash: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.length,
        createdAt: now(),
      });
      return { path: logical, file: resolved.path, bytes: bytes.length };
    },
  };
}
