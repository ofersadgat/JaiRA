/**
 * The run's instances, drawn on the conversation's own rail (DESIGN §11.1).
 *
 * The panel used to say this as an indented tree, which drew the same shape as the rail beside it
 * out of entirely different material — so the two could not be read against each other, and neither
 * one said what a repeat was. This is the rail with the contents taken away: the letterheads,
 * stacked, one row per state.
 *
 * ## The three rules
 *
 *  1. **A state with children opens a lane.** Its states are indented inside it and its colour runs
 *     down the whole of it. The indent is arithmetic rather than a special case — the gutter is as
 *     wide as the lanes open on that row, so the run's own trunk is one lane wide, a module is two,
 *     a state is three (see `centresFor`).
 *  2. **A state with nothing under it opens a lane and closes it again inside its own row**, drawn
 *     as a lobe — see {@link lobePath}. Drawn as an ordinary fork and join it is a chevron with no
 *     line in it, and a column of them is a saw blade.
 *  3. **The colour is the state's own**, the same hue the conversation gives it, which is what makes
 *     the panel a legend for the drawing beside it. That only holds if the palette is built ONCE:
 *     a hue is a state's position in the order states first appear, so derived from whatever rows
 *     are on screen it moves every time a loop is folded. See {@link RunIndex}.
 *
 * ## What it is not
 *
 * Not a second reading of the tree with the same information rearranged. Three things the tree could
 * not say are here — a repeat, as a colour returning; where the run is, as the letterhead's own tone;
 * and what each state cost, which the letterhead has always carried and the tree never did. Three it
 * said are gone, each because the drawing already says it: the step number is the row's position,
 * the nesting is the lanes, and the operation kind is one landing away.
 */
import { useState, type JSX, type MouseEvent as ReactMouseEvent } from "react";
import type { InstanceNode } from "@jaira/shared/browser";
import { nameOf } from "./rail";
import { type DisplayItem } from "./stepCompaction";
import { RailedRows } from "./railView";
import { metaOf } from "./sessionPanels";
import { Icon } from "./icons";
import { ContextMenu, pointOf, type MenuAnchor } from "./menu";
import { keyOfNode, stepsIn, toneOf, useRunIndexModel, type RunIndexFit } from "./runIndexModel";

// The index's rows, folds, loops and fitting live in `runIndexModel.ts`, shared with the universal copy
// (decision 0015); re-exported here, where their callers have always found them.
export { indexOf, keyOfNode, loopsIn, type IndexLoopRow, type IndexRow, type IndexStateRow, type RunIndexFit } from "./runIndexModel";

// `nameOf` and `paletteOfRun` live in `rail.ts`, shared with the universal copy of the conversation
// (decision 0015); re-exported here, where their callers have always found them.
export { paletteOfRun } from "./rail";

/** The loop's own control, on the first pass of the cycle. */
function LoopTag({ times, onToggle }: { times: number; onToggle: () => void }): JSX.Element {
  return (
    <button
      type="button"
      className="loop-tag"
      title={`${times} passes of this cycle — fold them into one row`}
      onClick={onToggle}
    >
      <span className="loop-tag-glyph">↻</span> {times} passes
    </button>
  );
}

/**
 * The Instances section: the run's shape, and a bookmark on every row.
 *
 * `onGoTo` is what makes a label a bookmark. Absent — a host with no conversation beside it — the
 * rows are still the run's shape and still fold, but nothing pretends to be a link.
 */
export function RunIndex({
  instances,
  here,
  asking,
  onGoTo,
  onCut,
  fit,
  heading = true,
}: {
  /** Fit the rows to a box — see {@link RunIndexFit}. */
  fit?: RunIndexFit | undefined;
  /** Whether the section draws its own `Instances` heading. A host with its own head says `false`. */
  heading?: boolean;
  /**
   * The two verbs of a cut (`cut.ts`), on a row's menu — the same point the conversation's entered
   * row offers, from the reading that surveys the run. Absent ⇒ a row has no menu.
   */
  onCut?: { rewind: (node: InstanceNode) => void; fork: (node: InstanceNode) => void } | undefined;
  instances: readonly InstanceNode[];
  /** The state the reader is on, by {@link keyOfNode}. */
  here?: string | undefined;
  /**
   * The instance whose QUESTION is on offer right now, when one is.
   *
   * The rail is where the close-and-reopen case showed up second: a task reopened with its gate
   * drawn and answerable had every row in the index at rest, because the instance holding it was
   * terminated `canceled` by the stop while the question itself was seeded back into the hub. It
   * cannot be read off the tree — see `askingInstanceOf` in `runViews.tsx` — so it is handed in.
   */
  asking?: string | undefined;
  onGoTo?: ((node: InstanceNode) => void) | undefined;
}): JSX.Element {
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  // Everything the index derives (`useRunIndexModel`): its rows with folds and loops applied, the
  // rail's rows over them, the palette from the RUN, the gestures, the clock and the fitted rows.
  const { steps, rows, palette, shutLanes, toggleFold, toggleLoop, foldable, allShut, foldAll, folds, onShut, byKey, mark, fitRows, gapOf, expand, now } = useRunIndexModel({ instances, fit, here });

  /** A lane with nothing under it cannot fold, so its mark does what its label does. */
  const onPick = (key: string): void => {
    const node = byKey.get(key);
    if (node !== undefined) onGoTo?.(node);
  };

  const row = (index: number, folded: boolean): JSX.Element | null => {
    const what = rows[index];
    if (what === undefined) return null;
    if (what.kind === "loop") {
      return (
        <div className="loop-shut">
          <button
            type="button"
            className="loop-shut-go"
            title={`expand ${what.times} passes`}
            onClick={() => toggleLoop(what.key)}
          >
            <span className="loop-swatches" aria-hidden="true">
              {what.members.slice(0, what.period).map((member, i) => (
                <i key={`${keyOfNode(member)}:${i}`} style={{ background: palette.get(nameOf(member)) ?? "var(--rule)" }} />
              ))}
            </span>
            <span className="loop-shut-names mono">
              {what.members
                .slice(0, what.period)
                .map((member) => nameOf(member))
                .join(" · ")}
            </span>
          </button>
          <LoopTag times={what.times} onToggle={() => toggleLoop(what.key)} />
        </div>
      );
    }

    const node = what.node;
    const tone = toneOf(node, asking);
    const held = stepsIn(node);
    const name = nameOf(node);
    const label = onGoTo === undefined ? undefined : `go to ${name} in the conversation`;
    const inside = (
      <>
        <span className={`rail-mark-dot ts-dot-${node.status}`} />
        <span className="rail-mark-name">{name}</span>
        {node.operation?.status === "failed" && node.operation.reason !== undefined ? (
          <span className="rail-mark-why">{node.operation.reason}</span>
        ) : null}
        {folded ? (
          <span className="rail-mark-count">
            {held} step{held === 1 ? "" : "s"}
          </span>
        ) : null}
        {metaOf(node, now) !== "" ? <span className="rail-mark-meta">{metaOf(node, now)}</span> : null}
      </>
    );
    // The run's own root has nothing before it to rewind to, and no cut names it.
    const cuttable = onCut !== undefined && node.parentInstanceId !== undefined;
    return (
      <div
        className={[
          "rail-mark",
          // A folded state is a TILE — an edge, like a closed folder — beside the stacked knot the rail
          // draws for it (the person's pick, 2026-09-24: B's knot with D's tile).
          folded ? "rolled" : "",
          tone !== undefined ? `tb ${tone}` : "",
          what.loop !== undefined ? "in-loop" : "",
          node.superseded ? "gone" : "",
          here === keyOfNode(node) ? "here here-chip" : "",
        ]
          .filter((one) => one.length > 0)
          .join(" ")}
        {...(cuttable
          ? {
              onContextMenu: (e: ReactMouseEvent<HTMLDivElement>) => {
                e.preventDefault();
                setMenu({
                  ...pointOf(e),
                  items: [
                    ...(onGoTo !== undefined ? [{ label: `Go to ${name} in the conversation`, onSelect: () => onGoTo(node) }] : []),
                    {
                      label: `Rewind to before ${name}`,
                      note: "deletes it and everything after",
                      separator: onGoTo !== undefined,
                      onSelect: () => onCut.rewind(node),
                    },
                    { label: `Fork before ${name}`, note: "a new task from here", onSelect: () => onCut.fork(node) },
                  ],
                });
              },
            }
          : {})}
      >
        {what.lane !== undefined ? (
          <button
            type="button"
            className={`rail-mark-chev${folded ? "" : " open"}`}
            aria-label={`${folded ? "Expand" : "Collapse"} ${name}`}
            onClick={() => toggleFold(what.lane!, false)}
          >
            <Icon name="chevron" />
          </button>
        ) : (
          // The slot is kept so every name in the column starts at the same x. A leaf has no fold.
          <span className="rail-mark-chev pad" aria-hidden="true" />
        )}
        {onGoTo === undefined ? (
          <span className="rail-mark-go static">{inside}</span>
        ) : (
          <button type="button" className="rail-mark-go" title={label} onClick={() => onGoTo(node)}>
            {inside}
          </button>
        )}
        {what.loop?.head === true ? <LoopTag times={what.loop.times} onToggle={() => toggleLoop(what.loop!.key)} /> : null}
      </div>
    );
  };

  const rowClass = (index: number): string | undefined => {
    const what = rows[index];
    if (what === undefined || what.kind !== "state") return undefined;
    return here === keyOfNode(what.node) ? "is-here" : undefined;
  };

  /** Go to the TOP of a state named on a folded line — its own row in the conversation. */
  const goTop = (key: string): void => {
    const node = byKey.get(key);
    if (node !== undefined) onGoTo?.(node);
  };

  const renderGap = (item: Extract<DisplayItem, { kind: "gap" }>): JSX.Element => {
    // What it passes over, by name: the outermost states among its rows (`gapOf`).
    const { count, named, more } = gapOf(item);
    return (
      <div className="rail-mark rail-gap">
        <span className="rail-mark-chev pad" aria-hidden="true" />
        <button
          type="button"
          className="rail-gap-go"
          title={`show the ${count} step${count === 1 ? "" : "s"} here`}
          onClick={() => expand(item.key)}
        >
          <span className="rail-gap-glyph">⋯</span>
          {count} step{count === 1 ? "" : "s"}
        </button>
        <span className="rail-gap-names">
          {named.map((one, i) => (
            <span key={one.key} className="rail-gap-name-wrap">
              {i > 0 ? <span className="rail-crumb-sep">·</span> : null}
              <button
                type="button"
                className="rail-gap-name"
                title={`go to the top of ${one.stateId}`}
                disabled={onGoTo === undefined}
                onClick={() => goTop(one.goTo)}
              >
                {one.stateId}
              </button>
            </span>
          ))}
          {more > 0 ? <span className="rail-crumb-sep">+{more}</span> : null}
        </span>
      </div>
    );
  };

  const renderCrumb = (item: Extract<DisplayItem, { kind: "crumb" }>): JSX.Element => {
    const deepest = byKey.get(item.lanes[item.lanes.length - 1]?.key ?? "");
    return (
      <div className="rail-mark rail-crumbs-mark">
        <span className="rail-mark-chev pad" aria-hidden="true" />
        <span className="rail-crumbs">
          {item.lanes.map((lane, i) => (
            <span key={lane.key} className="rail-crumb-wrap">
              {i > 0 ? <span className="rail-crumb-sep">›</span> : null}
              <button
                type="button"
                className={i === item.lanes.length - 1 ? "rail-crumb last" : "rail-crumb"}
                title={`go to the top of ${lane.stateId}`}
                disabled={onGoTo === undefined}
                onClick={() => goTop(lane.key)}
              >
                {lane.stateId}
              </button>
            </span>
          ))}
        </span>
        {deepest !== undefined && metaOf(deepest, now) !== "" ? <span className="rail-mark-meta">{metaOf(deepest, now)}</span> : null}
      </div>
    );
  };

  const drawn =
    instances.length === 0 ? (
      <p className="empty">No run yet.</p>
    ) : (
      <RailedRows
        className="run-index"
        steps={steps}
        renderStep={(index) => row(index, false)}
        renderRolled={(lane) => {
          const at = steps.findIndex((step) => step.key === lane.key);
          return at < 0 ? null : row(at, true);
        }}
        mark={mark}
        rowClass={rowClass}
        palette={palette}
        shut={shutLanes}
        onShut={onShut}
        foldable={foldable}
        onPick={onPick}
        compact={fitRows}
        renderGap={renderGap}
        renderCrumb={renderCrumb}
      />
    );

  if (!heading) {
    return (
      <>
        {menu !== null ? <ContextMenu anchor={menu} onClose={() => setMenu(null)} /> : null}
        {drawn}
      </>
    );
  }

  return (
    <section>
      {/* The fold-all lives in the heading, which is the row already reserved for saying what this
          section is — the same arrangement, and the same growing-label control, as a session's own
          gutter in the conversation. */}
      <h3>
        <span>Instances</span>
        {folds.length > 0 ? (
          <button
            type="button"
            className="foldall"
            aria-label={allShut ? "Expand all" : "Collapse all"}
            onClick={foldAll}
          >
            <Icon name={allShut ? "unfold" : "fold"} />
            <span className="foldall-label">{allShut ? "expand all" : "collapse all"}</span>
          </button>
        ) : null}
      </h3>
      {menu !== null ? <ContextMenu anchor={menu} onClose={() => setMenu(null)} /> : null}
      {drawn}
    </section>
  );
}
