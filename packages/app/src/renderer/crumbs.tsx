/**
 * The address bar, as chrome — the part that is the same wherever a path is drawn.
 *
 * Files and Tasks both answer "where am I" with a path, and they answered it with two different
 * controls: a file explorer bar with chevron menus in one view, and a plainer strip of buttons in
 * the other. The two are the same thing about different hierarchies — a folder path with runs on
 * the end, and a project with a workflow and its levels on the end — so what is shared is everything
 * except which crumbs go in it.
 *
 * This file holds the bar that renders the crumbs; their MODEL is `crumbModel.ts`. Who builds the
 * crumbs is the caller's business: `files.tsx` builds them from the open document, `taskBar.tsx` from the focused project.
 */
import { useState, type CSSProperties, type JSX, type ReactNode } from "react";
import { isAllCrumb, type Crumb } from "./crumbModel";
import { ContextMenu, type MenuAnchor, type MenuItem } from "./menu";

// The model — what a crumb is and how a path's crumbs are built — is `crumbModel.ts`, shared with the
// universal copy; re-exported so the views that build crumbs keep importing them from here.
export { alternatives, runCrumbs, shortRunName, type Crumb, type RunCrumbInput } from "./crumbModel";

/** "All projects" — see {@link isAllCrumb}. */
function allCrumb(crumb: Crumb): string {
  return isAllCrumb(crumb) ? " crumb-all" : "";
}

/**
 * The bar itself: the crumbs, then whatever the view wants at the right-hand end.
 *
 * Clicking the bar's own background is the caller's to define — in Files it puts the inspector back
 * on the open file — which is why every crumb and every tool stops the click from propagating.
 */
export function CrumbBar({
  crumbs,
  title,
  onClick,
  trailing,
  tools,
}: {
  crumbs: readonly Crumb[];
  title?: string;
  /** What clicking the bar's background means. Absent ⇒ nothing, and the bar is not a button. */
  onClick?: (() => void) | undefined;
  /** Read-only annotations after the path: a label, an error count. Not controls. */
  trailing?: ReactNode;
  /** Controls: a mode toggle, a New button. Clicks here never reach {@link onClick}. */
  tools?: ReactNode;
}): JSX.Element {
  // Which chevron is open, so the same click closes it and the glyph can turn to face down.
  const [menu, setMenu] = useState<(MenuAnchor & { at: number }) | null>(null);
  return (
    <header
      className={`doc-bar${onClick === undefined ? " inert" : ""}`}
      {...(onClick !== undefined ? { onClick } : {})}
      {...(title !== undefined ? { title } : {})}
    >
      {crumbs.map((crumb, i) => (
        <span
          key={`${i}:${crumb.kind}:${crumb.text}`}
          className="crumb-part"
          {...(crumb.hue !== undefined ? { style: { "--hue": crumb.hue } as CSSProperties } : {})}
        >
          {/* The separator is the join between two levels, so it is where "what ELSE is at this
              level" belongs — Explorer's move, and the reason it turns to face down when open. A
              level with no alternatives keeps a plain glyph rather than an empty menu. */}
          {crumb.options === undefined ? (
            // The root has nothing to its left, so its chevron would be a separator between the bar
            // and the window. It keeps the menu and loses the glyph.
            i === 0 ? null : <span className="crumb-sep">›</span>
          ) : (
            <button
              className={`crumb-sep${menu?.at === i ? " open" : ""}${i === 0 ? " first" : ""}`}
              title="what else is at this level"
              aria-haspopup="menu"
              onClick={(e) => {
                e.stopPropagation();
                const box = e.currentTarget.getBoundingClientRect();
                setMenu(menu?.at === i ? null : { at: i, x: box.left, y: box.bottom + 2, items: crumb.options! });
              }}
            >
              {menu?.at === i ? "⌄" : "›"}
            </button>
          )}
          {crumb.go === undefined ? (
            <span
              className={`crumb crumb-${crumb.kind}${allCrumb(crumb)}${crumb.pending === true ? " crumb-pending" : ""} ${i === crumbs.length - 1 ? "last" : "inert"}`}
              title={crumb.title}
            >
              {crumb.text}
            </span>
          ) : (
            <button
              className={`crumb crumb-${crumb.kind}${allCrumb(crumb)}${crumb.pending === true ? " crumb-pending" : ""}`}
              title={crumb.title ?? (crumb.kind === "run" ? "back to this run" : "open this state")}
              onClick={(e) => {
                e.stopPropagation();
                crumb.go?.();
              }}
            >
              {crumb.text}
            </button>
          )}
        </span>
      ))}
      <span className="grow" />
      {trailing}
      {/* Controls, not navigation: the bar's own click means "describe this file", and a toggle that
          also did that would be a toggle you cannot press without a side effect. */}
      {tools !== undefined ? (
        <span className="doc-bar-tools" onClick={(e) => e.stopPropagation()}>
          {tools}
        </span>
      ) : null}
      {menu !== null ? <ContextMenu anchor={menu} onClose={() => setMenu(null)} /> : null}
    </header>
  );
}

export type { MenuItem };
