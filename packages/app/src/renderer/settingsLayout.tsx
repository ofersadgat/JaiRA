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
 *
 * A row or a section that one layer may or may not state takes a {@link RowLayer}: the switch before
 * its name (on, this layer states it and the control edits it; off, the control shows what it
 * inherits and cannot be changed — `Field.toggle`'s rule), and its part in the "Just you" view
 * (`useLayerRow`): not drawn under "What you changed" unless the layer states it, and on the
 * personal layer the line saying what it replaces.
 */
import type { JSX, ReactNode } from "react";
import { Switch, SettingsLayerContext, useLayerRow } from "./controls";

/** A Settings page: its title, whose settings these are, and its sections. */
export function SettingsPage({
  title,
  lead,
  under,
  aside,
  onlyStated = false,
  className,
  children,
}: {
  title: string;
  /** One sentence: whose settings these are, and what anything unset falls back to. */
  lead?: ReactNode;
  /** Under the lead — the Just you view's "What you changed | Every row". */
  under?: ReactNode;
  /** At the head's right edge — the layer switch, a re-check. */
  aside?: ReactNode;
  /**
   * Only the rows the layer states are drawn ("What you changed"). A section left with none is not
   * drawn either, and a page left with none says so in one line — both in `styles.css`, because only
   * the page's own DOM knows what its rows came to.
   */
  onlyStated?: boolean;
  className?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className={`set-page${className !== undefined ? ` ${className}` : ""}`} {...(onlyStated ? { "data-only-stated": "" } : {})}>
      <header className="set-head">
        <div className="set-head-say">
          <div className="set-title" role="heading" aria-level={1}>
            {title}
          </div>
          {lead !== undefined ? <p className="set-lead">{lead}</p> : null}
          {under !== undefined ? <div className="set-under">{under}</div> : null}
        </div>
        {aside !== undefined ? <div className="set-head-aside">{aside}</div> : null}
      </header>
      {onlyStated ? <p className="set-nothing">Nothing is set just for you on this page. Choose Every row to set something.</p> : null}
      {children}
    </div>
  );
}

/**
 * A row's (or a section's) place in the layers: the config paths it writes, whether the layer being
 * edited states them, and what switching that changes.
 */
export interface RowLayer {
  /** The config paths the row writes, the first stated one being what its "instead of" line reports. */
  paths: readonly string[];
  /** The layer being edited states it. */
  on: boolean;
  /** On: this layer states it (the value shown is pinned). Off: it is removed, and inherits again. */
  onChange: (on: boolean) => void;
  disabled?: boolean | undefined;
  /** How the row spells a value, for the "instead of" line — a palette's name rather than its id. */
  format?: ((value: unknown, path: string) => string) | undefined;
}

/** The switch before a layered row's or section's name. */
function LayerSwitch({ name, layer }: { name: string; layer: RowLayer }): JSX.Element {
  return (
    <Switch
      on={layer.on}
      label={layer.on ? `${name} is set here — switch off to inherit it` : `set ${name} here`}
      {...(layer.disabled !== undefined ? { disabled: layer.disabled } : {})}
      onChange={layer.onChange}
    />
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
  layer,
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
  /** The whole section is ONE setting a layer may state — a set of tiles, a workspace. See {@link RowLayer}. */
  layer?: RowLayer | undefined;
  children: ReactNode;
}): JSX.Element | null {
  const layered = useLayerRow(layer?.paths, layer?.on, layer?.format);
  if (layer !== undefined && layered.hidden) return null;
  const body = plain ? children : <div className="set-group">{children}</div>;
  return (
    <section
      className={`set-section${wide ? " wide" : ""}${layer !== undefined ? (layer.on ? " set-stated" : " off") : ""}`}
      data-part={id}
      data-part-label={title}
    >
      <div className="set-section-title" role="heading" aria-level={2}>
        <span className="set-section-name">
          {layer !== undefined ? <LayerSwitch name={title} layer={layer} /> : null}
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
      {layered.instead !== undefined ? <div className="set-section-lead cfg-hint set-instead">{layered.instead}</div> : null}
      {layer === undefined ? (
        body
      ) : (
        // Stated or not, what is inside is this one setting's content, not rows of the page.
        <SettingsLayerContext.Provider value={null}>
          <div className="set-section-body" {...(layer.on ? {} : { inert: true })}>
            {body}
          </div>
        </SettingsLayerContext.Provider>
      )}
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
  layer,
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
  /** A setting a layer may or may not state — see {@link RowLayer}. */
  layer?: RowLayer | undefined;
  children?: ReactNode;
}): JSX.Element | null {
  const layered = useLayerRow(layer?.paths, layer?.on, layer?.format);
  // A full-width row with no setting of its own — a preview — belongs to its section: it is drawn
  // whenever the section is.
  if (layered.hidden && (layer !== undefined || !full)) return null;
  const off = layer !== undefined && !layer.on;
  return (
    <div className={`set-row${full ? " full" : ""}${off ? " off" : ""}`}>
      <div className="set-row-line">
        <div className="set-row-say">
          <div className="set-name" role="heading" aria-level={3}>
            {layer !== undefined ? <LayerSwitch name={typeof name === "string" ? name : "this"} layer={layer} /> : null}
            <span>{name}</span>
            {reset !== undefined ? <ResetButton {...reset} /> : null}
            {info !== undefined ? (
              <span className="set-icon set-info" title={info} aria-label={info} role="img">
                ⓘ
              </span>
            ) : null}
          </div>
          {description !== undefined ? <p className="set-desc">{description}</p> : null}
          {layered.instead !== undefined ? <p className="set-desc set-instead">{layered.instead}</p> : null}
        </div>
        {control !== undefined && !full ? (
          <div className="set-ctl" {...(off ? { inert: true } : {})}>
            {control}
          </div>
        ) : null}
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
