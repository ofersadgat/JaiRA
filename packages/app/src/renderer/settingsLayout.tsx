/**
 * The shape every Settings page is built from — after t3code's `settingsLayout.tsx`, which the
 * person picked on 2026-09-23 as "much more readable than jaira patterns".
 *
 * Three pieces, and each exists to take a decision away from the page that uses it:
 *
 *  - **A page** is a title, one sentence saying WHOSE settings these are, and its sections.
 *  - **A section** is a quiet sentence-case heading over ONE bordered card. It is also what the
 *    sidebar's accordion lists under the tab: `data-part` names it, and the Settings view finds every
 *    one on the page, lights the one being read and scrolls to the one clicked (`App.tsx`).
 *  - **A row** is one setting: its name, ONE sentence under it, and its control at the right edge; a
 *    ↺ beside the name while the value differs from what it would be untouched, and an ⓘ holding
 *    whatever did not fit in the sentence. Nothing about a setting is said at the far right any more
 *    — the control says what it is set to.
 *
 * A render function for each, with no opinion about where it sits
 * ([[ui-components-are-render-functions]]): the page decides the order, the row decides nothing.
 */
import type { JSX, ReactNode } from "react";

/** A Settings page: its title, whose settings these are, and its sections. */
export function SettingsPage({
  title,
  lead,
  aside,
  className,
  children,
}: {
  title: string;
  /** One sentence: whose settings these are, and what anything unset falls back to. */
  lead?: ReactNode;
  /** At the head's right edge — the layer switch, a re-check. */
  aside?: ReactNode;
  className?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className={`set-page${className !== undefined ? ` ${className}` : ""}`}>
      <header className="set-head">
        <div className="set-head-say">
          <div className="set-title" role="heading" aria-level={1}>
            {title}
          </div>
          {lead !== undefined ? <p className="set-lead">{lead}</p> : null}
        </div>
        {aside !== undefined ? <div className="set-head-aside">{aside}</div> : null}
      </header>
      {children}
    </div>
  );
}

/**
 * One section: a heading over one card of rows.
 *
 * `id` is what the sidebar's accordion scrolls to and lights; `plain` drops the card for a section
 * whose body is a workspace of its own (File types), and `wide` lets it take the page's full width.
 */
export function SettingsSection({
  id,
  title,
  info,
  lead,
  action,
  plain = false,
  wide = false,
  children,
}: {
  id: string;
  title: string;
  /** What the section is for, behind an ⓘ beside its heading — a heading carries no paragraph. */
  info?: string | undefined;
  /**
   * A line under the heading, for the rare section whose explanation has to be SEEN rather than
   * hovered (it names a key, or it is the only thing that says why the card is empty).
   */
  lead?: ReactNode;
  /** At the heading's right edge. */
  action?: ReactNode;
  plain?: boolean;
  wide?: boolean;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className={`set-section${wide ? " wide" : ""}`} data-part={id} data-part-label={title}>
      <div className="set-section-title" role="heading" aria-level={2}>
        <span className="set-section-name">
          {title}
          {info !== undefined ? (
            <span className="set-icon set-info" title={info} aria-label={info} role="img">
              ⓘ
            </span>
          ) : null}
        </span>
        {action}
      </div>
      {lead !== undefined ? <div className="set-section-lead cfg-hint">{lead}</div> : null}
      {plain ? children : <div className="set-group">{children}</div>}
    </section>
  );
}

/**
 * One setting.
 *
 * `children` go UNDER the row across its whole width — a preview, a list — and `full` drops the
 * control column for a row that is only a heading over them.
 */
export function SettingsRow({
  name,
  description,
  info,
  reset,
  control,
  full = false,
  children,
}: {
  name: ReactNode;
  /** One sentence. What does not fit goes in `info`. */
  description?: ReactNode;
  /** The rest of the explanation, behind an ⓘ beside the name. */
  info?: string;
  /** Present while the value differs from what it would be untouched — see {@link ResetButton}. */
  reset?: { label: string; onReset: () => void; disabled?: boolean } | undefined;
  control?: ReactNode;
  full?: boolean;
  children?: ReactNode;
}): JSX.Element {
  return (
    <div className={`set-row${full ? " full" : ""}`}>
      <div className="set-row-line">
        <div className="set-row-say">
          <div className="set-name" role="heading" aria-level={3}>
            <span>{name}</span>
            {reset !== undefined ? <ResetButton {...reset} /> : null}
            {info !== undefined ? (
              <span className="set-icon set-info" title={info} aria-label={info} role="img">
                ⓘ
              </span>
            ) : null}
          </div>
          {description !== undefined ? <p className="set-desc">{description}</p> : null}
        </div>
        {control !== undefined && !full ? <div className="set-ctl">{control}</div> : null}
      </div>
      {children}
    </div>
  );
}

/** ↺ — put this setting back to what it would be untouched. `label` says what that is. */
export function ResetButton({ label, onReset, disabled }: { label: string; onReset: () => void; disabled?: boolean | undefined }): JSX.Element {
  return (
    <button type="button" className="set-icon set-reset" title={label} aria-label={label} disabled={disabled} onClick={onReset}>
      ↺
    </button>
  );
}

/** Two to four choices side by side, the chosen one raised — t3code's segmented control. */
export function Segmented<T extends string>({
  value,
  options,
  label,
  disabled,
  onChange,
}: {
  value: T;
  options: ReadonlyArray<readonly [label: string, value: T]>;
  /** What the group chooses, for a screen reader. */
  label: string;
  disabled?: boolean;
  onChange: (value: T) => void;
}): JSX.Element {
  return (
    <div className="set-seg" role="group" aria-label={label}>
      {options.map(([text, option]) => (
        <button key={option} type="button" aria-pressed={value === option} disabled={disabled} onClick={() => onChange(option)}>
          {text}
        </button>
      ))}
    </div>
  );
}
