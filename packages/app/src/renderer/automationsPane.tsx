/**
 * Settings → Tools → Automations (decision 0010 §4, mockup B.2): the editor of a layer's built-in
 * `system/events` workflow. Each line is one named transition of the events task — it waits for an
 * event, starts the task you pick (or tells you), and goes back to waiting.
 *
 * {@link AutomationsView} is a render function over what `automationsModel.ts` says: every piece of
 * state arrives as a prop, and each state it can be in is one `renderToStaticMarkup`. The host
 * ({@link AutomationsPane}) reads the three layers' copies of the file, holds a line being edited until
 * it can be written, and writes — copying on the first edit (a project's copy `$ref`s Shared's, and
 * Shared's is made from the built-in first when it has none), and asking where on the personal layer,
 * which holds no workflow files.
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
  EVENTS_STATE_ID,
  eventOnAnywhere,
  eventPicksOf,
  eventsDocText,
  filterFormOf,
  filterOfForm,
  filterSchemaOf,
  flagText,
  freshLineName,
  lineFlagsOf,
  linesProblem,
  moveLine,
  parseEventsDoc,
  rebaseLines,
  shownLinesOf,
  sharedSeedOf,
  skeleton,
  stepFormOf,
  stepOfForm,
  stepSummary,
  whenOf,
  writeEventsDoc,
  type AutomationLine,
  type AutomationStep,
  type EventsDoc,
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

/** One step of an own line, editable. */
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
            onStep(stepOfForm(step.workflow, form.values, picked));
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
          <span className="au-wf">
            <TextInput value={step.workflow} mono list={WORKFLOWS_LIST} placeholder="a workflow — feature/review" label={`the workflow step ${index + 1} starts`} disabled={props.locked} onChange={(workflow) => onStep({ ...step, workflow })} />
          </span>
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
              onChange={(next) => onStep(stepOfForm(step.workflow, next as Record<string, unknown>, form.picked))}
              ctx={{ path: "", labels: "keys", disabled: props.locked, ...(sources !== undefined ? { sources } : {}) }}
            />
          </div>
        )
      ) : null}
    </li>
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

  const ownRow = (line: AutomationLine, i: number, lineFlags: LineFlag[]): JSX.Element => {
    const badge = badgeFor(line, props.status);
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
            {line.raw !== undefined ? (
              <>
                <div className="au-when">
                  <span className="au-word">When</span>
                  <code className="au-raw">{typeof line.raw.rule["when"] === "string" ? line.raw.rule["when"] : "—"}</code>
                </div>
                <p className="cfg-hint au-order">
                  Written by hand in the file, so it is edited there.{" "}
                  <button type="button" className="link au-link" onClick={props.onEditFile}>
                    Edit as a workflow file
                  </button>
                </p>
              </>
            ) : (
              <>
                <div className="au-when">
                  <span className="au-word">When</span>
                  <span className="au-event">
                    <TextInput value={line.event} mono list={EVENTS_LIST} placeholder="an event — git.push" label="the event this line waits for" disabled={props.locked} onChange={(event) => setLine(i, { ...line, event, filter: {} })} />
                  </span>
                  {badge !== undefined ? <ConnectionPill badge={badge} onOpenConnections={props.onOpenConnections} /> : null}
                </div>
                <FilterEditor line={line} disabled={props.locked} onFilter={(filter) => setLine(i, { ...line, filter })} />
                <ol className="au-actions">
                  {line.steps.map((step, s) => (
                    <StepEditor
                      key={s}
                      step={step}
                      index={s}
                      line={line}
                      props={props}
                      onStep={(next) => setLine(i, { ...line, steps: line.steps.map((one, k) => (k === s ? next : one)) })}
                      onRemove={line.steps.length > 1 ? () => setLine(i, { ...line, steps: line.steps.filter((_, k) => k !== s) }) : undefined}
                    />
                  ))}
                </ol>
                {line.steps.length > 1 ? <p className="cfg-hint au-order">In order: each step starts when the one before it has finished.</p> : null}
                <div className="au-add-action">
                  <button
                    type="button"
                    className="set-add"
                    disabled={props.locked}
                    onClick={() => setLine(i, { ...line, steps: [...line.steps, { kind: "start", workflow: "", inputs: {} }] })}
                  >
                    <span className="set-plus" aria-hidden="true">
                      +
                    </span>
                    <span className="cx-opt-hint">then…</span>
                  </button>
                </div>
              </>
            )}
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
    return (
      <div key={`shared:${i}`} className={`set-row au-row au-shared${shown.ignored ? " au-ignored" : ""}`}>
        <div className="set-row-line">
          <div className="set-row-say">
            <div className="au-head">
              <span className="mono au-name-static">{line.name}</span>
              <span className="cx-src" title="A line of Shared's events workflow, read through this project's copy">
                from Shared
              </span>
            </div>
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
          return ownRow(shown.line, ownIndex, flags[i] ?? []);
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

/** What the host asks main for. */
export interface AutomationsChannel {
  read: (layer: WorkflowLayer) => Promise<WorkflowSource>;
  write: (layer: WritableLayer, text: string) => Promise<unknown>;
}

interface Copies {
  project?: WorkflowSource;
  base?: WorkflowSource;
  system?: WorkflowSource;
}

const docOf = (source: WorkflowSource | undefined): unknown => {
  if (source === undefined || !source.exists || source.text.trim().length === 0) return undefined;
  return JSON.parse(source.text) as unknown;
};

/** What a layer's section is drawn from, over the copies read. */
export function automationsReadOf(
  copies: Copies,
  reads: WritableLayer,
): { own: EventsDoc; source: AutomationsViewProps["source"]; shared: AutomationLine[] | undefined } {
  const base = docOf(copies.base);
  const system = docOf(copies.system);
  const sharedDoc = base ?? system;
  const shared = sharedDoc !== undefined ? parseEventsDoc(sharedDoc).lines : [];
  if (reads === "base") {
    if (base !== undefined) return { own: parseEventsDoc(base), source: "copy", shared: undefined };
    return { own: parseEventsDoc(system ?? skeleton()), source: system !== undefined ? "built in" : "none", shared: undefined };
  }
  const project = docOf(copies.project);
  if (project !== undefined) return { own: parseEventsDoc(project), source: "copy", shared };
  return { own: { lines: [], splice: { ignored: [] }, follows: true }, source: "none", shared };
}

/**
 * The files one change writes, in order: Shared's copy made from the built-in first when a project's
 * copy is being made and Shared has none (a project's copy `$ref`s Shared's), then the layer's own.
 */
export function automationsWritesOf(copies: Copies, into: WritableLayer, lines: readonly AutomationLine[], ignored: readonly string[] | undefined): Array<{ layer: WritableLayer; text: string }> {
  const base = docOf(copies.base);
  const system = docOf(copies.system);
  if (into === "base") return [{ layer: "base", text: eventsDocText(writeEventsDoc(base ?? sharedSeedOf(system), lines)) }];
  const out: Array<{ layer: WritableLayer; text: string }> = [];
  // A `$BASE` that is not there does not fall back to the built-in: Shared's copy is written first.
  if (base === undefined) out.push({ layer: "base", text: eventsDocText(sharedSeedOf(system)) });
  const project = docOf(copies.project);
  const splice = { ignored: [...(ignored ?? (project !== undefined ? (parseEventsDoc(project).splice?.ignored ?? []) : []))] };
  out.push({ layer: "project", text: eventsDocText(writeEventsDoc(project ?? {}, lines, splice)) });
  return out;
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

export function AutomationsPane(props: AutomationsPaneProps): JSX.Element {
  const [copies, setCopies] = useState<Copies | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [draft, setDraft] = useState<AutomationLine[] | null>(null);
  const [writing, setWriting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [told, setTold] = useState<string | null>(null);
  const [held, setHeld] = useState<{ before: AutomationLine[]; after: AutomationLine[] } | null>(null);
  const [sentTo, setSentTo] = useState<WritableLayer | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const { channel } = props;
  const load = useCallback(async (): Promise<void> => {
    const read = async (layer: WorkflowLayer): Promise<WorkflowSource | undefined> => {
      try {
        return await channel.read(layer);
      } catch {
        return undefined;
      }
    };
    const [project, base, system] = await Promise.all([props.hasProject ? read("project") : Promise.resolve(undefined), read("base"), read("system")]);
    setCopies({ ...(project !== undefined ? { project } : {}), ...(base !== undefined ? { base } : {}), ...(system !== undefined ? { system } : {}) });
  }, [channel, props.hasProject]);
  useEffect(() => {
    load().catch((e: unknown) => setFailed(e instanceof Error ? e.message : String(e)));
  }, [load]);
  useEffect(() => {
    setDraft(null);
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
  const lines = draft ?? read?.own.lines ?? [];

  // Every workflow a step names has its inputs read, once.
  const named = [...new Set([...lines, ...(read?.shared ?? [])].flatMap((line) => line.steps.flatMap((step) => (step.kind === "start" && step.workflow.length > 0 ? [step.workflow] : []))))];
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
  const shown = shownLinesOf({ ...read.own, lines }, read.shared);
  const readNow = read;

  const commit = (into: WritableLayer, next: AutomationLine[], ignored?: string[]): void => {
    const onto = into === reads ? next : rebaseLines(readNow.own.lines, next, automationsReadOf(copies, into).own.lines);
    const writes = automationsWritesOf(copies, into, onto, ignored);
    setWriting(true);
    setProblem(null);
    void (async () => {
      for (const one of writes) await props.channel.write(one.layer, one.text);
    })()
      .then(
        () => {
          setDraft(null);
          const made = writes.filter((one) => !(one.layer === "project" ? copies.project?.exists : copies.base?.exists));
          setTold(made.length > 0 ? `Wrote ${made.map((one) => `${INTO_NAME[one.layer]}'s copy`).join(" and ")} of ${EVENTS_STATE_ID}.` : null);
        },
        (e: unknown) => setProblem(e instanceof Error ? e.message : String(e)),
      )
      .then(load)
      .finally(() => setWriting(false));
  };

  const change = (next: AutomationLine[]): void => {
    setDraft(next);
    setTold(null);
    clearTimeout(timer.current);
    const wrong = linesProblem(next);
    setProblem(wrong !== undefined ? `Not saved yet — ${wrong}` : null);
    if (wrong !== undefined) return;
    timer.current = setTimeout(() => {
      if (writesTo !== undefined) commit(writesTo, next);
      else setHeld({ before: readNow.own.lines, after: next });
    }, SETTLE_MS);
  };

  const ignore = (name: string, on: boolean): void => {
    const now = readNow.own.splice?.ignored ?? [];
    const ignored = on ? [...new Set([...now, name])] : now.filter((one) => one !== name);
    commit("project", lines, ignored);
  };

  const fileLayer: WorkflowLayer = reads === "project" && copies.project?.exists === true ? "project" : copies.base?.exists === true ? "base" : "system";

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
      onLines={change}
      onIgnore={ignore}
      onAnswer={(into) => {
        if (held === null) return;
        const change = held;
        setHeld(null);
        if (into === null) {
          setDraft(null);
          setProblem(null);
          return;
        }
        setSentTo(into);
        commit(into, change.after);
      }}
      onOpenConversation={props.onOpenConversation}
      onEditFile={() => props.onEditFile(fileLayer)}
      onOpenEvents={props.onOpenEvents}
      onOpenConnections={props.onOpenConnections}
    />
  );
}

