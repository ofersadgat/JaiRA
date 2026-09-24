/**
 * The side panel's FRAME — one for every room (the person's rulings, 2026-09-24; the panel-views
 * artifact, rounds 1–8). What it shows is a stack (`panelStack.ts`); what each entry says is its
 * FACE, handed in by the shell (`panelFaces.tsx`). This file draws the same furniture around all of
 * them, which is the point: the column used to be four inspectors with four headers, four ideas of
 * "back" and a close button on one of them.
 *
 * ## The furniture
 *
 *  - **The head.** On the root: the glyph, the name, the root's verbs as ICONS on the same line (they
 *    took a row of buttons of their own before, which cost the panel's best row twice over), then pin,
 *    fold and close. On a pushed entry: ‹, the trail of what is under it — each crumb a way back to
 *    that level — the entry's own name and what KIND of thing it is, then the same three.
 *  - **The offer bar.** Pinned, a new selection in the middle does not take the panel over: it waits
 *    here, named, with "Show it here".
 *  - **The tabs.** The nearest tabbed entry's, with as many LABELS as fit — the open tab's first, then
 *    from the left (`panelTabs.ts`). Every tab keeps its icon and count, which is what the folded rail
 *    draws too, so a tab that has lost its words is still the same control.
 *  - **The fold.** A 48px rail: the root's tabs as icons with the name under each, and pin and unfold
 *    at the bottom. Folded is a statement about the column, not the stack — unfolding shows the same
 *    stack exactly where it was.
 *
 * Motion is CSS on a keyed body: a push slides in from the right, a pop from the left, a replace
 * fades, a tab crossfades. Keyed on what is on top, so the animation plays exactly when that changes.
 */
import { useLayoutEffect, useMemo, useRef, useState, type JSX, type ReactNode } from "react";
import { Icon, type PATHS } from "./icons";
import { acceptOffer, close, crumbOf, kindWordOf, pin, pop, popTo, setTab, topOf, type PanelEntry, type PanelStack } from "./panelStack";
import { labelPlan } from "./panelTabs";

type IconKey = keyof typeof PATHS;

/** One tab of an entry. `id` is what `PanelEntry.tab` holds. */
export interface PanelTabSpec {
  id: string;
  label: string;
  icon: IconKey;
  /** A count or a short figure after the label — also the badge on the folded rail. */
  count?: number | string | undefined;
  /** The count's tone: something waiting on you (amber), live (accent), failed (red). */
  tone?: "amber" | "accent" | "red" | undefined;
}

/** A verb in the head, drawn as an icon with its name as the tooltip. */
export interface PanelVerb {
  icon: IconKey;
  label: string;
  onClick: () => void;
  disabled?: boolean | undefined;
  /** The verb that matters most — drawn filled. At most one. */
  primary?: boolean | undefined;
  danger?: boolean | undefined;
}

/** What an entry says: the frame asks for it and draws the rest. */
export interface PanelFace {
  /** The root's mark before its name — a status dot, a state's glyph. */
  glyph?: ReactNode;
  title: ReactNode;
  /** The name as text, for tooltips and the rail. */
  titleText: string;
  /** One line under the name: the facts that identify it. */
  sub?: ReactNode;
  verbs?: readonly PanelVerb[] | undefined;
  /** This entry's tabs, when it has them. `tab` is the open one. */
  tabs?: readonly PanelTabSpec[] | undefined;
  tab?: string | undefined;
  body: ReactNode;
  /** `false` when the body lays itself out to the column's height (Steps, a conversation). */
  scroll?: boolean;
  /** A bar under the head that holds the panel until it is dealt with — unsaved edits. */
  guard?: ReactNode;
}

/** The glyph a tab id is drawn with when a face does not say — shared by the rail and the strip. */
export const TAB_ICONS: Record<string, IconKey> = {
  conversation: "comment",
  steps: "plan",
  changes: "typeChanges",
  outputs: "typeData",
  configuration: "form",
  produced: "files",
  held: "pin",
  run: "play",
  checks: "check",
};

/**
 * The tab strip, labelled as far as the width allows.
 *
 * Measured rather than guessed: a hidden copy of the strip draws each tab bare and labelled, and
 * {@link labelPlan} decides from those widths and the strip's own. Re-measured when the column is
 * resized (a ResizeObserver) and when the tabs change.
 */
function PanelTabs({ tabs, open, onTab }: { tabs: readonly PanelTabSpec[]; open: string | undefined; onTab: (id: string) => void }): JSX.Element {
  const strip = useRef<HTMLDivElement | null>(null);
  const measure = useRef<HTMLDivElement | null>(null);
  const [plan, setPlan] = useState<boolean[]>(() => tabs.map(() => true));
  const signature = tabs.map((tab) => `${tab.id}:${tab.label}:${tab.count ?? ""}`).join("|");
  const openAt = tabs.findIndex((tab) => tab.id === open);

  useLayoutEffect(() => {
    const el = strip.current;
    const ruler = measure.current;
    if (el === null || ruler === null) return;
    const decide = (): void => {
      const bare = [...ruler.querySelectorAll<HTMLElement>("[data-bare]")].map((node) => node.offsetWidth);
      const full = [...ruler.querySelectorAll<HTMLElement>("[data-full]")].map((node) => node.offsetWidth);
      const widths = tabs.map((_, i) => ({ bare: bare[i] ?? 0, label: Math.max(0, (full[i] ?? 0) - (bare[i] ?? 0)) }));
      const next = labelPlan(widths, openAt, el.clientWidth - 2);
      setPlan((was) => (was.length === next.length && was.every((one, i) => one === next[i]) ? was : next));
    };
    decide();
    if (typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(decide);
    watch.observe(el);
    return () => watch.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, openAt]);

  const draw = (tab: PanelTabSpec, labelled: boolean, extra?: Record<string, string>): JSX.Element => (
    <>
      <Icon name={tab.icon} className="sp-tab-icon" />
      {labelled ? <span className="sp-tab-label">{tab.label}</span> : null}
      {tab.count !== undefined && tab.count !== 0 && tab.count !== "" ? (
        <span className={`sp-tab-count${tab.tone !== undefined ? ` ${tab.tone}` : ""}`} {...extra}>
          {tab.count}
        </span>
      ) : null}
    </>
  );

  return (
    <div className="sp-tabs" ref={strip} role="tablist">
      {tabs.map((tab, i) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={tab.id === open}
          className={`sp-tab${tab.id === open ? " on" : ""}`}
          title={tab.label}
          onClick={() => onTab(tab.id)}
        >
          {draw(tab, plan[i] ?? true)}
        </button>
      ))}
      {/* The ruler: every tab twice, bare and labelled, out of sight. */}
      <div className="sp-tabs-ruler" ref={measure} aria-hidden="true">
        {tabs.map((tab) => (
          <span key={tab.id} className="sp-tab-pair">
            <span className="sp-tab" data-bare="">
              {draw(tab, false)}
            </span>
            <span className="sp-tab" data-full="">
              {draw(tab, true)}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}

/** The head's right end: pin, fold, close — the same three on every entry. */
function FrameControls({
  stack,
  onStack,
  onFold,
}: {
  stack: PanelStack;
  onStack: (next: (stack: PanelStack) => PanelStack) => void;
  onFold: () => void;
}): JSX.Element {
  return (
    <span className="sp-controls">
      <button
        type="button"
        className={`sp-icon${stack.pinned ? " on" : ""}`}
        aria-pressed={stack.pinned}
        title={stack.pinned ? "Unpin — let a new selection replace this" : "Pin — keep this while you select other things"}
        onClick={() => onStack((was) => pin(was, !was.pinned))}
      >
        <Icon name="pin" />
      </button>
      <button type="button" className="sp-icon" title="Fold the panel to a rail" onClick={onFold}>
        <Icon name="fold" />
      </button>
      <button type="button" className="sp-icon" title="Close the panel" onClick={() => onStack(close)}>
        <Icon name="cross" />
      </button>
    </span>
  );
}

/**
 * The folded panel: the root's tabs as a column of icons, each with its name under it, and pin and
 * unfold at the bottom. Choosing a tab unfolds onto it — a tab on a rail that did nothing but light
 * up would be a picture of a control.
 */
function PanelRail({
  stack,
  face,
  onStack,
  onUnfold,
}: {
  stack: PanelStack;
  face: PanelFace | undefined;
  onStack: (next: (stack: PanelStack) => PanelStack) => void;
  onUnfold: () => void;
}): JSX.Element {
  return (
    <div className="sp-rail" aria-label="Side panel, folded">
      <div className="sp-rail-tabs">
        {face?.glyph !== undefined ? (
          <span className="sp-rail-glyph" title={face.titleText}>
            {face.glyph}
          </span>
        ) : null}
        {(face?.tabs ?? []).map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={`sp-rail-tab${tab.id === face?.tab ? " on" : ""}`}
            title={tab.label}
            onClick={() => {
              onStack((was) => setTab(was, tab.id));
              onUnfold();
            }}
          >
            <span className="sp-rail-icon">
              <Icon name={tab.icon} />
              {tab.count !== undefined && tab.count !== 0 && tab.count !== "" ? (
                <span className={`sp-rail-badge${tab.tone !== undefined ? ` ${tab.tone}` : ""}`}>{tab.count}</span>
              ) : null}
            </span>
            <span className="sp-rail-name">{tab.label}</span>
          </button>
        ))}
      </div>
      <div className="sp-rail-foot">
        <button
          type="button"
          className={`sp-icon${stack.pinned ? " on" : ""}`}
          aria-pressed={stack.pinned}
          title={stack.pinned ? "Unpin" : "Pin"}
          onClick={() => onStack((was) => pin(was, !was.pinned))}
        >
          <Icon name="pin" />
        </button>
        <button type="button" className="sp-icon" title="Unfold the panel" onClick={onUnfold}>
          <Icon name="unfold" />
        </button>
      </div>
    </div>
  );
}

/**
 * One side panel. `face` answers for any entry in the stack; the frame asks for the top one, the
 * nearest tabbed one (whose tabs are drawn), and the root (which the rail draws).
 */
export function SidePanel({
  stack,
  onStack,
  face,
  folded,
  onFold,
}: {
  stack: PanelStack;
  onStack: (next: (stack: PanelStack) => PanelStack) => void;
  face: (entry: PanelEntry) => PanelFace;
  folded: boolean;
  onFold: (folded: boolean) => void;
}): JSX.Element | null {
  /** The waiting selection by its own name, when its face can say one. */
  const offerName = stack.offer === null ? undefined : face(stack.offer).titleText;
  const top = topOf(stack);
  const root = stack.entries[0];
  const topFace = useMemo(() => (top === undefined ? undefined : face(top)), [top, face]);
  /** The nearest entry, from the top down, that has tabs — its strip is the one drawn. */
  const tabbedAt = useMemo(() => {
    for (let i = stack.entries.length - 1; i >= 0; i--) if ("tab" in stack.entries[i]!) return i;
    return -1;
  }, [stack.entries]);
  const tabbed = tabbedAt < 0 ? undefined : tabbedAt === stack.entries.length - 1 ? topFace : face(stack.entries[tabbedAt]!);
  const rootFace = root === undefined ? undefined : root === top ? topFace : face(root);

  if (top === undefined || topFace === undefined) return null;
  if (folded) return <PanelRail stack={stack} face={rootFace} onStack={onStack} onUnfold={() => onFold(false)} />;

  const pushed = stack.entries.length > 1;
  const verbs = topFace.verbs ?? [];
  return (
    <div className={`sp${pushed ? " pushed" : ""}`} data-kind={top.kind}>
      <header className="sp-head">
        {pushed ? (
          <>
            <button type="button" className="sp-icon sp-back" title="Back" onClick={() => onStack(pop)}>
              <Icon name="back" />
            </button>
            <div className="sp-titles">
              <div className="sp-trail">
                {stack.entries.slice(0, -1).map((entry, i) => (
                  <span key={entry.key} className="sp-trail-part">
                    {i > 0 ? <span className="sp-trail-sep">›</span> : null}
                    <button type="button" className="sp-crumb" title={`Back to ${crumbOf(entry)}`} onClick={() => onStack((was) => popTo(was, i))}>
                      {i === 0 ? (rootFace?.titleText ?? crumbOf(entry)) : crumbOf(entry)}
                    </button>
                  </span>
                ))}
              </div>
              <div className="sp-name-line">
                <span className="sp-name ellip" title={topFace.titleText}>
                  {topFace.title}
                </span>
                <span className="sp-kind">{kindWordOf(top)}</span>
              </div>
            </div>
          </>
        ) : (
          <>
            {topFace.glyph !== undefined ? <span className="sp-glyph">{topFace.glyph}</span> : null}
            <div className="sp-titles">
              <div className="sp-name-line">
                <span className="sp-name ellip" title={topFace.titleText}>
                  {topFace.title}
                </span>
              </div>
              {topFace.sub !== undefined ? <div className="sp-sub ellip">{topFace.sub}</div> : null}
            </div>
          </>
        )}
        {verbs.length > 0 ? (
          <span className="sp-verbs">
            {verbs.map((verb) => (
              <button
                key={verb.label}
                type="button"
                className={`sp-icon${verb.primary === true ? " primary" : ""}${verb.danger === true ? " danger" : ""}`}
                title={verb.label}
                aria-label={verb.label}
                disabled={verb.disabled}
                onClick={verb.onClick}
              >
                <Icon name={verb.icon} />
              </button>
            ))}
          </span>
        ) : null}
        <FrameControls stack={stack} onStack={onStack} onFold={() => onFold(true)} />
      </header>

      {pushed && topFace.sub !== undefined ? <div className="sp-sub sp-sub-pushed ellip">{topFace.sub}</div> : null}

      {stack.offer !== null ? (
        <div className="sp-offer" role="status">
          <Icon name="pin" className="sp-offer-glyph" />
          <span className="grow ellip">
            <b>{offerName ?? crumbOf(stack.offer)}</b> is selected
          </span>
          <button type="button" className="link" onClick={() => onStack(acceptOffer)}>
            Show it here
          </button>
          <button type="button" className="sp-icon" title="Dismiss" onClick={() => onStack((was) => ({ ...was, offer: null, motion: "none" }))}>
            <Icon name="cross" />
          </button>
        </div>
      ) : null}

      {topFace.guard !== undefined ? <div className="sp-guard">{topFace.guard}</div> : null}

      {tabbed?.tabs !== undefined && tabbed.tabs.length > 0 ? (
        <PanelTabs
          tabs={tabbed.tabs}
          open={tabbedAt === stack.entries.length - 1 ? tabbed.tab : undefined}
          onTab={(id) => onStack((was) => setTab(was, id))}
        />
      ) : null}

      <div
        key={`${top.key}|${"tab" in top ? top.tab : ""}`}
        className={`sp-body sp-motion-${stack.motion}${topFace.scroll === false ? " fill" : " scroll"}`}
      >
        {topFace.body}
      </div>
    </div>
  );
}
