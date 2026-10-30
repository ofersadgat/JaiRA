/**
 * The artifact map (DESIGN §7.6): what an agent *thinks* it wrote, and where the
 * bytes actually went.
 *
 * The invariant this exists to keep: **a write to `P` followed by a read of `P`
 * returns the content**, whatever the configured destination did with the file. The
 * agent is never told its file moved, so a workflow authored against one
 * destination runs unchanged against another.
 *
 * The store is an interface rather than a table because of package layering:
 * `@jaira/runtime` must not import `@jaira/persistence` (the dependency runs the
 * other way). The app and CLI inject a SQLite-backed store; everything else gets
 * the in-memory one, which is also what `virtual:` uses.
 */

/** One recorded write: the logical path an agent used → where it landed. */
export interface ArtifactRecord {
  taskId: string;
  /** The path as the producer addressed it, relative to the workspace, `/`-separated. */
  logicalPath: string;
  /** Absolute host path. Absent when the destination is `virtual:`. */
  physicalPath?: string;
  /** Inline content — always present for `virtual:`, and for small files. */
  content?: string;
  /** sha-256 of the content, for identity independent of location. */
  hash: string;
  bytes: number;
  format?: string;
  /**
   * Whether this artifact may RUN when it is shown.
   *
   * Recorded rather than derived, and that is the whole safety of it. If "is this scriptable" were
   * answered from the media type, every `text/html` artifact any producer ever wrote would become
   * scriptable the day the interactive renderer shipped — including ones written before the question
   * existed. Here it is a claim the producing call made, kept with the bytes, so an artifact cannot
   * acquire scripts by being opened somewhere new.
   */
  interactive?: boolean;
  /** Which instance and output slot produced it, when it came from one. */
  instanceId?: string;
  stateId?: string;
  slot?: string;
  createdAt: number;
}

/**
 * What a published artifact is (decision 0020): a page (`.html`/`.htm`), a Markdown document, or a
 * canvas — `project/canvas.json` and one `.dc.html` per artboard, Claude Design's files.
 */
export type ArtifactKind = "page" | "markdown" | "canvas";

/**
 * One publish of an artifact (decision 0020 §1): every `show_artifact` publish, and every save a person
 * makes in the canvas editor, is a version.
 *
 * A version holds what it CHANGED, as Claude Code's publishes do ("own files not sent this time were
 * kept"): a file's whole text, or `null` for one it removed. What an artifact holds at a version is
 * every change up to it folded together ({@link foldVersions}) — so a canvas of twelve artboards saved
 * forty times is not forty copies of twelve files.
 */
export interface ArtifactVersion {
  taskId: string;
  /** The artifact's id, minted at its first publish (`a-…`): what `url` names and `list` returns. */
  artifact: string;
  /** 1 for the first publish, then one more each time. */
  version: number;
  /** Who made it: the model's publish, or a person's save in the editor. */
  author: "model" | "person";
  kind: ArtifactKind;
  /** The artifact type it was made from (`design`), for a canvas. */
  type?: string;
  title?: string;
  /** What the page is, from the tool's list — the glyph a card draws. */
  icon?: string;
  /** The file it opens on: a page's own name, a canvas's `project/canvas.json`. */
  entry: string;
  changes: Record<string, string | null>;
  /** The capabilities the publish declared (`{ downloads: {} }`), as given. */
  capabilities?: Record<string, unknown>;
  /** The call that published it, when a call did. */
  recordId?: string;
  createdAt: number;
}

/** A publish before the store numbers it. */
export type ArtifactVersionInput = Omit<ArtifactVersion, "version">;

/** Every file an artifact holds at the last of `versions` (ordered by version): each change folded over the ones before. */
export function foldVersions(versions: readonly ArtifactVersion[]): Record<string, string> {
  const files: Record<string, string> = {};
  for (const v of versions) {
    for (const [path, text] of Object.entries(v.changes)) {
      if (text === null) delete files[path];
      else files[path] = text;
    }
  }
  return files;
}

export interface ArtifactStore {
  /** Record a write, replacing any previous record for the same logical path. */
  put(record: ArtifactRecord): void;
  /** The most recent record for a logical path within a task. */
  get(taskId: string, logicalPath: string): ArtifactRecord | undefined;
  list(taskId: string): ArtifactRecord[];
  /** Number a publish one past the artifact's latest and keep it. */
  publish(input: ArtifactVersionInput): ArtifactVersion;
  /** Every version of one artifact, oldest first. */
  versions(taskId: string, artifact: string): ArtifactVersion[];
  /** Each of a task's published artifacts at its latest version, in the order they were first published. */
  latest(taskId: string): ArtifactVersion[];
}

/** What an artifact holds at `version` (its latest when absent): every file, by path. */
export function filesAt(store: ArtifactStore, taskId: string, artifact: string, version?: number): Record<string, string> {
  return foldVersions(store.versions(taskId, artifact).filter((v) => version === undefined || v.version <= version));
}

/** The default store: run-scoped, in memory. Also the whole of `virtual:`. */
export class MemoryArtifactStore implements ArtifactStore {
  private readonly byTask = new Map<string, Map<string, ArtifactRecord>>();
  private readonly published = new Map<string, ArtifactVersion[]>();

  publish(input: ArtifactVersionInput): ArtifactVersion {
    const key = `${input.taskId}\u0000${input.artifact}`;
    const list = this.published.get(key) ?? [];
    const version: ArtifactVersion = { ...input, version: (list.at(-1)?.version ?? 0) + 1 };
    list.push(version);
    this.published.set(key, list);
    return version;
  }

  versions(taskId: string, artifact: string): ArtifactVersion[] {
    return [...(this.published.get(`${taskId}\u0000${artifact}`) ?? [])];
  }

  latest(taskId: string): ArtifactVersion[] {
    return [...this.published.entries()]
      .filter(([key]) => key.startsWith(`${taskId}\u0000`))
      .map(([, list]) => list.at(-1)!);
  }

  put(record: ArtifactRecord): void {
    const key = record.taskId;
    const map = this.byTask.get(key) ?? new Map<string, ArtifactRecord>();
    map.set(record.logicalPath, record);
    this.byTask.set(key, map);
  }

  get(taskId: string, logicalPath: string): ArtifactRecord | undefined {
    return this.byTask.get(taskId)?.get(logicalPath);
  }

  list(taskId: string): ArtifactRecord[] {
    return [...(this.byTask.get(taskId)?.values() ?? [])];
  }
}
