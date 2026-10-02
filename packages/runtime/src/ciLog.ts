/**
 * A CI job's log as an agent should read it (decision 0016 §2): the forge's framing taken out, and
 * the machine it names picked out of its first lines.
 *
 * Both formats are MEASURED (decision 0016, Verified), not documented:
 *
 *  - **GitLab** prefixes every line `<timestamp>Z <stream><O|E><flag> ` — the flag a space for a new
 *    line, `+` for a line that CONTINUES the one before it. Sections are
 *    `section_start:<epoch>:<name>[opts]\r` / `section_end:…\r`, colour is ANSI, and a `\r` inside a
 *    line redraws it.
 *  - **GitHub** opens with a UTF-8 byte-order mark and prefixes every line `<timestamp>Z `. Each user
 *    step opens with a `##[group]Run …` line; the machine is in a `##[group]VM Image` group (older
 *    runners: `Operating System` and `Runner Image` groups).
 *
 * The raw log is never what the agent is handed: the prefixes alone are a third of every line.
 */

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, "g");
const GITLAB_PREFIX = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z [0-9a-f]{2}[OE]([ +])/;
const GITLAB_SECTION = /section_(?:start|end):\d+:[A-Za-z0-9_.-]+(?:\[[^\]]*\])?\r?/g;
const GITHUB_PREFIX = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z) /;
const BOM = String.fromCharCode(0xfeff);

/** What a log says about the machine that ran it — each only when it says so. */
export interface CiMachine {
  os?: string;
  image?: string;
  imageVersion?: string;
  runnerVersion?: string;
  executor?: string;
}

/** A redrawn line keeps what was drawn last. */
function lastDrawn(line: string): string {
  if (!line.includes("\r")) return line;
  const drawn = line.split("\r").filter((part) => part.length > 0);
  return drawn[drawn.length - 1] ?? "";
}

/** A GitLab log, one line per line: prefixes gone, continuations joined, sections and colour removed. */
export function cleanGitlabLog(raw: string): string {
  const out: string[] = [];
  /** Per line of `out`: it held only section markers so far — GitLab's page does not count it as a line. */
  const markerOnly: boolean[] = [];
  const lines = raw.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  for (const line of lines) {
    const prefix = GITLAB_PREFIX.exec(line);
    const rest = prefix !== null ? line.slice(prefix[0].length) : line;
    const withoutSections = rest.replace(GITLAB_SECTION, "");
    const body = lastDrawn(withoutSections.replace(ANSI, ""));
    const onlyMarkers = body.length === 0 && withoutSections !== rest;
    if (prefix?.[1] === "+" && out.length > 0) {
      out[out.length - 1] += body;
      markerOnly[out.length - 1] = markerOnly[out.length - 1]! && onlyMarkers;
    } else {
      out.push(body);
      markerOnly.push(onlyMarkers);
    }
  }
  // GitLab's page numbers neither a line of section markers alone nor an empty one — so, with both
  // left out, line N here is `#L<N>` on the job's page (measured against gitlab.com's numbering).
  return out.filter((body, i) => !markerOnly[i] && body.length > 0).join("\n");
}

/** One step of a GitHub job, as `job()` reads it — what the split needs. */
export interface LogStep {
  number: number;
  name: string;
  startedAt?: string;
  finishedAt?: string;
  skipped?: boolean;
}

export interface CleanGithubLog {
  text: string;
  /** Per step that wrote anything, in order — present when the job's steps were given. */
  steps: Array<{ number: number; name: string; text: string }>;
}

/** Whole seconds: GitHub's step times have no fraction (measured), its log lines seven digits. */
const second = (iso: string | undefined): number | undefined => (iso === undefined ? undefined : Math.floor(Date.parse(iso) / 1000) * 1000);

/**
 * A GitHub log: the byte-order mark, the prefixes and the colour taken out — and, given the job's
 * steps, split into them.
 *
 * The split: a line that OPENS a step — `##[group]Run …`, `Post job cleanup.`, `Cleaning up orphan
 * processes` — moves to the next step once that step has started (to the second); any other line
 * moves on only once it is past both the current step's end and the next one's start. Step times are
 * whole seconds and several steps share one (measured), so neither rule alone is enough.
 */
export function cleanGithubLog(raw: string, steps: readonly LogStep[] = []): CleanGithubLog {
  const text = raw.startsWith(BOM) ? raw.slice(1) : raw;
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const ran = steps.filter((step) => step.skipped !== true && step.startedAt !== undefined).sort((a, b) => a.number - b.number);
  const bodies: string[][] = ran.map(() => []);
  const out: string[] = [];
  let at = 0;
  for (const line of lines) {
    const prefix = GITHUB_PREFIX.exec(line);
    const body = lastDrawn((prefix !== null ? line.slice(prefix[0].length) : line).replace(ANSI, ""));
    // GitHub's page numbers a step's lines without its `##[endgroup]`s — left out here too, line L of a
    // step's text is `#step:<n>:<L>` (measured against github.com's numbering).
    if (body === "##[endgroup]") continue;
    out.push(body);
    if (ran.length === 0) continue;
    const when = prefix !== null ? Date.parse(prefix[1]!) : undefined;
    if (when !== undefined) {
      const opens = body.startsWith("##[group]Run ") || body === "Post job cleanup." || body.startsWith("Cleaning up orphan processes");
      if (opens && at + 1 < ran.length && when >= second(ran[at + 1]!.startedAt)!) at++;
      else {
        while (at + 1 < ran.length) {
          const next = second(ran[at + 1]!.startedAt)!;
          const ended = second(ran[at]!.finishedAt) ?? next;
          if (when >= next + 1000 && when >= ended + 1000) at++;
          else break;
        }
      }
    }
    bodies[at]!.push(body);
  }
  return {
    text: out.join("\n"),
    steps: ran.map((step, i) => ({ number: step.number, name: step.name, text: bodies[i]!.join("\n") })).filter((step) => step.text.length > 0),
  };
}

/**
 * The machine, from a cleaned log's head: GitLab's "Running with gitlab-runner …" and "Using … executor
 * with image …"; GitHub's "Current runner version: '…'" and its VM Image group (or, from older runners,
 * its Operating System and Runner Image groups).
 */
export function machineFromLog(clean: string): CiMachine {
  const machine: CiMachine = {};
  let group = "";
  for (const line of clean.split("\n").slice(0, 400)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("##[group]")) {
      group = trimmed.slice("##[group]".length);
      continue;
    }
    if (trimmed === "##[endgroup]") {
      group = "";
      continue;
    }
    let m: RegExpExecArray | null;
    if ((m = /^Running with gitlab-runner (\S+)/.exec(trimmed)) !== null) machine.runnerVersion ??= m[1]!;
    else if ((m = /^Current runner version: '([^']+)'/.exec(trimmed)) !== null) machine.runnerVersion ??= m[1]!;
    else if ((m = /^Using (.+?) executor with image (\S+)/.exec(trimmed)) !== null) {
      machine.executor ??= m[1]!;
      machine.image ??= m[2]!;
    } else if ((m = /^Preparing the "([^"]+)" executor/.exec(trimmed)) !== null) machine.executor ??= m[1]!;
    else if (group === "VM Image") {
      if ((m = /^- OS: (.+)$/.exec(trimmed)) !== null) machine.os ??= m[1]!;
      else if ((m = /^- Name: (.+)$/.exec(trimmed)) !== null) machine.image ??= m[1]!;
      else if ((m = /^- Version: (.+)$/.exec(trimmed)) !== null) machine.imageVersion ??= m[1]!;
    } else if (group === "Operating System" && trimmed.length > 0) machine.os = machine.os === undefined ? trimmed : `${machine.os} ${trimmed}`;
    else if (group === "Runner Image") {
      if ((m = /^Image: (.+)$/.exec(trimmed)) !== null) machine.image ??= m[1]!;
      else if ((m = /^Version: (.+)$/.exec(trimmed)) !== null) machine.imageVersion ??= m[1]!;
    }
  }
  return machine;
}
