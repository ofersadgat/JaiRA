/**
 * What to call a project directory, on a surface that has only the directory.
 *
 * Every list in the window that spans projects — the inbox strip, the root's conversation list, the
 * sidebar's own rows — has to put a name on a row, and the only thing those rows carry is an
 * absolute path. `C:\checkouts\acme\services\billing` does not fit in a chip and would be truncated
 * to the half every project on the machine has in common, so it is reduced to a segment.
 *
 * **Prefer the published label.** `listProjects` already names each open project — the basename for
 * a checkout, `~/.jaira` for the shared root, `JaiRA` for its own — and a surface holding that list
 * should use it, so that one project is called one thing everywhere. These are the fallback for a
 * directory no longer in the list, which is what a request outliving its session by a tick looks
 * like.
 *
 * Both separators, and that is the whole reason this is one function rather than three copies. Three
 * surfaces split on `/` alone; on Windows a path has none, so each of them "reduced"
 * `C:\UbuntuCode\JaiRA` to itself and printed the full path in a chip — or, for the segment above,
 * to nothing at all.
 */

/** The segments of a directory, in order, with the empties dropped. */
function segmentsOf(dir: string): string[] {
  return dir.split(/[\\/]+/).filter((part) => part.length > 0);
}

/** A project's own name: the last segment of its path. */
export function projectName(dir: string | null): string {
  if (dir === null) return "";
  return segmentsOf(dir).at(-1) ?? dir;
}

/**
 * The name of the folder a project SITS IN — the segment above it.
 *
 * What the sidebar puts beside an open project's name (SHELL.md §5.1): two checkouts of one
 * repository share a basename and are told apart by this. Empty for a path with nothing above it,
 * which is a root and has no answer to give.
 */
export function parentName(dir: string): string {
  return segmentsOf(dir).at(-2) ?? "";
}
