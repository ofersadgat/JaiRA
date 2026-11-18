/**
 * JaiRA's own marks in a shell's output (decision 0030): `\x1eJAIRA:<kind>:<payload>\x1e`, written by
 * what JaiRA adds around a command — where it ended (`cwd`), its end in a live shell (`end`: its exit,
 * its directory and its environment, NUL-separated) and that its stdout is through (`out`). They are
 * taken out of what the terminal shows and what the model reads.
 */

const OPEN = "\u001e";
const PREFIX = `${OPEN}JAIRA:`;
/** A mark longer than this is not one of ours finishing: what was held goes on as text. */
const LONGEST = 2_000_000;

/** Takes JaiRA's marks out of a stream that arrives in pieces, and hands each to `onMark`. */
export class MarkFilter {
  private held = "";

  constructor(private readonly onMark: (kind: string, payload: string) => void) {}

  /** The text of this piece with any marks taken out; the start of a mark is held for the next piece. */
  feed(text: string): string {
    let input = this.held + text;
    this.held = "";
    let out = "";
    for (;;) {
      const start = input.indexOf(OPEN);
      if (start < 0) return out + input;
      out += input.slice(0, start);
      const rest = input.slice(start);
      if (rest.length < PREFIX.length) {
        if (PREFIX.startsWith(rest)) {
          this.held = rest;
          return out;
        }
        out += OPEN;
        input = rest.slice(1);
        continue;
      }
      if (!rest.startsWith(PREFIX)) {
        out += OPEN;
        input = rest.slice(1);
        continue;
      }
      const end = rest.indexOf(OPEN, PREFIX.length);
      if (end < 0) {
        if (rest.length > LONGEST) return out + rest;
        this.held = rest;
        return out;
      }
      const body = rest.slice(PREFIX.length, end);
      const colon = body.indexOf(":");
      this.onMark(colon < 0 ? body : body.slice(0, colon), colon < 0 ? "" : body.slice(colon + 1));
      input = rest.slice(end + 1);
    }
  }

  /** The stream ended: what was held, as text. */
  flush(): string {
    const held = this.held;
    this.held = "";
    return held;
  }
}

/** Every mark taken out of a whole text, for a result read at once. */
export function withoutMarks(text: string, onMark: (kind: string, payload: string) => void = () => undefined): string {
  const filter = new MarkFilter(onMark);
  return filter.feed(text) + filter.flush();
}

/** A POSIX shell's single-quoted word for `text`, whatever it holds. */
export function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/**
 * The line an emulated shell's command is run as: a trap that says where it ended, then the command.
 * POSIX keeps `$?` across a trap, so the command's exit is the shell's.
 */
export function withCwdMark(command: string): string {
  return `trap 'printf "\\036JAIRA:cwd:%s\\036" "$PWD" >&2' EXIT\n${command}`;
}
