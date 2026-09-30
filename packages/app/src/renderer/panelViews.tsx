/**
 * What the side panel's entries SHOW — one component per tab or card (the person's rulings,
 * 2026-09-24; the panel-views artifact, rounds 1–8). The frame is `sidePanel.tsx`; which of these an
 * entry gets, and with what, is `panelFaces.tsx`.
 *
 * Every one of them is drawn in the SETTINGS patterns — a section is a heading over one card of rows,
 * a row is a name with its value or control at the right (`settingsLayout.tsx`) — because the panel
 * is the other place the app lays out facts about a thing, and the settings pages are where that
 * layout was settled. The inspectors these replace each had a vocabulary of their own.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { ArtifactSummary, EffectiveStateValues, InstanceNode, SessionRef, StateView, TaskDetail } from "@jaira/shared/browser";
import type { JsonValue } from "@declarative-ai/json";
import { Badge } from "./board";
import { Icon } from "./icons";
import { RunIndex, keyOfNode } from "./runIndex";
import { invoke } from "./store";
import { sizeOf, type ArtifactSurface } from "./transcriptView";
import { RunInputsForm } from "./runPanel";
import { useRerunForm } from "./newTaskModel";
import { createBlocker, runInputsOf, type RunField, type RunValues } from "./runForm";
import { useTouched } from "./schemaForm/check";
import { SelectInput } from "./controls";
import { ValueView } from "./valueView";
import { ValuePanelContext, type PinnedValue } from "./valuePanel";
import { STEP_ROW, callLine, checksCountOf, countOf, durationWords, pathOf, previewOf, producedValueOf, runMetricsOf, stepRowsOf, tookOf, useStepFollow, useStepsFit, valueRowsOf } from "./panelViewsModel";

// How tall one row of the Steps index is — `.rail.run-index`'s `--rail-cap` — lives in `panelViewsModel.ts`.
export { STEP_ROW };

/* ------------------------------------------------------------------------------------------------ */
/* Small shared pieces                                                                              */
/* ------------------------------------------------------------------------------------------------ */

/** A heading over one card of rows — `SettingsSection`'s markup, without its layer machinery. */
export function PanelSection({ title, action, children, plain = false }: { title: string; action?: ReactNode; children: ReactNode; plain?: boolean }): JSX.Element {
  return (
    <section className="set-section pv-section">
      <div className="set-section-title" role="heading" aria-level={2}>
        <span className="set-section-name">{title}</span>
        {action}
      </div>
      {plain ? children : <div className="set-group">{children}</div>}
    </section>
  );
}

/** One line: a name, and what it is at the right. Dense — the panel is narrow and these repeat. */
export function PanelRow({
  name,
  value,
  title,
  onClick,
  mono = false,
}: {
  name: ReactNode;
  value?: ReactNode;
  title?: string | undefined;
  onClick?: (() => void) | undefined;
  mono?: boolean;
}): JSX.Element {
  const body = (
    <>
      <span className="pv-row-name">{name}</span>
      {value !== undefined ? <span className={`pv-row-value${mono ? " mono" : ""}`}>{value}</span> : null}
    </>
  );
  return onClick !== undefined ? (
    <button type="button" className="set-row pv-row clickable" title={title} onClick={onClick}>
      {body}
    </button>
  ) : (
    <div className="set-row pv-row" title={title}>
      {body}
    </div>
  );
}

// `previewOf`, `tookOf`, `pathOf` and what a run consumed live in `panelViewsModel.ts`, shared with the
// universal copy (decision 0015); re-exported here, where their callers have always found them.
export { previewOf, tookOf, pathOf, checksCountOf };

/** Rows for a value: one per key of an object, one for anything else. Each opens the value whole. */
function ValueRows({ value, onOpen }: { value: unknown; onOpen: (name: string, value: unknown) => void }): JSX.Element {
  const { rows: entries, keyed } = valueRowsOf(value);
  if (keyed) {
    if (entries.length === 0) return <div className="set-row pv-row pv-none">empty</div>;
    return (
      <>
        {entries.map(([key, one]) => (
          <PanelRow key={key} name={key} value={previewOf(one)} mono title={`open ${key}`} onClick={() => onOpen(key, one)} />
        ))}
      </>
    );
  }
  return <PanelRow name="value" value={previewOf(value)} mono onClick={() => onOpen("value", value)} />;
}

/* ------------------------------------------------------------------------------------------------ */
/* Steps                                                                                            */
/* ------------------------------------------------------------------------------------------------ */

/**
 * The Steps tab: the run's index in a box that FITS (`stepCompaction.ts`), and under it the card of
 * the step that is selected.
 *
 * With no step selected the index takes the whole column — there is nothing else to make room for.
 * With one, the index is a box whose height the person drags (remembered), and the card is below it:
 * the index says where you are, the card says what happened there, and scrolling one list to see the
 * other is the thing this layout is for avoiding.
 */
export function StepsView({
  detail,
  step,
  onStep,
  current,
  onScreen,
  convo,
  asking,
  onGoTo,
  onCut,
  boxHeight,
  onBoxHeight,
  card,
}: {
  detail: TaskDetail;
  /** The selected step, by instance id. */
  step: string | undefined;
  onStep: (step: string | undefined) => void;
  /** The step being viewed in the conversation beside this panel, when there is one. */
  current?: string | undefined;
  onScreen?: ReadonlySet<string> | undefined;
  /** Whether the conversation is on screen beside the panel. */
  convo: boolean;
  asking?: string | undefined;
  /** Take the conversation to a step — absent when there is none to take. */
  onGoTo?: ((node: InstanceNode) => void) | undefined;
  onCut?: { rewind: (node: InstanceNode) => void; fork: (node: InstanceNode) => void } | undefined;
  boxHeight: number;
  onBoxHeight: (height: number) => void;
  /** The selected step's card. */
  card: ReactNode;
}): JSX.Element {
  const box = useRef<HTMLDivElement | null>(null);
  const [rows, setRows] = useState(12);
  // The card is about the step you PICKED, and it goes when the step being viewed moves on
  // (`useStepFollow`, the person's ruling, 2026-09-24).
  useStepFollow(step, current, onStep);
  useLayoutEffect(() => {
    const el = box.current;
    if (el === null) return;
    const measure = (): void => setRows(stepRowsOf(el.clientHeight));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, [step !== undefined]);

  // A drag on the divider: the box's new height, clamped so neither half vanishes.
  const drag = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const el = box.current;
    if (el === null) return;
    const start = e.clientY;
    const from = el.clientHeight;
    const max = (el.parentElement?.clientHeight ?? 800) - 120;
    const move = (ev: PointerEvent): void => onBoxHeight(Math.round(Math.max(STEP_ROW * 4 + 8, Math.min(max, from + ev.clientY - start))));
    const up = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const fit = useStepsFit(rows, step, current, onScreen, convo);

  return (
    <div className="pv-steps">
      {detail.blocked.length > 0 ? (
        <div className="pv-blocked">
          {detail.blocked.map((b) => (
            <div key={b.stateId} className="notice warn">
              <b>{b.stateId.split("/").pop()}</b> — {b.reason}
            </div>
          ))}
        </div>
      ) : null}
      <div ref={box} className={`pv-steps-box${step === undefined ? " fill" : ""}`} style={step === undefined ? undefined : { height: `${boxHeight}px` }}>
        <RunIndex
          instances={detail.instances}
          heading={false}
          fit={fit}
          {...(step !== undefined ? { here: step } : current !== undefined ? { here: current } : {})}
          {...(asking !== undefined ? { asking } : {})}
          // A row is a way to its card first — the conversation is one link further, on the card.
          onGoTo={(node) => {
            onStep(keyOfNode(node));
            onGoTo?.(node);
          }}
          {...(onCut !== undefined ? { onCut } : {})}
        />
      </div>
      {step !== undefined ? (
        <>
          <div className="pv-steps-split" role="separator" aria-orientation="horizontal" title="Drag to resize the list" onPointerDown={drag} />
          <div className="pv-steps-card">{card}</div>
        </>
      ) : null}
    </div>
  );
}

/**
 * One step, densely: what went in and came out FIRST, then how it ran (the person's ruling — the
 * I/O is what a step is looked up for). The path sits at the top right of the Inputs line, where a
 * heading row had room for it; each row is one line and opens its value whole.
 */
export function StepCard({
  detail,
  node,
  project,
  sessions,
  onClose,
  onOpen,
  onConfig,
  onGoTo,
}: {
  detail: TaskDetail;
  node: InstanceNode;
  project?: string | undefined;
  /** The task's sessions — which of them this step ran. */
  sessions: readonly SessionRef[];
  onClose: () => void;
  /** Open one value in the panel, on top of this. */
  onOpen: (title: string, value: unknown) => void;
  /** The configuration this step ran with. */
  onConfig: () => void;
  onGoTo?: (() => void) | undefined;
}): JSX.Element {
  const [values, setValues] = useState<EffectiveStateValues | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    setValues(undefined);
    void invoke("state:effective", { stateId: node.stateId, taskId: detail.taskId, instanceId: node.instanceId, ...(project !== undefined ? { project } : {}) })
      .then((found) => live && setValues(found?.values ?? null))
      .catch(() => live && setValues(null));
    return () => {
      live = false;
    };
  }, [node.stateId, node.instanceId, detail.taskId, project, node.status]);

  const path = pathOf(detail.instances, node);
  const inputs = values?.inputs ?? node.inputs;
  const output = values?.output;
  const ran = sessions.filter((one) => one.instanceId === node.instanceId);
  const cost = node.operation?.costUsd ?? ran.reduce((sum, one) => sum + (one.costUsd ?? 0), 0);
  const name = path[path.length - 1] ?? node.stateId;
  const open = (slot: string, value: unknown): void => onOpen(`${name} · ${slot}`, value);

  return (
    <div className="pv-card">
      <div className="pv-card-head">
        <Badge status={node.status} />
        <span className="pv-card-name mono">{name}</span>
        <span className="pv-card-path mono ellip" title={path.join(" › ")}>
          {path.slice(0, -1).join(" › ")}
        </span>
        {onGoTo !== undefined ? (
          <button type="button" className="sp-icon" title="Go to it in the conversation" onClick={onGoTo}>
            <Icon name="comment" />
          </button>
        ) : null}
        <button type="button" className="sp-icon" title="Close the card" onClick={onClose}>
          <Icon name="cross" />
        </button>
      </div>

      <PanelSection title="Inputs">
        {inputs === undefined ? <div className="set-row pv-row pv-none">{values === undefined ? "reading…" : "none recorded"}</div> : <ValueRows value={inputs} onOpen={open} />}
      </PanelSection>
      <PanelSection title="Output">
        {output === undefined ? (
          <div className="set-row pv-row pv-none">{values === undefined ? "reading…" : node.status === "running" ? "not yet" : "none published"}</div>
        ) : (
          <ValueRows value={output} onOpen={open} />
        )}
      </PanelSection>

      <PanelSection title="How it ran">
        <PanelRow name="status" value={node.superseded ? `${node.status} · superseded` : node.status} />
        <PanelRow name="took" value={tookOf(node.startedAt, node.endedAt)} title={new Date(node.startedAt).toLocaleString()} />
        {node.operationCalls !== undefined ? (
          // An operation LIST (hw SPEC §7.1d): each call, in the order it ran.
          node.operationCalls.map((call, i) =>
            call === undefined ? null : (
              <PanelRow key={i} name={`call ${i + 1}`} value={callLine(call)} title={call.status === "failed" ? call.reason : undefined} />
            ),
          )
        ) : node.operation !== undefined ? (
          <PanelRow name="operation" value={node.operation.kind} />
        ) : null}
        {node.operation?.status === "failed" && node.operation.reason !== undefined ? <PanelRow name="why" value={node.operation.reason} /> : null}
        {cost > 0 ? <PanelRow name="cost" value={`$${cost.toFixed(cost < 0.1 ? 3 : 2)}`} /> : null}
        {ran.length > 0 ? <PanelRow name="sessions" value={ran.length} title={ran.map((one) => one.sessionId).join("\n")} /> : null}
        <PanelRow name="instance" value={node.instanceId} mono />
        <PanelRow name="configuration" value="as it ran ›" onClick={onConfig} />
      </PanelSection>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* Outputs, produced, held                                                                 */
/* ------------------------------------------------------------------------------------------------ */

const count = countOf;
const duration = durationWords;

/**
 * What the run consumed, summed across every call it made.
 *
 * Here because a cost with nothing beside it is a number you can only believe or disbelieve. Tokens
 * are what make it checkable: `$0.21` next to 40k cached input tokens is an agent session doing
 * ordinary work, and next to 300 tokens it is a bug — and those two used to look identical.
 *
 * `costSource` is shown whenever it is anything other than the provider's own figure, because that
 * is the difference between a charge and an estimate. JaiRA computes neither: it records what the
 * executor reported, and this says which kind of number that was.
 */
export function RunMetrics({ states }: { states: SessionRef[] }): JSX.Element | null {
  const metrics = runMetricsOf(states);
  if (metrics === null) return null;
  const { started, spent, cost, source, input, output, cached, written, reasoning } = metrics;

  return (
    <PanelSection title="What it consumed" action={<span className="count">{states.length} calls</span>}>
      {started !== undefined ? <PanelRow name="started" value={new Date(started).toLocaleString()} title={new Date(started).toISOString()} /> : null}
      {spent !== undefined ? <PanelRow name="in calls" value={duration(spent)} /> : null}
      {cost !== undefined ? (
        <PanelRow
          name="cost"
          value={
            <>
              ${cost.toFixed(4)}
              {/* Only when it is NOT the provider's own charge. A silent estimate is the one that
                  gets quoted back as a fact. */}
              {source !== undefined && source !== "provider" ? (
                <span className="chip chip-warn" title="not the provider's own charge">
                  {source === "table" ? "price table" : "unknown"}
                </span>
              ) : null}
            </>
          }
        />
      ) : null}
      {input !== undefined ? <PanelRow name="in" value={count(input)} title="total billed input, including cache reads and writes" /> : null}
      {output !== undefined ? <PanelRow name="out" value={<>{count(output)}{reasoning !== undefined ? <span className="sub"> · {count(reasoning)} thinking</span> : null}</>} /> : null}
      {cached !== undefined || written !== undefined ? (
        <PanelRow
          name="cache"
          title="read at roughly a tenth of the base rate; written above it"
          value={`${cached !== undefined ? `${count(cached)} read` : "—"}${written !== undefined ? ` · ${count(written)} written` : ""}`}
        />
      ) : null}
    </PanelSection>
  );
}

/** What the task's last run published, a row per output — and what the run consumed getting there. */
export function OutputsView({ detail, sessions, onOpen }: { detail: TaskDetail; sessions: SessionRef[]; onOpen: (title: string, value: unknown) => void }): JSX.Element {
  const latest = detail.runs[detail.runs.length - 1];
  return (
    <>
      {latest?.outputs === undefined ? (
        <p className="empty">{detail.status === "running" ? "Nothing published yet." : "This task published no outputs."}</p>
      ) : (
        <PanelSection title="Published">
          <ValueRows value={latest.outputs} onOpen={(slot, value) => onOpen(`output · ${slot}`, value)} />
        </PanelSection>
      )}
      <RunMetrics states={sessions} />
    </>
  );
}

/**
 * What a conversation PRODUCED — the artifact map as a list, with the chosen one drawn under it.
 * It was a disclosure over the chat's thread; it is a tab here, because the thread pushes whatever is
 * above it off the screen and the panel is where a thing is held still.
 */
export function ProducedView({
  taskId,
  project,
  signal,
  artifacts,
  onOpen,
  onHold,
}: {
  taskId: string;
  project?: string | undefined;
  signal: unknown;
  artifacts: ArtifactSurface;
  onOpen: (item: PinnedValue) => void;
  onHold: (item: PinnedValue) => void;
}): JSX.Element {
  const [list, setList] = useState<ArtifactSummary[] | undefined>(undefined);
  const [selected, setSelected] = useState<string | null>(null);
  const [doc, setDoc] = useState<{ path: string; text: string } | null>(null);
  useEffect(() => {
    let live = true;
    void invoke("artifact:list", { taskId, ...(project !== undefined ? { project } : {}) })
      .then((rows) => live && setList(rows))
      .catch(() => live && setList([]));
    return () => {
      live = false;
    };
  }, [taskId, project, signal]);
  useEffect(() => {
    if (selected === null) {
      setDoc(null);
      return;
    }
    let live = true;
    void invoke("uri:read", { uri: `artifact://${taskId}/${selected}`, ...(project !== undefined ? { project } : {}) })
      .then((content) => live && setDoc({ path: selected, text: content.text }))
      .catch(() => live && setDoc(null));
    return () => {
      live = false;
    };
  }, [selected, taskId, project]);

  if (list === undefined) return <p className="empty">Reading what it produced…</p>;
  if (list.length === 0) return <p className="empty">Nothing produced yet.</p>;
  const shown = list.find((row) => row.path === selected);
  // `panelViewsModel.ts`' `producedValueOf`, shared with the universal copy.
  const valueOf = producedValueOf;
  const item = (row: ArtifactSummary, text: string): PinnedValue => ({ title: row.path, value: valueOf(row, text), serve: artifacts.serve, ...(artifacts.onPrompt !== undefined ? { onPrompt: artifacts.onPrompt } : {}) });
  return (
    <>
      <PanelSection title="Produced" action={<span className="count">{list.length}</span>}>
        {list.map((row) => (
          <button
            type="button"
            key={row.path}
            className={`set-row pv-row clickable${row.path === selected ? " sel" : ""}`}
            onClick={() => setSelected(row.path === selected ? null : row.path)}
          >
            <span className="pv-row-name mono ellip" title={row.path}>
              {row.path}
            </span>
            <span className="pv-row-value">
              {row.interactive ? <span className="chip chat-artifact-live">runs</span> : null} {sizeOf(row.bytes)}
            </span>
          </button>
        ))}
      </PanelSection>
      {shown !== undefined && doc !== null ? (
        <div className="pv-artifact">
          <ValueView
            value={valueOf(shown, doc.text)}
            serve={artifacts.serve}
            {...(artifacts.onPrompt !== undefined ? { onPrompt: artifacts.onPrompt } : {})}
            actions={
              <span className="pv-artifact-acts">
                <button type="button" className="sp-icon" title="Open it on its own, in this panel" onClick={() => onOpen(item(shown, doc.text))}>
                  <Icon name="read" />
                </button>
                <button type="button" className="sp-icon" title="Hold it — keep it in Held" onClick={() => onHold(item(shown, doc.text))}>
                  <Icon name="pin" />
                </button>
              </span>
            }
          />
        </div>
      ) : null}
    </>
  );
}

/** The values somebody asked the panel to HOLD, each with a way to let go of it. */
export function HeldView({ held, onOpen, onDrop }: { held: readonly PinnedValue[]; onOpen: (item: PinnedValue) => void; onDrop: (item: PinnedValue) => void }): JSX.Element {
  if (held.length === 0) {
    return <p className="empty">Nothing held. A value&apos;s ⋯ → Hold keeps it here while the conversation goes on.</p>;
  }
  return (
    <PanelSection title="Held" action={<span className="count">{held.length}</span>}>
      {held.map((item) => (
        <div key={item.title} className="set-row pv-row pv-held">
          <button type="button" className="pv-row-name link ellip" title={`open ${item.title}`} onClick={() => onOpen(item)}>
            {item.title}
          </button>
          <button type="button" className="sp-icon" title="Let go of it" onClick={() => onDrop(item)}>
            <Icon name="cross" />
          </button>
        </div>
      ))}
    </PanelSection>
  );
}

/**
 * A value on its own — the Preview card. The viewer inside has no panel to open itself in (the
 * provider is cleared), so its ⋯ offers what makes sense here: save it.
 */
export function PreviewCard({ item, onHold, held }: { item: PinnedValue; onHold?: (() => void) | undefined; held?: boolean }): JSX.Element {
  return (
    <div className={item.node === undefined ? "pinned-body pv-preview" : "pinned-body pv-preview pinned-surface"}>
      <ValuePanelContext.Provider value={null}>
        {item.node ?? (
          <ValueView
            value={item.value}
            {...(item.hint !== undefined ? { hint: item.hint } : {})}
            {...(item.label !== undefined ? { label: item.label } : {})}
            {...(item.serve !== undefined ? { serve: item.serve } : {})}
            {...(item.onPrompt !== undefined ? { onPrompt: item.onPrompt } : {})}
            {...(onHold !== undefined
              ? {
                  actions: (
                    <button type="button" className={`sp-icon${held === true ? " on" : ""}`} title={held === true ? "Held" : "Hold it — keep it in Held"} onClick={onHold}>
                      <Icon name="pin" />
                    </button>
                  ),
                }
              : {})}
          />
        )}
      </ValuePanelContext.Provider>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* A state's Checks                                                                                 */
/* ------------------------------------------------------------------------------------------------ */

/**
 * Everything the old state inspector said below its Run form: whether it lints, what it runs on, where
 * it goes next, what it is made of, who it names and who names it, and whether tasks are pinned to an
 * older copy. One section each, rows in the settings shape.
 */
export function StateChecks({
  state,
  onRevealIssue,
  onOpenConfig,
  onOpenState,
}: {
  state: StateView;
  onRevealIssue?: ((path: string) => void) | undefined;
  onOpenConfig?: (() => void) | undefined;
  onOpenState?: ((stateId: string) => void) | undefined;
}): JSX.Element {
  return (
    <>
      {state.fileOnly ? (
        <div className="notice">Read from the file alone, with no project open. Lint results, dependants, drift and runs are not known — open a project to see them.</div>
      ) : null}
      <PanelSection title="Validation" action={state.issues.length > 0 ? <span className="count">{state.issues.length}</span> : undefined}>
        {state.issues.length === 0 ? (
          <div className="set-row pv-row pv-none">{state.fileOnly ? "not checked" : "lints clean"}</div>
        ) : (
          state.issues.map((issue, i) => (
            <PanelRow
              key={i}
              name={<span className={issue.severity === "error" ? "pv-bad" : "pv-warn"}>{issue.path === "" ? "this file" : issue.path}</span>}
              value={issue.message}
              {...(onRevealIssue !== undefined && issue.path.length > 0 ? { onClick: () => onRevealIssue(issue.path), title: "show the control this is about" } : {})}
            />
          ))
        )}
      </PanelSection>

      <PanelSection title="Environment">
        {state.environment.executor === undefined ? (
          <div className="set-row pv-row pv-none">no executor named — inherited or not a function operation</div>
        ) : (
          <>
            <PanelRow name="executor" value={<>{state.environment.executor} <span className={`chip ${state.environment.available ? "chip-ok" : "chip-bad"}`}>{state.environment.available ? "available" : "not available"}</span></>} mono />
            {state.environment.from !== undefined ? <PanelRow name="from" value={state.environment.from} mono /> : null}
          </>
        )}
        {state.operation?.model !== undefined ? <PanelRow name="model" value={state.operation.model} mono /> : null}
        {onOpenConfig !== undefined ? <PanelRow name="effective configuration" value="read ›" onClick={onOpenConfig} /> : null}
      </PanelSection>

      {state.transitions.length > 0 ? (
        <PanelSection title="Transitions" action={<span className="count">{state.transitions.length}</span>}>
          {state.transitions.map((t, i) => (
            <PanelRow key={i} name={<span className="mono">{t.when}</span>} value={`→ ${t.to.split("/").pop()}${t.loops ? " ↺" : ""}`} mono />
          ))}
        </PanelSection>
      ) : null}

      {state.children.length > 0 ? (
        <PanelSection title="Children" action={<span className="count">in run order</span>}>
          {state.children.map((child) => (
            <PanelRow key={child.key} name={<span className="mono">{child.key}</span>} value={child.hasChildren ? "composite" : undefined} />
          ))}
        </PanelSection>
      ) : null}

      {state.references.length > 0 ? (
        <PanelSection title="References">
          {state.references.map((ref) => (
            <PanelRow key={ref.ref} name={<span className="mono ellip">{ref.ref}</span>} value={ref.resolved ? "resolves" : <span className="pv-bad">missing</span>} />
          ))}
        </PanelSection>
      ) : null}

      {state.referencedBy.length > 0 ? (
        <PanelSection title="Referenced by">
          {state.referencedBy.map((id) => (
            <PanelRow key={id} name={<span className="mono ellip">{id}</span>} {...(onOpenState !== undefined ? { value: "open ›", onClick: () => onOpenState(id) } : {})} />
          ))}
        </PanelSection>
      ) : null}

      {state.driftedTasks.length > 0 ? (
        <PanelSection title="Snapshot drift">
          <div className="set-row pv-row pv-warn">
            {state.driftedTasks.length} task(s) here are pinned to an older snapshot and will not see an edit until they are re-run.
          </div>
        </PanelSection>
      ) : null}
    </>
  );
}

// `useEffectiveRead` is `configPanelModel.ts`'s, so the universal config card reads the same way.
export { useEffectiveRead } from "./configPanelModel";

/** What a re-run with changes needs: the workflow's form, filled with what the task was called with. */
export interface RerunSurface {
  workflow: string;
  /** Undefined while the workflow's inputs are being read; null when its file does not parse. */
  fields: RunField[] | null | undefined;
  values: RunValues;
  busy: boolean;
  onChange: (values: RunValues) => void;
  onRun: (inputs: Record<string, JsonValue>) => void;
  /**
   * Where a copy may START — the beginning, or before any state the task entered (the person's
   * ruling, 2026-09-24). A step is a FORK at that state's entry: everything before it is kept, so the
   * inputs are the ones it ran with and the form is a reading of them.
   */
  starts?: readonly { seq: number; label: string }[] | undefined;
  onFork?: ((seq: number) => void) | undefined;
}

/**
 * A copy of a task with its inputs changed — the form its workflow declares, opening on the values
 * the task was called with. Starting it makes a NEW task; the one it came from is left as it ran.
 */
export function RerunForm({ run, onCancel }: { run: RerunSurface; onCancel: () => void }): JSX.Element {
  // Where the copy starts and why the button is off — `newTaskModel.ts`'s, shared with the universal copy.
  const { check, touched, touch, from, setFrom, forking, blocked, startLabel } = useRerunForm(run);
  return (
    <form
      className="new-task-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (blocked !== null) return;
        if (forking) run.onFork?.(Number(from));
        else run.onRun(runInputsOf(run.fields ?? [], run.values));
      }}
    >
      {run.starts !== undefined && run.starts.length > 0 && run.onFork !== undefined ? (
        <label className="field">
          <span>Start from</span>
          <SelectInput
            value={from}
            options={[["the beginning", ""], ...run.starts.map((one): [string, string] => [`before ${one.label}`, String(one.seq)])]}
            onChange={setFrom}
          />
        </label>
      ) : null}
      {forking ? (
        <div className="sub">Everything before {startLabel} is kept, so the copy runs with the inputs this task had.</div>
      ) : run.fields === undefined ? (
        <div className="sub">reading its inputs…</div>
      ) : run.fields === null ? (
        <div className="notice bad">That workflow&apos;s file does not parse, so its inputs cannot be read.</div>
      ) : run.fields.length === 0 ? (
        <div className="sub">This workflow declares no inputs — the copy will run the same.</div>
      ) : (
        <RunInputsForm fields={run.fields} values={run.values} check={check} touched={touched} touch={touch} onChange={run.onChange} />
      )}
      <div className="pane-actions">
        <button type="submit" className="primary" disabled={blocked !== null} title={blocked ?? (forking ? `a copy that starts before ${startLabel}` : `starts a new ${run.workflow}`)}>
          {forking ? "Start the copy there" : "Start the copy"}
        </button>
        <button type="button" className="ghost" onClick={onCancel}>
          Cancel
        </button>
        {blocked !== null && blocked.length > 0 ? <span className="sub ellip">{blocked}</span> : null}
      </div>
    </form>
  );
}

/** Re-exported for the faces, which build pinned values from a JSON value. */
export type { JsonValue };
