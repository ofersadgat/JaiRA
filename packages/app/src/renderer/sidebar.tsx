/**
 * The one left column (DESIGN §11.1, restructured by SHELL.md §5.1).
 *
 * The window used to open with two left edges: a 46px strip of glyphs for switching views, and then
 * — in the two views that had one — a second column for the thing being browsed, the file tree in
 * Files and the section list in Settings. Two columns to say one thing ("where am I, and in what"),
 * each with its own width to drag, each stopping short of the top of the window because a title bar
 * was sitting there.
 *
 * This is both of them, and now it is PROJECTS OVER VIEWS. Top to bottom:
 *
 *  - the **title row**, which starts at y=0 because the frame no longer does (see `main/index.ts`).
 *    It carries the collapse button and the app's name, and it is the window's drag handle — the
 *    only one on this side, which is why nothing else may be put in it.
 *  - the **projects**, each a row. The one the address is standing on is expanded, and the views —
 *    Files, Tasks, Chat — are nested inside it. That is the only arrangement that reads in the same
 *    order as the address bar: project first, then room, then what is in the room.
 *  - the **footer**: Logs, Debug, theme and Settings, kept at the bottom edge because none of them
 *    belongs to a project.
 *
 * **Exactly one project is expanded, and it is derived from the address rather than stored.** The
 * precedent is `uiState.ts`, where `SHUT.folders` is deliberately keyed per LAYER and not per
 * checkout, because the alternative "grows without bound as projects come and go, to remember
 * something about a folder in a project that is not open". Storing which project is open re-invents
 * the mode the address was meant to retire, and gives the window two answers to "where am I".
 *
 * A row that has something to browse IS the accordion for it — the file tree opens under **Files**,
 * the sections under **Settings**. Not a separate headed section further down the column: that put
 * the word "Files" on the screen twice, once as the button that goes there and once as the heading
 * over what it holds, and left the tree looking like a thing beside the views rather than the inside
 * of one. Clicking a row you are not on goes there and opens it; clicking the row you are on folds
 * it, which is the only meaning left for that click.
 *
 * COLLAPSED it is a rail of {@link SIDEBAR_RAIL} pixels, in two zones — see {@link Sidebar}.
 * Deliberately not "gone": every view in the app is reached from this column, so a sidebar that
 * closed to nothing would be a sidebar you had to reopen before you could do anything, and the
 * button to reopen it would be the only thing on screen that still worked.
 */
import { Fragment, useState, type JSX, type ReactNode } from "react";
import { ContextMenu, type MenuAnchor } from "./menu";
import { Pills, type PillCounts } from "./pill";

/** One row of the view switcher, and whatever it opens onto. */
export interface SidebarView {
  id: string;
  glyph: string;
  label: string;
  /**
   * What this view browses, shown under the row while the view is the one showing.
   *
   * Absent ⇒ the row is a plain switch. Tasks and Logs have nothing to list here: their content IS
   * the view, and a twisty over an empty drawer is worse than no twisty.
   */
  panel?: ReactNode;
  /** Whether that drawer is open, and how to toggle it. Only read when `panel` is set. */
  open?: boolean;
  onOpen?: (open: boolean) => void;
  /** What this view has waiting in the open project — see SHELL.md §4.3. */
  counts?: PillCounts;
  /** Marking this view's share seen, which is what clears its status pills. */
  onSeen?: () => void;
}

/** One project the window can stand on. */
export interface SidebarProject {
  /** The directory — what every project-scoped call names. */
  project: string;
  /** Its basename, or the role name for the two that have one. */
  label: string;
  kind: "user" | "shared" | "system";
  counts: PillCounts;
  onSeen?: () => void;
}

/**
 * How much room a row's trailing end can spare for pills.
 *
 * Narrower than the bar's, because a project name is data and must not be truncated to make room
 * for a count of it. `running` heads the priority order, so what a tight budget costs is the tail of
 * the fold and never the fact that something is working (SHELL.md §4.2).
 */
const ROW_PILL_BUDGET = 96;

/**
 * The way to a project that is not open, and the two ways to make one.
 *
 * A row of the project list rather than a control beside it: "open another" is a sibling of the
 * projects it would join, and a button in the title row would be a second place to go somewhere.
 */
function OpenAnother({ busy, onChooseProject }: { busy: boolean; onChooseProject: (mode: "open" | "init") => void }): JSX.Element {
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  return (
    <>
      <button
        className="side-row side-open"
        title="open another project"
        disabled={busy}
        aria-haspopup="menu"
        onClick={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          setMenu({
            x: box.left,
            y: box.bottom + 4,
            items: [
              { label: "Open project…", onSelect: () => onChooseProject("open") },
              { label: "New project…", onSelect: () => onChooseProject("init") },
            ],
          });
        }}
      >
        <span className="side-glyph">+</span>
        <span className="side-label ellip app-secondary">Open a project…</span>
      </button>
      {menu ? <ContextMenu anchor={menu} onClose={() => setMenu(null)} /> : null}
    </>
  );
}

export function Sidebar({
  views,
  footer,
  settings,
  view,
  onView,
  collapsed,
  onCollapsed,
  projects,
  at,
  onProject,
  busy,
  theme,
  onTheme,
  onChooseProject,
}: {
  /** The rows nested under the OPEN project. Empty when the address is standing at the root. */
  views: readonly SidebarView[];
  /** The rows that belong to no project — Logs and Debug. */
  footer: readonly SidebarView[];
  /** The row pinned to the very bottom. Same shape as the rest — it has a drawer too. */
  settings: SidebarView;
  /** The id of the view showing. */
  view: string;
  onView: (id: string) => void;
  collapsed: boolean;
  onCollapsed: (collapsed: boolean) => void;
  projects: readonly SidebarProject[];
  /**
   * The project the address is standing on, and therefore the one expanded.
   *
   * Null is the ROOT — "all projects", which is a real place: no project is expanded, and the views
   * are not shown because there is nothing yet for them to be views OF.
   */
  at: string | null;
  onProject: (project: string | null) => void;
  busy: boolean;
  theme: "light" | "dark";
  onTheme: (theme: "light" | "dark") => void;
  onChooseProject: (mode: "open" | "init") => void;
}): JSX.Element {
  const rowOf = (v: SidebarView, nested: boolean): JSX.Element => {
    const here = view === v.id;
    // A drawer belongs to the view it is under, so it is only ever open on the view you are on —
    // and never at all while the column is a strip of glyphs with no room for it.
    const drawer = v.panel !== undefined && here && !collapsed;
    const open = drawer && (v.open ?? true);
    return (
      <Fragment key={v.id}>
        <button
          className={`side-row${nested ? " side-nested" : ""}${here ? " on is-active" : ""}`}
          title={v.label}
          aria-label={v.label}
          aria-current={here ? "page" : undefined}
          aria-expanded={drawer ? open : undefined}
          onClick={() => (drawer ? v.onOpen?.(!open) : onView(v.id))}
        >
          <span className="side-glyph">{v.glyph}</span>
          {/* One register for every nav row, footer included — they are one control, and this
              function renders all of them. `app-label` is for a heading over a group, and a view row
              is exactly that: the tree under Files is what it heads. */}
          <span className="side-label ellip app-label">{v.label}</span>
          {v.counts !== undefined && !collapsed ? (
            <Pills counts={v.counts} budget={ROW_PILL_BUDGET} onClear={v.onSeen} />
          ) : null}
          {/* Only on the row that has a drawer, and only where it is showing: a caret on every row
              would promise four drawers and deliver one. */}
          {drawer ? <span className="side-twist">{open ? "▾" : "▸"}</span> : null}
        </button>
        {open ? <div className="side-drawer">{v.panel}</div> : null}
      </Fragment>
    );
  };

  /**
   * One project, and the views nested inside it when it is the one the address is on.
   *
   * The name is DATA — a directory basename, the same string the crumb prints — so it never takes
   * uppercase and never changes face to look selected. What says it is open is its register
   * (`data-title` against `data-secondary`), its twisty, and the band its section sits on.
   */
  const projectRow = (p: SidebarProject): JSX.Element => {
    const open = p.project === at;
    return (
      <Fragment key={p.project}>
        <div className={`side-section${open ? " open" : ""}`}>
          <button
            className="side-row side-project-row"
            title={p.project}
            aria-expanded={open}
            // Clicking a project puts the address on it, which is what expands it. Clicking the one
            // you are on goes back to the root — there is no second gesture for "close", because
            // being closed is just not being where the address is.
            onClick={() => onProject(open ? null : p.project)}
          >
            <span className="side-twist">{open ? "▾" : "▸"}</span>
            <span className={`side-label ellip ${open ? "data-title" : "data-secondary"}`}>{p.label}</span>
            <Pills counts={p.counts} budget={ROW_PILL_BUDGET} onClear={p.onSeen} />
          </button>
          {open ? <div className="side-views">{views.map((v) => rowOf(v, true))}</div> : null}
        </div>
      </Fragment>
    );
  };

  return (
    <nav className={`sidebar${collapsed ? " shut" : ""}`}>
      {/*
        The window's drag handle, and the reason it is this row and not another: with the frame gone
        there is nowhere else to grab. Anything interactive put here has to opt out again with
        `-webkit-app-region: no-drag` (the stylesheet does that for buttons), so a control added here
        without noticing becomes a control that cannot be clicked.

        It also absorbs the inset macOS needs for its traffic lights — see `--wco-left`.
      */}
      <div className="side-title">
        <button
          className="side-toggle"
          title={collapsed ? "show the sidebar" : "hide the sidebar"}
          aria-label={collapsed ? "Show the sidebar" : "Hide the sidebar"}
          aria-expanded={!collapsed}
          onClick={() => onCollapsed(!collapsed)}
        >
          {collapsed ? "▸|" : "|◂"}
        </button>
        {collapsed ? null : <span className="side-brand app-label">JAIRA</span>}
      </div>

      {collapsed ? (
        /*
          The rail, in TWO zones: project tiles, a divider, then the open project's view glyphs.

          This used to render `null` in place of the brand and the project name whenever collapsed,
          which with the project as the head of the address made the first crumb invisible AND
          unreachable — you could not tell which project the glyphs below were about, and could not
          change it without reopening the column. Exclusivity is what makes the two zones possible:
          there is always at most one project the rail is on, so the second zone has one subject.
        */
        <div className="side-rail">
          <div className="rail-projects">
            {projects.map((p) => (
              <button
                key={p.project}
                className={`side-row rail-tile${p.project === at ? " on is-active" : ""}`}
                title={p.project}
                aria-current={p.project === at ? "true" : undefined}
                onClick={() => onProject(p.project === at ? null : p.project)}
              >
                {/* The initial, in the data voice: it stands for a directory name, and a rail one
                    character wide is still showing you that name rather than a word JaiRA chose. */}
                <span className="side-glyph data-text">{p.label.slice(0, 1).toLowerCase()}</span>
              </button>
            ))}
          </div>
          {at !== null && views.length > 0 ? (
            <>
              <div className="rail-split" />
              <div className="rail-views">{views.map((v) => rowOf(v, false))}</div>
            </>
          ) : null}
        </div>
      ) : (
        <div className="side-nav">
          {projects.map(projectRow)}
          <OpenAnother busy={busy} onChooseProject={onChooseProject} />
        </div>
      )}

      <div className="side-foot">
        {footer.map((v) => rowOf(v, false))}
        {/* Theme sits here rather than inside Settings: it is a per-person display preference, and
            burying it behind a view that needs an open project would make it unreachable on an empty
            window. */}
        <button
          className="side-row"
          title={theme === "dark" ? "switch to light" : "switch to dark"}
          aria-label="Toggle theme"
          onClick={() => onTheme(theme === "dark" ? "light" : "dark")}
        >
          <span className="side-glyph">{theme === "dark" ? "☀" : "☾"}</span>
          <span className="side-label ellip app-label">{theme === "dark" ? "Light" : "Dark"}</span>
        </button>
        {rowOf(settings, false)}
      </div>
    </nav>
  );
}
