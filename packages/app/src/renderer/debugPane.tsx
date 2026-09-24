/**
 * The Debug view: run JaiRA against itself, and watch every part of it (DESIGN §11.3).
 *
 * Everything in this app is downstream of one question — *does a workflow, run here, actually work?*
 * — and until now the only way to ask it was to author a workflow, configure a provider, create a
 * task and read a board. Every one of those steps can be the broken one, so a failure anywhere told
 * you nothing about where.
 *
 * This pane asks the question in one click. It runs a two-state workflow that ships with the app
 * (the built-in layer, decision 0006) and shows the result beside the machinery that produced it: the
 * files that loaded, the instance tree, the live event stream, the prompts actually sent and the
 * replies actually received. Nothing here is a special path — it is `task:create` and `task:start`,
 * the same channels the board uses, against state files the Files tree lists like any others, which
 * is what makes a pass here mean something about the real thing. Nothing is installed first, so it
 * runs on a machine whose shared root holds no state at all. (The RUN is still recorded in the shared
 * root's own project, so a shared root that cannot be written to at all cannot hold a self-test.)
 *
 * The second stage is what makes it a test rather than a smoke check: it takes the FIRST stage's
 * output as a declared input and reports on it. A pass therefore proves the binding carried, not
 * merely that a provider answered.
 *
 * Two run modes, and reaching for the second is the diagnostic:
 *
 *  - **scripted** replaces the LLM with canned replies. It exercises the engine, the bindings, the
 *    journal, the board and every panel — with no provider and no cost.
 *  - **live** is the same run against whatever `models.default` resolves to here.
 *
 * Scripted passes and live fails ⇒ the provider. Scripted fails ⇒ JaiRA.
 */
import { type CSSProperties, type JSX, type ReactNode } from "react";
import type {
  AvailabilitySnapshot,
  ConversationView,
  SessionRef,
  SessionView,
  TaskDetail,
  WorkflowLayer,
} from "@jaira/shared/browser";
import { Badge } from "./board";
import { Conversation } from "./detail";
import { SELF_TEST_ROOT } from "./debugWorkflow";
import { SessionPanel } from "./session";
import type { DebugFile, DebugState } from "./store";

/**
 * What the run's outputs say, read defensively.
 *
 * Defensively because these come off a model. `passed` is only a pass when it is literally `true`:
 * a missing field, a string `"true"`, or a run that failed before publishing anything must all read
 * as "not proven", and a truthiness check would turn two of those three into a green banner.
 */
export function verdictOf(outputs: unknown): { passed: boolean | null; greeting?: string; verdict?: string } {
  if (outputs === null || typeof outputs !== "object" || Array.isArray(outputs)) return { passed: null };
  const record = outputs as Record<string, unknown>;
  return {
    passed: record["passed"] === true ? true : record["passed"] === false ? false : null,
    ...(typeof record["greeting"] === "string" ? { greeting: record["greeting"] } : {}),
    ...(typeof record["verdict"] === "string" ? { verdict: record["verdict"] } : {}),
  };
}

/**
 * Who could answer the live run, as the last availability check found it.
 *
 * Read from the cached snapshot rather than probed here: the checks run at startup, at project open
 * and after every configuration write, so this is what Settings would say too. A pane that ran its
 * own check would be a second opinion nobody asked for and would occasionally disagree.
 */
function Readiness({ availability }: { availability: AvailabilitySnapshot }): JSX.Element {
  const ok = [...availability.routes, ...availability.executors].filter((p) => p.status === "ok");
  if (availability.checkedAt === 0) {
    return (
      <div className="notice warn">
        Nothing has been checked yet, so a live run may find no provider. The scripted run needs none.
      </div>
    );
  }
  if (ok.length === 0) {
    return (
      <div className="notice warn">
        Nothing here reported healthy, so a live run will probably fail to find a model — see Settings ›
        Connections. The scripted run needs none, and is the better first test anyway.
      </div>
    );
  }
  return (
    <div className="notice">
      A live run goes to whatever <code>models.default</code> resolves to. Reported healthy:{" "}
      {ok.map((p) => p.name).join(", ")}.
    </div>
  );
}

/** What a self-test row says about the copy that loads: which layer it is in, in the pane's words. */
export function debugFileStatus(file: Pick<DebugFile, "layer">): {
  word: string;
  tone: "success" | "unknown" | "error";
} {
  if (file.layer === null) return { word: "missing", tone: "error" };
  if (file.layer === "system") return { word: "built in", tone: "success" };
  // A person's copy wins over what ships.
  return { word: "overridden", tone: "unknown" };
}

/** One state file's row: which copy loads, and where it is. */
function FileRow({ file, onOpen }: { file: DebugFile; onOpen: () => void }): JSX.Element {
  const status = debugFileStatus(file);
  return (
    <div className={`debug-file debug-file-${status.tone}`}>
      <span className={`dot ${status.tone}`} />
      <span className="mono grow ellip" title={file.file || file.stateId}>
        {file.stateId}
      </span>
      <span className="chip">{status.word}</span>
      <button className="link" onClick={onOpen} disabled={file.layer === null}>
        open ↗
      </button>
    </div>
  );
}

export interface DebugPaneProps {
  debug: DebugState;
  /** The selected task's detail — the self-test's own, once one has been started. */
  detail: TaskDetail | null;
  conversation: ConversationView | null;
  sessionHistory: SessionRef[];
  session: SessionView | null;
  sessionInstance: string | null;
  liveTurn: { sessionId?: string; seq?: number; text: string } | null;
  stream: string[];
  availability: AvailabilitySnapshot;
  hasProject: boolean;
  onRun: (options: { scripted?: boolean; fresh?: boolean }) => void;
  onCancel: () => void;
  onRecheck: () => void;
  onDismissError: () => void;
  /** Open the copy that LOADS — the row knows which layer that is. */
  onOpenState: (stateId: string, layer: WorkflowLayer) => void;
  onShowSession: (instanceId: string | null) => void;
  /** The shell's side panel column, and the classes and width variable its grid needs. */
  panel?: ReactNode;
  panelClass?: string;
  panelStyle?: CSSProperties;
}

export function DebugPane({
  debug,
  detail,
  conversation,
  sessionHistory,
  session,
  sessionInstance,
  liveTurn,
  stream,
  availability,
  hasProject,
  onRun,
  onCancel,
  onRecheck,
  onDismissError,
  onOpenState,
  onShowSession,
  panel,
  panelClass,
  panelStyle,
}: DebugPaneProps): JSX.Element {
  // The detail panel is only about the self-test when the selection still IS the self-test. Clicking
  // a card in Tasks moves the selection, and showing that task's tree under a "self-test" heading
  // would attribute somebody else's run to this button.
  const mine = detail !== null && detail.taskId === debug.taskId ? detail : null;
  const run = mine?.runs[mine.runs.length - 1];
  const result = verdictOf(run?.outputs ?? null);
  const running = mine?.status === "running" || run?.outcome === "running";
  const missing = debug.files.filter((f) => f.layer === null).length;
  const overridden = debug.files.filter((f) => f.layer !== null && f.layer !== "system");

  return (
    // `view` is what makes this a two-column grid the height of the viewport — without it the
    // columns laid out as blocks and the middle one had no height to scroll INSIDE, so a pane
    // longer than the window simply ran off the bottom of it.
    <div className={`view debug-view${panelClass ?? ""}`} style={panelStyle}>
      <div className="col mid debug">
        <header className="debug-head">
          <h2>Workflow self-test</h2>
          <p className="sub">
            Two prompt states run in sequence. The first is asked to say hello world; the second takes
            what it said as a declared input and reports whether it did. A pass means the model
            answered <em>and</em> that its output was validated, bound and carried into the next state.
          </p>
        </header>

        <section>
          <h3>What it runs</h3>
          <ol className="debug-stages">
            <li>
              <span className="mono">{SELF_TEST_ROOT}/say</span>
              <span className="sub">asks for the greeting, publishes it as </span>
              <span className="mono">greeting: string</span>
            </li>
            <li>
              <span className="mono">{SELF_TEST_ROOT}/check</span>
              <span className="sub">reads </span>
              <span className="mono">.children.say.output.greeting</span>
              <span className="sub">, publishes </span>
              <span className="mono">passed: boolean</span>
              <span className="sub"> and </span>
              <span className="mono">verdict: string</span>
            </li>
          </ol>
          {/* The files themselves, verbatim — the copies that LOAD, from whichever layer supplied
              them. This pane's claim is that nothing here is special, and the only way to make that
              checkable is to show what it runs. */}
          <details className="debug-source">
            <summary>The state files, as they load</summary>
            {debug.files.map((f) => (
              <div key={f.stateId}>
                <div className="sub mono">{f.file || `${f.stateId}.json`}</div>
                <pre className="outputs">{f.text}</pre>
              </div>
            ))}
          </details>
        </section>

        <section>
          <h3>Where it comes from</h3>
          <div className="notice">
            The self-test ships with JaiRA, so there is nothing to install and it runs with nothing in
            the shared root. A copy of one of its states in <code>~/.jaira</code> wins over the built-in
            one, as an override of any built-in does.
          </div>
          {debug.files.map((f) => (
            <FileRow key={f.stateId} file={f} onOpen={() => (f.layer === null ? undefined : onOpenState(f.stateId, f.layer))} />
          ))}
          {missing > 0 ? (
            <div className="notice bad">
              {missing === 1 ? "One state was" : `${missing} states were`} found in no layer, so the run cannot
              start. The built-in layer is missing from this build.
            </div>
          ) : null}
          {overridden.length > 0 ? (
            <div className="notice warn">
              {overridden.length === 1 ? "One state loads" : `${overridden.length} states load`} from the shared
              root instead of from what ships, and a run uses what loads.
            </div>
          ) : null}
          <div className="pane-actions">
            <button className="ghost" disabled={debug.busy} onClick={onRecheck}>
              Re-check
            </button>
          </div>
        </section>

        <section>
          <h3>Run it</h3>
          <Readiness availability={availability} />
          {!hasProject ? (
            <div className="notice warn">
              No project is open. A task belongs to a checkout, so open one from Settings before running.
            </div>
          ) : null}
          <div className="pane-actions">
            <button disabled={debug.busy || running || !hasProject} onClick={() => onRun({})}>
              Run (live LLM)
            </button>
            <button
              className="ghost"
              disabled={debug.busy || running || !hasProject}
              onClick={() => onRun({ scripted: true })}
              title="Replaces the model with canned replies — exercises everything except the provider"
            >
              Run scripted
            </button>
            <button
              className="ghost"
              disabled={debug.busy || running || !hasProject || debug.taskId === null}
              onClick={() => onRun({ fresh: true })}
              title="A new task, rather than another run on the last one"
            >
              New task
            </button>
            <button className="ghost" disabled={!running} onClick={onCancel}>
              Cancel
            </button>
          </div>
          {debug.error !== null ? (
            <button className="notice bad clickable" onClick={onDismissError}>
              {debug.error}
            </button>
          ) : null}
        </section>

        {mine !== null ? (
          <section>
            <h3>Result</h3>
            {run === undefined ? (
              <p className="empty">Started — no run has settled yet.</p>
            ) : (
              <>
                <div
                  className={`debug-verdict ${
                    result.passed === true ? "good" : result.passed === false ? "bad" : "unknown"
                  }`}
                >
                  <Badge status={mine.status} />
                  <span className="debug-verdict-word">
                    {result.passed === true ? "PASS" : result.passed === false ? "FAIL" : "NO VERDICT"}
                  </span>
                  <span className="sub">
                    {run.outcome}
                  </span>
                </div>
                {/* Both halves, always — the greeting is the evidence and the verdict is the judgement,
                    and a verdict shown without what it judged is a verdict you cannot check. */}
                {result.greeting !== undefined ? (
                  <div className="field">
                    <span>the greeting</span>
                    <pre className="outputs">{result.greeting}</pre>
                  </div>
                ) : null}
                {result.verdict !== undefined ? (
                  <div className="field">
                    <span>the judgement</span>
                    <pre className="outputs">{result.verdict}</pre>
                  </div>
                ) : null}
                {result.passed === null && run.outcome !== "running" ? (
                  <div className="notice warn">
                    The run settled without publishing a verdict — look at the instance tree and the
                    events beside it for where it stopped.
                  </div>
                ) : null}
                {run.failure !== undefined ? (
                  <pre className="outputs">{JSON.stringify(run.failure, null, 2)}</pre>
                ) : null}
              </>
            )}
          </section>
        ) : null}

        {mine !== null ? (
          <section className="debug-transcript">
            <h3>What was actually said</h3>
            {/* The prompts and replies verbatim, per state — the one surface that can show that the
                second call really was given the first call's answer. */}
            <SessionPanel
              history={sessionHistory}
              session={session}
              showing={sessionInstance}
              live={liveTurn}
              onShow={onShowSession}
            />
          </section>
        ) : null}

        {mine !== null ? (
          <section>
            <h3>Journal</h3>
            <Conversation conversation={conversation} />
          </section>
        ) : null}
        {/* The component gallery used to end this column. It is its own view now (`galleryPane.tsx`):
            it proves the surfaces a run can park at RENDER, which is a question about authoring
            rather than about this installation, and it needed no self-test to answer. */}
      </div>

      {/* The shell's side panel — the self-test's task, the same panel every room has. Reused
          rather than reimplemented, because a debug view that renders its own version of the screen
          it is meant to be testing tests the wrong screen. */}
      {panel}
    </div>
  );
}
