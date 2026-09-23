/**
 * The Files screen: what the tree draws, and what it leaves out.
 *
 * The setting exists because the exclusion it replaced was a constant nobody could see. It named
 * `snapshots`, `tasks`, `artifacts` and `worktrees`; those moved under `system/` or were never
 * spelled that way, so for months it matched nothing, `system/` sat at the top of every root, and
 * there was no surface in the app that could have said why. A rule you can read is a rule that can
 * be found wrong.
 *
 * Three decisions shape the screen:
 *
 *  - **The two lists are drawn as ONE ordered sequence**, because that is how they are evaluated.
 *    Last match wins, so `!system` after `system` reveals — and a screen that showed two unrelated
 *    boxes would make the one question a person actually has (*why can I still not see it?*) an
 *    exercise in guessing which box was consulted first.
 *  - **The defaults are shown, not implied.** An unset shared list renders them as dashed rows
 *    marked `default`, the same idiom the type screen uses for the face JaiRA ships: an empty box
 *    under a heading that says what is hidden cannot say what is hidden.
 *  - **Taking over the list keeps them.** Adding your first pattern writes the defaults out
 *    alongside it, because a project's array REPLACES the base's — so an "add" that quietly dropped
 *    `system` would be a click that revealed a database nobody asked to see.
 *
 * The `system/` switch is the concrete want made a control. Reading a run's journal at the moment a
 * run has gone wrong is a real thing to do, and the alternative to a checkbox is knowing to type
 * `!system` into a list — or leaving the app for a file manager.
 */
import { useState, type JSX } from "react";
import type { JsonValue } from "@declarative-ai/json";
import { DEFAULT_HIDDEN_PATHS, SYSTEM_DIR_NAME, type ConfigLayer, type ConfigView } from "@jaira/shared/browser";
import { Field, FieldGrid, Level, Switch } from "./controls";

/** The shared list as authored in ONE layer, or `null` when that layer says nothing. */
function hiddenIn(doc: JsonValue | null): string[] | null {
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return null;
  const files = (doc as Record<string, JsonValue>)["files"];
  if (files === undefined || files === null || typeof files !== "object" || Array.isArray(files)) return null;
  const hidden = (files as Record<string, JsonValue>)["hidden"];
  return Array.isArray(hidden) ? hidden.filter((p): p is string => typeof p === "string") : null;
}

/**
 * One rule, as a row.
 *
 * A pattern is a path, so it is set in the data voice — the same voice the tree it filters is set
 * in. Reveal rules carry the eye rather than the ✕ and lose the strike, because `!drafts` and
 * `drafts` are opposite instructions and one character is not enough to tell them apart at a glance.
 */
function RuleRow({
  pattern,
  origin,
  onDrop,
}: {
  pattern: string;
  /** Where the rule came from — what makes the sequence legible as layers rather than one list. */
  origin: "default" | "shared" | "yours";
  onDrop?: (() => void) | undefined;
}): JSX.Element {
  const reveal = pattern.startsWith("!");
  return (
    <span className={`rule-chip${origin === "default" ? " is-ours" : ""}${reveal ? " reveal" : ""}`}>
      <span className="rule-mark" aria-hidden="true">
        {reveal ? "◉" : "◌"}
      </span>
      <span className="rule-pattern data-text">{reveal ? pattern.slice(1) : pattern}</span>
      {onDrop !== undefined ? (
        <button className="rule-drop" title={`remove ${pattern}`} onClick={onDrop}>
          ✕
        </button>
      ) : (
        <span className="rule-origin app-secondary">{origin}</span>
      )}
    </span>
  );
}

/** The box a list of rules lives in, with the field that adds one at the end. */
function RuleBox({
  rows,
  placeholder,
  disabled,
  onAdd,
}: {
  rows: JSX.Element[];
  placeholder: string;
  disabled: boolean;
  onAdd: (pattern: string) => void;
}): JSX.Element {
  const [typed, setTyped] = useState("");
  const add = (): void => {
    const clean = typed.trim();
    // A bare `!` reveals nothing and hides nothing; it is a half-typed entry, and accepting it would
    // put a rule in the file that reads like an instruction and is not one.
    if (clean.length > 0 && clean !== "!") onAdd(clean);
    setTyped("");
  };
  return (
    <div className="rule-stack">
      {rows}
      <input
        className="rule-add data-text"
        value={typed}
        placeholder={placeholder}
        disabled={disabled}
        spellCheck={false}
        onChange={(e) => setTyped(e.target.value)}
        onBlur={add}
        onKeyDown={(e) => {
          if (e.key === "Enter") add();
          if (e.key === "Escape") setTyped("");
        }}
      />
    </div>
  );
}

/**
 * The Files settings screen.
 *
 * `editable` follows every other layered section: the base is always writable, a project's layer
 * only with a project open. The personal list is writable either way — it belongs to the person,
 * not to whatever is open.
 */
export function FilesPane({
  config,
  layer,
  personal,
  busy,
  editable,
  onSaveShared,
  onSavePersonal,
}: {
  config: ConfigView | null;
  layer: ConfigLayer;
  /** `settings.filesHidden` — this person's own rules, applied after the shared ones. */
  personal: readonly string[];
  busy: boolean;
  editable: boolean;
  onSaveShared: (patterns: string[] | null, layer: ConfigLayer) => void;
  onSavePersonal: (patterns: string[]) => void;
}): JSX.Element {
  const authored = config === null ? null : hiddenIn(layer === "base" ? config.base : config.project);
  const shared = authored ?? [...DEFAULT_HIDDEN_PATHS];
  const isDefault = authored === null;
  const locked = busy || !editable;

  // Adding to an unset list writes the defaults out with it — see the header. Removing the last
  // pattern writes `[]`, which is a real statement ("show everything") and must not silently fall
  // back to the defaults, so only the explicit Reset clears the key.
  const setShared = (patterns: string[]): void => onSaveShared(patterns, layer);

  const revealsSystem = personal.includes(`!${SYSTEM_DIR_NAME}`);
  const toggleSystem = (on: boolean): void => {
    const without = personal.filter((p) => p !== `!${SYSTEM_DIR_NAME}`);
    onSavePersonal(on ? [...without, `!${SYSTEM_DIR_NAME}`] : without);
  };

  return (
    <div className="pane files-pane">
      <Level
        title="Hidden in the tree"
        hint={
          <>
            Glob patterns, matched against the path inside each root. A folder that matches takes its
            contents with it. Later rules win, so a <code className="cfg-param">!pattern</code> below
            can put something back.
          </>
        }
      >
        <FieldGrid>
          <Field
            label="Shared"
            param="files.hidden"
            wide
            // On, this layer states its own list (starting from the one in effect); off, it goes back to
            // the defaults — which is what "Reset to the defaults" used to be a button for.
            toggle={{ on: !isDefault, disabled: locked, onChange: (on) => (on ? setShared(shared) : onSaveShared(null, layer)) }}
            hint={
              isDefault
                ? "What every root hides until someone says otherwise. Adding one keeps these."
                : `Written in ${layer === "base" ? "the shared root's" : "this project's"} settings.json, so everyone who opens it sees the same tree.`
            }
          >
            <RuleBox
              rows={shared.map((pattern, i) => (
                <RuleRow
                  key={`${pattern}-${i}`}
                  pattern={pattern}
                  origin={isDefault ? "default" : "shared"}
                  {...(isDefault || locked ? {} : { onDrop: () => setShared(shared.filter((_, at) => at !== i)) })}
                />
              ))}
              placeholder="+ pattern…"
              disabled={locked}
              onAdd={(pattern) => setShared([...shared, pattern])}
            />
          </Field>

          <Field
            label="Yours"
            param="filesHidden"
            wide
            hint="Applied after the shared list and kept out of it — in user-settings.json, so it never arrives through a pull request."
          >
            <RuleBox
              rows={personal.map((pattern, i) => (
                <RuleRow
                  key={`${pattern}-${i}`}
                  pattern={pattern}
                  origin="yours"
                  {...(busy ? {} : { onDrop: () => onSavePersonal(personal.filter((_, at) => at !== i)) })}
                />
              ))}
              placeholder="+ pattern, or !pattern to reveal…"
              disabled={busy}
              onAdd={(pattern) => onSavePersonal([...personal, pattern])}
            />
          </Field>
        </FieldGrid>
      </Level>

      <Level
        title="JaiRA's own directory"
        hint={
          <>
            <code className="cfg-param">system/</code> holds the database, tasks, snapshots, logs and
            artifacts. Nobody authors it, so it is hidden — but reading what a run wrote is a fair
            thing to want when a run has gone wrong.
          </>
        }
      >
        <FieldGrid>
          <Field
            label={`Show ${SYSTEM_DIR_NAME}/`}
            hint={
              revealsSystem
                ? "Shown, for you alone. This is a `!system` rule in your own list."
                : "Hidden — the default, and what almost everyone wants."
            }
          >
            <Switch on={revealsSystem} label={revealsSystem ? "shown" : "hidden"} disabled={busy} onChange={toggleSystem} />
          </Field>
        </FieldGrid>
      </Level>

      <Level title="In effect" hint="Every rule, in the order it is applied. The last one to match a path decides.">
        <div className="rule-effect">
          {[
            ...shared.map((pattern) => ({ pattern, origin: isDefault ? ("default" as const) : ("shared" as const) })),
            ...personal.map((pattern) => ({ pattern, origin: "yours" as const })),
          ].map((rule, i) => (
            <RuleRow key={`${rule.pattern}-${i}`} pattern={rule.pattern} origin={rule.origin} />
          ))}
          {shared.length === 0 && personal.length === 0 ? (
            <span className="cfg-hint">
              No rules: every root shows everything, <code className="cfg-param">system/</code> included.
            </span>
          ) : null}
        </div>
      </Level>
    </div>
  );
}
