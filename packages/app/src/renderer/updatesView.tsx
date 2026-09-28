/**
 * The Update, drawn (decision 0011 §4, the person's rulings on round 3 of the mockups, 2026-09-26): the
 * sidebar's row above Settings, and the split button About's Status row carries. Both are one click —
 * download if needed, then Wait + update, which restarts at once when nothing is going — with a
 * chevron at the right end for the other ways ({@link UpdateMenuCard}). What each shows and offers is
 * `updatesModel.ts`'s to decide; this file only draws it.
 *
 * Render functions, placed by their callers: the row by the sidebar's foot, the split button by a
 * settings row, the menu into a {@link Popover} either of them opens.
 */
import { Fragment, type JSX } from "react";
import type { UpdateBusy, UpdateRestartChoice, UpdateState } from "@jaira/shared/browser";
import { Icon } from "./icons";
import { Popover, usePopover, useHover } from "./popover";
import { publishedWords, sidebarUpdateOf, updateMenu, type UpdateMenu } from "./updatesModel";
import { applyUpdate, dismissUpdate, refreshBusy, useUpdate } from "./updatesStore";
import { pressUpdateRow, showsUpdateTip, updateRowTone } from "./updateRow";

/**
 * The menu behind a chevron: what is going in its head, then the choices, the default ticked — the
 * approval card's answer menu, narrower. `onNotes` is the sidebar's Release notes.
 */
export function UpdateMenuCard({ menu, onPick, onNotes }: { menu: UpdateMenu; onPick: (choice: UpdateRestartChoice) => void; onNotes?: () => void }): JSX.Element {
  return (
    <>
      <div className="upd-menu-head">{menu.head}</div>
      {menu.items.map((item) => (
        <Fragment key={item.name}>
          {item.rule === true ? <div className="answer-rule" /> : null}
          <button
            type="button"
            role="menuitem"
            className={item.kind === "choice" && item.on === true ? "on" : undefined}
            onClick={() => (item.kind === "choice" ? onPick(item.choice) : onNotes?.())}
          >
            <span className="cx-tick">{item.kind === "choice" && item.on === true ? "✓" : ""}</span>
            <span className="cx-opt-text">
              <span className="cx-opt-name ellip">{item.name}</span>
              <span className="cx-opt-hint">{item.hint}</span>
            </span>
          </button>
        </Fragment>
      ))}
    </>
  );
}

/**
 * The sidebar's Update row, above Settings — drawn only while there is something to do
 * (`sidebarUpdateOf`). The row is the one click; the × on hover hides the notice until a newer version
 * (the person's ruling: × on hover, and nowhere else); the chevron opens the menu. A failed check or
 * download opens About, with ↻ to try again. Hovering the row shows the full version — a nightly reads
 * just "nightly" on the row.
 *
 * In the collapsed rail it is its glyph alone, and the glyph is the click.
 */
export function SidebarUpdateRow({
  collapsed,
  onOpenAbout,
  onNotes,
  onRetry,
}: {
  collapsed: boolean;
  /** Settings → About, where a failure, a download or a wait is said in full. */
  onOpenAbout: () => void;
  /** Settings → About, with the release notes open. */
  onNotes: () => void;
  onRetry: () => void;
}): JSX.Element | null {
  const { update, busy, queued, restarting } = useUpdate();
  const pop = usePopover<HTMLDivElement>();
  const hover = useHover<HTMLButtonElement>();
  const row = sidebarUpdateOf(update, restarting);
  if (row === null || update === null) return null;
  const next = update.available;

  const click = (): void => pressUpdateRow(row, next, { openUrl: (url) => void window.open(url, "_blank", "noopener"), apply: () => applyUpdate("wait"), onOpenAbout });
  const tone = updateRowTone(row);
  const cls = tone !== undefined ? ` ${tone}` : "";
  const published = publishedWords(next?.releaseDate);

  return (
    <div className={`side-row upd-side${cls}${pop.open ? " open" : ""}`} ref={pop.anchor}>
      <button
        ref={hover.anchor}
        className="side-hit"
        {...hover.bind}
        aria-label={row.title}
        title={collapsed ? row.title : undefined}
        disabled={row.kind === "restarting"}
        onClick={click}
      >
        <span className="side-glyph">{row.glyph}</span>
        <span className="side-label ellip app-label">{row.label}</span>
        {collapsed ? null : row.kind === "downloading" ? (
          <>
            <span className="um-bar um-accent upd-side-bar">
              <i style={{ width: `${row.percent ?? 0}%` }} />
            </span>
            <span className="upd-side-ver">{row.percent ?? 0}%</span>
          </>
        ) : row.version !== undefined ? (
          <span className="upd-side-ver">{row.version}</span>
        ) : null}
      </button>
      {collapsed ? null : (
        <>
          {row.kind === "error" ? (
            <button className="side-act upd-retry" title="Check again" aria-label="Check again" onClick={onRetry}>
              ↻
            </button>
          ) : null}
          {row.dismissible && next !== undefined ? (
            <button
              className="side-act upd-dismiss"
              title="Hide this update until a newer version"
              aria-label="Hide this update until a newer version"
              onClick={() => dismissUpdate(next.version)}
            >
              ×
            </button>
          ) : null}
          {row.menu ? (
            <button
              className={`side-act upd-caret${pop.open ? " on" : ""}`}
              title="Other ways to update"
              aria-label="Other ways to update"
              aria-haspopup="menu"
              aria-expanded={pop.open}
              onClick={() => {
                if (!pop.open) refreshBusy();
                pop.toggle();
              }}
            >
              <Icon name="chevron" />
            </button>
          ) : null}
        </>
      )}
      {pop.open ? (
        <Popover at={pop} side="right" align="start" className="cx-submenu answer-menu upd-menu" role="menu">
          <UpdateMenuCard
            menu={updateMenu(update, busy, "sidebar", queued)}
            onPick={(choice) => {
              pop.close();
              applyUpdate(choice);
            }}
            onNotes={() => {
              pop.close();
              onNotes();
            }}
          />
        </Popover>
      ) : null}
      {/* The full version and when it was published, beside the row — a nightly's row says only
          "nightly". Not over the menu, which says more. */}
      {hover.open && !pop.open && next !== undefined && showsUpdateTip(row, next) ? (
        <Popover anchor={hover.anchor} side="right" align="start" className="upd-tip" role="tooltip">
          <code>{next.version}</code>
          {published !== undefined ? <span>{published}</span> : null}
          <span>
            {row.kind === "manual" ? "Click to open the release page" : row.kind === "downloaded" ? "Click to restart" : "Click to update"} · <b>×</b> hides it until a newer
            version
          </span>
        </Popover>
      ) : null}
    </div>
  );
}

/**
 * About's Update: the app's split button (the approval card's "Allow ▾"), the same one click and the
 * same menu as the sidebar row, less Release notes, which are right under it.
 */
export function UpdateSplit({
  label,
  state,
  busy,
  queued,
  disabled,
}: {
  label: string;
  state: UpdateState;
  busy: UpdateBusy | undefined;
  queued: UpdateRestartChoice | undefined;
  disabled?: boolean;
}): JSX.Element {
  const pop = usePopover<HTMLDivElement>();
  return (
    <div className="split primary upd-split" ref={pop.anchor}>
      <button type="button" className="split-main primary" disabled={disabled} onClick={() => applyUpdate("wait")}>
        {label}
      </button>
      <button
        type="button"
        className="split-caret primary"
        aria-expanded={pop.open}
        aria-haspopup="menu"
        aria-label="Other ways to update"
        disabled={disabled}
        onClick={() => {
          if (!pop.open) refreshBusy();
          pop.toggle();
        }}
      >
        <Icon name="chevron" />
      </button>
      {pop.open ? (
        <Popover at={pop} side="below" align="end" className="cx-submenu answer-menu upd-menu" role="menu">
          <UpdateMenuCard
            menu={updateMenu(state, busy, "about", queued)}
            onPick={(choice) => {
              pop.close();
              applyUpdate(choice);
            }}
          />
        </Popover>
      ) : null}
    </div>
  );
}
