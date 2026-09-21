/**
 * The rest of the configuration — as a FORM, not a JSON box.
 *
 * Providers and Executors got purpose-built screens because they are what people configure daily.
 * Everything else was left to a raw editor, which is the same failure the LLM config box had: it
 * makes the user the parser. You had to already know the field is `inlineMaxBytes` and not
 * `maxInlineBytes`, that `execEnvironment` takes a string OR an object, and that a destination is a
 * template over a closed variable set — none of which the box told you, and all of which it would
 * accept and then refuse on save.
 *
 * Two things get bespoke controls rather than the generic renderer, because their shape carries
 * meaning a property walk cannot:
 *
 *  - **The exec environment** is `"windows" | { wsl }` — a discriminated union spelled as a string or
 *    an object, which no "type: object" schema describes honestly.
 *  - **The policy** is an ORDERED rule list over command matchers, first match wins. Order is the
 *    meaning, so it gets a list with move controls, exactly as the function rules do.
 *
 * The raw document stays reachable behind a disclosure. That is not a hedge: the policy block is
 * `Record<string, JsonValue>` at the config layer and a project may legitimately carry a field newer
 * than this form, so the escape hatch is what keeps the screen from being lossy.
 */
import { useState, type JSX } from "react";
import {
  ARTIFACT_DESTINATIONS,
  ARTIFACT_VARIABLES,
  CONFIG_SECTIONS,
  type ConfigLayer,
  type ConfigView,
} from "@jaira/shared/browser";
import { Chip, Disclosure, Field, FieldGrid, Level, NumInput, SelectInput, TextInput } from "./controls";
import { LlmConfigForm, summariseLlmConfig, type LlmConfigDoc } from "./llmConfigForm";
import { SchemaForm } from "./schemaForm/SchemaForm";
import type { Schema } from "./schemaForm/types";

export interface ConfigPaneProps {
  config: ConfigView | null;
  layer: ConfigLayer;
  busy: boolean;
  editable: boolean;
  /** Write the whole layer document. The caller validates it in main before it lands. */
  onSave: (layer: ConfigLayer, doc: unknown) => void;
  /** The raw-JSON escape hatch, which is still the Files view's editor. */
  children?: JSX.Element;
}

/**
 * Write into ONE layer's document, a dotted path at a time — what every form on a settings screen
 * saves through.
 *
 * `set` writes one path; `undefined` removes it, so the field inherits again, and a container the
 * removal emptied goes with it. `stated` says whether THIS layer says anything at a path, which is
 * what a field's set/not-set switch shows. Both read the layer's own document and never the merged
 * one: saving in a project must not copy the shared root's settings out of it.
 */
export function layerWriter(
  doc: Record<string, unknown> | null,
  layer: ConfigLayer,
  onSave: (layer: ConfigLayer, doc: unknown) => void,
): { set: (path: string, value: unknown) => void; stated: (path: string) => boolean } {
  const set = (path: string, value: unknown): void => {
    const next = structuredClone(doc ?? {}) as Record<string, unknown>;
    const parts = path.split(".");
    const chain: Array<{ parent: Record<string, unknown>; key: string }> = [];
    let cursor = next;
    for (const part of parts.slice(0, -1)) {
      const held = cursor[part];
      cursor[part] = held !== null && typeof held === "object" && !Array.isArray(held) ? { ...(held as object) } : {};
      chain.push({ parent: cursor, key: part });
      cursor = cursor[part] as Record<string, unknown>;
    }
    const leaf = parts[parts.length - 1]!;
    if (value === undefined) delete cursor[leaf];
    else cursor[leaf] = value;
    // A container the removal emptied goes with it, so an untouched section leaves no trace.
    for (const { parent, key } of chain.reverse()) {
      const block = parent[key];
      if (block !== null && typeof block === "object" && !Array.isArray(block) && Object.keys(block).length === 0) {
        delete parent[key];
      }
    }
    onSave(layer, next);
  };

  const stated = (path: string): boolean => {
    let cursor: unknown = doc;
    for (const part of path.split(".")) {
      if (cursor === null || typeof cursor !== "object" || Array.isArray(cursor)) return false;
      cursor = (cursor as Record<string, unknown>)[part];
      if (cursor === undefined) return false;
    }
    return true;
  };
  return { set, stated };
}

export function ConfigPane({ config, layer, busy, editable, onSave, children }: ConfigPaneProps): JSX.Element {
  if (config === null) return <p className="empty">The configuration could not be read.</p>;

  const doc = (layer === "base" ? config.base : config.project) as Record<string, unknown> | null;
  const effective = config.effective as Record<string, unknown>;
  const locked = busy || !editable;

  const { set, stated } = layerWriter(doc, layer, onSave);

  return (
    <div className="cfg-pane">
      <Artifacts effective={effective} locked={locked} stated={stated} set={set} />
      <ExecEnvironment effective={effective} locked={locked} stated={stated} set={set} />
      <DefaultEnvironment effective={effective} locked={locked} stated={stated} set={set} />
      <Policy effective={effective} locked={locked} stated={stated} set={set} />

      {/* `autopilot` (decision 0005 §6) through the same declared form: one number, and its description
          is the whole explanation — the threshold a fast-forward's answers are held to. */}
      {CONFIG_SECTIONS.filter((s) => s.key === "autopilot" || s.key === "memo" || s.key === "workflows").map((section) => (
        <section key={section.key} className="cfg-group">
          <header className="cfg-group-head">
            <h4>{section.title}</h4>
            <p className="cfg-hint">{section.hint}</p>
          </header>
          <SchemaForm
            schema={section.schema as Schema}
            value={effective[section.key]}
            onChange={(next) => set(section.key, next)}
            // `setAt` writes each field at its own path. `value` is the MERGED section, and handing a
            // rebuilt section back would pin every inherited sibling into this layer with the one edit.
            ctx={{ path: section.key, disabled: locked, isSet: stated, setAt: set }}
          />
        </section>
      ))}

      <Disclosure summary="The raw document" desc="everything, as it is stored">
        <div className="cfg-stack">
          <p className="cfg-hint">
            The escape hatch, and the reason this screen is not lossy: a project may carry a field
            newer than this form, and it survives every save made above.
          </p>
          {children}
        </div>
      </Disclosure>
    </div>
  );
}

interface Writer {
  effective: Record<string, unknown>;
  locked: boolean;
  stated: (path: string) => boolean;
  set: (path: string, value: unknown) => void;
}

/** Where a produced file lands — a template, offered as presets plus the variables it may use. */
function Artifacts({ effective, locked, stated, set }: Writer): JSX.Element {
  const artifacts = (effective["artifacts"] ?? {}) as Record<string, unknown>;
  const destination = typeof artifacts["destination"] === "string" ? (artifacts["destination"] as string) : "";

  return (
    <section className="cfg-group">
      <header className="cfg-group-head">
        <h4>Artifacts</h4>
        <p className="cfg-hint">
          Where a file an agent produces actually lands. A path TEMPLATE rather than a mode, because
          &ldquo;which backend&rdquo; and &ldquo;how the path is derived&rdquo; are independent questions
          and an enum conflates them.
        </p>
      </header>

      <Field
        label="Destination"
        param="artifacts.destination"
        hint="Pick one, or write a template of your own."
        set={stated("artifacts.destination")}
      >
        <div className="cfg-stack">
          <div className="cfg-chips">
            {ARTIFACT_DESTINATIONS.map((option) => (
              <Chip
                key={option.value}
                active={destination === option.value}
                disabled={locked}
                title={option.what}
                onClick={() => set("artifacts.destination", option.value)}
              >
                {option.label}
              </Chip>
            ))}
          </div>
          <TextInput
            value={destination}
            mono
            placeholder="$JAIRA/artifacts/$TASK_ID/$RELPATH"
            disabled={locked}
            onChange={(v) => set("artifacts.destination", v === "" ? undefined : v)}
          />
          <p className="cfg-hint">
            Variables: {ARTIFACT_VARIABLES.map((v) => <code key={v}>{v} </code>)}
          </p>
        </div>
      </Field>

      <FieldGrid>
        <Field
          label="Artifact directory"
          param="artifacts.dir"
          hint="What $ARTIFACT_DIR expands to, inside the root's system/ directory."
          set={stated("artifacts.dir")}
        >
          <TextInput
            value={typeof artifacts["dir"] === "string" ? (artifacts["dir"] as string) : ""}
            mono
            placeholder="artifacts"
            disabled={locked}
            onChange={(v) => set("artifacts.dir", v === "" ? undefined : v)}
          />
        </Field>
        <Field
          label="Keep inline below"
          param="artifacts.inlineMaxBytes"
          hint="Content smaller than this rides along in bindings and prompts rather than being read back. Larger is fewer reads and bigger prompts."
          set={stated("artifacts.inlineMaxBytes")}
        >
          <NumInput
            value={typeof artifacts["inlineMaxBytes"] === "number" ? (artifacts["inlineMaxBytes"] as number) : undefined}
            disabled={locked}
            onChange={(n) => set("artifacts.inlineMaxBytes", n)}
          />
        </Field>
      </FieldGrid>
    </section>
  );
}

/** Where the project-wide defaults live in the config document — see {@link DefaultEnvironment}. */
const DEFAULT_ENVIRONMENT = "executors.default.prompt.defaults";

/**
 * The project's own `environment` block: what fills a call that a state left unsaid.
 *
 * A state's `environment` is a defaults layer over its descendants; this is the same idea one level
 * out, over every state in the project. It was reachable already — the executor tree's router node
 * carries a `defaults` block and always has — but only by opening Executors, expanding the tree, and
 * recognizing "Default call settings" as the thing you were looking for. Nobody found it, which for
 * a setting is the same as not having it.
 *
 * So it is surfaced here under the name it has everywhere else, and it writes to the SAME place:
 * `executors.default.prompt.defaults`. One storage location, two ways in. A second key meaning the
 * same thing would be a second answer to "what model does this project use by default", and the two
 * would disagree the first time somebody edited one of them.
 *
 * Only the call surface, deliberately. An `environment` may also carry `prompt`, `function` and
 * `args`, and a project-wide default for any of those is not a default — it is a state's whole
 * operation, applied to every state that never asked for one.
 */
function DefaultEnvironment({ effective, locked, stated, set }: Writer): JSX.Element {
  const executors = (effective["executors"] ?? {}) as Record<string, unknown>;
  const prompt = ((executors["default"] as Record<string, unknown> | undefined)?.["prompt"] ?? {}) as Record<string, unknown>;
  const defaults = (prompt["defaults"] ?? {}) as Record<string, unknown>;
  const model = typeof defaults["model"] === "string" ? (defaults["model"] as string) : "";
  const { model: _model, ...knobs } = defaults;

  return (
    <section className="cfg-group">
      <header className="cfg-group-head">
        <h4>Default environment</h4>
        <p className="cfg-hint">
          What a state that names nothing is filled in with — the same fields a state&rsquo;s own
          <code> environment </code> block carries, one level out. Applied UNDER whatever a state
          says, so naming a field there always wins.
        </p>
      </header>

      <Field
        label="Default model"
        param={`${DEFAULT_ENVIRONMENT}.model`}
        hint="A bare id routes to whatever serves that family here — 'claude-sonnet-5' reaches the CLI agent on a machine with no API key. Prefix it ('claude-cli/sonnet') to insist on one route. Empty leaves the choice to the state."
        set={stated(`${DEFAULT_ENVIRONMENT}.model`)}
      >
        <TextInput
          value={model}
          mono
          placeholder="left to the state"
          disabled={locked}
          onChange={(v) => set(`${DEFAULT_ENVIRONMENT}.model`, v === "" ? undefined : v)}
        />
      </Field>

      <LlmConfigForm
        value={knobs as LlmConfigDoc}
        disabled={locked}
        onChange={(next) => {
          // The model is written by the field above and merged back here, so editing a knob cannot
          // drop it — the same shape the executor tree's own defaults editor uses, for the same
          // reason: `LlmConfigForm` owns every key it renders and would otherwise take the block.
          const merged = { ...next, ...(model === "" ? {} : { model }) };
          set(DEFAULT_ENVIRONMENT, Object.keys(merged).length === 0 ? undefined : merged);
        }}
      />
      <p className="cfg-hint">{summariseLlmConfig(knobs as LlmConfigDoc)}</p>
    </section>
  );
}

/**
 * `"windows" | { wsl: string }` — a discriminated union spelled two different ways.
 *
 * Its own control because no `type: object` schema describes that honestly: the generic renderer
 * would offer a `wsl` box on a value that is sometimes a bare string, and writing to it would produce
 * a document the parser refuses.
 */
function ExecEnvironment({ effective, locked, stated, set }: Writer): JSX.Element {
  const value = effective["execEnvironment"];
  const distro = value !== null && typeof value === "object" ? String((value as { wsl?: string }).wsl ?? "") : "";

  return (
    <section className="cfg-group">
      <header className="cfg-group-head">
        <h4>Where commands run</h4>
        <p className="cfg-hint">
          Natively, or inside a WSL distro — which is where git and every agent then run too.
          Deliberately not Windows git against <code>\\wsl$</code>, which is slow and permission-fragile.
        </p>
      </header>
      <FieldGrid>
        <Field
          label="Environment"
          param="execEnvironment"
          hint="Naming a distro runs everything inside it."
          set={stated("execEnvironment")}
        >
          <SelectInput
            value={distro === "" ? "windows" : "wsl"}
            options={[
              ["natively on Windows", "windows"],
              ["inside a WSL distro", "wsl"],
            ]}
            disabled={locked}
            onChange={(v) => set("execEnvironment", v === "windows" ? "windows" : { wsl: distro || "Ubuntu" })}
          />
        </Field>
        {distro !== "" || (typeof value === "object" && value !== null) ? (
          <Field label="Distro" param="execEnvironment.wsl" hint="As `wsl -l` lists it." set={stated("execEnvironment")}>
            <TextInput
              value={distro}
              mono
              placeholder="Ubuntu"
              disabled={locked}
              onChange={(v) => set("execEnvironment", { wsl: v })}
            />
          </Field>
        ) : null}
      </FieldGrid>
    </section>
  );
}

/** The actions a policy rule can take, in the order they escalate. */
const POLICY_ACTIONS: Array<[string, string]> = [
  ["allow", "allow"],
  ["ask first", "require_approval"],
  ["deny", "deny"],
];

interface PolicyRule {
  match?: { program?: string; subcommand?: string; flags?: string[]; anyFlag?: string[]; argIncludes?: string };
  action?: string;
  reason?: string;
}

/**
 * The safety policy: an ORDERED rule list over parsed command intent, first match wins.
 *
 * Order is the meaning, so this is a list with move controls rather than a set of fields — the same
 * shape the function rules take, for the same reason. The matcher is over PARSED intent (a program, a
 * subcommand, a flag) and never a regex over the raw string, which is what makes a rule mean the same
 * thing whichever way a command was spelled.
 */
function Policy({ effective, locked, stated, set }: Writer): JSX.Element {
  const policy = (effective["policy"] ?? {}) as Record<string, unknown>;
  const rules = Array.isArray(policy["rules"]) ? (policy["rules"] as PolicyRule[]) : [];

  const write = (next: PolicyRule[]): void => set("policy.rules", next.length > 0 ? next : undefined);
  const replace = (index: number, rule: PolicyRule): void => write(rules.map((r, i) => (i === index ? rule : r)));
  const move = (index: number, by: number): void => {
    const next = [...rules];
    const target = index + by;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    write(next);
  };

  return (
    <section className="cfg-group">
      <header className="cfg-group-head">
        <h4>Safety policy</h4>
        <p className="cfg-hint">
          What an agent may run without asking. Rules are checked IN ORDER and the first match wins;
          anything no rule matches falls through to the built-in rules and then to the default below.
          A matcher is over parsed intent — a program, a subcommand, a flag — never a regex over the
          raw string, so a rule means the same thing however the command was spelled.
        </p>
      </header>

      <FieldGrid>
        <Field
          label="Anything else"
          param="policy.default"
          hint="The verdict for a command no rule and no built-in matches."
          set={stated("policy.default")}
        >
          <SelectInput
            value={typeof policy["default"] === "string" ? (policy["default"] as string) : ""}
            options={[["— inherit (allow)", ""], ...POLICY_ACTIONS]}
            disabled={locked}
            onChange={(v) => set("policy.default", v === "" ? undefined : v)}
          />
        </Field>
        <Field
          label="Unlisted tools"
          param="policy.toolDefault"
          hint="For tools that do not run a command line — writing a file, say."
          set={stated("policy.toolDefault")}
        >
          <SelectInput
            value={typeof policy["toolDefault"] === "string" ? (policy["toolDefault"] as string) : ""}
            options={[
              ["— inherit", ""],
              ["allow", "allow"],
              ["ask first", "ask"],
              ["deny", "deny"],
            ]}
            disabled={locked}
            onChange={(v) => set("policy.toolDefault", v === "" ? undefined : v)}
          />
        </Field>
        <Field
          label="Built-in rules"
          param="policy.builtins"
          hint="JaiRA's own refusals — force pushes, credential paths, package publishes. Turning them off is a deliberate opt-out."
          set={stated("policy.builtins")}
        >
          <SelectInput
            value={policy["builtins"] === false ? "off" : ""}
            options={[
              ["on — the built-in refusals apply", ""],
              ["off — this project's rules only", "off"],
            ]}
            disabled={locked}
            onChange={(v) => set("policy.builtins", v === "off" ? false : undefined)}
          />
        </Field>
      </FieldGrid>

      <Level title={`Rules (${rules.length})`} depth={1} hint="First match wins, so order matters.">
        <div className="cfg-stack">
          {rules.length === 0 ? (
            <p className="cfg-hint">
              No rules of this project&apos;s own — the built-ins and the default above decide everything.
            </p>
          ) : null}
          {rules.map((rule, index) => (
            <div key={index} className="cfg-rule-card">
              <div className="cfg-rule-head">
                <span className="cfg-step-index" aria-hidden="true">
                  {index + 1}
                </span>
                <SelectInput
                  value={rule.action ?? "allow"}
                  options={POLICY_ACTIONS}
                  disabled={locked}
                  onChange={(v) => replace(index, { ...rule, action: v })}
                />
                <span className="grow" />
                <button className="ghost" disabled={locked || index === 0} onClick={() => move(index, -1)} title="earlier">
                  ↑
                </button>
                <button
                  className="ghost"
                  disabled={locked || index === rules.length - 1}
                  onClick={() => move(index, 1)}
                  title="later"
                >
                  ↓
                </button>
                <button
                  className="ghost danger"
                  disabled={locked}
                  onClick={() => write(rules.filter((_, i) => i !== index))}
                >
                  Remove
                </button>
              </div>
              <FieldGrid min={170}>
                <Field label="Program" param="match.program" hint="Normalised — git, npm, curl.">
                  <TextInput
                    value={rule.match?.program ?? ""}
                    mono
                    placeholder="git"
                    disabled={locked}
                    onChange={(v) => replace(index, { ...rule, match: { ...rule.match, program: v || undefined } })}
                  />
                </Field>
                <Field label="Subcommand" param="match.subcommand" hint="push, publish, install.">
                  <TextInput
                    value={rule.match?.subcommand ?? ""}
                    mono
                    placeholder="push"
                    disabled={locked}
                    onChange={(v) => replace(index, { ...rule, match: { ...rule.match, subcommand: v || undefined } })}
                  />
                </Field>
                <Field label="Any of these flags" param="match.anyFlag" hint="Comma-separated; one is enough to match.">
                  <TextInput
                    value={(rule.match?.anyFlag ?? []).join(", ")}
                    mono
                    placeholder="--force, -f"
                    disabled={locked}
                    onChange={(v) => {
                      const list = v.split(",").map((f) => f.trim()).filter((f) => f.length > 0);
                      replace(index, { ...rule, match: { ...rule.match, anyFlag: list.length > 0 ? list : undefined } });
                    }}
                  />
                </Field>
                <Field label="An argument contains" param="match.argIncludes" hint="A substring — a path, a URL.">
                  <TextInput
                    value={rule.match?.argIncludes ?? ""}
                    mono
                    placeholder=".ssh"
                    disabled={locked}
                    onChange={(v) => replace(index, { ...rule, match: { ...rule.match, argIncludes: v || undefined } })}
                  />
                </Field>
                <Field label="Reason" param="reason" hint="Shown when this rule causes a prompt or a refusal.">
                  <TextInput
                    value={rule.reason ?? ""}
                    placeholder="force-pushing rewrites published history"
                    disabled={locked}
                    onChange={(v) => replace(index, { ...rule, reason: v || undefined })}
                  />
                </Field>
              </FieldGrid>
            </div>
          ))}
          <div className="pane-actions">
            <button disabled={locked} onClick={() => write([...rules, { action: "require_approval", match: {} }])}>
              Add a rule
            </button>
          </div>
        </div>
      </Level>
    </section>
  );
}
