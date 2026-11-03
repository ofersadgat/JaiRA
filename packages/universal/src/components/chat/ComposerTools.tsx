import { useState, type JSX, type ReactNode } from "react";
import { View } from "@tamagui/core";
import {
  holdsTool,
  MODE_WHEN_UNSET,
  OTHER_SUBJECT,
  SCRIPT_SUBJECT,
  SHELL_TOOL,
  TOOL_CATEGORIES,
  TOOL_SPEC_BY_NAME,
  type PermissionSet,
  type PermissionSetMode,
  type ToolCategory,
  type ToolChoice,
  type ToolImplementation,
  type ToolSpec,
} from "@jaira/shared/browser";
import {
  commandGroupsOf,
  commandSubjectOf,
  sectionCountOf,
  sectionModeOf,
  toolImplementationOf,
  toolModeOf,
  withCommand,
  withOther,
  withoutSubject,
  withSectionMode,
  withSubject,
  withSubjectMode,
  withToolHeld,
  withToolImplementation,
  type Parked,
} from "@jaira/ui/composerPermissionSet";
import { runtimeWordsOf, type RuntimeAnswer, type RuntimeRows } from "@jaira/ui/composerStack";
import { SCRIPT_HINT, SHELL_HINT, TOOL_ICONS, modeMeta } from "@jaira/ui/permissionSetWords";
import { Press, Txt, edge, useHover } from "../../primitives";
import { useTokens } from "../../tokens";
import type { IconName } from "../panel/Icon";
import { AddLine, ChipIcon, CommandGroupRow, Count, FoldBody, ImplPicker, ModeChip, ModePicker, OptText } from "../settings/permissions/rows";
import { CardHint } from "./ComposerCards";

/**
 * The composer's Tools card: the categories — each a fold with the mode its tools share, its tools
 * ticked in or out with their mode and implementation, Execution's commands under their program,
 * `script`, the line that adds a command — and `Other`. Every edit is `composerPermissionSet.ts`'s;
 * the rows are `settings/permissions/rows.tsx`'s parts where they are the same, and a tick where the
 * composer's line is one.
 *
 * The map it draws is what the whole stack comes to (decision 0023 §2.6 step 5, ruling 8); what it
 * writes is the stack's tools layer, worked out by its caller. Read-only with `tagOf`, the same rows
 * are the stack's Everything (§7.4): each line tagged with the layer that decided it. With `runtime`,
 * what this run answered is marked on the line it is about, in --accent, each let go of with its ×
 * (2026-11-03: the runtime layer folded into tools); a program's group, or Execution, holding one opens.
 *
 *   the categories     column
 *   a category         a --line above (not the first); its head row, centred, gap 4
 *   its fold           row, gap 6, grows, padding 5 4, radius 5 (hovered --panel-2): › 10 wide (turned a
 *                      quarter open), the words, the count
 *   empty, and Other   the head padded 5 0 5 20; empty: its name --tok-hint
 *   a tool             row, centred, gap 4, radius 7; hovered --text 7%; ticked --accent 13%
 *   its tick           row, gap 8, padding 5 7, grows; ✓ 10 wide (--ok); its words --dim (ticked or
 *                      hovered --text)
 *   a layer's tag      before the mode: padding 0 7, round, --panel-2, app 500 10/12.5 on 1.5, --dim
 *   a run's mark       before the mode: row, gap 3, padding 0 4 0 7, round, --accent 13%, app 600
 *                      10/12.5 on 1.5, --accent; its × 12 wide, --accent (hovered --bad)
 *   a run's own line   an answer with no line to mark: the terminal icon, the width in the data face,
 *                      its mark and its decision's chip
 */
export function ToolsBody({
  offered,
  map,
  parked,
  cliRoute,
  write,
  setParked,
  initiallyOpen = [],
  readOnly = false,
  tagOf,
  runtime,
}: {
  offered: readonly ToolChoice[];
  map: PermissionSet;
  parked: Parked;
  cliRoute: string | undefined;
  write: (next: PermissionSet, nextParked?: Parked) => void;
  setParked: (next: Parked) => void;
  initiallyOpen?: readonly string[];
  /** Nothing can be changed: Everything. */
  readOnly?: boolean;
  /** The layer that decided a line, drawn beside its mode. */
  tagOf?: ((subject: string) => string | undefined) | undefined;
  /** What this run answered, by the line each is about (`runtimeRowsOf`) — and how one is let go of. */
  runtime?: { rows: RuntimeRows; onForget?: ((keys: string[]) => void) | undefined } | undefined;
}): JSX.Element {
  const run = runtime?.rows;
  // Where an answer of this run is, a fold starts open: what changed is what the person looks for.
  const marked = new Set<string>();
  if (run !== undefined) {
    for (const tool of Object.keys(run.byTool)) {
      const category = TOOL_SPEC_BY_NAME.get(tool)?.category;
      if (category !== undefined) marked.add(category);
    }
    if (Object.keys(run.bySubject).length > 0 || Object.keys(run.byProgram).length > 0 || run.loose.length > 0) marked.add("execution");
    for (const program of Object.keys(run.byProgram)) marked.add(`program:${program}`);
    for (const subject of Object.keys(run.bySubject)) marked.add(`program:${subject.split(" ")[0]!}`);
  }
  // Pressing a fold turns it from how it starts: open where it is marked, shut elsewhere.
  const [toggledCats, setToggledCats] = useState<ReadonlySet<string>>(new Set(initiallyOpen));
  const openCats = { has: (id: string): boolean => toggledCats.has(id) !== marked.has(id) };
  const toggleCat = (id: string): void =>
    setToggledCats((was) => {
      const next = new Set(was);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const forget = runtime?.onForget;
  const marks = (answers: readonly RuntimeAnswer[] | undefined): ReactNode =>
    answers === undefined ? null : answers.map((answer) => <RunMark key={answer.key} answer={answer} onForget={forget !== undefined ? () => forget([answer.key]) : undefined} />);
  const tag = (subject: string, answers?: readonly RuntimeAnswer[]): ReactNode => {
    const layer = tagOf?.(subject);
    return (
      <>
        {marks(answers)}
        {layer !== undefined ? <LayerTag layer={layer} /> : null}
      </>
    );
  };
  const every = run === undefined ? [] : [...Object.values(run.byTool), ...Object.values(run.bySubject), ...Object.values(run.byProgram), run.loose].flat();
  return (
    <>
      {every.length > 0 ? (
        <View flexDirection="row" alignItems="center" gap={8} paddingHorizontal={4} paddingBottom={6}>
          <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "accent" }} numberOfLines={1} flexShrink={1}>
            {every.length === 1 ? "One answer from this run is marked" : `${every.length} answers from this run are marked`}
          </Txt>
          {forget !== undefined ? (
            <Press onPress={() => forget(every.map((answer) => answer.key))} marginLeft="auto" title="Let go of every answer given in this task">
              {({ hovered }) => <Txt spec={{ voice: "app", scale: 11 / 12.5, color: hovered ? "text" : "tok-hint" }}>let go of all</Txt>}
            </Press>
          ) : null}
        </View>
      ) : null}
      <View flexDirection="column" minWidth={0}>
        {TOOL_CATEGORIES.map((category, index) => {
          const inCategory = offered.filter((tool) => TOOL_SPEC_BY_NAME.get(tool.name)?.category === category.id);
          if (inCategory.length === 0) return <PlainCat key={category.id} first={index === 0} name={category.label} hint="nothing here" dim />;
          return (
            <CxCategory
              key={category.id}
              first={index === 0}
              category={category}
              granted={sectionCountOf(map, category.id)}
              mode={sectionModeOf(map, parked, category.id)}
              open={openCats.has(category.id)}
              onOpen={() => toggleCat(category.id)}
              readOnly={readOnly}
              onMode={(next) => {
                const cascaded = withSectionMode(map, parked, category.id, next);
                write(cascaded.permissionSet, cascaded.parked);
              }}
            >
              {inCategory.map((tool) => (
                <TickedTool
                  key={tool.name}
                  tool={tool}
                  spec={TOOL_SPEC_BY_NAME.get(tool.name)}
                  granted={holdsTool(map, tool.name)}
                  mode={toolModeOf(map, parked, tool.name)}
                  impl={toolImplementationOf(map, parked, tool.name)}
                  cliRoute={cliRoute}
                  readOnly={readOnly}
                  tag={tag(tool.name, run?.byTool[tool.name])}
                  onGrant={() => write(withToolHeld(map, parked, tool.name, !holdsTool(map, tool.name)))}
                  onMode={(next) => (holdsTool(map, tool.name) ? write(withSubjectMode(map, tool.name, next)) : setParked({ ...parked, [tool.name]: { ...parked[tool.name], mode: next } }))}
                  onImpl={(next) => (holdsTool(map, tool.name) ? write(withToolImplementation(map, tool.name, next)) : setParked({ ...parked, [tool.name]: { ...parked[tool.name], implementation: next } }))}
                />
              ))}
              {category.id === "execution" ? (
                <>
                  {commandGroupsOf(map).map((group) => (
                    <CommandGroupRow key={group.program} group={group} permissionSet={map} readOnly={readOnly} open={openCats.has(`program:${group.program}`)} onOpen={() => toggleCat(`program:${group.program}`)} onMode={(next) => write(Object.hasOwn(map.entries, group.program) ? withSubjectMode(map, group.program, next) : withSubject(map, group.program, next))}>
                      {group.subs.map((sub) => (
                        <TickedSubject key={sub.subject} subject={sub.subject} held mode={sub.mode} readOnly={readOnly} tag={tag(sub.subject, run?.bySubject[sub.subject])} onHeld={() => write(withoutSubject(map, sub.subject))} onMode={(next) => write(withSubjectMode(map, sub.subject, next))} />
                      ))}
                      {(run?.byProgram[group.program] ?? []).map((answer) => (
                        <RunLine key={answer.key} answer={answer} onForget={forget !== undefined ? () => forget([answer.key]) : undefined} />
                      ))}
                      {readOnly ? null : (
                        <AddLine
                          label={`add a ${group.program} subcommand`}
                          example="push"
                          onAdd={(typed) => {
                            const named = commandSubjectOf(typed, group.program);
                            if ("problem" in named) return named.problem;
                            write(withCommand(map, named.subject));
                            return undefined;
                          }}
                        />
                      )}
                    </CommandGroupRow>
                  ))}
                  {(run?.loose ?? []).map((answer) => (
                    <RunLine key={answer.key} answer={answer} onForget={forget !== undefined ? () => forget([answer.key]) : undefined} />
                  ))}
                  <TickedSubject
                    subject={SCRIPT_SUBJECT}
                    hint={SCRIPT_HINT}
                    held={Object.hasOwn(map.entries, SCRIPT_SUBJECT)}
                    mode={map.entries[SCRIPT_SUBJECT]?.mode ?? parked[SCRIPT_SUBJECT]?.mode ?? MODE_WHEN_UNSET}
                    readOnly={readOnly}
                    tag={tag(SCRIPT_SUBJECT)}
                    onHeld={() => write(Object.hasOwn(map.entries, SCRIPT_SUBJECT) ? withoutSubject(map, SCRIPT_SUBJECT) : withSubject(map, SCRIPT_SUBJECT, parked[SCRIPT_SUBJECT]?.mode ?? MODE_WHEN_UNSET))}
                    onMode={(next) => (Object.hasOwn(map.entries, SCRIPT_SUBJECT) ? write(withSubjectMode(map, SCRIPT_SUBJECT, next)) : setParked({ ...parked, [SCRIPT_SUBJECT]: { mode: next } }))}
                  />
                  {readOnly ? null : (
                    <AddLine
                      label="add a command"
                      example="git status"
                      onAdd={(typed) => {
                        const named = commandSubjectOf(typed);
                        if ("problem" in named) return named.problem;
                        write(withCommand(map, named.subject));
                        const added = `program:${named.subject.split(" ")[0]!}`;
                        if (!openCats.has(added)) toggleCat(added);
                        return undefined;
                      }}
                    />
                  )}
                </>
              ) : null}
            </CxCategory>
          );
        })}
        <PlainCat
          first={false}
          name="Other"
          hint="anything not listed above — an agent's own tools with no equal here included"
          control={
            <>
              {tag(OTHER_SUBJECT)}
              <ModePicker head mode={map.other ?? MODE_WHEN_UNSET} title="Anything this project has no name for" readOnly={readOnly} onMode={(next) => write(withOther(map, next))} />
            </>
          }
        />
      </View>
      <CardHint>
        {readOnly
          ? "What the whole stack comes to, each line with the layer that decided it. Change a line under This conversation, or in the layer that says it."
          : offered.length === 0
            ? "This project registers no tools."
            : "Ticking a tool offers it; the mode beside it is what happens when it is called. A shell line is taken apart, and each part answers to its own line here."}
      </CardHint>
    </>
  );
}

/** What this run answered about a line, in --accent — `this run · allow in packages` — and its × to let it go. */
function RunMark({ answer, onForget }: { answer: RuntimeAnswer; onForget: (() => void) | undefined }): JSX.Element {
  const t = useTokens();
  return (
    <View
      flexDirection="row"
      alignItems="center"
      gap={3}
      flexShrink={0}
      paddingLeft={7}
      paddingRight={onForget !== undefined ? 4 : 7}
      borderRadius={999}
      backgroundColor={t.mix(t.v("accent"), 13, "transparent") as never}
      {...({ title: `${answer.width}: answered ${answer.decision} for this run${answer.place !== undefined ? `, in ${answer.place}` : ""}` } as object)}
    >
      <Txt spec={{ voice: "app", scale: 10 / 12.5, weight: 600, lineHeight: 1.5, color: "accent" }} numberOfLines={1}>
        {runtimeWordsOf(answer)}
      </Txt>
      {onForget !== undefined ? (
        <Press onPress={onForget} label={`let go of ${answer.key}`} title="Let go of this answer: the line decides again" width={12} alignItems="center">
          {({ hovered }) => <Txt spec={{ voice: "app", scale: 11 / 12.5, weight: 600, lineHeight: 1.3, color: hovered ? "bad" : "accent" }}>×</Txt>}
        </Press>
      ) : null}
    </View>
  );
}

/** An answer of this run with no line to mark: a line of its own — the width, its mark, its decision. */
function RunLine({ answer, onForget }: { answer: RuntimeAnswer; onForget: (() => void) | undefined }): JSX.Element {
  return (
    <View flexDirection="row" alignItems="center" gap={8} paddingVertical={5} paddingHorizontal={7} borderRadius={7}>
      <ChipIcon name="terminal" />
      <Txt spec={{ voice: "data", scale: 11.5 / 12, color: "text" }} numberOfLines={1} flexShrink={1} minWidth={0}>
        {answer.width}
      </Txt>
      <View flexDirection="row" alignItems="center" gap={4} marginLeft="auto" flexShrink={0}>
        <RunMark answer={answer} onForget={onForget} />
        <ModeChip mode={answer.decision} />
      </View>
    </View>
  );
}

/** The layer that decided a line (decision 0023 §2.7): its id in a quiet pill, before the mode. */
export function LayerTag({ layer }: { layer: string }): JSX.Element {
  const t = useTokens();
  return (
    <Txt
      spec={{ voice: "app", scale: 10 / 12.5, weight: 500, lineHeight: 1.5, color: "dim" }}
      flexShrink={0}
      paddingHorizontal={7}
      borderRadius={999}
      backgroundColor={t.v("panel-2") as never}
      numberOfLines={1}
      {...({ title: `decided by ${layer}` } as object)}
    >
      {layer}
    </Txt>
  );
}

/** A head with nothing to fold (an empty category, and Other): padding 5 0 5 20. */
function PlainCat({ first, name, hint, dim = false, control }: { first: boolean; name: string; hint: string; dim?: boolean; control?: ReactNode }): JSX.Element {
  const t = useTokens();
  return (
    <View {...(first ? {} : (edge(t, { top: 1 }) as object))}>
      <View flexDirection="row" alignItems="center" gap={4} minWidth={0} paddingTop={5} paddingBottom={5} paddingLeft={20}>
        <OptText name={name} hint={hint} nameColor={dim ? "tok-hint" : "text"} grow />
        {control}
      </View>
    </View>
  );
}

/** `CategoryRow` as the composer draws it: the fold, and the mode its tools share. */
function CxCategory({ first, category, granted, mode, open, onOpen, onMode, readOnly, children }: { first: boolean; category: ToolCategory; granted: number; mode: PermissionSetMode | undefined; open: boolean; onOpen: () => void; onMode: (next: PermissionSetMode) => void; readOnly: boolean; children: ReactNode }): JSX.Element {
  const t = useTokens();
  return (
    <View {...(first ? {} : (edge(t, { top: 1 }) as object))}>
      <View flexDirection="row" alignItems="center" gap={4} minWidth={0}>
        <Press
          onPress={onOpen}
          {...({ "aria-expanded": open } as object)}
          flexGrow={1}
          flexShrink={1}
          flexBasis={0}
          minWidth={0}
          flexDirection="row"
          alignItems="center"
          gap={6}
          paddingVertical={5}
          paddingHorizontal={4}
          borderRadius={5}
          box={({ hovered }) => ({ backgroundColor: hovered ? t.v("panel-2") : "transparent" })}
        >
          <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "tok-hint" }} width={10} flexShrink={0} textAlign="center" transform={[{ rotate: open ? "90deg" : "0deg" }]}>
            ›
          </Txt>
          <OptText name={category.label} hint={category.hint} />
          {granted > 0 ? <Count n={granted} /> : null}
        </Press>
        <ModePicker head mode={mode} title={`${category.label}: sets every tool under it`} readOnly={readOnly} onMode={onMode} />
      </View>
      {open ? <FoldBody>{children}</FoldBody> : null}
    </View>
  );
}

/** A tool's row with its tick: a line of the map the composer offers or not. */
function TickLine({ on, onPress, icon, name, hint, title, trail, readOnly }: { on: boolean; onPress: () => void; icon: IconName; name: string; hint: string; title: string; trail: ReactNode; readOnly: boolean }): JSX.Element {
  const t = useTokens();
  const [hovered, hover] = useHover();
  return (
    <View flexDirection="row" alignItems="center" gap={4} borderRadius={7} position="relative" backgroundColor={(on ? t.mix(t.v("accent"), 13, "transparent") : hovered && !readOnly ? t.mix(t.v("text"), 7, "transparent") : "transparent") as never} {...hover}>
      <Press onPress={readOnly ? () => undefined : onPress} title={title} {...(readOnly ? { cursor: "default" } : {})} flexGrow={1} flexShrink={1} flexBasis="auto" minWidth={0} flexDirection="row" alignItems="center" gap={8} paddingVertical={5} paddingHorizontal={7} borderRadius={7}>
        {({ hovered: over }) => (
          <>
            <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "ok" }} width={10} flexShrink={0}>
              {on ? "✓" : ""}
            </Txt>
            <ChipIcon name={icon} />
            <OptText name={name} hint={hint} nameColor={on || (over && !readOnly) ? "text" : "dim"} />
          </>
        )}
      </Press>
      {trail}
    </View>
  );
}

/** `ToolRow`, ticked: the tool's tick, its words, the implementation (where the answering agent has its own) and the mode. */
function TickedTool({ tool, spec, granted, mode, impl, cliRoute, readOnly, tag, onGrant, onMode, onImpl }: { tool: ToolChoice; spec?: ToolSpec | undefined; granted: boolean; mode: PermissionSetMode; impl: ToolImplementation; cliRoute: string | undefined; readOnly: boolean; tag: ReactNode; onGrant: () => void; onMode: (next: PermissionSetMode) => void; onImpl: (next: ToolImplementation) => void }): JSX.Element {
  const native = cliRoute !== undefined ? tool.natives?.[cliRoute] : undefined;
  const hint = tool.name === SHELL_TOOL ? SHELL_HINT : spec?.unserved === true ? `${spec.hint} · not served yet` : (spec?.hint ?? tool.name);
  return (
    <TickLine
      on={granted}
      onPress={onGrant}
      readOnly={readOnly}
      icon={(TOOL_ICONS[tool.name] ?? "tool") as IconName}
      name={spec?.label ?? tool.name}
      hint={hint}
      title={hint}
      trail={
        <>
          {tag}
          {native !== undefined ? <ImplPicker value={impl} native={native} onPick={onImpl} readOnly={readOnly} /> : null}
          <ModePicker mode={mode} title={`${tool.name}: ${modeMeta(mode).hint}`} readOnly={readOnly} onMode={onMode} />
        </>
      }
    />
  );
}

/** `SubjectRow`, ticked: a command the map names (or `script`), in or out, and its mode. */
function TickedSubject({ subject, hint, held, mode, readOnly, tag, onHeld, onMode }: { subject: string; hint?: string; held: boolean; mode: PermissionSetMode; readOnly: boolean; tag: ReactNode; onHeld: () => void; onMode: (next: PermissionSetMode) => void }): JSX.Element {
  const script = subject === SCRIPT_SUBJECT;
  return (
    <TickLine
      on={held}
      onPress={onHeld}
      readOnly={readOnly}
      icon={script ? "script" : "terminal"}
      name={subject}
      hint={hint ?? ""}
      title={hint ?? subject}
      trail={
        <>
          {tag}
          <ModePicker mode={mode} title={`${subject}: ${modeMeta(mode).hint}`} readOnly={readOnly} onMode={onMode} />
        </>
      }
    />
  );
}
