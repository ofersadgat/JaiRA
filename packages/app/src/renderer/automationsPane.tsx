/**
 * Settings → Tools → Automations (decision 0010 §4, mockup B.2; the rulings of 2026-09-25): the editor
 * of a layer's built-in `system/events` workflow and of the state each of its lines runs. Each line is
 * one named transition of the events task — it waits for an event and enters the line's state, whose
 * steps (start a task, tell me) are ONE operation list run in order — and the task goes back to waiting.
 *
 * {@link AutomationsView} is a render function over what `automationsModel.ts` says: every piece of
 * state arrives as a prop, and each state it can be in is one `renderToStaticMarkup`. The host
 * ({@link AutomationsPane}) reads the layers' copies of the root and of each line's state, holds what is
 * being edited until it can be written, and writes — copying on the first edit (a project's copy
 * `$ref`s Shared's, and Shared's is made from the built-in first when it has none), and asking where
 * on the personal layer, which holds no workflow files.
 *
 * On a project page Shared's lines are editable too. Their STEPS changed there are the project's own
 * copy of that one state file — for this project alone, and said so on the line; their event, filter
 * or name changed there make a line of the project's own of that name, and Shared's is ignored here.
 */
import { useCallback, useEffect, useRef, useState, type DragEvent, type JSX } from "react";
import {
  EVENT_NAMES,
  EVENT_SPECS,
  isEventName,
  type ConfigLayer,
  type EventsStatusView,
  type JairaEventsConfig,
  type WorkflowLayer,
  type WorkflowSource,
  type WritableLayer,
} from "@jaira/shared/browser";
import {
  automationStateIdOf,
  automationsReadOf,
  automationsWritesOf,
  EVENTS_STATE_ID,
  eventOnAnywhere,
  eventPicksOf,
  filterFormOf,
  filterOfForm,
  filterSchemaOf,
  flagText,
  freshLineName,
  lineFlagsOf,
  linesProblem,
  moveLine,
  rebaseLines,
  sharedStepsWritesOf,
  shownLinesOf,
  stepFormOf,
  stepOfForm,
  stepSummary,
  whenOf,
  type AutomationLine,
  type AutomationStep,
  type AutomationWrite,
  type Copies,
  type LayerFiles,
  type LineFlag,
  type ShownLine,
} from "./automationsModel";
import { TextInput } from "./controls";
import { connectionBadgeOf, JAIRA_BADGE, type ConnectionBadge } from "./eventsModel";
import { ConnectionPill } from "./eventsPane";
import { runSchemaOf, type RunField } from "./runForm";
import { SchemaForm } from "./schemaForm/SchemaForm";
import type { ValueSources } from "./schemaForm/types";
import { Segmented, SettingsSection } from "./settingsLayout";

const EVENTS_LIST = "au-events";
const WORKFLOWS_LIST = "au-workflows";
const LINE_DRAG = "application/x-jaira-automation";

const INTO_NAME: Readonly<Record<WritableLayer, string>> = { base: "Shared", project: "this project" };

// --- the view --------------------------------------------------------------------------------

export interface AutomationsViewProps {
  /** Which layer's file the section's own lines are. */
  reads: WritableLayer;
  /**
   * Where those lines come from: the layer's own copy, the built-in (Shared with no copy yet), or
   * nothing (a project with no copy — its own lines are none, and Shared's are all spliced in).
   */
  source: "copy" | "built in" | "none";
  shown: readonly ShownLine[];
  /** The `events` block in effect — which events are switched on. */
  events: JairaEventsConfig;
  status: EventsStatusView | null;
  /** The workflows a step can start. */
  workflows: ReadonlyArray<{ id: string; label?: string | undefined }>;
  /** Each workflow's declared inputs, once read — absent: not read yet; null: unreadable. */
  forms: Readonly<Record<string, RunField[] | null>>;
  locked: boolean;
  /** Why what is on screen is not written yet, or why a write was refused. */
  problem: string | null;
  told: string | null;
  /** The personal layer's first change is held: where does it go? */
  asking: readonly WritableLayer[] | null;
  /** The layer's name in the footer: the project's, or Shared. */
  layerName: string;
  /** The events task exists, so its conversation can be opened. */
  hasTask: boolean;
  onLines: (lines: AutomationLine[]) => void;
  /** A Shared line edited on a project page — `before` as Shared has it, `next` as it is now. */
  onSharedLine: (before: AutomationLine, next: AutomationLine) => void;
  /** Take a project's own copy of a Shared line's steps away: Shared's run here again. */
  onUseSharedSteps: (name: string) => void;
  onIgnore: (name: string, ignored: boolean) => void;
  onAnswer: (into: WritableLayer | null) => void;
  onOpenConversation: () => void;
  onEditFile: () => void;
  onOpenEvents: () => void;
  onOpenConnections?: () => void;
}

/** The connection a line's event comes through: the remote its filter names, else the first. */
function badgeFor(line: AutomationLine, status: EventsStatusView | null): ConnectionBadge | undefined {
  if (!isEventName(line.event)) return undefined;
  if (EVENT_SPECS[line.event].group === "task") return JAIRA_BADGE;
  const remotes = status?.remotes ?? [];
  const named = typeof line.filter.remote === "string" ? remotes.find((remote) => remote.name === line.filter.remote) : undefined;
  const remote = named ?? remotes[0];
  return remote === undefined ? undefined : connectionBadgeOf(remote);
}

/** A name box that says its new name when it is left, not at every letter. */
function NameBox({ name, disabled, onRename }: { name: string; disabled: boolean; onRename: (next: string) => void }): JSX.Element {
  const [text, setText] = useState(name);
  const was = useRef(name);
  if (was.current !== name) {
    was.current = name;
    setText(name);
  }
  const commit = (): void => {
    if (text !== name) onRename(text.trim());
  };
  return (
    <span className="au-name">
      <TextInput value={text} mono label="name of this line" disabled={disabled} onChange={setText} onBlur={commit} onKeyDown={(e) => (e.key === "Enter" ? commit() : undefined)} />
    </span>
  );
}

/**
 * A line's filter: the keys it states, as a schema form, and a `+ key` for each other key the event
 * takes — so a push's line is not three empty boxes. A key opened here stays drawn until it is left.
 */
function FilterEditor({ line, disabled, onFilter }: { line: AutomationLine; disabled: boolean; onFilter: (filter: AutomationLine["filter"]) => void }): JSX.Element | null {
  const [opened, setOpened] = useState<readonly string[]>([]);
  if (!isEventName(line.event)) return null;
  const keys = EVENT_SPECS[line.event].filters;
  if (keys.length === 0) return null;
  const all = filterSchemaOf(line.event);
  const properties = (all["properties"] ?? {}) as Record<string, unknown>;
  const shown = keys.filter((key) => line.filter[key] !== undefined || opened.includes(key));
  const offered = keys.filter((key) => !shown.includes(key));
  return (
    <div className="au-filter">
      {shown.length > 0 ? (
        <SchemaForm
          schema={{ ...all, properties: Object.fromEntries(shown.map((key) => [key, properties[key]])), required: shown }}
          value={Object.fromEntries(shown.map((key) => [key, filterFormOf(line.filter)[key] ?? []]))}
          onChange={(next) => onFilter(filterOfForm(next))}
          ctx={{ path: "", labels: "keys", hidePaths: true, disabled, addLabel: () => "+ glob" }}
        />
      ) : null}
      {offered.length > 0 ? (
        <div className="au-filter-add">
          <span className="au-word">only where</span>
          {offered.map((key) => (
            <button key={key} type="button" className="set-add" disabled={disabled} onClick={() => setOpened([...opened, key])}>
              <span className="set-plus" aria-hidden="true">
                +
              </span>
              <span className="cx-opt-hint mono">{key}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function FlagLine({ flag, onOpenEvents }: { flag: LineFlag; onOpenEvents: () => void }): JSX.Element {
  return (
    <p className="set-desc warn-text au-flag">
      {flagText(flag)}
      {flag.kind === "off" ? (
        <>
          {" "}
          <button type="button" className="link au-link" onClick={onOpenEvents}>
            Switch it on in Events
          </button>
        </>
      ) : null}
    </p>
  );
}

/** One step of a line — one call of its state's operation list — editable. */
function StepEditor({
  step,
  index,
  line,
  props,
  onStep,
  onRemove,
}: {
  step: AutomationStep;
  index: number;
  line: AutomationLine;
  props: AutomationsViewProps;
  onStep: (next: AutomationStep) => void;
  onRemove: (() => void) | undefined;
}): JSX.Element {
  const kind = step.kind;
  const fields = step.kind === "start" && step.workflow.length > 0 ? props.forms[step.workflow] : undefined;
  const form = step.kind === "start" ? stepFormOf(step) : undefined;
  const picks = eventPicksOf(line.event);
  const sources: ValueSources | undefined =
    step.kind === "start" && form !== undefined
      ? {
          label: "from the event",
          optionsFor: () => picks,
          picked: (path) => form.picked[path],
          pick: (path, id) => {
            const picked = { ...form.picked };
            if (id === undefined) delete picked[path];
            else picked[path] = id;
            onStep(stepOfForm(step, form.values, picked));
          },
        }
      : undefined;
  return (
    <li className="au-action">
      <div className="au-action-head">
        <span className="au-n">{index + 1}</span>
        {index > 0 ? <span className="au-word">then</span> : null}
        <Segmented
          value={kind}
          label={`what step ${index + 1} does`}
          disabled={props.locked}
          options={[
            ["start", "start"],
            ["tell me", "notify"],
          ]}
          onChange={(next) => {
            if (next === kind) return;
            onStep(next === "start" ? { kind: "start", workflow: "", inputs: {} } : { kind: "notify", text: "" });
          }}
        />
        {step.kind === "start" ? (
          <>
            <span className="au-wf">
              <TextInput value={step.workflow} mono list={WORKFLOWS_LIST} placeholder="a workflow — feature/review" label={`the workflow step ${index + 1} starts`} disabled={props.locked} onChange={(workflow) => onStep({ ...step, workflow })} />
            </span>
            {/* The rulings of 2026-09-25: a started task is the events task's child unless it is asked
                to stand on its own — then it is not filed under the events task, and its card says so. */}
            <Segmented
              value={step.topLevel === true ? "top" : "child"}
              label={`how step ${index + 1} starts its task`}
              disabled={props.locked}
              options={[
                ["as a child", "child"],
                ["on its own", "top"],
              ]}
              onChange={(how) => {
                const { topLevel: _was, ...rest } = step;
                onStep(how === "top" ? { ...rest, topLevel: true } : rest);
              }}
            />
          </>
        ) : (
          <span className="au-note">
            <TextInput value={step.text} placeholder="what to tell you" label={`what step ${index + 1} tells you`} disabled={props.locked} onChange={(text) => onStep({ kind: "notify", text })} />
          </span>
        )}
        {onRemove !== undefined ? (
          <button type="button" className="quiet au-remove" title="remove this step" aria-label="remove this step" disabled={props.locked} onClick={onRemove}>
            ×
          </button>
        ) : null}
      </div>
      {step.kind === "start" && form !== undefined ? (
        fields === undefined ? (
          step.workflow.length > 0 ? <p className="cfg-hint au-inputs-note">reading its inputs…</p> : null
        ) : fields === null ? (
          <p className="cfg-hint warn-text au-inputs-note">{step.workflow} does not parse, so its inputs cannot be read.</p>
        ) : fields.length === 0 ? (
          <p className="cfg-hint au-inputs-note">no inputs</p>
        ) : (
          <div className="au-inputs">
            <SchemaForm
              schema={runSchemaOf(fields)}
              value={form.values}
              onChange={(next) => onStep(stepOfForm(step, next as Record<string, unknown>, form.picked))}
              ctx={{ path: "", labels: "keys", disabled: props.locked, ...(sources !== undefined ? { sources } : {}) }}
            />
          </div>
        )
      ) : null}
    </li>
  );
}

/** A line's event, filter and steps, editable — the same for a line of the layer's own and a Shared line on a project page. */
function LineBody({ line, props, onLine }: { line: AutomationLine; props: AutomationsViewProps; onLine: (next: AutomationLine) => void }): JSX.Element {
  const badge = badgeFor(line, props.status);
  return (
    <>
      <div className="au-when">
        <span className="au-word">When</span>
        <span className="au-event">
          <TextInput value={line.event} mono list={EVENTS_LIST} placeholder="an event — git.push" label="the event this line waits for" disabled={props.locked} onChange={(event) => onLine({ ...line, event, filter: {} })} />
        </span>
        {badge !== undefined ? <ConnectionPill badge={badge} onOpenConnections={props.onOpenConnections} /> : null}
      </div>
      <FilterEditor line={line} disabled={props.locked} onFilter={(filter) => onLine({ ...line, filter })} />
      <ol className="au-actions">
        {line.steps.map((step, s) => (
          <StepEditor
            key={s}
            step={step}
            index={s}
            line={line}
            props={props}
            onStep={(next) => onLine({ ...line, steps: line.steps.map((one, k) => (k === s ? next : one)) })}
            onRemove={line.steps.length > 1 ? () => onLine({ ...line, steps: line.steps.filter((_, k) => k !== s) }) : undefined}
          />
        ))}
      </ol>
      {line.steps.length > 1 ? <p className="cfg-hint au-order">In order: each step starts when the one before it has finished.</p> : null}
      <div className="au-add-action">
        <button type="button" className="set-add" disabled={props.locked} onClick={() => onLine({ ...line, steps: [...line.steps, { kind: "start", workflow: "", inputs: {} }] })}>
          <span className="set-plus" aria-hidden="true">
            +
          </span>
          <span className="cx-opt-hint">then…</span>
        </button>
      </div>
    </>
  );
}

export function AutomationsView(props: AutomationsViewProps): JSX.Element {
  const own = props.shown.filter((shown) => shown.from === "own").map((shown) => shown.line);
  const flags = lineFlagsOf(props.shown, props.events);
  const setLine = (i: number, next: AutomationLine): void => props.onLines(own.map((line, j) => (j === i ? next : line)));
  const hasShared = props.shown.some((shown) => shown.from === "shared");

  const drop = (to: number) => (e: DragEvent): void => {
    const from = Number(e.dataTransfer.getData(LINE_DRAG));
    e.preventDefault();
    if (!Number.isInteger(from) || from === to) return;
    props.onLines(moveLine(own, from, to));
  };

  const rawBody = (line: AutomationLine): JSX.Element => (
    <>
      <div className="au-when">
        <span className="au-word">When</span>
        <code className="au-raw">{typeof line.raw?.rule["when"] === "string" ? line.raw.rule["when"] : "—"}</code>
      </div>
      <p className="cfg-hint au-order">
        Written by hand in the file, so it is edited there.{" "}
        <button type="button" className="link au-link" onClick={props.onEditFile}>
          Edit as a workflow file
        </button>
      </p>
    </>
  );

  /** Where a project page's line runs its steps from, when that is worth saying. */
  const stepsNote = (shown: ShownLine): JSX.Element | null => {
    if (props.reads !== "project" || shown.line.raw !== undefined) return null;
    if (shown.from === "shared" && shown.stepsFrom === "project") {
      return (
        <p className="cfg-hint au-order au-steps-own">
          Its steps are changed for this project only, in this project's <span className="mono">{automationStateIdOf(shown.line.name)}</span>; Shared's line and every other project keep Shared's.{" "}
          <button type="button" className="link au-link" disabled={props.locked} onClick={() => props.onUseSharedSteps(shown.line.name)}>
            Use Shared's steps
          </button>
        </p>
      );
    }
    if (shown.from === "shared") return <p className="cfg-hint au-order">A change to its steps here is this project's own copy of them; a change to its event or filter makes it a line of this project's.</p>;
    if (shown.replaces === true) return <p className="cfg-hint au-order">This project's version of Shared's line of this name, which is ignored here.</p>;
    return null;
  };

  const ownRow = (shown: ShownLine, i: number, lineFlags: LineFlag[]): JSX.Element => {
    const { line } = shown;
    const off = isEventName(line.event) && !eventOnAnywhere(props.events, line.event);
    return (
      <div
        key={`own:${i}`}
        className={`set-row au-row${off ? " au-off" : ""}${lineFlags.length > 0 ? " au-flagged" : ""}`}
        onDragOver={(e) => e.preventDefault()}
        onDrop={drop(i)}
      >
        <div className="set-row-line">
          <div className="set-row-say">
            <div className="au-head">
              <span
                className="au-grip"
                role="button"
                tabIndex={0}
                draggable={!props.locked}
                title="drag to reorder — the first line that matches wins"
                aria-label="drag to reorder"
                onDragStart={(e) => e.dataTransfer.setData(LINE_DRAG, String(i))}
              >
                ⋮⋮
              </span>
              {line.raw === undefined ? (
                <NameBox name={line.name} disabled={props.locked} onRename={(name) => setLine(i, { ...line, name })} />
              ) : (
                <span className="mono au-name-static">{line.name}</span>
              )}
            </div>
            {line.raw !== undefined ? rawBody(line) : <LineBody line={line} props={props} onLine={(next) => setLine(i, next)} />}
            {stepsNote(shown)}
            {lineFlags.map((flag, f) => (
              <FlagLine key={f} flag={flag} onOpenEvents={props.onOpenEvents} />
            ))}
          </div>
          <div className="set-ctl">
            <button type="button" className="quiet au-remove" title="remove this line" aria-label="remove this line" disabled={props.locked} onClick={() => props.onLines(own.filter((_, j) => j !== i))}>
              ×
            </button>
          </div>
        </div>
      </div>
    );
  };

  const sharedRow = (shown: ShownLine, i: number, lineFlags: LineFlag[]): JSX.Element => {
    const { line } = shown;
    const badge = badgeFor(line, props.status);
    const editable = !shown.ignored && line.raw === undefined;
    return (
      <div key={`shared:${i}`} className={`set-row au-row au-shared${shown.ignored ? " au-ignored" : ""}`}>
        <div className="set-row-line">
          <div className="set-row-say">
            <div className="au-head">
              {editable ? (
                <NameBox name={line.name} disabled={props.locked} onRename={(name) => props.onSharedLine(line, { ...line, name })} />
              ) : (
                <span className="mono au-name-static">{line.name}</span>
              )}
              <span className="cx-src" title="A line of Shared's events workflow, read through this project's copy">
                from Shared
              </span>
            </div>
            {editable ? (
              <LineBody line={line} props={props} onLine={(next) => props.onSharedLine(line, next)} />
            ) : (
              <>
                <div className="au-when">
                  <span className="au-word">When</span>
                  <code className="au-raw">{line.raw !== undefined ? String(line.raw.rule["when"] ?? "—") : whenOf(line.event, line.filter)}</code>
                  {badge !== undefined ? <ConnectionPill badge={badge} onOpenConnections={props.onOpenConnections} /> : null}
                </div>
                {line.raw === undefined ? (
                  <ol className="au-actions">
                    {line.steps.map((step, s) => (
                      <li key={s} className="au-action">
                        <div className="au-action-head">
                          <span className="au-n">{s + 1}</span>
                          {s > 0 ? <span className="au-word">then</span> : null}
                          <span className="au-word">{step.kind === "start" ? "start" : "tell me"}</span>
                          {step.kind === "start" ? <span className="mono">{step.workflow}</span> : null}
                          <span className="cfg-hint au-summary">{stepSummary(step)}</span>
                        </div>
                      </li>
                    ))}
                  </ol>
                ) : null}
              </>
            )}
            {shown.ignored ? null : stepsNote(shown)}
            {lineFlags.map((flag, f) => (
              <FlagLine key={f} flag={flag} onOpenEvents={props.onOpenEvents} />
            ))}
          </div>
          <div className="set-ctl">
            {shown.ignored ? (
              <span className="cfg-hint">
                ignored here ·{" "}
                <button type="button" className="link au-link" disabled={props.locked} onClick={() => props.onIgnore(line.name, false)}>
                  Put back
                </button>
              </span>
            ) : (
              <button
                type="button"
                className="ghost"
                disabled={props.locked}
                title="Leave this line out of this project's events task (writes the filter in this project's copy)"
                onClick={() => props.onIgnore(line.name, true)}
              >
                Ignore in this project
              </button>
            )}
          </div>
        </div>
      </div>
    );
  };

  let ownIndex = -1;
  return (
    <SettingsSection
      id="automations"
      title="Automations"
      info="Transitions are first-match: an event goes to the first line whose event and filter it matches. A line's steps run in order, while the task keeps waiting for the next event. A line a line above always catches is flagged."
      lead="What happens when an event arrives. Each line is a transition of the built-in events task: it waits for the event, starts the task you pick, and goes back to waiting."
    >
      <datalist id={EVENTS_LIST}>
        {EVENT_NAMES.map((name) => (
          <option key={name} value={name}>
            {EVENT_SPECS[name].label}
            {eventOnAnywhere(props.events, name) ? "" : " · switched off"}
          </option>
        ))}
      </datalist>
      <datalist id={WORKFLOWS_LIST}>
        {props.workflows.map((workflow) => (
          <option key={workflow.id} value={workflow.id}>
            {workflow.label ?? workflow.id}
          </option>
        ))}
      </datalist>
      {props.shown.length > 0 && props.shown[0]!.from === "own" && hasShared ? <div className="ev-group app-label">This project</div> : null}
      {props.shown.map((shown, i) => {
        if (shown.from === "own") {
          ownIndex++;
          return ownRow(shown, ownIndex, flags[i] ?? []);
        }
        const first = i === 0 || props.shown[i - 1]!.from === "own";
        return [first ? <div key="shared-head" className="ev-group app-label">From Shared · ~/.jaira</div> : null, sharedRow(shown, i, flags[i] ?? [])];
      })}
      {props.shown.length === 0 ? <p className="cfg-hint au-empty">No automations yet. Add one, and the events task starts waiting for its event.</p> : null}
      {props.asking !== null ? (
        <div className="set-ask au-ask" role="group" aria-label="Where this change goes">
          <span>Just you is one settings file, and automations are a workflow file. Write this change to:</span>
          <div className="pane-actions">
            {props.asking.map((into, i) => (
              <button key={into} type="button" className={i === 0 ? "primary" : "ghost"} disabled={props.locked} onClick={() => props.onAnswer(into)}>
                {INTO_NAME[into] === "this project" ? "This project" : INTO_NAME[into]}
              </button>
            ))}
            <button type="button" className="ghost" onClick={() => props.onAnswer(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      {props.problem !== null ? <p className="cfg-hint warn-text au-problem">{props.problem}</p> : null}
      {props.told !== null ? (
        <p className="cfg-hint au-told" role="status">
          {props.told}
        </p>
      ) : null}
      <div className="set-row au-add">
        <button
          type="button"
          className="set-add"
          disabled={props.locked}
          onClick={() =>
            props.onLines([...own, { name: freshLineName(props.shown.map((shown) => shown.line.name)), event: "git.push", filter: {}, steps: [{ kind: "start", workflow: "", inputs: {} }] }])
          }
        >
          <span className="set-plus" aria-hidden="true">
            +
          </span>
          <span className="cx-opt-hint">automation</span>
        </button>
      </div>
      <div className="set-row au-foot">
        <p className="cfg-hint">
          Runs as the task <span className="mono">events</span> in {props.layerName}
          {props.source === "built in" ? " · as JaiRA ships it until you change it" : ""} ·{" "}
          <button type="button" className="link au-link" disabled={!props.hasTask} title={props.hasTask ? undefined : "The events task has not started here yet"} onClick={props.onOpenConversation}>
            Open its conversation
          </button>{" "}
          ·{" "}
          <button type="button" className="link au-link" onClick={props.onEditFile}>
            Edit as a workflow file
          </button>
        </p>
      </div>
    </SettingsSection>
  );
}

// --- the host ---------------------------------------------------------------------------------

/** What the host asks main for: a state file of a layer — the events root, or an automation's state. */
export interface AutomationsChannel {
  read: (layer: WorkflowLayer, stateId: string) => Promise<WorkflowSource>;
  write: (layer: WritableLayer, stateId: string, text: string) => Promise<unknown>;
  remove: (layer: WritableLayer, stateId: string) => Promise<unknown>;
}

const docOf = (source: WorkflowSource | undefined): unknown => {
  if (source === undefined || !source.exists || source.text.trim().length === 0) return undefined;
  return JSON.parse(source.text) as unknown;
};

/** Every name a root's lines and children use — the automations whose states are read beside it. */
function namesOf(root: unknown): string[] {
  if (root === null || typeof root !== "object" || Array.isArray(root)) return [];
  const doc = root as Record<string, unknown>;
  const children = doc["children"] !== null && typeof doc["children"] === "object" && !Array.isArray(doc["children"]) ? Object.keys(doc["children"] as object) : [];
  const rules = Array.isArray(doc["transitions"]) ? doc["transitions"].flatMap((rule) => (rule !== null && typeof rule === "object" && typeof (rule as { name?: unknown }).name === "string" ? [(rule as { name: string }).name] : [])) : [];
  return [...new Set([...children, ...rules])].filter((name) => name !== "$ref" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name));
}

export interface AutomationsPaneProps {
  channel: AutomationsChannel;
  /** The page's layer. */
  layer: ConfigLayer;
  /** A project is open — so there is a project layer to read and write. */
  hasProject: boolean;
  busy: boolean;
  events: JairaEventsConfig;
  status: EventsStatusView | null;
  workflows: ReadonlyArray<{ id: string; label?: string | undefined }>;
  forms: Readonly<Record<string, RunField[] | null>>;
  onWorkflow: (id: string) => void;
  projectName: string;
  /** The events task of the layer read, when there is one. */
  hasTask: boolean;
  onOpenConversation: () => void;
  onEditFile: (layer: WorkflowLayer) => void;
  onOpenEvents: () => void;
  onOpenConnections: () => void;
}

/** How long an edit rests before it is written — a name or a value is typed a letter at a time. */
const SETTLE_MS = 600;

/** What is edited and not yet written: the layer's own lines, and Shared lines edited on a project page. */
interface Pending {
  own?: AutomationLine[];
  /** By Shared's name for the line, the line as it is now. */
  shared: Record<string, { before: AutomationLine; next: AutomationLine }>;
}

const NOTHING_PENDING: Pending = { shared: {} };

export function AutomationsPane(props: AutomationsPaneProps): JSX.Element {
  const [copies, setCopies] = useState<Copies | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(NOTHING_PENDING);
  const [writing, setWriting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [told, setTold] = useState<string | null>(null);
  const [held, setHeld] = useState<{ before: AutomationLine[]; after: AutomationLine[] } | null>(null);
  const [sentTo, setSentTo] = useState<WritableLayer | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const { channel } = props;
  const load = useCallback(async (): Promise<void> => {
    const read = async (layer: WorkflowLayer, stateId: string): Promise<WorkflowSource | undefined> => {
      try {
        return await channel.read(layer, stateId);
      } catch {
        return undefined;
      }
    };
    const [project, base, system] = await Promise.all([props.hasProject ? read("project", EVENTS_STATE_ID) : Promise.resolve(undefined), read("base", EVENTS_STATE_ID), read("system", EVENTS_STATE_ID)]);
    const roots = { project: docOf(project), base: docOf(base), system: docOf(system) };
    // Every automation any of the roots names, read in both writable layers: a project's own copy of a
    // Shared line's state is how that line's steps change for the project alone.
    const names = [...new Set([...namesOf(roots.project), ...namesOf(roots.base), ...namesOf(roots.system)])];
    const statesOf = async (layer: WritableLayer): Promise<Record<string, unknown>> => {
      const found = await Promise.all(names.map(async (name) => [name, docOf(await read(layer, automationStateIdOf(name)))] as const));
      return Object.fromEntries(found.filter(([, doc]) => doc !== undefined));
    };
    const [projectStates, baseStates] = await Promise.all([props.hasProject ? statesOf("project") : Promise.resolve({}), statesOf("base")]);
    const layerOf = (root: unknown, states: Record<string, unknown>): LayerFiles => ({ ...(root !== undefined ? { root } : {}), states });
    setCopies({
      ...(props.hasProject ? { project: layerOf(roots.project, projectStates) } : {}),
      base: layerOf(roots.base, baseStates),
      ...(roots.system !== undefined ? { system: { root: roots.system } } : {}),
    });
  }, [channel, props.hasProject]);
  useEffect(() => {
    load().catch((e: unknown) => setFailed(e instanceof Error ? e.message : String(e)));
  }, [load]);
  useEffect(() => {
    setPending(NOTHING_PENDING);
    setHeld(null);
    setTold(null);
    setProblem(null);
  }, [props.layer]);
  useEffect(() => () => clearTimeout(timer.current), []);

  const writesTo: WritableLayer | undefined = props.layer === "you" ? (sentTo ?? undefined) : props.layer;
  const reads: WritableLayer = props.layer === "you" ? (props.hasProject ? "project" : "base") : props.layer;
  let read: ReturnType<typeof automationsReadOf> | undefined;
  let unreadable: string | undefined;
  try {
    if (copies !== null) read = automationsReadOf(copies, reads);
  } catch (e) {
    unreadable = (e as Error).message;
  }
  const lines = pending.own ?? read?.own.lines ?? [];
  const sharedNow = (read?.shared ?? []).map((line) => pending.shared[line.name]?.next ?? line);

  // Every workflow a step names has its inputs read, once.
  const named = [...new Set([...lines, ...sharedNow].flatMap((line) => line.steps.flatMap((step) => (step.kind === "start" && step.workflow.length > 0 ? [step.workflow] : []))))];
  useEffect(() => {
    for (const id of named) if (props.forms[id] === undefined && props.workflows.some((w) => w.id === id)) props.onWorkflow(id);
  });

  if (copies === null || read === undefined) {
    return (
      <SettingsSection id="automations" title="Automations">
        <p className={`cfg-hint${unreadable !== undefined ? " warn-text" : ""}`}>
          {unreadable !== undefined
            ? `The events workflow does not parse — ${unreadable}. Fix it in the Files view.`
            : failed !== null
              ? `The events workflow could not be read — ${failed}`
              : "Reading the events workflow…"}
        </p>
      </SettingsSection>
    );
  }
  const readNow = read;
  const shown = shownLinesOf({ ...readNow.own, lines }, readNow.shared === undefined ? undefined : sharedNow, readNow.stepsOf).map((one) =>
    // A Shared line edited here draws its steps as edited, wherever they are read from.
    one.from === "shared" && pending.shared[one.line.name] !== undefined ? { ...one, line: pending.shared[one.line.name]!.next } : one,
  );

  const run = (writes: readonly AutomationWrite[], wrote: (writes: readonly AutomationWrite[]) => string | null): void => {
    setWriting(true);
    setProblem(null);
    void (async () => {
      for (const one of writes) {
        if ("remove" in one) await props.channel.remove(one.layer, one.stateId);
        else await props.channel.write(one.layer, one.stateId, one.text);
      }
    })()
      .then(
        () => {
          setPending(NOTHING_PENDING);
          setTold(wrote(writes));
        },
        (e: unknown) => setProblem(e instanceof Error ? e.message : String(e)),
      )
      .then(load)
      .finally(() => setWriting(false));
  };

  /** What was made that was not there: "Wrote this project's copy of system/events/push_main." */
  const madeOf = (writes: readonly AutomationWrite[]): string | null => {
    const made = writes.filter((one) => !("remove" in one) && (one.stateId === EVENTS_STATE_ID ? copies[one.layer]?.root === undefined : copies[one.layer]?.states[one.stateId.slice(EVENTS_STATE_ID.length + 1)] === undefined));
    return made.length > 0 ? `Wrote ${made.map((one) => `${INTO_NAME[one.layer]}'s copy of ${one.stateId}`).join(" and ")}.` : null;
  };

  /** Everything pending, as the files it writes — Shared lines edited here folded in as the project's. */
  const writesOf = (into: WritableLayer, now: Pending, ignored?: string[]): AutomationWrite[] => {
    let own = now.own ?? (into === reads ? readNow.own.lines : automationsReadOf(copies, into).own.lines);
    const ignoring = [...(ignored ?? readNow.own.splice?.ignored ?? [])];
    const out: AutomationWrite[] = [];
    let rules = now.own !== undefined || ignored !== undefined;
    for (const { before, next } of Object.values(now.shared)) {
      const stepsOnly = before.name === next.name && before.event === next.event && JSON.stringify(before.filter) === JSON.stringify(next.filter);
      if (stepsOnly) {
        out.push(...sharedStepsWritesOf(copies, before.name, next.steps));
        continue;
      }
      // Its event, filter or name changed here: Shared's line is ignored in this project, and the
      // project gets a line of its own in its place.
      own = [...own.filter((line) => line.name !== next.name), next];
      if (!ignoring.includes(before.name)) ignoring.push(before.name);
      rules = true;
    }
    if (rules) {
      const before = automationsReadOf(copies, into).own.lines;
      out.push(...automationsWritesOf(copies, into, before, own, into === "project" ? ignoring : undefined));
    }
    return out;
  };

  const settle = (now: Pending): void => {
    setPending(now);
    setTold(null);
    clearTimeout(timer.current);
    const wrong = linesProblem([...(now.own ?? lines), ...Object.values(now.shared).map((edit) => edit.next)]);
    setProblem(wrong !== undefined ? `Not saved yet — ${wrong}` : null);
    if (wrong !== undefined) return;
    timer.current = setTimeout(() => {
      // Shared lines edited on a project page are that project's — whichever page layer it is.
      const sharedOnly = now.own === undefined;
      if (sharedOnly) {
        run(writesOf("project", now), madeOf);
        return;
      }
      if (writesTo !== undefined) {
        const onto = writesTo === reads ? now.own! : rebaseLines(readNow.own.lines, now.own!, automationsReadOf(copies, writesTo).own.lines);
        run(writesOf(writesTo, { ...now, own: onto }), madeOf);
      } else setHeld({ before: readNow.own.lines, after: now.own! });
    }, SETTLE_MS);
  };

  const ignore = (name: string, on: boolean): void => {
    const now = readNow.own.splice?.ignored ?? [];
    const ignored = on ? [...new Set([...now, name])] : now.filter((one) => one !== name);
    // Put back: Shared's line again — and the project's own line of that name, which stood in for it, goes.
    const own = on ? lines : lines.filter((line) => line.name !== name);
    run(writesOf("project", { own, shared: {} }, ignored), madeOf);
  };

  const fileLayer: WorkflowLayer = reads === "project" && copies.project?.root !== undefined ? "project" : copies.base?.root !== undefined ? "base" : "system";

  return (
    <AutomationsView
      reads={reads}
      source={readNow.source}
      shown={shown}
      events={props.events}
      status={props.status}
      workflows={props.workflows}
      forms={props.forms}
      locked={props.busy || writing}
      problem={problem}
      told={told}
      asking={held !== null ? (props.hasProject ? ["project", "base"] : ["base"]) : null}
      layerName={reads === "project" ? props.projectName : "Shared"}
      hasTask={props.hasTask}
      onLines={(next) => settle({ ...pending, own: next })}
      onSharedLine={(before, next) => {
        const original = pending.shared[before.name]?.before ?? before;
        settle({ ...pending, shared: { ...pending.shared, [original.name]: { before: original, next } } });
      }}
      onUseSharedSteps={(name) => run([{ layer: "project", stateId: automationStateIdOf(name), remove: true }], () => `This project runs Shared's steps for ${name} again.`)}
      onIgnore={ignore}
      onAnswer={(into) => {
        if (held === null) return;
        const change = held;
        setHeld(null);
        if (into === null) {
          setPending(NOTHING_PENDING);
          setProblem(null);
          return;
        }
        setSentTo(into);
        const onto = into === reads ? change.after : rebaseLines(change.before, change.after, automationsReadOf(copies, into).own.lines);
        run(writesOf(into, { own: onto, shared: {} }), madeOf);
      }}
      onOpenConversation={props.onOpenConversation}
      onEditFile={() => props.onEditFile(fileLayer)}
      onOpenEvents={props.onOpenEvents}
      onOpenConnections={props.onOpenConnections}
    />
  );
}
