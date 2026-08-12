/**
 * The one left column (DESIGN §11.1).
 *
 * The window used to open with two left edges: a 46px strip of glyphs for switching views, and then
 * — in the two views that had one — a second column for the thing being browsed, the file tree in
 * Files and the section list in Settings. Two columns to say one thing ("where am I, and in what"),
 * each with its own width to drag, each stopping short of the top of the window because a title bar
 * was sitting there.
 *
 * This is both of them. Top to bottom:
 *
 *  - the **title row**, which starts at y=0 because the frame no longer does (see `main/index.ts`).
 *    It carries the collapse button, the app's name and the open project's, and it is the window's
 *    drag handle — the only one on this side, which is why nothing else may be put in it.
 *  - the **views**, as rows rather than as a rail. A glyph with its name beside it is the same
 *    control the rail had, minus having to learn what `⌁` meant.
 *  - the **footer**: theme and Settings, kept at the bottom edge because neither is navigation.
 *
 * A row that has something to browse IS the accordion for it — the file tree opens under **Files**,
 * the sections under **Settings**. Not a separate headed section further down the column: that put
 * the word "Files" on the screen twice, once as the button that goes there and once as the heading
 * over what it holds, and left the tree looking like a thing beside the views rather than the inside
 * of one. Clicking a row you are not on goes there and opens it; clicking the row you are on folds
 * it, which is the only meaning left for that click.
 *
 * COLLAPSED it is the old rail again — glyphs only, in {@link SIDEBAR_RAIL} pixels. Deliberately not
 * "gone": every view in the app is reached from this column, so a sidebar that closed to nothing
 * would be a sidebar you had to reopen before you could do anything, and the button to reopen it
 * would be the only thing on screen that still worked.
 */
import { Fragment, useState, type JSX, type ReactNode } from "react";
import { ContextMenu, type MenuAnchor } from "./menu";

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
}

/**
 * Which project this window is on, and the two ways to change it.
 *
 * It sits in the title row beside the app's name rather than on a line of its own, because it is
 * part of the window's identity and not a place to navigate to — the address of what is OPEN is at
 * the top of the window, where an address bar belongs.
 */
function ProjectName({
  project,
  projectLabel,
  busy,
  onChooseProject,
}: {
  project: string | null;
  projectLabel: string;
  busy: boolean;
  onChooseProject: (mode: "open" | "init") => void;
}): JSX.Element {
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  return (
    <>
      <button
        className={`side-project ellip${project === null ? " none" : ""}`}
        title={project ?? "no project open"}
        aria-haspopup="menu"
        disabled={busy}
        onClick={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          setMenu({
            x: box.left,
            y: box.bottom + 4,
            items: [
              { label: "Open project…", onSelect: () => onChooseProject("open") },
              { label: "New project…", onSelect: () => onChooseProject("init") },
              ...(project === null
                ? []
                : [
                    {
                      label: "Copy path",
                      separator: true,
                      onSelect: () => void navigator.clipboard?.writeText(project),
                    },
                  ]),
            ],
          });
        }}
      >
        {project === null ? "open a project…" : projectLabel}
      </button>
      {menu ? <ContextMenu anchor={menu} onClose={() => setMenu(null)} /> : null}
    </>
  );
}

export function Sidebar({
  views,
  settings,
  view,
  onView,
  collapsed,
  onCollapsed,
  project,
  projectLabel,
  busy,
  theme,
  onTheme,
  onChooseProject,
}: {
  views: readonly SidebarView[];
  /** The row pinned to the footer. Same shape as the rest — it has a drawer too. */
  settings: SidebarView;
  /** The id of the view showing. */
  view: string;
  onView: (id: string) => void;
  collapsed: boolean;
  onCollapsed: (collapsed: boolean) => void;
  project: string | null;
  projectLabel: string;
  busy: boolean;
  theme: "light" | "dark";
  onTheme: (theme: "light" | "dark") => void;
  onChooseProject: (mode: "open" | "init") => void;
}): JSX.Element {
  const rowOf = (v: SidebarView): JSX.Element => {
    const here = view === v.id;
    // A drawer belongs to the view it is under, so it is only ever open on the view you are on —
    // and never at all while the column is a strip of glyphs with no room for it.
    const drawer = v.panel !== undefined && here && !collapsed;
    const open = drawer && (v.open ?? true);
    return (
      <Fragment key={v.id}>
        <button
          className={`side-row${here ? " on" : ""}`}
          title={v.label}
          aria-label={v.label}
          aria-current={here ? "page" : undefined}
          aria-expanded={drawer ? open : undefined}
          onClick={() => (drawer ? v.onOpen?.(!open) : onView(v.id))}
        >
          <span className="side-glyph">{v.glyph}</span>
          <span className="side-label ellip">{v.label}</span>
          {/* Only on the row that has a drawer, and only where it is showing: a caret on every row
              would promise four drawers and deliver one. */}
          {drawer ? <span className="side-twist">{open ? "▾" : "▸"}</span> : null}
        </button>
        {open ? <div className="side-drawer">{v.panel}</div> : null}
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
        {collapsed ? null : (
          <>
            <span className="side-brand">JAIRA</span>
            <ProjectName
              project={project}
              projectLabel={projectLabel}
              busy={busy}
              onChooseProject={onChooseProject}
            />
          </>
        )}
      </div>

      <div className="side-nav">{views.map(rowOf)}</div>

      <div className="side-foot">
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
          <span className="side-label ellip">{theme === "dark" ? "Light" : "Dark"}</span>
        </button>
        {rowOf(settings)}
      </div>
    </nav>
  );
}
