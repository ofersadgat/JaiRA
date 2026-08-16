/**
 * The five built-in UI components (SPEC §8.1, DESIGN §7.1).
 *
 * Each takes a parsed contract (normalized in the main process) plus the state's
 * resolved inputs, and calls `onSubmit` with a result shaped to land on the
 * state's declared outputs. Nothing here decides whether an answer is *valid* —
 * main re-validates every submission, so this layer is free to be purely about
 * presentation.
 */
import { useEffect, useRef, useState, type JSX } from "react";
import {
  displayText,
  type ChooseOptionConfig,
  type ComponentConfig,
  type ComponentOption,
  type ConfirmActionConfig,
  type EditMarkdownConfig,
  type FillFormConfig,
  type FormField,
  type ApprovalScope,
  type PendingApproval,
  type PendingInteraction,
  type PendingQuestion,
  type ReviewArtifactConfig,
  type UserApproveChangesetConfig,
} from "@jaira/shared/browser";
import { invoke } from "./store";
import { mountChangesetReview, rendererServices, type ComponentServices } from "./changesetReview";

export interface ComponentProps<C extends ComponentConfig> {
  config: C;
  inputs: Record<string, unknown>;
  onSubmit: (value: unknown) => void;
}

function OptionButtons({
  options,
  onPick,
}: {
  options: ComponentOption[];
  onPick: (value: string) => void;
}): JSX.Element {
  return (
    <div className="options">
      {options.map((option) => (
        <button
          key={option.value}
          className={option.tone === "danger" ? "danger" : undefined}
          onClick={() => onPick(option.value)}
        >
          {option.label ?? option.value}
        </button>
      ))}
    </div>
  );
}

/** A free-text comment box shared by the decision components. */
function Comments({ value, onChange }: { value: string; onChange: (v: string) => void }): JSX.Element {
  return (
    <label className="field">
      <span>Comments (optional)</span>
      <textarea rows={3} value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

function ChooseOption({ config, onSubmit }: ComponentProps<ChooseOptionConfig>): JSX.Element {
  const [comments, setComments] = useState("");
  return (
    <>
      {config.comments ? <Comments value={comments} onChange={setComments} /> : null}
      <OptionButtons
        options={config.options}
        onPick={(decision) => onSubmit({ decision, ...(comments ? { comments } : {}) })}
      />
    </>
  );
}

function ReviewArtifact({ config, inputs, onSubmit }: ComponentProps<ReviewArtifactConfig>): JSX.Element {
  const [comments, setComments] = useState("");
  const text = displayText(inputs[config.artifact]);
  return (
    <>
      <div className="artifact" data-testid="artifact">
        {text || <span className="empty">({config.artifact} is empty)</span>}
      </div>
      {config.comments ? <Comments value={comments} onChange={setComments} /> : null}
      <OptionButtons
        options={config.options}
        onPick={(decision) => onSubmit({ decision, ...(comments ? { comments } : {}) })}
      />
    </>
  );
}

function EditMarkdown({ config, inputs, onSubmit }: ComponentProps<EditMarkdownConfig>): JSX.Element {
  const seed = config.source !== undefined ? displayText(inputs[config.source]) : "";
  const [content, setContent] = useState(seed);
  return (
    <>
      <label className="field">
        <span>Markdown</span>
        <textarea rows={14} value={content} onChange={(e) => setContent(e.target.value)} spellCheck={false} />
      </label>
      <div className="options">
        <button onClick={() => onSubmit({ content })}>Save</button>
      </div>
    </>
  );
}

/** Initial value for a field: its authored default, else an empty-ish value. */
function seedValue(field: FormField): unknown {
  if (field.default !== undefined) return field.default;
  switch (field.type) {
    case "boolean":
      return false;
    case "enum":
      return field.enum?.[0] ?? "";
    case "number":
      return "";
    default:
      return "";
  }
}

function FillForm({ config, onSubmit }: ComponentProps<FillFormConfig>): JSX.Element {
  const [values, setValues] = useState<Record<string, unknown>>(() =>
    Object.fromEntries(config.fields.map((f) => [f.name, seedValue(f)])),
  );
  const set = (name: string, value: unknown): void => setValues((v) => ({ ...v, [name]: value }));

  return (
    <>
      {config.fields.map((field) => (
        <label className="field" key={field.name}>
          <span>
            {field.label ?? field.name}
            {field.optional ? " (optional)" : ""}
          </span>
          {field.type === "boolean" ? (
            <input
              type="checkbox"
              checked={values[field.name] === true}
              onChange={(e) => set(field.name, e.target.checked)}
            />
          ) : field.type === "enum" ? (
            <select value={String(values[field.name] ?? "")} onChange={(e) => set(field.name, e.target.value)}>
              {(field.enum ?? []).map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          ) : field.multiline ? (
            <textarea rows={4} value={String(values[field.name] ?? "")} onChange={(e) => set(field.name, e.target.value)} />
          ) : (
            <input
              type={field.type === "number" ? "number" : "text"}
              value={String(values[field.name] ?? "")}
              onChange={(e) => set(field.name, e.target.value)}
            />
          )}
          {field.description ? <small>{field.description}</small> : null}
        </label>
      ))}
      <div className="options">
        <button
          onClick={() => {
            // Coerce number fields once, here: an <input type="number"> hands back a
            // string, and main validates types strictly.
            const payload: Record<string, unknown> = {};
            for (const field of config.fields) {
              const raw = values[field.name];
              if (field.type === "number") {
                if (raw === "" || raw === undefined) continue;
                payload[field.name] = typeof raw === "number" ? raw : Number(raw);
              } else {
                payload[field.name] = raw;
              }
            }
            onSubmit(payload);
          }}
        >
          Submit
        </button>
      </div>
    </>
  );
}

function ConfirmAction({ config, onSubmit }: ComponentProps<ConfirmActionConfig>): JSX.Element {
  return (
    <div className="options">
      <button onClick={() => onSubmit({ confirmed: true })}>{config.confirmLabel}</button>
      <button className="ghost" onClick={() => onSubmit({ confirmed: false })}>
        {config.cancelLabel}
      </button>
    </div>
  );
}

/**
 * Host a component that MOUNTS ITSELF (CHANGESETS.md §8.1). The contract is a mount function, not a
 * React element — the caller owns the node, the component owns everything inside it, and the caller
 * can be a pane, a modal, or a second window without the component knowing. This wrapper is what
 * lets the existing React shell be one such caller.
 *
 * Remounts on `mountKey`, never on the callback's identity: `mount` is an inline closure at every
 * call site, so depending on it would tear the component down on every shell render — a reviewer
 * losing its half-made decisions each time a stream delta arrives. The key names the REQUEST, which
 * is the thing whose change genuinely means "different review".
 */
function MountHost({ mount, mountKey }: { mount: (node: HTMLElement) => () => void; mountKey: string }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const latest = useRef(mount);
  latest.current = mount;
  useEffect(() => {
    const node = ref.current;
    if (node === null) return undefined;
    return latest.current(node);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mountKey]);
  return <div className="mount-host" ref={ref} />;
}

/**
 * The changeset gate as a hostable element — exported because it has TWO hosts (§8.1's point): the
 * gate modal below, and the reviewed task's conversation view. `about` scopes `$WORKTREE` reads to
 * the reviewed task; `project` says which project's anchors every read resolves against (see
 * `PendingInteraction.project` — a review is parked in JaiRA's own project and is about another's);
 * `services` lets a host with more reach (the app shell has `drafts` and `openFile`; this module has
 * neither) supply what it can.
 */
export function ChangesetGate({
  config,
  inputs,
  onSubmit,
  about,
  project,
  services,
  mountKey,
}: ComponentProps<UserApproveChangesetConfig> & {
  about?: string | undefined;
  project?: string | undefined;
  services?: Partial<ComponentServices> | undefined;
  /** The request id — what makes this a DIFFERENT review. See {@link MountHost}. */
  mountKey: string;
}): JSX.Element {
  return (
    <MountHost
      mountKey={mountKey}
      mount={(node) =>
        mountChangesetReview(node, {
          config,
          inputs,
          services: {
            ...rendererServices((channel, request) => invoke(channel, request), {
              ...(about !== undefined ? { taskId: about } : {}),
              ...(project !== undefined ? { project } : {}),
            }),
            ...(services ?? {}),
          },
          onSubmit,
        })
      }
    />
  );
}

/** Fallback for a gate whose function is not one of the built-ins. */
function RawJson({ onSubmit }: { onSubmit: (value: unknown) => void }): JSX.Element {
  const [text, setText] = useState("");
  return (
    <>
      <label className="field">
        <span>Response (JSON)</span>
        <textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
      </label>
      <div className="options">
        <button
          onClick={() => {
            try {
              onSubmit(JSON.parse(text) as unknown);
            } catch {
              onSubmit(text);
            }
          }}
        >
          Submit
        </button>
      </div>
    </>
  );
}

/**
 * The gate dialog: dispatches on the parsed component contract. This modal is the
 * only path by which a human decision enters a run (SPEC §11.4) — it reaches the
 * engine through `interaction:submit`, which nothing inside a workflow can call.
 */
export function InteractionDialog({
  pending,
  error,
  onSubmit,
  services,
}: {
  pending: PendingInteraction;
  error?: string | null;
  onSubmit: (value: unknown) => void;
  /** Extra reach for components that mount themselves — see {@link ChangesetGate}. */
  services?: Partial<ComponentServices>;
}): JSX.Element {
  const config = pending.config;
  const inputs = pending.inputs as Record<string, unknown>;
  const body = ((): JSX.Element => {
    if (pending.configError !== undefined) {
      return (
        <p className="reason">
          This state&apos;s <code>{pending.component}</code> config is invalid: {pending.configError}
        </p>
      );
    }
    switch (config?.component) {
      case "choose_option":
        return <ChooseOption config={config} inputs={inputs} onSubmit={onSubmit} />;
      case "review_artifact":
        return <ReviewArtifact config={config} inputs={inputs} onSubmit={onSubmit} />;
      case "edit_markdown":
        return <EditMarkdown config={config} inputs={inputs} onSubmit={onSubmit} />;
      case "fill_form":
        return <FillForm config={config} inputs={inputs} onSubmit={onSubmit} />;
      case "confirm_action":
        return <ConfirmAction config={config} inputs={inputs} onSubmit={onSubmit} />;
      case "user-approve-changeset":
        return (
          <ChangesetGate
            config={config}
            inputs={inputs}
            onSubmit={onSubmit}
            about={pending.about}
            project={pending.project}
            services={services}
            mountKey={pending.requestId}
          />
        );
      default:
        return <RawJson onSubmit={onSubmit} />;
    }
  })();

  // A multi-file review is far too big for the gate modal (CHANGESETS.md §11's rejected modal
  // reviewer) — the same host widens for it, which is the caller exercising the room §8.1 gives it.
  const wide = config?.component === "user-approve-changeset";

  return (
    <div className="modal-backdrop">
      <div className={wide ? "modal modal-wide" : "modal"} data-testid="interaction">
        <h3>{config?.prompt ?? pending.component}</h3>
        <div className="sub">
          {pending.component} · {pending.taskId}
        </div>
        {body}
        {error ? <p className="reason">{error}</p> : null}
      </div>
    </div>
  );
}

/**
 * The per-command approval dialog (DESIGN §10.2).
 *
 * Distinct from a workflow gate: policy escalated a *tool call*, so what the user
 * judges is a command, and the answer carries a SCOPE — the reason they are not
 * asked the same thing on every call. The scope buttons widen left to right, with
 * deny kept visually separate so the destructive-looking choice is not the easy
 * mis-click.
 */
export function ApprovalDialog({
  pending,
  error,
  onDecide,
}: {
  pending: PendingApproval;
  error?: string | null;
  onDecide: (decision: "allow" | "deny", scope: ApprovalScope) => void;
}): JSX.Element {
  const detail = JSON.stringify(pending.input, null, 2);
  return (
    <div className="modal-backdrop">
      <div className="modal" data-testid="approval">
        <h3>Approve this command?</h3>
        <div className="sub">
          {pending.tool}
          {pending.taskId ? ` · ${pending.taskId}` : ""}
        </div>

        {pending.command !== undefined ? (
          <pre className="artifact" data-testid="approval-command">
            {pending.command}
          </pre>
        ) : (
          <pre className="artifact">{detail}</pre>
        )}

        {pending.reason !== undefined ? <p className="reason-note">Policy: {pending.reason}</p> : null}

        <div className="options">
          <button onClick={() => onDecide("allow", "once")}>Allow once</button>
          <button onClick={() => onDecide("allow", "workflow-run")}>Allow for this run</button>
          <button onClick={() => onDecide("allow", "always")}>Always allow</button>
        </div>
        <div className="options">
          <button className="danger" onClick={() => onDecide("deny", "once")}>
            Deny
          </button>
        </div>
        {error ? <p className="reason">{error}</p> : null}
      </div>
    </div>
  );
}

/**
 * A running agent's question (`AskUserQuestion`) — the third dialog, and deliberately NOT the
 * approval one: nothing here is being authorized. The agent asked something and the options are its
 * own; the answer travels back as the tool's input, so the choices are labels, not verdicts.
 *
 * One question with a single choice submits on click — the common case reads as one tap. Multiple
 * questions (or a multi-select, or a typed "other") collect first and submit together, because a
 * batch is one tool call and half an answer is not a thing the wire can carry.
 */
export function QuestionDialog({
  pending,
  error,
  onSubmit,
}: {
  pending: PendingQuestion;
  error?: string | null;
  /** `undefined` dismisses: the agent is told to use its own judgment and continue. */
  onSubmit: (answers: Record<string, string | string[]> | undefined) => void;
}): JSX.Element {
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});

  const answerOf = (question: string): string | string[] | undefined => {
    const typed = (other[question] ?? "").trim();
    if (typed.length > 0) return typed;
    const chosen = picked[question] ?? [];
    if (chosen.length === 0) return undefined;
    const multi = pending.questions.find((q) => q.question === question)?.multiSelect === true;
    return multi ? chosen : chosen[0]!;
  };
  const complete = pending.questions.every((q) => answerOf(q.question) !== undefined);
  const submit = (): void => {
    const answers: Record<string, string | string[]> = {};
    for (const q of pending.questions) {
      const answer = answerOf(q.question);
      if (answer !== undefined) answers[q.question] = answer;
    }
    onSubmit(answers);
  };
  // The one-tap case: a single single-select question with nothing typed answers on the click.
  const immediate = pending.questions.length === 1 && pending.questions[0]!.multiSelect !== true;

  const toggle = (q: { question: string; multiSelect?: boolean }, label: string): void => {
    if (immediate && (other[q.question] ?? "").trim().length === 0) {
      onSubmit({ [q.question]: label });
      return;
    }
    setPicked((prev) => {
      const had = prev[q.question] ?? [];
      const next = q.multiSelect === true ? (had.includes(label) ? had.filter((l) => l !== label) : [...had, label]) : [label];
      return { ...prev, [q.question]: next };
    });
  };

  return (
    <div className="modal-backdrop">
      <div className="modal" data-testid="question">
        <h3>{pending.questions.length === 1 ? "The agent has a question" : "The agent has questions"}</h3>
        {pending.taskId !== undefined ? <div className="sub">{pending.taskId}</div> : null}
        {pending.questions.map((q) => (
          <div key={q.question} className="question-block">
            <p className="question-text">
              {q.header !== undefined && q.header.length > 0 ? <span className="chip">{q.header}</span> : null} {q.question}
            </p>
            <div className="question-options">
              {q.options.map((option) => (
                <button
                  key={option.label}
                  className={`question-option${(picked[q.question] ?? []).includes(option.label) ? " selected" : ""}`}
                  title={option.description ?? ""}
                  onClick={() => toggle(q, option.label)}
                >
                  <span className="question-option-label">{option.label}</span>
                  {option.description !== undefined && option.description.length > 0 ? (
                    <small className="question-option-desc">{option.description}</small>
                  ) : null}
                </button>
              ))}
            </div>
            <label className="field">
              <small>Other</small>
              <input
                value={other[q.question] ?? ""}
                placeholder="Type your own answer…"
                onChange={(e) => setOther((prev) => ({ ...prev, [q.question]: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (other[q.question] ?? "").trim().length > 0 && complete) submit();
                }}
              />
            </label>
          </div>
        ))}
        <div className="options">
          {!immediate || Object.values(other).some((t) => t.trim().length > 0) ? (
            <button disabled={!complete} onClick={submit}>
              Answer
            </button>
          ) : null}
          <button className="danger" onClick={() => onSubmit(undefined)}>
            Let the agent decide
          </button>
        </div>
        {error ? <p className="reason">{error}</p> : null}
      </div>
    </div>
  );
}
