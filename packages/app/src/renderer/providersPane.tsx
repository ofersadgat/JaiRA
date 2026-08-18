/**
 * Providers — everything that can answer a prompt, and how each is reached (DESIGN §8.1, §8.3).
 *
 * One screen where there were two. "Models" listed the four serving routes and "Executors" listed
 * the agents, which is a split along how JaiRA reaches a thing rather than along anything a user is
 * doing: both tabs answered *what can run here and how do I set it up*, and neither answered it on
 * its own. A model provider and an agent provider differ in their settings, not in their purpose,
 * and `providerSpecs.ts` is where that difference is stated — as a type hierarchy, so the form can
 * show which settings come from which level instead of flattening them into one pile of boxes.
 *
 * What this screen does NOT do is choose. Which provider a state actually uses is the Executors
 * screen's question; this one is only about what is installed, reachable, and turned on.
 *
 * The state of a provider is OBSERVED, never assumed. A checkbox can say only on or off, so an
 * unavailable provider used to render as a ticked box — which is how this screen came to claim four
 * working providers on a machine configured for none. A provider therefore has four states, and the
 * pill says which: ready, not working, not set up, turned off.
 */
import { useMemo, useState, type JSX } from "react";
import {
  SECRET_SOURCE_LABELS,
  SECRET_TARGET_LABELS,
  type ConfigLayer,
  type ConfigView,
  type ExecutorInfo,
  type ProbeResult,
  type SecretCapabilities,
  type SecretTarget,
} from "@jaira/shared/browser";
import { Disclosure, Field, FieldGrid, Level, SelectInput, StatusDot, Switch, TextArea, TextInput, stateWord, type ProviderState } from "./controls";
import { BrandIcon, Icon } from "./icons";
import {
  MODEL_PROVIDERS,
  agentProviders,
  allFields,
  fieldText,
  fieldValue,
  providerBlockPath,
  type FieldSpec,
  type ProviderSpec,
} from "./providerSpecs";
import { checkCredentialName, executorBlock, type ExecutorPatch, type ExecutorTarget } from "./executorConfig";
import { routeBlock, type ModelPatch } from "./modelsConfig";

/** What a provider's row should say, from its configuration and what the check observed. */
export function providerState(enabled: boolean, probe: ProbeResult | undefined): ProviderState {
  if (!enabled) return "off";
  if (probe === undefined) return "unchecked";
  if (probe.status === "ok") return "available";
  if (probe.status === "failed") return "unavailable";
  if (probe.status === "disabled") return "off";
  return "unconfigured";
}

export interface ProvidersPaneProps {
  config: ConfigView | null;
  executors: ExecutorInfo[];
  /**
   * What the checks observed, kept as TWO maps rather than one.
   *
   * A route and an executor are different namespaces: nothing stops someone registering a generic
   * CLI called `local`, and a single merged map would then report one provider's health for the
   * other. Each row looks its result up in the map for its own family.
   */
  routeProbes: Record<string, ProbeResult>;
  executorProbes: Record<string, ProbeResult>;
  secrets: SecretCapabilities;
  busy: boolean;
  layer: ConfigLayer;
  /** False when this layer has no document to write — see the Settings shell, which hides the layer. */
  editable: boolean;
  onSaveRoute: (fields: ModelPatch, layer: ConfigLayer) => void;
  onSaveExecutor: (executor: ExecutorTarget, fields: ExecutorPatch, layer: ConfigLayer) => void;
  onAdd: (spec: { name: string; command: string }, layer: ConfigLayer) => void;
  onRemove: (name: string, layer: ConfigLayer) => void;
  onSaveCredential: (request: {
    executor: ExecutorTarget & { credential?: string | undefined };
    name: string;
    value: string;
    target: SecretTarget;
    layer: ConfigLayer;
  }) => void;
}

export function ProvidersPane(props: ProvidersPaneProps): JSX.Element {
  const { config, executors, routeProbes, executorProbes, layer } = props;
  const agents = useMemo(() => agentProviders(executors), [executors]);

  if (config === null) {
    return <p className="empty">The configuration could not be read.</p>;
  }

  const layerDoc = layer === "base" ? config.base : config.project;
  const groups: Array<{ title: string; hint: string; specs: ProviderSpec[] }> = [
    {
      title: "Model providers",
      hint: "They return a completion. A model id's prefix names one — anthropic/claude-sonnet-5 goes to the first of these.",
      specs: MODEL_PROVIDERS,
    },
    {
      title: "Agent providers",
      hint: "They answer by RUNNING — reading files, executing commands — on their own subscription or key. A prefix names one of these too: claude-cli/sonnet.",
      specs: agents,
    },
  ];

  return (
    <div className="cfg-pane">
      {groups.map((group) => (
        <section key={group.title} className="cfg-group">
          <header className="cfg-group-head">
            <h4>{group.title}</h4>
            <p className="cfg-hint">{group.hint}</p>
          </header>
          <ul className="cfg-rows">
            {group.specs.map((spec) => (
              <ProviderRow
                key={`${layer}:${spec.id}`}
                spec={spec}
                probe={spec.family === "model" ? routeProbes[spec.id] : executorProbes[spec.id]}
                layerDoc={layerDoc}
                effective={config.effective}
                {...props}
              />
            ))}
          </ul>
        </section>
      ))}
      <AddProvider layer={layer} busy={props.busy || !props.editable} onAdd={props.onAdd} />
    </div>
  );
}

/** This layer's own block for a provider, and the merged one — values and placeholders respectively. */
function blocksFor(spec: ProviderSpec, layerDoc: unknown, effective: unknown): {
  here: Record<string, unknown>;
  merged: Record<string, unknown>;
} {
  if (spec.location.kind === "route") {
    return {
      here: routeBlock(layerDoc, spec.location.key) ?? {},
      merged: routeBlock(effective, spec.location.key) ?? {},
    };
  }
  return {
    here: executorBlock(layerDoc, spec.location.name) ?? {},
    merged: executorBlock(effective, spec.location.name) ?? {},
  };
}

function ProviderRow({
  spec,
  probe,
  layerDoc,
  effective,
  busy,
  editable,
  layer,
  secrets,
  config,
  onSaveRoute,
  onSaveExecutor,
  onRemove,
  onSaveCredential,
}: ProvidersPaneProps & {
  spec: ProviderSpec;
  probe: ProbeResult | undefined;
  layerDoc: unknown;
  effective: unknown;
}): JSX.Element {
  const { here, merged } = blocksFor(spec, layerDoc, effective);
  const fields = useMemo(() => allFields(spec), [spec]);
  const saved = useMemo(
    () => Object.fromEntries(fields.map((f) => [f.path, fieldText(f.control, readAt(here, f.path))])),
    [fields, here],
  );

  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<Record<string, string>>(saved);
  const [baseline, setBaseline] = useState(saved);
  const [problem, setProblem] = useState<string | null>(null);

  // The document moved under the form — usually because this row just saved. Untouched boxes follow
  // it, edited ones are kept, so a save never discards typing that has not been sent yet.
  if (fields.some((f) => (baseline[f.path] ?? "") !== (saved[f.path] ?? ""))) {
    const next = { ...saved };
    for (const f of fields) if ((form[f.path] ?? "") !== (baseline[f.path] ?? "")) next[f.path] = form[f.path] ?? "";
    setBaseline(saved);
    setForm(next);
  }

  const locked = busy || !editable;
  const enabled = here["enabled"] !== false && merged["enabled"] !== false;
  const state = providerState(enabled, probe);
  const dirty = fields.some((f) => (form[f.path] ?? "") !== (saved[f.path] ?? ""));

  const write = (patch: Record<string, unknown>): void => {
    if (spec.location.kind === "route") {
      const key = spec.location.key;
      onSaveRoute(Object.fromEntries(Object.entries(patch).map(([p, v]) => [`routes.${key}.${p}`, v])), layer);
    } else {
      onSaveExecutor(
        {
          name: spec.location.name,
          kind: spec.location.executorKind,
          ...(typeof merged["command"] === "string" ? { command: merged["command"] } : {}),
        },
        patch,
        layer,
      );
    }
  };

  const save = (): void => {
    try {
      const patch: Record<string, unknown> = {};
      for (const f of fields) {
        if ((form[f.path] ?? "") === (saved[f.path] ?? "")) continue;
        patch[f.path] = fieldValue(f, form[f.path] ?? "");
      }
      setProblem(null);
      if (Object.keys(patch).length > 0) write(patch);
    } catch (e) {
      setProblem((e as Error).message);
    }
  };

  return (
    <li className={`cfg-row ${state}`}>
      {/* The mark carries the dot, so identity and state are read in one fixation rather than two.
          `spec.id` and not `spec.title`: the id is the registry name (`codex-cli`, `anthropic`),
          which is what `brandOf` knows how to resolve — "Codex" and "Claude CLI" are display
          spellings and match nothing. */}
      <div className="cfg-row-head">
        <span className="cfg-mark">
          <BrandIcon name={spec.id} className="cfg-mark-svg" />
          <StatusDot state={state} />
        </span>
        <span className="cfg-row-title">{spec.title}</span>
        {probe?.version ? <code className="cfg-version">{probe.version}</code> : null}
        <span className="grow" />
        <Switch
          on={enabled}
          disabled={locked}
          label={enabled ? `stop using ${spec.title} in this project` : `use ${spec.title} again`}
          // `undefined` REMOVES the key rather than writing `true`: on is the default, and a layer
          // that says so explicitly is a layer overriding something for no reason.
          onChange={(next) => write({ enabled: next ? undefined : false })}
        />
        <button
          className={`quiet cfg-chevron${open ? " open" : ""}`}
          aria-expanded={open}
          aria-label={open ? `hide ${spec.title}'s settings` : `configure ${spec.title}`}
          title={open ? "Done" : "Configure"}
          onClick={() => setOpen((v) => !v)}
        >
          <Icon name="chevron" />
        </button>
      </div>

      {/* One SENTENCE, where there was a description, a pill and a boxed report saying overlapping
          things. What a collapsed row owes the reader is the state of this provider on this machine
          right now; `spec.hint` — the standing "would you want this at all" line — moved inside,
          where it is read once while deciding rather than on every pass down the list. */}
      <p className="cfg-say">
        <span className="cfg-say-state">{stateWord(state)}</span>
        {probe && state !== "off" && probe.detail ? <> — {probe.detail}</> : null}
        {probe && state !== "off" && probe.fix ? <span className="cfg-fix">→ {probe.fix}</span> : null}
      </p>

      {open ? (
        <div className="cfg-row-body">
          <p className="cfg-hint">{spec.hint}</p>
          {spec.levels.map((level, depth) => (
            <Level key={level.title} title={level.title} hint={level.hint} depth={depth}>
              {level.fields.length === 0 ? (
                <p className="cfg-hint">Nothing to configure at this level.</p>
              ) : (
                <FieldGrid>
                  {level.fields.map((field) => (
                    <Field
                      key={field.path}
                      label={field.label}
                      param={paramOf(spec, field)}
                      hint={field.hint}
                      set={readAt(here, field.path) !== undefined}
                    >
                      <FieldControl
                        field={field}
                        value={form[field.path] ?? ""}
                        placeholder={placeholderFor(field, merged)}
                        disabled={locked}
                        onChange={(v) => setForm((f) => ({ ...f, [field.path]: v }))}
                      />
                    </Field>
                  ))}
                </FieldGrid>
              )}
            </Level>
          ))}

          <p className="cfg-hint">
            An empty box removes the setting from this layer, so it goes back to whatever the other
            layer or the built-in default says.
          </p>
          {problem ? <p className="sub warn-text">{problem}</p> : null}
          <div className="pane-actions">
            <button className="primary" onClick={save} disabled={locked || !dirty}>
              Save
            </button>
            <button
              className="ghost"
              onClick={() => {
                setForm(saved);
                setProblem(null);
              }}
              disabled={!dirty}
            >
              Revert
            </button>
            {spec.location.kind === "agent" && spec.location.executorKind === "generic" ? (
              <button
                className="ghost danger"
                disabled={locked}
                title="delete this CLI from the layer being edited — a built-in can only be turned off"
                onClick={() => onRemove(spec.id, layer)}
              >
                Remove
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      <CredentialBlock
        spec={spec}
        probe={probe}
        merged={merged}
        layer={layer}
        busy={locked}
        secrets={secrets}
        hasProject={config !== null && config.projectFile.length > 0}
        onSave={onSaveCredential}
      />
    </li>
  );
}

/** The config path this field writes, for the tag beside its label. */
function paramOf(spec: ProviderSpec, field: FieldSpec): string {
  const path = providerBlockPath(spec);
  if (path !== null) return `${path.join(".")}.${field.path}`;
  return `agents.genericCli[${spec.id}].${field.path}`;
}

/** Read a dotted path out of a block. */
function readAt(block: Record<string, unknown>, path: string): unknown {
  let cursor: unknown = block;
  for (const part of path.split(".")) {
    if (cursor === null || typeof cursor !== "object" || Array.isArray(cursor)) return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

/** What the field would be if this layer said nothing — the inherited value, else the suggestion. */
function placeholderFor(field: FieldSpec, merged: Record<string, unknown>): string {
  const inherited = fieldText(field.control, readAt(merged, field.path));
  if (inherited.length > 0 && field.control !== "select") return `${inherited} (inherited)`;
  return field.placeholder ?? "—";
}

function FieldControl({
  field,
  value,
  placeholder,
  disabled,
  onChange,
}: {
  field: FieldSpec;
  value: string;
  placeholder: string;
  disabled: boolean;
  onChange: (v: string) => void;
}): JSX.Element {
  if (field.control === "select") {
    return <SelectInput value={value} options={field.options ?? []} disabled={disabled} onChange={onChange} />;
  }
  if (field.control === "json" || field.control === "argv" || field.control === "env" || field.control === "patterns") {
    return <TextArea value={value} rows={field.control === "json" ? 5 : 3} placeholder={placeholder} disabled={disabled} onChange={onChange} />;
  }
  return (
    <TextInput
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      mono={field.control === "secret-name" || field.control === "url"}
      onChange={onChange}
    />
  );
}

/**
 * Where a provider's key comes from, and how to store one.
 *
 * Absent entirely for a runtime that uses no key. `claude-cli` carries the subscription its user
 * signed into: a box here invited someone to store a secret nothing would ever read, and then to
 * believe the provider was configured because the box was full. What it gets instead is the one
 * sentence that actually helps — how it signs in.
 */
function CredentialBlock({
  spec,
  probe,
  merged,
  layer,
  busy,
  secrets,
  hasProject,
  onSave,
}: {
  spec: ProviderSpec;
  probe: ProbeResult | undefined;
  merged: Record<string, unknown>;
  layer: ConfigLayer;
  busy: boolean;
  secrets: SecretCapabilities;
  hasProject: boolean;
  onSave: ProvidersPaneProps["onSaveCredential"];
}): JSX.Element | null {
  const named = typeof merged["credential"] === "string" ? merged["credential"] : undefined;
  const targets: SecretTarget[] = [
    ...(secrets.keychain ? (["keychain"] as SecretTarget[]) : []),
    ...(hasProject ? (["project-env-local"] as SecretTarget[]) : []),
    "base-env-local",
  ];
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [typedName, setTypedName] = useState("");
  const [target, setTarget] = useState<SecretTarget>(targets[0] ?? "base-env-local");
  const [problem, setProblem] = useState<string | null>(null);

  if (spec.credential === "none") {
    // Two very different reasons a provider uses no key, and they need different sentences. An AGENT
    // signs itself in, and the useful thing to say is how. A model provider that simply has no key —
    // weights on disk — has nothing to say at all, and the old wording told someone to run
    // `embedded login`, which is not a program.
    return spec.family === "agent" ? (
      <p className="cfg-hint">
        No API key — this runtime signs itself in. If it is not authenticated, run{" "}
        <code>{typeof merged["command"] === "string" ? merged["command"] : spec.id} login</code> in a terminal.
      </p>
    ) : null;
  }

  // What a stored key would be filed under: what config already names, else what has been typed
  // here, else the conventional variable. The last is what makes a first run possible without
  // reading the documentation to find out what JaiRA expects the key to be called — and the typed
  // one is what makes a provider with NO convention (a local server) reachable at all, which it was
  // not: the button sat permanently disabled with nowhere to enter a name.
  const name = named ?? (typedName.trim() || spec.suggestedCredential) ?? "";
  const needsName = named === undefined && spec.suggestedCredential === undefined;

  return (
    <div className="cfg-credential">
      <span className="cfg-hint">
        {named ? (
          <>
            Key <code>{named}</code>
            {probe?.credential ? ` — found in ${SECRET_SOURCE_LABELS[probe.credential.source]}` : null}
            {probe?.credentialMissing ? " — not found anywhere" : null}
          </>
        ) : spec.credential === "optional" ? (
          <>No key named, which is fine unless this provider needs one.</>
        ) : (
          <>
            No key named. Storing one below also writes the name <code>{name}</code> into this layer, so it is
            actually looked up.
          </>
        )}
      </span>
      {open ? (
        <div className="cfg-key-entry">
          {needsName ? (
            <Field
              label="Secret name"
              param="credential"
              hint="What this key is filed under. Config stores this NAME; the value goes to the store you pick below."
            >
              <TextInput value={typedName} mono placeholder="LOCAL_API_KEY" onChange={setTypedName} />
            </Field>
          ) : null}
          <input
            type="password"
            className="cfg-input mono"
            value={value}
            placeholder={`the value of ${name || "the secret"} — empty clears it`}
            onChange={(e) => setValue(e.target.value)}
          />
          <SelectInput
            value={target}
            options={targets.map((t) => [SECRET_TARGET_LABELS[t], t])}
            onChange={(v) => setTarget(v as SecretTarget)}
          />
          <div className="pane-actions">
            <button
              disabled={busy || name.length === 0}
              onClick={() => {
                try {
                  checkCredentialName(name);
                } catch (e) {
                  setProblem((e as Error).message);
                  return;
                }
                onSave({
                  executor: {
                    name: spec.id,
                    kind: spec.location.kind === "agent" ? spec.location.executorKind : "generic",
                    ...(named !== undefined ? { credential: named } : {}),
                  },
                  name,
                  value,
                  target,
                  layer,
                });
                setValue("");
                setTypedName("");
                setOpen(false);
              }}
            >
              Store the key
            </button>
            <button
              className="ghost"
              onClick={() => {
                setOpen(false);
                setValue("");
              }}
            >
              Cancel
            </button>
          </div>
          {problem ? <p className="sub warn-text">{problem}</p> : null}
        </div>
      ) : (
        <button className="ghost" disabled={busy} onClick={() => setOpen(true)}>
          {named ? "Replace the key" : "Add a key"}
        </button>
      )}
    </div>
  );
}

/** Declare a new agent CLI in the layer being edited (DESIGN §8.1's `generic-cli`). */
function AddProvider({
  layer,
  busy,
  onAdd,
}: {
  layer: ConfigLayer;
  busy: boolean;
  onAdd: (spec: { name: string; command: string }, layer: ConfigLayer) => void;
}): JSX.Element {
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");

  return (
    <Disclosure summary="Add an agent CLI" desc="any other coding-agent binary">
      <div className="cfg-stack">
        <p className="cfg-hint">
          It is registered under the name you give it, which is what a state&apos;s <code>function</code> then
          names and what a model prefix routes to. It enforces no policy of its own, so a project whose policy
          can require approval will refuse it.
        </p>
        <FieldGrid>
          <Field label="Registry name" param="agents.genericCli[].name" hint="How a workflow will name it.">
            <TextInput value={name} placeholder="opencode" disabled={busy} onChange={setName} />
          </Field>
          <Field label="Command" param="agents.genericCli[].command" hint="The executable, or a full path.">
            <TextInput value={command} placeholder="opencode" disabled={busy} onChange={setCommand} />
          </Field>
        </FieldGrid>
        <div className="pane-actions">
          <button
            disabled={busy || name.trim().length === 0 || command.trim().length === 0}
            onClick={() => {
              onAdd({ name: name.trim(), command: command.trim() }, layer);
              setName("");
              setCommand("");
            }}
          >
            Add it
          </button>
        </div>
      </div>
    </Disclosure>
  );
}
