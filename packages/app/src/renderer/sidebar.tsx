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
 * of one. **Clicking a row goes there and shows what is in it — always, and never the reverse.**
 *
 * There is no fold and no caret. A drawer is open exactly while its view is the one selected, and
 * the way to close it is to select another — which is the only thing a person is saying when they
 * click a row. Anything else gives two ways to hide one thing; and because a fold is remembered, it
 * gave a column that could open with the tree of the view you were on already gone.
 *
 * A row also carries its own VERBS ({@link SidebarAct}) — new conversation, find — as glyphs at its
 * trailing end. They were the top two lines of the drawer, which is one fold away from the row that
 * names them and a line of the column each, whether or not anybody was searching.
 *
 * COLLAPSED it is a rail of {@link SIDEBAR_RAIL} pixels, in two zones — see {@link Sidebar}.
 * Deliberately not "gone": every view in the app is reached from this column, so a sidebar that
 * closed to nothing would be a sidebar you had to reopen before you could do anything, and the
 * button to reopen it would be the only thing on screen that still worked.
 */
import { Fragment, useState, type CSSProperties, type JSX, type ReactNode } from "react";
import { ContextMenu, type MenuAnchor } from "./menu";
import { Pills, type PillCounts } from "./pill";
import { parentName } from "./projects";

/**
 * One thing a row can DO, drawn as a glyph inside it.
 *
 * A view row is a place, and every place has one or two verbs that belong to it and nowhere else —
 * "start a conversation" is only ever about Chat, "find a file" is only ever about Files. Those used
 * to live at the top of the drawer, which put them one fold away from the row that names them and
 * cost a line of the column each: the search box was on screen whether or not anybody was searching.
 *
 * On the ROW, they are reachable without opening the drawer at all, and a click on one means the
 * verb rather than "go there and then look for the button".
 */
export interface SidebarAct {
  id: string;
  glyph: string;
  /** What it does, as a sentence — the tooltip and the accessible name. */
  label: string;
  /** Whether it is currently ON, for the ones that toggle something in the drawer (search). */
  on?: boolean;
  onAct: () => void;
}

/** One row of the view switcher, and whatever it opens onto. */
export interface SidebarView {
  id: string;
  glyph: string;
  label: string;
  /**
   * What this view browses, shown under the row while the view is the one showing.
   *
   * Absent ⇒ the row is a plain switch. Tasks and Logs have nothing to list here: their content IS
   * the view.
   *
   * There is NO fold. A drawer is shown exactly while its view is the one selected, and hidden by
   * selecting another — which is the only state a person is expressing when they click a row. A
   * caret on top of that gave two ways to hide one thing and one of them was remembered, so a
   * column could open with the tree of the view you were on already gone.
   */
  panel?: ReactNode;
  /** This row's own verbs — see {@link SidebarAct}. Drawn only while the column has width for them. */
  acts?: readonly SidebarAct[];
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
  /**
   * The colour that stands for this project, as a CSS variable reference — see `hueOf`.
   *
   * One hue, four places: the dot on this row, this project's tile in the collapsed rail, the head
   * crumb of the address bar, and its chip on the inbox strip. It is how "this row, that crumb and
   * that pending approval are the same project" is answered without reading three directory names.
   */
  hue: string;
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
 * The same, on the project row that is OPEN — which has one more thing to say and no more width.
 *
 * Narrower on purpose. While a project is open, the two rows directly beneath it carry its counts
 * split by room (see SHELL.md §4.3), so this row is the only place in the column saying WHERE the
 * project is and the third place saying how much is in it. `running` still heads the order, so what
 * a tighter budget costs is the tail of the fold and never the fact that something is working.
 */
const OPEN_PILL_BUDGET = 62;

/** What one of a row's own verbs costs the pills, in px — see {@link SidebarAct}. */
const ACT_WIDTH = 20;



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
  roots,
  footer,
  settings,
  onLeaveSettings,
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
  /**
   * The rows that stand at the ROOT of the address — every project's work at once.
   *
   * Above the projects rather than beside or below them, because that is the reading order the
   * address has: the root is above the things inside it, and "all tasks" is the level "this
   * project's tasks" is one step down from. They select a view AND put the address at the root,
   * which is one gesture because they are one place.
   */
  roots: readonly SidebarView[];
  /** The rows that belong to no project — Logs and Debug. */
  footer: readonly SidebarView[];
  /**
   * The row pinned to the very bottom — until it is the view you are on, when it goes to the top.
   *
   * Same shape as the rest: it has a drawer, and it has counts nowhere, and it is drawn by the same
   * function. Where it SITS is the only thing about it that moves — see the lifted row below.
   */
  settings: SidebarView;
  /**
   * The way out of Settings, and back to whatever the window was showing before it.
   *
   * Settings is the one view that is not a place in the address: you go into it FROM somewhere, and
   * the thing a person wants afterwards is that somewhere back. Which view that was is the shell's
   * to remember — this column only has to offer the door.
   */
  onLeaveSettings: () => void;
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
  /**
   * One nav row.
   *
   * `scope` is which address the row belongs to, and it is what makes "Tasks" at the root and
   * "Tasks" inside a project two different rows rather than one drawn twice: they carry the same
   * view id, and only where the address is standing tells them apart.
   *
   * The row is a DIV holding a button, rather than one button, and that is forced rather than
   * chosen: a row now carries its own verbs and its own twisty, and a `<button>` inside a
   * `<button>` is not markup a browser will keep — Chrome breaks the inner one out of the outer and
   * the row lays itself out twice. The clickable area is `.side-hit`, which is everything up to the
   * first control, so the row still behaves as one target where nothing else is drawn.
   */
  const rowOf = (
    v: SidebarView,
    nested: boolean,
    scope: "root" | "project" | "any" = "any",
    /**
     * What this row is, when it is not simply a row in the column.
     *
     * `back` makes it the header of the settings panel: it grows a `‹`, and its body means "out"
     * rather than "here", because you are already here. `expand` is the rail's ⚙ — there is no room
     * for a panel at 46px, so the click opens the column and the panel opens with it, rather than
     * switching to a view whose navigation cannot be drawn.
     */
    mode?: { back?: () => void; expand?: () => void },
  ): JSX.Element => {
    const inScope = scope === "any" || (scope === "root") === (at === null);
    const here = view === v.id && inScope;
    // A drawer belongs to the view it is under, so it is only ever open on the view you are on —
    // and never at all while the column is a strip of glyphs with no room for it.
    // Shown while this is the view, and never otherwise. That is the whole rule — see `panel`.
    const drawer = v.panel !== undefined && here && !collapsed;
    const acts = collapsed ? [] : (v.acts ?? []);
    return (
      <Fragment key={v.id}>
        <div className={`side-row${nested ? " side-nested" : ""}${here ? " on is-active" : ""}`}>
          {/* Back, on a LIFTED row: the row moved to the top of the column and this is the way out
              of it (SHELL.md §5.1). Left of the name rather than at the far end, because it undoes
              the thing the name is announcing and reads in that order. */}
          {mode?.back !== undefined ? (
            <button className="side-back" title="back to where you were" aria-label="Back" onClick={mode.back}>
              ‹
            </button>
          ) : null}
          <button
            className="side-hit"
            title={v.label}
            aria-label={v.label}
            aria-current={here ? "page" : undefined}
            onClick={() => {
              // The panel's header is where you already are, so the only move left in it is out —
              // the same click the arrow beside it makes.
              if (mode?.back !== undefined) return mode.back();
              // The rail's ⚙: open the column, and the panel opens in it.
              mode?.expand?.();
              // A root row goes to the root FIRST — the view means a different thing there — and a
              // nested one is already inside the project it is drawn in.
              if (scope === "root" && at !== null) onProject(null);
              // GOING somewhere shows what is there — always, and nothing else this row can be
              // clicked for. The drawer follows the selection and has no state of its own.
              onView(v.id);
            }}
          >
            <span className="side-glyph">{v.glyph}</span>
            {/* One register for every nav row, footer included — they are one control, and this
                function renders all of them. `app-label` is for a heading over a group, and a view
                row is exactly that: the tree under Files is what it heads. */}
            <span className="side-label ellip app-label">{v.label}</span>
          </button>
          {acts.map((act) => (
            <button
              key={act.id}
              className={`side-act${act.on === true ? " on" : ""}`}
              title={act.label}
              aria-label={act.label}
              aria-pressed={act.on}
              onClick={act.onAct}
            >
              {act.glyph}
            </button>
          ))}
          {v.counts !== undefined && !collapsed ? (
            <Pills counts={v.counts} budget={ROW_PILL_BUDGET - acts.length * ACT_WIDTH} onClear={v.onSeen} />
          ) : null}
        </div>
        {drawer ? <div className="side-drawer">{v.panel}</div> : null}
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
        <div className={`side-section${open ? " open" : ""}`} style={{ "--hue": p.hue } as CSSProperties}>
          <div className="side-row side-project-row">
            <button
              className="side-hit"
              title={p.project}
              aria-expanded={open}
              // Clicking a project puts the address on it, which is what expands it. Clicking the
              // one you are on goes back to the root — there is no second gesture for "close",
              // because being closed is just not being where the address is.
              onClick={() => onProject(open ? null : p.project)}
            >
              {/* The hue, as a mark BESIDE the name rather than on it. The name is data and
                  recolouring it would be the one thing state may not do to a voice. */}
              <i className="side-dot" />
              <span className="side-label side-name">
                <span className={`ellip ${open ? "data-title" : "data-secondary"}`}>{p.label}</span>
                {/* Where it is, BESIDE what it is called rather than under it — one row per project,
                    however much it has to say. Only on the open one: a path against four names is a
                    column of paths, and only one of them is the one you are working in. It yields
                    the width first (`flex: 0 1 auto` against the name's `flex: none`), because the
                    name is the answer and this is the qualifier. */}
                {open ? <span className="side-where ellip data-faint">{parentName(p.project)}</span> : null}
              </span>
            </button>
            <Pills counts={p.counts} budget={open ? OPEN_PILL_BUDGET : ROW_PILL_BUDGET} onClear={p.onSeen} />
            {open ? null : <span className="side-twist is-mark">▸</span>}
          </div>
          {open ? <div className="side-views">{views.map((v) => rowOf(v, true, "project"))}</div> : null}
        </div>
      </Fragment>
    );
  };

  /** Light or dark, as a row. Drawn in the panel when the column is open, in the rail when it is not. */
  const themeRow = (
    <button
      className="side-row side-theme"
      title={theme === "dark" ? "switch to light" : "switch to dark"}
      aria-label="Toggle theme"
      onClick={() => onTheme(theme === "dark" ? "light" : "dark")}
    >
      <span className="side-glyph">{theme === "dark" ? "☀" : "☾"}</span>
      <span className="side-label ellip app-label">{theme === "dark" ? "Light" : "Dark"}</span>
    </button>
  );

  /**
   * Settings, while you are IN it: a full-height panel OVER the column, headed by its own row.
   *
   * It is pinned to the foot because it belongs to no project — true, and the reason it starts
   * there. But the foot is also where the column runs out of room, so opening it as an accordion put
   * its section list in the two inches between the last project and the bottom of the window, with
   * the whole of the navigation it had just been left for still stacked above it.
   *
   * A panel rather than a taller accordion, because Settings is not a place in the address: you are
   * not in a project while you are in it, so the column has nothing to be showing underneath. The
   * row becomes the panel's header, the `‹` beside it is the way out, and everything that belongs to
   * no project — the sections, Logs, Debug, the theme — is in here with it. That is the whole of
   * "not part of your work", in one place, instead of four rows competing with the projects for the
   * bottom of the column.
   *
   * Only while the column has width for it: in the rail there is no room for a panel, so ⚙ opens the
   * column first (see the rail's own footer).
   */
  const settingsPanel = view === "settings" && !collapsed;

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
          {/* The root's own glyphs, above the tiles — the same order the expanded column has. */}
          <div className="rail-views">{roots.map((v) => rowOf(v, false, "root"))}</div>
          <div className="rail-split" />
          <div className="rail-projects">
            {projects.map((p) => (
              <button
                key={p.project}
                className={`rail-tile${p.project === at ? " on" : ""}`}
                title={p.project}
                aria-current={p.project === at ? "true" : undefined}
                style={{ "--hue": p.hue } as CSSProperties}
                onClick={() => onProject(p.project === at ? null : p.project)}
              >
                {/* Two letters, in the data voice: they stand for a directory name, and a rail is
                    still showing you that name rather than a word JaiRA chose. Two rather than one
                    because one cannot tell `notes-api` from `nginx`. */}
                <span className="side-glyph">{p.label.replace(/[^a-z0-9]/gi, "").slice(0, 2).toLowerCase() || "·"}</span>
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
          {/* The root, above the things inside it. It takes no hue and no dot: there is no project
              for a colour to be OF, which is the same fact "All projects" states in the crumb. */}
          <div className="side-roots">{roots.map((v) => rowOf(v, false, "root"))}</div>
          {projects.map(projectRow)}
          <OpenAnother busy={busy} onChooseProject={onChooseProject} />
        </div>
      )}

      {/*
        The foot, which is now one row wide open and four in the rail.

        Logs, Debug and the theme moved INTO the settings panel: they belong to no project, which is
        the whole of what they have in common with Settings, and four rows saying so at the bottom of
        the column were four rows the projects were competing with. The rail keeps them, because
        there is no panel at 46px to put them in — and losing them there would leave a mode of the
        window with no way to reach the log.
      */}
      <div className="side-foot">
        {collapsed ? footer.map((v) => rowOf(v, false)) : null}
        {collapsed ? themeRow : null}
        {/* Not drawn while the panel is: the panel's header IS this row, and the second copy under
            it would be a row that cannot be seen and cannot be reached. */}
        {settingsPanel ? null : rowOf(settings, false, "any", collapsed ? { expand: () => onCollapsed(false) } : undefined)}
      </div>

      {settingsPanel ? (
        <div className="side-panel">
          {rowOf(settings, false, "any", { back: onLeaveSettings })}
          <div className="side-panel-rest">
            {footer.map((v) => rowOf(v, false))}
            {themeRow}
          </div>
        </div>
      ) : null}
    </nav>
  );
}
