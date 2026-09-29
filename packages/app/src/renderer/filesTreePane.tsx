/**
 * The Files tree section: what the tree leaves out, rule by rule, with what each rule does HERE.
 *
 * It replaces the Files page's chips (`filesPane.tsx`), and the reason is the question those could
 * not answer. A chip said `**\/build` was a rule; it could not say that in this repository the rule
 * hid six folders, every one a workflow state's snapshot that `.jaira/system` already hid — which is
 * how a default nobody needed stayed a default. So every line here carries its count and its first
 * matches, from one walk of the root (`files:hiddenReport`), and a pattern being typed is previewed
 * the same way before it is added.
 *
 * Four decisions shape it:
 *
 *  - **The layers concatenate, so the list is drawn whole.** Built-in rules first, in their groups
 *    (JaiRA's own files, Secrets, …), then what each layer adds — "Added in Shared", "Added in this
 *    project", "Added just for you". That is the order the rules are applied in, and last match wins.
 *  - **A rule you did not write is switched off, not deleted.** Its switch appends `!pattern` to the
 *    layer being edited, and the line says so — struck through, "off here, so this project shows it
 *    (writes !pattern)". The `!` is then drawn on the line it undoes rather than as a second rule of
 *    the layer's own, because it IS that line's state. A rule of a layer read AFTER the one being
 *    edited cannot be undone from here, and its switch says which layer to edit instead.
 *  - **The layer's own list has the set / not set switch** every setting has: off, the layer adds
 *    nothing and every rule it wrote goes. A layer is never written an empty list — it would read the
 *    same as no list, and a migration once read `[]` as *show everything*.
 *  - **"Why is a path hidden?"** is asked of main (`files:whyHidden`) and answered top-down, the way
 *    the walk decides: a file inside `dist/` is hidden by the rule that hid the folder.
 *
 * Drawn by {@link FilesTreeView}, a render function over a report, so a server render (a test, a
 * catalog figure) needs no main process; {@link FilesTreeSection} is the part that asks.
 */
import type { JSX } from "react";
import type { JsonValue } from "@declarative-ai/json";
import { SYSTEM_DIR_NAME, type ConfigLayer, type ConfigView, type HiddenReport, type HiddenRuleReport, type HiddenVerdict } from "@jaira/shared/browser";
import { Field, FieldGrid, Switch } from "./controls";
import { LAYER_WORDS, filesTreeOf, groupSummary, previewSentence, samplesOf, useFilesTree, whyParts, type HidPart } from "./filesTreeModel";
import { SettingsSection } from "./settingsLayout";

// What the section computes is `filesTreeModel.ts`'s, shared with the universal copy (decision 0015).
export { groupRules, hiddenIn, isSwitchOf, lastWordOn, previewSentence, ruleNotes, withHidden } from "./filesTreeModel";

/** The sentence under "Why is a path hidden?" — its parts are `filesTreeModel.ts`'s. */
export function whySentence(verdict: HiddenVerdict): JSX.Element {
  return <HidWords parts={whyParts(verdict)} />;
}

/** Parts as words and `code.hid-code`. */
function HidWords({ parts }: { parts: readonly HidPart[] }): JSX.Element {
  return (
    <>
      {parts.map((part, i) =>
        "code" in part ? (
          <code key={i} className="hid-code">
            {part.code}
          </code>
        ) : (
          part.text
        ),
      )}
    </>
  );
}

/** A pattern in the data voice, its `!` in the ok colour. */
function Pattern({ pattern }: { pattern: string }): JSX.Element {
  return pattern.startsWith("!") ? (
    <span className="hid-pattern data-text">
      <span className="hid-bang">!</span>
      {pattern.slice(1)}
    </span>
  ) : (
    <span className="hid-pattern data-text">{pattern}</span>
  );
}

export interface FilesTreeViewProps {
  view: ConfigView;
  /** The layer being edited. */
  layer: ConfigLayer;
  /** What the walk found, or `null` while it is being asked. */
  report: HiddenReport | null;
  /** Why the report could not be read, when it could not. */
  error?: string | undefined;
  busy: boolean;
  onWrite: (layer: ConfigLayer, doc: JsonValue) => void;
  /** The add line's text, and its preview (`null` while there is none). */
  typed: string;
  preview: HiddenReport | null;
  onType: (text: string) => void;
  /** The "why" line's text, and its answer. */
  asked: string;
  answer: HiddenVerdict | string | null;
  onAsk: (text: string) => void;
  /** Which groups the person has folded or opened — absent means the default for that group. */
  open: Record<string, boolean>;
  onFold: (id: string, open: boolean) => void;
}

/** The section, drawn from a report. */
export function FilesTreeView(props: FilesTreeViewProps): JSX.Element {
  const { view, layer, report, busy, onWrite } = props;
  // What the section says and writes — the layer's own list, the groups, each line's switch, "Show
  // system/" — is `filesTreeModel.ts`'s, shared with the universal copy (decision 0015).
  const tree = filesTreeOf(view, layer, report, onWrite);
  const { own, here, rules, groups, capped, showsSystem, toggleSystem } = tree;
  const add = (pattern: string): void => {
    if (tree.add(pattern)) props.onType("");
  };

  const line = (entry: { rule: HiddenRuleReport; index: number }): JSX.Element => {
    const { rule, index } = entry;
    const { mine, undo, word, later, off, put, amount, notes, switchLabel, toggle } = tree.lineOf(entry);
    return (
      <li key={`${index}-${rule.pattern}`} className={`hid-line${off ? " is-off" : ""}`}>
        <span className="hid-pat-cell">
          <Pattern pattern={rule.pattern} />
          {put ? <span className="hid-chip hid-puts">puts back</span> : null}
        </span>
        <span className="hid-what">
          {off ? (
            <span className="hid-offnote">
              {word.by === here ? "off here" : `off in ${LAYER_WORDS[word.by].says}`}, so {LAYER_WORDS[word.by].says} {put ? "hides it again" : "shows it"} (writes{" "}
              <code className="hid-code">{undo}</code>)
            </span>
          ) : amount !== null ? (
            <>
              <span className="hid-count">
                {capped ? "at least " : ""}
                {amount}
              </span>
              <span className="hid-samples data-secondary">{samplesOf(rule)}</span>
            </>
          ) : (
            <span className="hid-none app-absent">nothing here</span>
          )}
          {notes.map((note) => (
            <span key={note} className="hid-note">
              {note}
            </span>
          ))}
        </span>
        <span className={`hid-chip hid-origin${mine ? " is-here" : ""}`}>{tree.lineOf(entry).origin}</span>
        <span className="hid-switch">
          <Switch
            on={!off}
            label={switchLabel}
            disabled={busy || later}
            onChange={toggle}
          />
        </span>
      </li>
    );
  };

  const extra = props.preview?.extra;
  return (
    <SettingsSection
      id="files-tree"
      title="Files tree"
      info="What the Files tree leaves out, and why. Built-in rules come first, then what Shared, this project and you add; the last rule to match a path decides."
    >
      <FieldGrid>
        <Field
          label="Hidden in the tree"
          param="files.hidden"
          hint="Later rules win, so a !pattern puts back something an earlier rule hid. A folder that matches takes its contents with it."
          layer={{ stated: own !== null, disabled: busy, label: tree.clearLabel, onInherit: tree.clear }}
        >
          <span className="hid-own app-secondary">{tree.ownWords}</span>
        </Field>
      </FieldGrid>

      <div className="hid-body">
        <div className="hid-box" role="table" aria-label="Hidden-path rules">
          <div className="hid-cols" role="row">
            <span role="columnheader">Pattern</span>
            <span role="columnheader">What it hides here</span>
            <span role="columnheader">From</span>
            <span role="columnheader" className="hid-col-switch" aria-label="in effect" />
          </div>
          {report === null ? (
            <div className="hid-wait app-absent">{props.error !== undefined ? props.error : "reading the tree…"}</div>
          ) : (
            groups.map((group) => {
              // Folded when it hides nothing here — unless a layer switched one of its rules off, which
              // is a decision somebody made and is worth seeing without looking for it.
              const open = tree.openOf(group, props.open);
              return (
                <div key={group.id} className={`hid-group${open ? " open" : ""}`}>
                  <button type="button" className="hid-fold" aria-expanded={open} onClick={() => props.onFold(group.id, !open)}>
                    <span className="hid-chev" aria-hidden="true">
                      ›
                    </span>
                    <span className="hid-group-name">{group.name}</span>
                    <span className="hid-group-sum app-secondary">{groupSummary(group, rules, capped)}</span>
                  </button>
                  {open ? <ul className="hid-lines">{group.lines.map(line)}</ul> : null}
                </div>
              );
            })
          )}
        </div>

        <div className="hid-add">
          <input
            className="cfg-input mono hid-add-input"
            value={props.typed}
            placeholder="pattern, or !pattern to put something back"
            disabled={busy}
            spellCheck={false}
            aria-label="add a rule"
            onChange={(e) => props.onType(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") add(props.typed);
              if (e.key === "Escape") props.onType("");
            }}
          />
          <button type="button" disabled={busy || props.typed.trim().length === 0 || props.typed.trim() === "!"} onClick={() => add(props.typed)}>
            Add
          </button>
          {props.typed.trim().length > 0 && extra !== undefined && extra.pattern === props.typed.trim() ? (
            <span className="hid-preview data-secondary">{previewSentence(extra, props.preview?.capped === true)}</span>
          ) : null}
        </div>
      </div>

      <FieldGrid>
        <Field label="Why is a path hidden?" hint="A path inside the tree's root, or a full path from a file manager." wide>
          <div className="hid-ask">
            <input
              className="cfg-input mono"
              value={props.asked}
              placeholder="packages/cli/dist/index.js"
              spellCheck={false}
              aria-label="path to explain"
              onChange={(e) => props.onAsk(e.target.value)}
            />
            {props.answer !== null && props.asked.trim().length > 0 ? (
              <div className={`hid-why${typeof props.answer === "string" ? " is-bad" : ""}`} aria-live="polite">
                {typeof props.answer === "string" ? props.answer : whySentence(props.answer)}
              </div>
            ) : null}
          </div>
        </Field>
        <Field
          label={`Show ${SYSTEM_DIR_NAME}/`}
          hint={
            showsSystem
              ? "Shown, for you alone: a !system rule in your own list."
              : "Hidden — the default. It holds the database, tasks, snapshots and logs, which nobody authors."
          }
        >
          <Switch on={showsSystem} label={showsSystem ? "shown" : "hidden"} disabled={busy} onChange={toggleSystem} />
        </Field>
      </FieldGrid>
    </SettingsSection>
  );
}

/**
 * The section, with the asking (`filesTreeModel.ts`'s `useFilesTree`): the report (again whenever the
 * layers change), the add line's preview and the "why" line, each debounced as it is typed.
 *
 * `project` is the project the page is for (`null` at the root, where the shared root is walked);
 * `onWrite` takes the layer's WHOLE new document, the same contract as `config:write`.
 */
export function FilesTreeSection(props: {
  view: ConfigView;
  layer: ConfigLayer;
  project: string | null;
  busy: boolean;
  onWrite: (layer: ConfigLayer, doc: JsonValue) => void;
}): JSX.Element {
  return <FilesTreeView {...useFilesTree(props)} />;
}
