/**
 * The five built-in UI components (SPEC §8.1, DESIGN §7.1).
 *
 * Each takes a parsed contract (normalized in the main process) plus the state's
 * resolved inputs, and calls `onSubmit` with a result shaped to land on the
 * state's declared outputs. Nothing here decides whether an answer is *valid* —
 * main re-validates every submission, so this layer is free to be purely about
 * presentation.
 */
import { useState, type JSX } from "react";
import {
  displayText,
  type ChooseOptionConfig,
  type ComponentConfig,
  type ComponentOption,
  type ConfirmActionConfig,
  type EditMarkdownConfig,
  type FillFormConfig,
  type FormField,
  type PendingInteraction,
  type ReviewArtifactConfig,
} from "@jaira/shared/browser";

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
}: {
  pending: PendingInteraction;
  error?: string | null;
  onSubmit: (value: unknown) => void;
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
      default:
        return <RawJson onSubmit={onSubmit} />;
    }
  })();

  return (
    <div className="modal-backdrop">
      <div className="modal" data-testid="interaction">
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
