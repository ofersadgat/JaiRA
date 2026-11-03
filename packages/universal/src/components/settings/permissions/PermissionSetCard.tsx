import { useState, type JSX } from "react";
import { View } from "@tamagui/core";
import {
  MODE_WHEN_UNSET,
  RUNNER_GROUP_SUBJECT,
  SCRIPT_SUBJECT,
  SHELL_TOOL,
  SYSTEM_AREAS,
  TOOL_CATEGORIES,
  TOOL_SPEC_BY_NAME,
  holdsTool,
  mcpServerSubject,
  mcpToolLines,
  mcpToolSubject,
  runnerSubject,
  type McpServerStatus,
  type PermissionSet,
  type ToolCategory,
  type ToolChoice,
} from "@jaira/shared/browser";
import {
  addableScript,
  addableTools,
  canBeUnavailable,
  commandGroupsOf,
  commandSubjectOf,
  elsewhereLabel,
  groupHeadOf,
  holdsProgramLine,
  holdsRunners,
  isUnavailableLine,
  linePlaceKindOf,
  placeOptionsOf,
  placeProblem,
  placeRowsOf,
  placesSentence,
  placeTypedHint,
  suggestedPrograms,
  suggestedSubcommands,
  toolImplementationOf,
  toolModeOf,
  withCommand,
  withOther,
  withoutPlace,
  withoutProgram,
  withoutRunners,
  withoutSubject,
  withPlace,
  withPlaceMode,
  withPlacePicked,
  withRunners,
  withSubject,
  withSubjectMode,
  withToolHeld,
  withToolImplementation,
  withUnavailable,
  writtenCountOf,
} from "@jaira/ui/composerPermissionSet";
import { holdsMcpServer, mappedMcpToolsOf, mcpAddLabel, mcpGroupHint, mcpGroupModeOf, mcpGroupsOf, mcpLineCount, mcpToolHint, unnamedMcpTools, withMcpServerMode, withMcpTool, withoutMcpServer, type McpGroup } from "@jaira/ui/mcpBucketModel";
import { addPlaceLabel, placeNoun } from "@jaira/ui/permissionSetWords";
import { Txt } from "../../../primitives";
import type { IconName } from "../../panel/Icon";
import {
  AddButton,
  AddMenu,
  AreaRow,
  CategoryRow,
  ChipIcon,
  CommandGroupRow,
  Count,
  FoldBody,
  ModePicker,
  OptText,
  PlainCategory,
  RUNNERS_HINT,
  RemoveLine,
  RunnerGroupRow,
  SCRIPT_HINT,
  SHELL_HINT,
  SubjectRow,
  TOOL_ICONS,
  ToolRow,
  type AddOption,
  type AreaSideLine,
  type LinePlaces,
} from "./rows";
import { Press } from "../../../primitives";
import { useTokens } from "../../../tokens";

/**
 * A permission set on the page — its sections, a line per subject with its implementation and its mode,
 * commands grouped under their program, the MCP servers, and `Other` last. A line with places folds onto
 * a row per place (decision 0023 §4.2). Every edit is `composerPermissionSet.ts`'s or
 * `mcpBucketModel.ts`'s. The sections stand 2 below what is over them.
 *
 * Read-only (`readOnly`, or no `onChange`) it draws only the lines the set WRITES — a section that writes
 * none is left out, a line's places are drawn without minus or add row — which is how a layer's own
 * contents are read wherever a set is shown and not edited.
 */

const NO_PARKED = {};

/** The key a program's fold is kept under, beside the section ids. */
export const programFold = (program: string): string => `program:${program}`;
/** The key the command runners' group fold is kept under. */
export const RUNNERS_FOLD = "runners";
/** The key a server's fold is kept under. */
export const mcpServerFold = (server: string): string => `mcp:${server}`;
/** The key a line's places fold is kept under. */
export const placesFold = (subject: string): string => `places:${subject}`;

const RUNNERS_OPTION: AddOption = { subject: RUNNER_GROUP_SUBJECT, label: "Command runners", hint: RUNNERS_HINT, icon: "terminal" };
const SCRIPT_OPTION: AddOption = { subject: SCRIPT_SUBJECT, label: "script", hint: SCRIPT_HINT, icon: "script" };

/** What `Other` says when the set writes none (decision 0023 §2.3). */
export const OTHER_NOT_WRITTEN = "not written — what this layer leaves out falls through";
const OTHER_HINT = "anything not listed above — an agent's own tools with no equal here included";

function toolOption(name: string): AddOption {
  const spec = TOOL_SPEC_BY_NAME.get(name);
  return { subject: name, label: spec?.label ?? name, hint: name === SHELL_TOOL ? SHELL_HINT : spec?.unserved === true ? `${spec.hint} · not served yet` : spec?.hint, icon: (TOOL_ICONS[name] ?? "tool") as IconName };
}

/** The sections a permission set opens on: the ones that write a line. */
export function openSectionsOf(permissionSet: PermissionSet): string[] {
  return TOOL_CATEGORIES.filter((category) => writtenCountOf(permissionSet, category.id) > 0).map((category) => category.id);
}

export function PermissionSetCard({
  permissionSet,
  tools,
  onChange,
  readOnly,
  mcp,
}: {
  permissionSet: PermissionSet;
  tools: readonly ToolChoice[];
  onChange?: ((next: PermissionSet) => void) | undefined;
  readOnly?: boolean | undefined;
  mcp?: readonly McpServerStatus[] | undefined;
}): JSX.Element {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(openSectionsOf(permissionSet)));
  const toggle = (id: string, to?: boolean): void => {
    const next = to ?? !open.has(id);
    setOpen((was) => new Set(next ? [...was, id] : [...was].filter((one) => one !== id)));
  };
  const locked = readOnly === true || onChange === undefined;
  const write = (next: PermissionSet): void => onChange?.(next);
  const offered = tools.map((tool) => tool.name);
  const writes = (name: string): boolean => holdsTool(permissionSet, name) || isUnavailableLine(permissionSet, name);
  /**
   * A line's places, as its row takes them — or `undefined` where the line draws none: its calls name
   * no place, it is `unavailable`, or it names none and nothing can be added. `hint` is what the line
   * says of itself without them.
   */
  const placesFor = (subject: string, hint: string): LinePlaces | undefined => {
    const kind = linePlaceKindOf(subject);
    if (kind === undefined || isUnavailableLine(permissionSet, subject) || !Object.hasOwn(permissionSet.entries, subject)) return undefined;
    const rows = placeRowsOf(permissionSet, subject);
    if (rows.length === 0 && locked) return undefined;
    const isOpen = open.has(placesFold(subject));
    const n = rows.filter((row) => !row.anywhere).length;
    const noun = placeNoun(kind, n);
    const lead = hint === "" ? "" : `${hint} — `;
    const said = n === 0 ? hint : isOpen ? `${lead}${placesSentence(permissionSet, subject, noun)}` : `${lead}${noun}`;
    const own = permissionSet.entries[subject]?.mode;
    return {
      kind,
      rows,
      open: isOpen,
      onOpen: () => toggle(placesFold(subject)),
      hint: said,
      ...(n > 0 && own === undefined ? { elsewhere: elsewhereLabel(permissionSet, subject) } : {}),
      ...(locked
        ? {}
        : {
            onPlaceMode: (place, next) => write(withPlaceMode(permissionSet, subject, place, next)),
            onRemovePlace: (place) => write(withoutPlace(permissionSet, subject, place)),
            add: {
              label: addPlaceLabel(kind),
              options: placeOptionsOf(permissionSet, subject).map((option) => ({ subject: option.id, label: option.label, hint: option.hint, icon: option.icon as IconName })),
              onPick: (id) => write(withPlacePicked(permissionSet, subject, id)),
              typed: {
                label: addPlaceLabel(kind),
                example: kind === "site" ? "github.com" : kind === "branch" ? "main" : "src",
                hint: placeTypedHint(subject),
                onAdd: (typed) => {
                  const problem = placeProblem(permissionSet, subject, typed);
                  if (problem !== undefined) return problem;
                  write(withPlace(permissionSet, subject, typed.trim()));
                  return undefined;
                },
              },
            },
          }),
    };
  };
  /** A line's own mode as its head shows it: on a line with places, its `**` alone — none means `elsewhere: as …`. */
  const headMode = (subject: string): typeof permissionSet.other => {
    const entry = permissionSet.entries[subject];
    return Object.keys(entry?.places ?? {}).length > 0 ? entry?.mode : (entry?.mode ?? MODE_WHEN_UNSET);
  };
  const unavailableOf = (subject: string): (() => void) | undefined => (locked || !canBeUnavailable(subject) ? undefined : () => write(withUnavailable(permissionSet, subject)));
  let first = true;
  const isFirst = (): boolean => {
    const was = first;
    first = false;
    return was;
  };
  return (
    <View flexDirection="column" minWidth={0} marginTop={2}>
      {TOOL_CATEGORIES.map((category) => {
        if (category.id === "mcp") {
          const groups = mcpGroupsOf(permissionSet, mcp);
          if (groups.length === 0 && locked) return null;
          return <McpBucket key={category.id} first={isFirst()} category={category} permissionSet={permissionSet} servers={mcp} locked={locked} write={write} open={open} toggle={toggle} />;
        }
        const inCategory = tools.filter((tool) => TOOL_SPEC_BY_NAME.get(tool.name)?.category === category.id);
        if (inCategory.length === 0) return <PlainCategory key={category.id} first={isFirst()} name={category.label} hint="nothing here" dim />;
        const held = inCategory.filter((tool) => writes(tool.name));
        const groups = category.id === "execution" ? commandGroupsOf(permissionSet) : [];
        const script = category.id === "execution" && Object.hasOwn(permissionSet.entries, SCRIPT_SUBJECT);
        const runners = category.id === "execution" && holdsRunners(permissionSet);
        if (locked && held.length === 0 && groups.length === 0 && !script && !runners) return null;
        return (
          <CategoryRow key={category.id} first={isFirst()} category={category} granted={writtenCountOf(permissionSet, category.id)} open={open.has(category.id)} onOpen={() => toggle(category.id)}>
            {category.id === "system"
              ? SYSTEM_AREAS.filter((area) => held.some((tool) => tool.name === area.look || tool.name === area.change)).map((area) => {
                  // An area is one row and two lines of the set (decision 0019, ruling 1).
                  const side = (name: string): AreaSideLine => ({
                    tool: name,
                    held: holdsTool(permissionSet, name),
                    unavailable: isUnavailableLine(permissionSet, name),
                    mode: toolModeOf(permissionSet, NO_PARKED, name),
                    onMode: (next) => write(withSubjectMode(permissionSet, name, next)),
                    onUnavailable: unavailableOf(name),
                    ...(offered.includes(name) ? { onAdd: () => write(withToolHeld(permissionSet, NO_PARKED, name, true)) } : {}),
                    onRemove: () => write(withoutSubject(permissionSet, name)),
                  });
                  return (
                    <AreaRow
                      key={area.id}
                      area={area}
                      look={side(area.look)}
                      change={side(area.change)}
                      readOnly={locked}
                      onRemove={locked ? undefined : () => write(withoutSubject(withoutSubject(permissionSet, area.look), area.change))}
                    />
                  );
                })
              : held.map((tool) => {
                  const spec = TOOL_SPEC_BY_NAME.get(tool.name);
                  const hint = tool.name === SHELL_TOOL ? SHELL_HINT : spec?.unserved === true ? `${spec.hint} · not served yet` : (spec?.hint ?? tool.name);
                  const unavailable = isUnavailableLine(permissionSet, tool.name);
                  return (
                    <ToolRow
                      key={tool.name}
                      tool={tool}
                      spec={spec}
                      mode={unavailable ? undefined : headMode(tool.name)}
                      impl={toolImplementationOf(permissionSet, NO_PARKED, tool.name)}
                      readOnly={locked}
                      unavailable={unavailable}
                      onUnavailable={unavailableOf(tool.name)}
                      places={placesFor(tool.name, hint)}
                      onRemove={locked ? undefined : () => write(withoutSubject(permissionSet, tool.name))}
                      onMode={(next) => write(withSubjectMode(permissionSet, tool.name, next))}
                      onImpl={(next) => write(withToolImplementation(permissionSet, tool.name, next))}
                    />
                  );
                })}
            {groups.map((group) => (
              <CommandGroupRow
                key={group.program}
                group={group}
                permissionSet={permissionSet}
                open={open.has(programFold(group.program))}
                onOpen={() => toggle(programFold(group.program))}
                readOnly={locked}
                head={groupHeadOf(permissionSet, group)}
                places={holdsProgramLine(group) ? placesFor(group.program, "") : undefined}
                onRemove={locked ? undefined : () => write(withoutProgram(permissionSet, group.program))}
                onMode={(next) => write(holdsProgramLine(group) ? withSubjectMode(permissionSet, group.program, next) : withSubject(permissionSet, group.program, next))}
              >
                {group.subs.map((sub) => (
                  <SubjectRow
                    key={sub.subject}
                    subject={sub.subject}
                    mode={headMode(sub.subject)}
                    readOnly={locked}
                    places={placesFor(sub.subject, "")}
                    onRemove={locked ? undefined : () => write(withoutSubject(permissionSet, sub.subject))}
                    onMode={(next) => write(withSubjectMode(permissionSet, sub.subject, next))}
                  />
                ))}
                {locked ? null : (
                  <AddMenu
                    label={`add a ${group.program} subcommand`}
                    options={suggestedSubcommands(permissionSet, group.program).map((subject) => ({ subject, label: subject, icon: "terminal" as const, mono: true }))}
                    onPick={(subject) => write(withCommand(permissionSet, subject))}
                    typed={{
                      label: `add a ${group.program} subcommand`,
                      example: "push",
                      onAdd: (typed) => {
                        const named = commandSubjectOf(typed, group.program);
                        if ("problem" in named) return named.problem;
                        write(withCommand(permissionSet, named.subject));
                        return undefined;
                      },
                    }}
                  />
                )}
              </CommandGroupRow>
            ))}
            {runners ? (
              <RunnerGroupRow
                permissionSet={permissionSet}
                open={open.has(RUNNERS_FOLD)}
                onOpen={() => toggle(RUNNERS_FOLD)}
                readOnly={locked}
                onRemove={locked ? undefined : () => write(withoutRunners(permissionSet))}
                onGroupMode={(next) => write(withSubject(permissionSet, RUNNER_GROUP_SUBJECT, next))}
                onRunnerMode={(program, next) => {
                  const subject = runnerSubject(program);
                  write(Object.hasOwn(permissionSet.entries, subject) ? withSubjectMode(permissionSet, subject, next) : withSubject(permissionSet, subject, next));
                }}
                onRemoveRunner={(program) => write(withoutSubject(permissionSet, runnerSubject(program)))}
                placesOf={(program) => placesFor(runnerSubject(program), "")}
              />
            ) : null}
            {script ? (
              <SubjectRow
                subject={SCRIPT_SUBJECT}
                hint={SCRIPT_HINT}
                mode={headMode(SCRIPT_SUBJECT)}
                readOnly={locked}
                places={placesFor(SCRIPT_SUBJECT, SCRIPT_HINT)}
                onRemove={locked ? undefined : () => write(withoutSubject(permissionSet, SCRIPT_SUBJECT))}
                onMode={(next) => write(withSubjectMode(permissionSet, SCRIPT_SUBJECT, next))}
              />
            ) : null}
            {locked ? null : category.id === "execution" ? (
              <AddMenu
                label="add a command, the shell, or script"
                options={[
                  ...addableTools(permissionSet, category.id, offered).map(toolOption),
                  ...(addableScript(permissionSet) ? [SCRIPT_OPTION] : []),
                  ...(holdsRunners(permissionSet) ? [] : [RUNNERS_OPTION]),
                  ...suggestedPrograms(permissionSet).map((program) => ({ subject: program, label: program, hint: `every ${program} command — then name the ones that differ`, icon: "terminal" as const, mono: true })),
                ]}
                onPick={(subject) => {
                  if (subject === SCRIPT_SUBJECT) write(withSubject(permissionSet, SCRIPT_SUBJECT, MODE_WHEN_UNSET));
                  else if (subject === RUNNER_GROUP_SUBJECT) {
                    write(withRunners(permissionSet));
                    toggle(RUNNERS_FOLD, true);
                  } else if (TOOL_SPEC_BY_NAME.has(subject)) write(withToolHeld(permissionSet, NO_PARKED, subject, true));
                  else {
                    write(withCommand(permissionSet, subject));
                    toggle(programFold(subject), true);
                  }
                }}
                typed={{
                  label: "add a command",
                  example: "terraform plan",
                  onAdd: (typed) => {
                    const named = commandSubjectOf(typed);
                    if ("problem" in named) return named.problem;
                    write(withCommand(permissionSet, named.subject));
                    toggle(programFold(named.subject.split(" ")[0]!), true);
                    return undefined;
                  },
                }}
              />
            ) : (
              <AddMenu label="add a tool" options={addableTools(permissionSet, category.id, offered).map(toolOption)} onPick={(subject) => write(withToolHeld(permissionSet, NO_PARKED, subject, true))} />
            )}
          </CategoryRow>
        );
      })}
      {permissionSet.other !== undefined ? (
        <PlainCategory
          first={false}
          name="Other"
          hint={OTHER_HINT}
          control={
            <ModePicker
              head
              mode={permissionSet.other}
              title="Anything this permission set has no line for"
              readOnly={locked}
              onMode={(next) => write(withOther(permissionSet, next))}
              onRemove={locked ? undefined : () => write(withoutOther(permissionSet))}
              removeHint="not written — what this set leaves out falls through to the sets under it"
            />
          }
        />
      ) : (
        <PlainCategory first={false} name="Other" hint={OTHER_NOT_WRITTEN} dim control={locked ? undefined : <AddButton label="write one" onPress={() => write(withOther(permissionSet, MODE_WHEN_UNSET))} />} />
      )}
    </View>
  );
}

/** `other`, taken back out of the set — what it leaves out then falls through (decision 0023 §2.3). */
function withoutOther(permissionSet: PermissionSet): PermissionSet {
  const { other: _gone, ...rest } = permissionSet;
  return rest;
}

/** A permission set's MCP bucket — one group per configured server. */
function McpBucket({
  category,
  permissionSet,
  servers,
  locked,
  write,
  open,
  toggle,
  first,
}: {
  category: ToolCategory;
  permissionSet: PermissionSet;
  servers: readonly McpServerStatus[] | undefined;
  locked: boolean;
  write: (next: PermissionSet) => void;
  open: ReadonlySet<string>;
  toggle: (id: string, to?: boolean) => void;
  first: boolean;
}): JSX.Element | null {
  const groups = mcpGroupsOf(permissionSet, servers);
  if (groups.length === 0) return <PlainCategory first={first} name={category.label} hint="nothing here — add a server in Settings → Connections" dim />;
  return (
    <CategoryRow first={first} category={category} granted={mcpLineCount(permissionSet)} open={open.has(category.id)} onOpen={() => toggle(category.id)}>
      {groups.map((group) => (
        <McpServerGroup key={group.server} group={group} permissionSet={permissionSet} locked={locked} write={write} open={open.has(mcpServerFold(group.server))} onOpen={() => toggle(mcpServerFold(group.server))} />
      ))}
    </CategoryRow>
  );
}

function McpServerGroup({ group, permissionSet, locked, write, open, onOpen }: { group: McpGroup; permissionSet: PermissionSet; locked: boolean; write: (next: PermissionSet) => void; open: boolean; onOpen: () => void }): JSX.Element {
  const t = useTokens();
  const lines = mcpToolLines(permissionSet, group.server);
  const serverLine = mcpServerSubject(group.server);
  const held = holdsMcpServer(permissionSet, group.server) || lines.length > 0 || isUnavailableLine(permissionSet, serverLine);
  const listed = new Map((group.status?.tools ?? []).map((tool) => [tool.name, tool]));
  const unnamed = unnamedMcpTools(permissionSet, group);
  // What the server's tools count as (decision 0019, ruling 5): drawn under it, following that line.
  const mapped = mappedMcpToolsOf(permissionSet, group);
  const mappedBy = new Map(mapped.map((one) => [one.tool, one]));
  return (
    <View>
      <View flexDirection="row" alignItems="center" gap={4} minWidth={0} paddingVertical={1}>
        {!locked && held ? <RemoveLine subject={group.server} onRemove={() => write(withoutMcpServer(permissionSet, group.server))} /> : null}
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
          paddingVertical={3}
          paddingHorizontal={4}
          borderRadius={5}
          box={({ hovered }) => ({ backgroundColor: hovered ? t.v("panel-2") : "transparent" })}
        >
          <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "tok-hint" }} width={10} flexShrink={0} textAlign="center" transform={[{ rotate: open ? "90deg" : "0deg" }]}>
            ›
          </Txt>
          <ChipIcon name="model" />
          <OptText name={group.server} mono hint={mcpGroupHint(permissionSet, group, open)} />
          {lines.length > 0 ? <Count n={lines.length} /> : null}
        </Press>
        <ModePicker
          head
          mode={mcpGroupModeOf(permissionSet, group.server)}
          title={`${group.server}: any ${group.server} tool not named under it`}
          onMode={(next) => write(withMcpServerMode(permissionSet, group.server, next))}
          readOnly={locked}
          unavailable={isUnavailableLine(permissionSet, serverLine)}
          onUnavailable={locked ? undefined : () => write(withUnavailable(permissionSet, serverLine))}
        />
      </View>
      {open ? (
        <FoldBody sub>
          {lines.map((line) => {
            const unavailable = isUnavailableLine(permissionSet, line.subject);
            const mode = line.mode ?? MODE_WHEN_UNSET;
            const counts = mappedBy.get(line.tool);
            const hint = counts !== undefined ? `${counts.hint}; its own line too, the stricter kept` : mcpToolHint(listed.get(line.tool));
            return (
              <SubjectRow
                key={line.subject}
                subject={line.tool}
                icon="tool"
                mono
                hint={hint}
                mode={unavailable ? undefined : mode}
                unavailable={unavailable}
                readOnly={locked}
                {...(locked ? {} : { onRemove: () => write(withoutSubject(permissionSet, line.subject)), onUnavailable: () => write(withUnavailable(permissionSet, line.subject)) })}
                onMode={(next) => write(withSubjectMode(permissionSet, line.subject, next))}
              />
            );
          })}
          {mapped
            .filter((one) => !one.named)
            .map((one) => (
              <SubjectRow
                key={one.subject}
                subject={one.tool}
                icon={(TOOL_ICONS[one.mapping.as] ?? "system") as IconName}
                mono
                follows
                hint={one.hint}
                mode={one.mode}
                readOnly={locked}
                onMode={(next) => write(withSubjectMode(permissionSet, one.subject, next))}
              />
            ))}
          {locked ? null : (
            <AddMenu
              label={mcpAddLabel(group.server, unnamed)}
              options={unnamed.map((tool) => ({ subject: mcpToolSubject(group.server, tool.name), label: tool.name, hint: mcpToolHint(tool), icon: "tool" as const, mono: true }))}
              onPick={(subject) => {
                const tool = unnamed.find((one) => mcpToolSubject(group.server, one.name) === subject);
                if (tool !== undefined) write(withMcpTool(permissionSet, group.server, tool));
              }}
              typed={{
                label: `name a ${group.server} tool`,
                example: unnamed[0]?.name ?? "get_code",
                onAdd: (typed) => {
                  const name = typed.trim();
                  if (name.length === 0 || /\s/.test(name)) return `a tool's name is one word, as the server lists it`;
                  const tool = listed.get(name);
                  write(withMcpTool(permissionSet, group.server, tool ?? name));
                  return undefined;
                },
              }}
            />
          )}
        </FoldBody>
      ) : null}
    </View>
  );
}
