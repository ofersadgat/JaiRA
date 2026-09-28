import { useRef, useState, type JSX, type ReactNode } from "react";
import { View } from "@tamagui/core";
import { EVENT_SPECS, isEventName } from "@jaira/shared/browser";
import { INTO_NAME, badgeFor, newLineOf, useAutomationsHost, type AutomationsPaneProps, type AutomationsViewProps } from "@jaira/ui/automationsHost";
import {
  automationStateIdOf,
  eventOnAnywhere,
  eventPicksOf,
  filterFormOf,
  filterOfForm,
  filterSchemaOf,
  flagText,
  freshLineName,
  lineFlagsOf,
  stepFormOf,
  stepOfForm,
  stepSummary,
  whenOf,
  type AutomationLine,
  type AutomationStep,
  type LineFlag,
  type ShownLine,
} from "@jaira/ui/automationsModel";
import { runSchemaOf } from "@jaira/ui/runForm";
import type { ValueSources } from "@jaira/ui/schemaForm/types";
import { Txt, edge, useHover, type FontSpec } from "../../primitives";
import { useTokens } from "../../tokens";
import { FormInput } from "../form/inputs";
import { SchemaForm } from "../form/SchemaForm";
import { Hint, PaneActions, SourceTag } from "./bits";
import { Button } from "./Button";
import { Segmented } from "./controls";
import { ConnectionPill, EventGroup } from "./EventsSection";
import { AddButton } from "./permissions/rows";
import { SettingsSection } from "./SettingsPage";

/**
 * `automationsPane.tsx`, universal (decision 0015): Settings → Tools → Automations — the lines of a
 * layer's built-in events workflow, each an event, a filter and the steps it runs. What the host reads,
 * holds and writes is `automationsHost.ts`'s, the hook the DOM pane runs; what a line says is
 * `automationsModel.ts`'s. Reordering by dragging is the desktop's alone (the grip is drawn; a line is
 * moved on a phone by editing the file), and so are the `<datalist>` completions of the event and
 * workflow boxes. The rules (`[data-part="automations"]`; the rows' font is the body's, 13/12.5):
 *
 *   .au-head             row, centred, gap 8, 8 below; `.au-grip` padding 0 4, -3 tracking, --tok-hint
 *   .au-name 16em        its box padding 2 8, at 600; `.au-name-static` 600
 *   .au-when, .au-action-head   row, wraps, centred, gap 6 8; `.au-word` --dim, one line
 *   .au-event 17em, .au-wf 15em, .au-note grows from 16em
 *   .au-filter, .au-order, .au-add-action, .au-inputs-note   6 above, 2em in
 *   .au-actions          column, gap 8, 8 above; each 4 above; `.au-n` 1.4em round, --panel-2, --dim,
 *                        data 600 at 0.85 on 1
 *   .au-inputs           8 above, 2em in, padding 2 12, 1px --line, radius 10, --bg
 *   .au-remove           padding 0 7, 1.1em; `.au-flag` 8 above; `.au-link` the font it stands in
 *   .au-off .au-when     0.7; `.au-ignored` name, When and steps struck through, --tok-hint, 0.7
 *   .set-row.au-add 6 12, .set-row.au-foot 10 16; `.au-foot p`, `.au-empty`, `.au-problem`, `.au-told`
 *                        padding 10 16; `.au-ask` (a `.set-ask`) 10 16 around
 *
 * The card's first two children are the `<datalist>`s, so every child drawn takes the `* + *` rule,
 * the first too, and no `.ev-group` is ever the card's first child (its top is never rounded).
 */
export function AutomationsSection(props: AutomationsPaneProps): JSX.Element {
  const host = useAutomationsHost(props);
  if ("waiting" in host) {
    return (
      <SettingsSection id="automations" title="Automations">
        <Hint card color={host.warn ? "warn" : "dim"}>
          {host.waiting}
        </Hint>
      </SettingsSection>
    );
  }
  return <AutomationsView {...host.props} />;
}

/** The rows' own font: the body's. */
const BODY = 13 / 12.5;
const WORD = { voice: "app", scale: BODY, lineHeight: 1.5, color: "dim" } as const;
const HINT = { voice: "app", scale: 11 / 12.5, lineHeight: 1.4, color: "dim" } as const;
const DESC = { voice: "app", scale: 1.03, lineHeight: 1.45, color: "warn" } as const;

/** `n` em of the rows' font. */
function useEm(): (n: number) => never {
  const t = useTokens();
  return (n) => t.scaled("size-app", BODY * n) as never;
}

/** `button.link.au-link`, in the words it stands in (`spec`, theirs): the accent, underlined under the pointer. */
function Link({ children, onPress, disabled = false, title, spec = HINT }: { children: string; onPress: () => void; disabled?: boolean; title?: string | undefined; spec?: FontSpec }): JSX.Element {
  const [hovered, hover] = useHover();
  return (
    <Txt
      spec={{ ...spec, color: "accent" }}
      {...(disabled ? { opacity: 0.5 } : { onPress, ...hover })}
      {...(title !== undefined ? { title } : {})}
      role="button"
      textDecorationLine={hovered && !disabled ? "underline" : "none"}
    >
      {children}
    </Txt>
  );
}

/** A `.cfg-hint` paragraph 2em in: `.au-order`, `.au-inputs-note`. */
function Note({ children, color }: { children: ReactNode; color?: string }): JSX.Element {
  const em = useEm();
  return (
    <Txt spec={{ ...HINT, ...(color !== undefined ? { color } : {}) }} marginTop={6} marginLeft={em(2)}>
      {children}
    </Txt>
  );
}

/** A name box that says its new name when it is left, not at every letter. */
function NameBox({ name, disabled, onRename }: { name: string; disabled: boolean; onRename: (next: string) => void }): JSX.Element {
  const em = useEm();
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
    <View width={em(16)} maxWidth="100%">
      <FormInput value={text} mono tight label="name of this line" disabled={disabled} onChange={setText} onBlur={commit} onSubmit={commit} />
    </View>
  );
}

/**
 * A line's filter: the keys it states, as a schema form, and a `+ key` for each other key the event
 * takes — so a push's line is not three empty boxes. A key opened here stays drawn until it is left.
 */
function FilterEditor({ line, disabled, onFilter }: { line: AutomationLine; disabled: boolean; onFilter: (filter: AutomationLine["filter"]) => void }): JSX.Element | null {
  const em = useEm();
  const [opened, setOpened] = useState<readonly string[]>([]);
  if (!isEventName(line.event)) return null;
  const keys = EVENT_SPECS[line.event].filters;
  if (keys.length === 0) return null;
  const all = filterSchemaOf(line.event);
  const properties = (all["properties"] ?? {}) as Record<string, unknown>;
  const shown = keys.filter((key) => line.filter[key] !== undefined || opened.includes(key));
  const offered = keys.filter((key) => !shown.includes(key));
  return (
    <View marginTop={6} marginLeft={em(2)}>
      {shown.length > 0 ? (
        <SchemaForm
          schema={{ ...all, properties: Object.fromEntries(shown.map((key) => [key, properties[key]])), required: shown }}
          value={Object.fromEntries(shown.map((key) => [key, filterFormOf(line.filter)[key] ?? []]))}
          onChange={(next) => onFilter(filterOfForm(next))}
          ctx={{ path: "", labels: "keys", hidePaths: true, disabled, addLabel: () => "+ glob" }}
        />
      ) : null}
      {offered.length > 0 ? (
        <View flexDirection="row" flexWrap="wrap" alignItems="center" rowGap={2} columnGap={6} marginTop={4}>
          <Txt spec={WORD} numberOfLines={1}>
            only where
          </Txt>
          {offered.map((key) => (
            <AddButton key={key} label={key} disabled={disabled} onPress={() => setOpened([...opened, key])} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

function FlagLine({ flag, onOpenEvents }: { flag: LineFlag; onOpenEvents: () => void }): JSX.Element {
  return (
    <Txt spec={DESC} marginTop={8}>
      {flagText(flag)}
      {flag.kind === "off" ? (
        <>
          {" "}
          <Link spec={DESC} onPress={onOpenEvents}>
            Switch it on in Events
          </Link>
        </>
      ) : null}
    </Txt>
  );
}

/** `.au-n`: a step's number. */
function StepNumber({ n }: { n: number }): JSX.Element {
  const t = useTokens();
  const size = t.scaled("size-data", 0.85 * 1.4) as never;
  return (
    <View width={size} height={size} borderRadius={999} alignItems="center" justifyContent="center" backgroundColor={t.v("panel-2") as never}>
      <Txt spec={{ voice: "data", scale: 0.85, weight: 600, lineHeight: 1, color: "dim" }} textAlign="center">
        {String(n)}
      </Txt>
    </View>
  );
}

/** `.au-remove`: a quiet ×. */
function Remove({ label, disabled, onPress }: { label: string; disabled: boolean; onPress: () => void }): JSX.Element {
  return (
    <Button kind="quiet" title={label} label={label} disabled={disabled} onPress={onPress} paddingVertical={0} paddingHorizontal={7} font={{ scale: BODY * 1.1 }}>
      ×
    </Button>
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
  const t = useTokens();
  const em = useEm();
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
    <View paddingTop={4}>
      <View flexDirection="row" flexWrap="wrap" alignItems="center" rowGap={6} columnGap={8}>
        <StepNumber n={index + 1} />
        {index > 0 ? (
          <Txt spec={WORD} numberOfLines={1}>
            then
          </Txt>
        ) : null}
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
            <View width={em(15)} maxWidth="100%">
              <FormInput value={step.workflow} mono placeholder="a workflow — feature/review" label={`the workflow step ${index + 1} starts`} disabled={props.locked} onChange={(workflow) => onStep({ ...step, workflow })} />
            </View>
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
          <View flexGrow={1} flexShrink={1} flexBasis={em(16)} minWidth={0}>
            <FormInput value={step.text} placeholder="what to tell you" label={`what step ${index + 1} tells you`} disabled={props.locked} onChange={(text) => onStep({ kind: "notify", text })} />
          </View>
        )}
        {onRemove !== undefined ? <Remove label="remove this step" disabled={props.locked} onPress={onRemove} /> : null}
      </View>
      {step.kind === "start" && form !== undefined ? (
        fields === undefined ? (
          step.workflow.length > 0 ? <Note>reading its inputs…</Note> : null
        ) : fields === null ? (
          <Note color="warn">{`${step.workflow} does not parse, so its inputs cannot be read.`}</Note>
        ) : fields.length === 0 ? (
          <Note>no inputs</Note>
        ) : (
          <View marginTop={8} marginLeft={em(2)} paddingVertical={2} paddingHorizontal={12} borderRadius={10} backgroundColor={t.v("bg") as never} {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }) as object)}>
            <SchemaForm
              schema={runSchemaOf(fields)}
              value={form.values}
              onChange={(next) => onStep(stepOfForm(step, next as Record<string, unknown>, form.picked))}
              ctx={{ path: "", labels: "keys", disabled: props.locked, ...(sources !== undefined ? { sources } : {}) }}
            />
          </View>
        )
      ) : null}
    </View>
  );
}

/** A line's event, filter and steps, editable — the same for a line of the layer's own and a Shared line on a project page. */
function LineBody({ line, props, off = false, onLine }: { line: AutomationLine; props: AutomationsViewProps; off?: boolean; onLine: (next: AutomationLine) => void }): JSX.Element {
  const em = useEm();
  const badge = badgeFor(line, props.status);
  return (
    <>
      <View flexDirection="row" flexWrap="wrap" alignItems="center" rowGap={6} columnGap={8} {...(off ? { opacity: 0.7 } : {})}>
        <Txt spec={WORD} numberOfLines={1}>
          When
        </Txt>
        <View width={em(17)} maxWidth="100%">
          <FormInput value={line.event} mono placeholder="an event — git.push" label="the event this line waits for" disabled={props.locked} onChange={(event) => onLine({ ...line, event, filter: {} })} />
        </View>
        {badge !== undefined ? <ConnectionPill first badge={badge} onOpenConnections={props.onOpenConnections} /> : null}
      </View>
      <FilterEditor line={line} disabled={props.locked} onFilter={(filter) => onLine({ ...line, filter })} />
      <View flexDirection="column" gap={8} marginTop={8}>
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
      </View>
      {line.steps.length > 1 ? <Note>In order: each step starts when the one before it has finished.</Note> : null}
      <View marginTop={6} marginLeft={em(2)} flexDirection="row">
        <AddButton label="then…" disabled={props.locked} onPress={() => onLine({ ...line, steps: [...line.steps, { kind: "start", workflow: "", inputs: {} }] })} />
      </View>
    </>
  );
}

/** `.set-row.au-row`: the line on the left, its control at the top right (`.set-row-line`, aligned to the start). */
function LineRow({ children, control }: { children: ReactNode; control: ReactNode }): JSX.Element {
  return (
    <View paddingVertical={13} paddingHorizontal={16}>
      <View flexDirection="row" alignItems="flex-start" columnGap={32}>
        <View flexGrow={1} flexShrink={1} flexBasis={0} minWidth={0}>
          {children}
        </View>
        <View flexDirection="row" alignItems="center" justifyContent="flex-end" gap={8} minWidth={0} flexShrink={0}>
          {control}
        </View>
      </View>
    </View>
  );
}

/** `.au-when` with a line's event as written (`code.au-raw`). */
function WhenRaw({ when, badge, props, look = {}, strike = {} }: { when: string; badge?: ReturnType<typeof badgeFor>; props: AutomationsViewProps; look?: object; strike?: object }): JSX.Element {
  return (
    <View flexDirection="row" flexWrap="wrap" alignItems="center" rowGap={6} columnGap={8} {...look}>
      <Txt spec={WORD} numberOfLines={1} {...strike}>
        When
      </Txt>
      <Txt spec={{ voice: "data", scale: 11 / 12, lineHeight: 1.5, color: "text" }} {...strike}>
        {when}
      </Txt>
      {badge !== undefined ? <ConnectionPill first badge={badge} onOpenConnections={props.onOpenConnections} /> : null}
    </View>
  );
}

function AutomationsView(props: AutomationsViewProps): JSX.Element {
  const t = useTokens();
  const own = props.shown.filter((shown) => shown.from === "own").map((shown) => shown.line);
  const flags = lineFlagsOf(props.shown, props.events);
  const setLine = (i: number, next: AutomationLine): void => props.onLines(own.map((line, j) => (j === i ? next : line)));
  const hasShared = props.shown.some((shown) => shown.from === "shared");

  /** Where a project page's line runs its steps from, when that is worth saying. */
  const stepsNote = (shown: ShownLine): JSX.Element | null => {
    if (props.reads !== "project" || shown.line.raw !== undefined) return null;
    if (shown.from === "shared" && shown.stepsFrom === "project") {
      return (
        <Note>
          {`Its steps are changed for this project only, in this project's ${automationStateIdOf(shown.line.name)}; Shared's line and every other project keep Shared's. `}
          <Link disabled={props.locked} onPress={() => props.onUseSharedSteps(shown.line.name)}>
            Use Shared's steps
          </Link>
        </Note>
      );
    }
    if (shown.from === "shared") return <Note>A change to its steps here is this project's own copy of them; a change to its event or filter makes it a line of this project's.</Note>;
    if (shown.replaces === true) return <Note>This project's version of Shared's line of this name, which is ignored here.</Note>;
    return null;
  };

  const ownRow = (shown: ShownLine, i: number, lineFlags: LineFlag[]): JSX.Element => {
    const { line } = shown;
    const off = isEventName(line.event) && !eventOnAnywhere(props.events, line.event);
    return (
      <LineRow key={`own:${i}`} control={<Remove label="remove this line" disabled={props.locked} onPress={() => props.onLines(own.filter((_, j) => j !== i))} />}>
        <View flexDirection="row" alignItems="center" gap={8} marginBottom={8}>
          <Txt spec={{ voice: "app", scale: BODY, lineHeight: 1.5, color: "tok-hint" }} paddingHorizontal={4} letterSpacing={-3} {...({ title: "drag to reorder — the first line that matches wins" } as object)}>
            ⋮⋮
          </Txt>
          {line.raw === undefined ? (
            <NameBox name={line.name} disabled={props.locked} onRename={(name) => setLine(i, { ...line, name })} />
          ) : (
            <Txt spec={{ voice: "app", scale: BODY, weight: 600, lineHeight: 1.5 }}>{line.name}</Txt>
          )}
        </View>
        {line.raw !== undefined ? (
          <>
            <WhenRaw when={typeof line.raw.rule["when"] === "string" ? line.raw.rule["when"] : "—"} props={props} {...(off ? { look: { opacity: 0.7 } } : {})} />
            <Note>
              {"Written by hand in the file, so it is edited there. "}
              <Link onPress={props.onEditFile}>Edit as a workflow file</Link>
            </Note>
          </>
        ) : (
          <LineBody line={line} props={props} off={off} onLine={(next) => setLine(i, next)} />
        )}
        {stepsNote(shown)}
        {lineFlags.map((flag, f) => (
          <FlagLine key={f} flag={flag} onOpenEvents={props.onOpenEvents} />
        ))}
      </LineRow>
    );
  };

  const sharedRow = (shown: ShownLine, i: number, lineFlags: LineFlag[]): JSX.Element => {
    const { line } = shown;
    const badge = badgeFor(line, props.status);
    const editable = !shown.ignored && line.raw === undefined;
    const faded = shown.ignored ? { opacity: 0.7 } : {};
    const strike = shown.ignored ? ({ textDecorationLine: "line-through", color: t.v("tok-hint") } as object) : {};
    return (
      <LineRow
        key={`shared:${i}`}
        control={
          shown.ignored ? (
            <Txt spec={HINT}>
              {"ignored here · "}
              <Link disabled={props.locked} onPress={() => props.onIgnore(line.name, false)}>
                Put back
              </Link>
            </Txt>
          ) : (
            <Button kind="ghost" disabled={props.locked} title="Leave this line out of this project's events task (writes the filter in this project's copy)" onPress={() => props.onIgnore(line.name, true)}>
              Ignore in this project
            </Button>
          )
        }
      >
        <View flexDirection="row" alignItems="center" gap={8} marginBottom={8}>
          {editable ? (
            <NameBox name={line.name} disabled={props.locked} onRename={(name) => props.onSharedLine(line, { ...line, name })} />
          ) : (
            <Txt spec={{ voice: "app", scale: BODY, weight: 600, lineHeight: 1.5 }} {...faded} {...strike}>
              {line.name}
            </Txt>
          )}
          <SourceTag first>from Shared</SourceTag>
        </View>
        {editable ? (
          <LineBody line={line} props={props} onLine={(next) => props.onSharedLine(line, next)} />
        ) : (
          <>
            <WhenRaw when={line.raw !== undefined ? String(line.raw.rule["when"] ?? "—") : whenOf(line.event, line.filter)} badge={badge} props={props} look={faded} strike={strike} />
            {line.raw === undefined ? (
              <View flexDirection="column" gap={8} marginTop={8} {...faded}>
                {line.steps.map((step, s) => (
                  <View key={s} paddingTop={4} flexDirection="row" flexWrap="wrap" alignItems="center" rowGap={6} columnGap={8}>
                    <StepNumber n={s + 1} />
                    {s > 0 ? (
                      <Txt spec={WORD} numberOfLines={1} {...strike}>
                        then
                      </Txt>
                    ) : null}
                    <Txt spec={WORD} numberOfLines={1} {...strike}>
                      {step.kind === "start" ? "start" : "tell me"}
                    </Txt>
                    {step.kind === "start" ? (
                      <Txt spec={{ voice: "app", scale: BODY, lineHeight: 1.5 }} {...strike}>
                        {step.workflow}
                      </Txt>
                    ) : null}
                    <Txt spec={{ ...HINT, voice: "data", scale: (11 / 12.5) * (12.5 / 12) }} {...strike}>
                      {stepSummary(step)}
                    </Txt>
                  </View>
                ))}
              </View>
            ) : null}
          </>
        )}
        {shown.ignored ? null : stepsNote(shown)}
        {lineFlags.map((flag, f) => (
          <FlagLine key={f} flag={flag} onOpenEvents={props.onOpenEvents} />
        ))}
      </LineRow>
    );
  };

  const items: JSX.Element[] = [];
  if (props.shown.length > 0 && props.shown[0]!.from === "own" && hasShared) items.push(<EventGroup key="own-head" heading="This project" first={false} />);
  let ownIndex = -1;
  props.shown.forEach((shown, i) => {
    if (shown.from === "own") {
      ownIndex++;
      items.push(ownRow(shown, ownIndex, flags[i] ?? []));
      return;
    }
    if (i === 0 || props.shown[i - 1]!.from === "own") items.push(<EventGroup key="shared-head" heading="From Shared · ~/.jaira" first={false} />);
    items.push(sharedRow(shown, i, flags[i] ?? []));
  });
  if (props.shown.length === 0) {
    items.push(
      <Hint key="empty" paddingVertical={10} paddingHorizontal={16}>
        No automations yet. Add one, and the events task starts waiting for its event.
      </Hint>,
    );
  }
  if (props.asking !== null) {
    items.push(
      <View key="ask" alignSelf="flex-start" flexDirection="column" gap={6} maxWidth={560} marginVertical={10} marginHorizontal={16} paddingVertical={8} paddingHorizontal={10} borderRadius={8} backgroundColor={t.v("panel-2") as never} {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }) as object)} role="group" aria-label="Where this change goes">
        <Txt spec={{ voice: "app", scale: 11.5 / 12.5, lineHeight: 1.5 }}>Just you is one settings file, and automations are a workflow file. Write this change to:</Txt>
        <PaneActions>
          {props.asking.map((into, i) => (
            <Button key={into} kind={i === 0 ? "primary" : "ghost"} disabled={props.locked} onPress={() => props.onAnswer(into)}>
              {INTO_NAME[into] === "this project" ? "This project" : INTO_NAME[into]}
            </Button>
          ))}
          <Button kind="ghost" onPress={() => props.onAnswer(null)}>
            Cancel
          </Button>
        </PaneActions>
      </View>,
    );
  }
  if (props.problem !== null) {
    items.push(
      <Hint key="problem" color="warn" paddingVertical={10} paddingHorizontal={16}>
        {props.problem}
      </Hint>,
    );
  }
  if (props.told !== null) {
    items.push(
      <Hint key="told" paddingVertical={10} paddingHorizontal={16} role="status">
        {props.told}
      </Hint>,
    );
  }
  items.push(
    <View key="add" paddingVertical={6} paddingHorizontal={12} flexDirection="row">
      <AddButton label="automation" disabled={props.locked} onPress={() => props.onLines([...own, newLineOf(freshLineName(props.shown.map((shown) => shown.line.name)))])} />
    </View>,
  );
  items.push(
    <View key="foot" paddingVertical={10} paddingHorizontal={16}>
      <Hint paddingVertical={10} paddingHorizontal={16}>
        {`Runs as the task events in ${props.layerName}${props.source === "built in" ? " · as JaiRA ships it until you change it" : ""} · `}
        <Link disabled={!props.hasTask} title={props.hasTask ? undefined : "The events task has not started here yet"} onPress={props.onOpenConversation}>
          Open its conversation
        </Link>
        {" · "}
        <Link onPress={props.onEditFile}>Edit as a workflow file</Link>
      </Hint>
    </View>,
  );

  const rule = edge(t, { top: 1 }) as object;
  return (
    <SettingsSection
      id="automations"
      title="Automations"
      info="Transitions are first-match: an event goes to the first line whose event and filter it matches. A line's steps run in order, while the task keeps waiting for the next event. A line a line above always catches is flagged."
      lead="What happens when an event arrives. Each line is a transition of the built-in events task: it waits for the event, starts the task you pick, and goes back to waiting."
      plain
    >
      <View borderRadius={12} backgroundColor={t.v("panel") as never} {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }) as object)} {...({ boxShadow: "0 1px 2px rgba(0, 0, 0, 0.03)" } as object)}>
        {items.map((item) => (
          <View key={item.key} {...rule}>
            {item}
          </View>
        ))}
      </View>
    </SettingsSection>
  );
}
