/**
 * The Debug view: run JaiRA against itself, and watch every part of it (DESIGN §11.3).
 *
 * Everything in this app is downstream of one question — *does a workflow, run here, actually work?*
 * — and until now the only way to ask it was to author a workflow, configure a provider, create a
 * task and read a board. Every one of those steps can be the broken one, so a failure anywhere told
 * you nothing about where.
 *
 * This pane asks the question in one click. It installs a two-state workflow, runs it, and shows the
 * result beside the machinery that produced it: the files on disk, the instance tree, the live event
 * stream, the prompts actually sent and the replies actually received. Nothing here is a special
 * path — it is `workflow:write`, `task:create` and `task:start`, the same three channels the Files
 * tree and the board use, which is what makes a pass here mean something about the real thing.
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
import { type JSX } from "react";
import type {
  AvailabilitySnapshot,
  ConversationView,
  SessionRef,
  SessionView,
  TaskDetail,
  ValidateSchemaResult,
} from "@jaira/shared/browser";
import { Badge } from "./board";
import { ComponentGallery } from "./componentGallery";
import { Conversation, TaskPanel } from "./detail";
import { SELF_TEST_ROOT, SELF_TEST_STATES, selfTestFiles } from "./debugWorkflow";
import { SessionPanel } from "./session";
import type { DebugState } from "./store";

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
        Providers. The scripted run needs none, and is the better first test anyway.
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

/** One state file's row: is it there, is it ours, and where did it land. */
function FileRow({
  stateId,
  file,
  exists,
  matches,
  onOpen,
}: {
  stateId: string;
  file: string;
  exists: boolean;
  matches: boolean;
  onOpen: () => void;
}): JSX.Element {
  const status = !exists ? "missing" : matches ? "installed" : "edited";
  return (
    <div className={`debug-file debug-file-${status}`}>
      <span className={`dot ${exists ? (matches ? "success" : "unknown") : "error"}`} />
      <span className="mono grow ellip" title={file || stateId}>
        {stateId}
      </span>
      <span className="chip">{status}</span>
      <button className="link" onClick={onOpen} disabled={!exists}>
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
  onInstall: (force: boolean) => void;
  onRecheck: () => void;
  onDismissError: () => void;
  onOpenState: (stateId: string) => void;
  onShowSession: (instanceId: string | null) => void;
  /** The schema check the gallery's JSON editors validate through — the store's. */
  validateSchema: (schemaId: string, text: string) => Promise<ValidateSchemaResult | null>;
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
  onInstall,
  onRecheck,
  onDismissError,
  onOpenState,
  onShowSession,
  validateSchema,
}: DebugPaneProps): JSX.Element {
  const files = selfTestFiles();
  // The detail panel is only about the self-test when the selection still IS the self-test. Clicking
  // a card in Tasks moves the selection, and showing that task's tree under a "self-test" heading
  // would attribute somebody else's run to this button.
  const mine = detail !== null && detail.taskId === debug.taskId ? detail : null;
  const run = mine?.runs[mine.runs.length - 1];
  const result = verdictOf(run?.outputs ?? null);
  const running = mine?.status === "running" || run?.outcome === "running";
  const missing = debug.files.filter((f) => !f.exists).length;
  const edited = debug.files.filter((f) => f.exists && !f.matches).length;

  return (
    // `view` is what makes this a two-column grid the height of the viewport — without it the
    // columns laid out as blocks and the middle one had no height to scroll INSIDE, so a pane
    // longer than the window simply ran off the bottom of it.
    <div className="view debug-view">
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
          {/* The files themselves, verbatim. This pane's claim is that nothing here is special, and
              the only way to make that checkable is to show what it writes. */}
          <details className="debug-source">
            <summary>The state files, as they will be written</summary>
            {SELF_TEST_STATES.map((stateId) => (
              <div key={stateId}>
                <div className="sub mono">{stateId}.json</div>
                <pre className="outputs">{JSON.stringify(files[stateId], null, 2)}</pre>
              </div>
            ))}
          </details>
        </section>

        <section>
          <h3>Installed</h3>
          <div className="notice">
            The self-test lives in the SHARED root, not in the open project — it is a fact about this
            installation, and three debug files in a checkout's <code>.jaira/</code> would be three
            files in its next commit.
          </div>
          {debug.files.map((f) => (
            <FileRow key={f.stateId} {...f} onOpen={() => onOpenState(f.stateId)} />
          ))}
          {debug.files.length > 0 ? (
            <div className="sub mono ellip" title={debug.files[0]!.file}>
              {debug.files[0]!.file}
            </div>
          ) : null}
          {edited > 0 ? (
            <div className="notice warn">
              {edited === 1 ? "One file differs" : `${edited} files differ`} from what this build would
              write. Left alone — a run uses what is on disk. Reinstall to put them back.
            </div>
          ) : null}
          <div className="pane-actions">
            <button className="ghost" disabled={debug.busy || missing === 0} onClick={() => onInstall(false)}>
              Install missing
            </button>
            <button className="ghost" disabled={debug.busy} onClick={() => onInstall(true)}>
              Reinstall
            </button>
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

        {/* The other half of the same question. The self-test above proves a workflow RUNS; this
            proves the surfaces it can park at RENDER — and it needs no project, no provider and no
            run to do it, which is why it sits below rather than behind a button. */}
        <section className="debug-gallery">
          <h3>Component gallery</h3>
          <p className="sub">
            Every surface a run can put in front of you, with nothing behind it: the six built-in UI
            components a state&apos;s <code>operation.function</code> may name, the fallback for one
            it may not, and the two dialogs JaiRA raises on its own — a command approval and an
            agent&apos;s question. Each card renders the REAL dialog from the config beside it, so
            editing the config is editing what you see, and answering it shows what a state&apos;s
            declared outputs would receive.
          </p>
          <ComponentGallery validateSchema={validateSchema} />
        </section>
      </div>

      <aside className="col panel">
        {mine !== null ? (
          // The ordinary task panel, unmodified: instances, live events and the run's outputs. Reused
          // rather than reimplemented, because a debug view that renders its own version of the
          // screen it is meant to be testing tests the wrong screen.
          <TaskPanel
            detail={mine}
            stream={stream}
            onStart={() => onRun({})}
            onCancel={onCancel}
            onOpenState={onOpenState}
          />
        ) : (
          <p className="empty">Run the self-test to see its task here.</p>
        )}
      </aside>
    </div>
  );
}
