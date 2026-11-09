/**
 * The canvas editor's undo (Ctrl+Z) and redo (Ctrl+Shift+Z, Ctrl+Y): what the canvas was before each of
 * the person's edits — `canvas.json` as the editor holds it, and every artboard's source — newest last.
 *
 * An edit is whatever one press, one drag or one key did: the calls made in one turn of the event loop
 * are kept as one step (drawing an artboard writes canvas.json and a new file, and is one undo), and a
 * drag records once, at its first move. An undo is itself an edit of the files: the editor saves what it
 * changed as the person's next version, as any other edit — it never rewinds the version history.
 */
export interface CanvasState<I> {
  readonly index: I;
  readonly sources: Readonly<Record<string, string>>;
}

export class CanvasHistory<S> {
  private past: S[] = [];
  private future: S[] = [];
  private open = false;

  constructor(private readonly limit = 200) {}

  /** Before an edit: `was`, the canvas as it stood, is kept. Calls in the same turn are one step. */
  record(was: S): void {
    if (this.open) return;
    this.open = true;
    queueMicrotask(() => {
      this.open = false;
    });
    this.past.push(was);
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
  }

  /** The state to go back to, `now` kept for a redo; undefined when there is nothing to undo. */
  undo(now: S): S | undefined {
    const was = this.past.pop();
    if (was === undefined) return undefined;
    this.future.push(now);
    return was;
  }

  /** The state an undo left, `now` kept for the next undo; undefined when there is nothing to redo. */
  redo(now: S): S | undefined {
    const next = this.future.pop();
    if (next === undefined) return undefined;
    this.past.push(now);
    return next;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }
}

/** The files that differ between two states, as the editor saves them: `project/canvas.json` and `project/<artboard>`. */
export function changedPaths<I>(a: CanvasState<I>, b: CanvasState<I>): string[] {
  const paths: string[] = [];
  if (a.index !== b.index && JSON.stringify(a.index) !== JSON.stringify(b.index)) paths.push("project/canvas.json");
  for (const path of new Set([...Object.keys(a.sources), ...Object.keys(b.sources)])) {
    if (a.sources[path] !== b.sources[path]) paths.push(path);
  }
  return paths;
}
