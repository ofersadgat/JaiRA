/**
 * Lint paths, and the form controls that answer for them.
 *
 * A `LintIssue.path` is written in the document's own vocabulary — `outputs.report`,
 * `children.critique.inputs.issue`, `transitions[2].when`, `operation.input.prompt`. The inspector
 * has always shown that string; what it could not do was take you to the control that produced it,
 * so reading a diagnostic meant translating a path into a scroll position by eye.
 *
 * This module is the translation, and it is deliberately one small vocabulary rather than a lookup
 * table per surface:
 *
 *  - a control declares which path it answers for, in a `data-issue` attribute ({@link ISSUE_ATTR});
 *  - {@link covers} decides whether an anchor answers for an issue, on SEGMENT boundaries, so
 *    `inputs.a` never claims `inputs.ab` while `outputs` still claims `outputs.report.kind`;
 *  - {@link anchorFor} picks the most specific anchor present, so a row wins over the table holding
 *    it and the table still catches an issue no row declares.
 *
 * Nothing here is React. The marking (a red outline) and the revealing (scroll, then flash) both
 * read from the same functions, which is what keeps "outlined" and "scrolled to" the same element.
 */
import type { LintIssue, LintSeverity } from "@jaira/shared/browser";

/** The attribute a control declares its path in. Space-separated when one control answers for two. */
export const ISSUE_ATTR = "data-issue";

/** How long a revealed control stays flashed. Long enough to find it, short enough not to nag. */
export const FLASH_MS = 1000;

/**
 * True when `anchor` names `path` or anything inside it.
 *
 * The boundary check is the whole function. Plain `startsWith` would let `inputs.a` claim
 * `inputs.abbrev` — the same class of bug as a prefix match on a directory name — so a longer path
 * must continue with a separator: `.` for a key, `[` for an index.
 */
export function covers(anchor: string, path: string): boolean {
  if (anchor.length === 0) return false;
  if (anchor === path) return true;
  if (!path.startsWith(anchor)) return false;
  const next = path[anchor.length];
  return next === "." || next === "[";
}

/** What the form knows about one state's diagnostics, asked one control at a time. */
export interface FormIssues {
  /** Every issue at or under `path`, errors first. */
  at: (path: string) => LintIssue[];
  /** True when there is nothing to mark anywhere. */
  empty: boolean;
}

/** Errors before warnings. The first of a list decides its outline, so the order is load-bearing. */
function worstFirst(a: LintIssue, b: LintIssue): number {
  return a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1;
}

/**
 * Index one state's issues for the form.
 *
 * Duplicates are dropped on the way in: a state reachable from two roots is linted once per root, so
 * the same (path, message) can arrive twice, and a tooltip that says everything twice reads as two
 * problems.
 */
export function formIssues(issues: readonly LintIssue[]): FormIssues {
  const seen = new Set<string>();
  const unique: LintIssue[] = [];
  for (const issue of issues) {
    const key = `${issue.severity}\u0000${issue.path}\u0000${issue.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(issue);
  }
  // Errors before warnings, so the worst thing under a control is the first line of its tooltip and
  // the colour of its box.
  const ordered = [...unique].sort(worstFirst);
  return {
    empty: ordered.length === 0,
    at: (path) => ordered.filter((issue) => covers(path, issue.path)),
  };
}

/** An index over no issues — the default wherever a form is rendered with nothing linted. */
export const NO_ISSUES: FormIssues = formIssues([]);

/**
 * The class the BOX holding a bad value wears.
 *
 * A leading space, so it appends to an existing `className` without one more template literal at
 * every call site. The worst severity decides, which is why {@link formIssues} orders them.
 *
 * The mark goes on the input, never on the row or the table around it. A container outline says "one
 * of these five boxes is wrong" and leaves the reader to work out which; it also collides with the
 * file tree, which has its own `has-error` for a file that does not lint. `issue-bad` is a red
 * border on the box itself — the same language `.unwired` and `.link-input.unresolved` already
 * speak, one field further along.
 */
export function classOf(list: readonly LintIssue[]): string {
  const severity: LintSeverity | undefined = list[0]?.severity;
  return severity === undefined ? "" : severity === "error" ? " issue-bad" : " issue-warn";
}

/**
 * The class for one input, given the path it holds.
 *
 * `inner` excludes what a NEIGHBOURING box owns — a slot's binding box takes everything reported
 * against the slot except `<slot>.kind`, which the type picker beside it answers for. Without that
 * the two boxes would both light up for one diagnostic and neither would be the answer.
 */
export function fieldClass(issues: FormIssues, path: string, inner: readonly string[] = []): string {
  return classOf(issues.at(path).filter((issue) => !inner.some((child) => covers(child, issue.path))));
}

/** The tooltip, or `undefined` — never an empty string, which renders as a blank tip. */
export function titleOf(list: readonly LintIssue[]): string | undefined {
  return list.length === 0 ? undefined : list.map((issue) => issue.message).join("\n");
}

/** What a container declares: where it is (for the reveal), and what is wrong inside it. */
export interface IssueMark {
  className: string;
  title?: string | undefined;
  [ISSUE_ATTR]: string;
}

/**
 * What a row, table or block declares, ready to spread onto the element.
 *
 * A container is the SCROLL TARGET and the tooltip; it is not marked in colour — see
 * {@link classOf}. Scrolling to a row and flashing it is the right granularity for "where is this?",
 * because a 20px input in the middle of a scrolled panel is a poor thing to centre on and a poor
 * thing to find. Which box is wrong is then said by the box.
 */
export function markFor(
  issues: FormIssues,
  path: string | readonly string[],
  base: string,
): IssueMark {
  // More than one path where a control is genuinely the editor for two parts of the document: the
  // children table holds `children` and, in its spine checkboxes, `sequence`.
  const anchors = typeof path === "string" ? [path] : path;
  const mine = [...new Set(anchors.flatMap((anchor) => issues.at(anchor)))].sort(worstFirst);
  return { className: base, title: titleOf(mine), [ISSUE_ATTR]: anchors.join(" ") };
}

/**
 * The element in `root` that best answers for `path`.
 *
 * Most specific wins: with both `outputs` and `outputs.report` declared, an issue on
 * `outputs.report.kind` reveals the row rather than the table. With only `outputs` declared it
 * reveals the table — which is the honest answer for a diagnostic the form has no finer control for,
 * and better than revealing nothing.
 */
export function anchorFor(root: ParentNode, path: string): HTMLElement | null {
  let best: HTMLElement | null = null;
  let length = -1;
  for (const element of root.querySelectorAll<HTMLElement>(`[${ISSUE_ATTR}]`)) {
    for (const anchor of (element.getAttribute(ISSUE_ATTR) ?? "").split(" ")) {
      if (!covers(anchor, path) || anchor.length <= length) continue;
      best = element;
      length = anchor.length;
    }
  }
  return best;
}
