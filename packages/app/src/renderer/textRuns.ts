/**
 * Long text cut into runs a phone can draw. iOS backs every text view with ONE bitmap the size of its
 * box — about 5 KB a character at 3x, whether the view is on screen or not — so a phone draws a long
 * text as many short views, and only the ones near the screen are mounted (`Virtual`). A browser draws
 * only what shows and keeps one text.
 *
 * Measured 2026-10-27: a conversation of ~59,000 characters held ~390 MB of text bitmaps on a phone;
 * a single tool output in it, drawn as one unwrapped text, would have needed 5.7 GB.
 *
 * A run is at most {@link RUN_CHARS} characters and {@link RUN_LINES} lines — a text's box is as wide
 * as its column whatever it holds, so its LINES make it tall, not only its characters. Runs are cut
 * between lines; a line longer than a run is cut at its last space inside the run (else at its
 * length), and is the one place a run boundary moves a line break. Empty lines at a cut start the next
 * run rather than end the last, where a trailing newline draws no line.
 */
export const RUN_CHARS = 1500;
export const RUN_LINES = 40;

/** Items grouped into runs of at most `count` items and `size` total, in order. An item larger than `size` is a run alone. */
export function runsOf<T>(items: readonly T[], sizeOf: (item: T) => number, size: number, count: number): T[][] {
  const runs: T[][] = [];
  let run: T[] = [];
  let total = 0;
  for (const item of items) {
    const n = sizeOf(item);
    if (run.length > 0 && (total + n > size || run.length >= count)) {
      runs.push(run);
      run = [];
      total = 0;
    }
    run.push(item);
    total += n;
  }
  if (run.length > 0) runs.push(run);
  return runs;
}

/** `text` as runs; one run — the text itself — when it is short. */
export function textRuns(text: string, chars = RUN_CHARS, lines = RUN_LINES): string[] {
  const all = text.split("\n");
  if (text.length <= chars && all.length <= lines) return [text];
  // Lines longer than a run, cut into pieces of their own.
  const pieces: string[] = [];
  for (let line of all) {
    while (line.length > chars) {
      const space = line.lastIndexOf(" ", chars);
      const cut = space > chars / 2 ? space + 1 : chars;
      pieces.push(line.slice(0, cut));
      line = line.slice(cut);
    }
    pieces.push(line);
  }
  const runs = runsOf(pieces, (line) => line.length + 1, chars, lines);
  // Empty lines at the end of a run go to the start of the next one.
  for (let i = 0; i < runs.length - 1; i++) {
    const run = runs[i]!;
    let empty = 0;
    while (empty < run.length - 1 && run[run.length - 1 - empty] === "") empty++;
    if (empty > 0) runs[i + 1] = [...run.splice(run.length - empty), ...runs[i + 1]!];
  }
  return runs.map((run) => run.join("\n"));
}
