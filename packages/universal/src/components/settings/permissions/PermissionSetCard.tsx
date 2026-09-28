import { useState, type JSX } from "react";
import { View } from "@tamagui/core";
import {
  MODE_WHEN_UNSET,
  RUNNER_GROUP_SUBJECT,
  SCRIPT_SUBJECT,
  SHELL_TOOL,
  TOOL_CATEGORIES,
  TOOL_SPEC_BY_NAME,
  holdsTool,
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
  commandGroupsOf,
  commandSubjectOf,
  holdsRunners,
  sectionCountOf,
  suggestedPrograms,
  suggestedSubcommands,
  toolImplementationOf,
  toolModeOf,
  withCommand,
  withOther,
  withoutProgram,
  withoutRunners,
  withoutSubject,
  withRunners,
  withSubject,
  withSubjectMode,
  withToolHeld,
  withToolImplementation,
} from "@jaira/ui/composerPermissionSet";
import { holdsMcpServer, mcpAddLabel, mcpGroupHint, mcpGroupModeOf, mcpGroupsOf, mcpLineCount, mcpToolHint, unnamedMcpTools, withMcpServerMode, withMcpTool, withoutMcpServer, type McpGroup } from "@jaira/ui/mcpBucketModel";
import { modeMeta } from "@jaira/ui/permissionSetWords";
import { Txt } from "../../../primitives";
import type { IconName } from "../../panel/Icon";
import {
  AddMenu,
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
} from "./rows";
import { Press } from "../../../primitives";
import { useTokens } from "../../../tokens";

/**
 * `permissionSetCard.tsx` and `mcpBucket.tsx`, universal (decision 0015): a permission set on the page —
 * its sections, a line per subject with its implementation and its mode, commands grouped under their
 * program, the MCP servers, and `Other` last. Every edit is `composerPermissionSet.ts`'s or
 * `mcpBucketModel.ts`'s, as the DOM's are. `.set-config .llm-detail .cx-cats`: 2 above.
 */

const NO_PARKED = {};

/** The key a program's fold is kept under, beside the section ids. */
export const programFold = (program: string): string => `program:${program}`;
/** The key the command runners' group fold is kept under. */
export const RUNNERS_FOLD = "runners";
/** The key a server's fold is kept under. */
export const mcpServerFold = (server: string): string => `mcp:${server}`;

const RUNNERS_OPTION: AddOption = { subject: RUNNER_GROUP_SUBJECT, label: "Command runners", hint: RUNNERS_HINT, icon: "terminal" };
const SCRIPT_OPTION: AddOption = { subject: SCRIPT_SUBJECT, label: "script", hint: SCRIPT_HINT, icon: "script" };

function toolOption(name: string): AddOption {
  const spec = TOOL_SPEC_BY_NAME.get(name);
  return { subject: name, label: spec?.label ?? name, hint: name === SHELL_TOOL ? SHELL_HINT : spec?.unserved === true ? `${spec.hint} · not served yet` : spec?.hint, icon: (TOOL_ICONS[name] ?? "tool") as IconName };
}

/** The sections a permission set opens on: the ones that hold a line. */
export function openSectionsOf(permissionSet: PermissionSet): string[] {
  return TOOL_CATEGORIES.filter((category) => sectionCountOf(permissionSet, category.id) > 0).map((category) => category.id);
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
        const held = inCategory.filter((tool) => holdsTool(permissionSet, tool.name));
        const groups = category.id === "execution" ? commandGroupsOf(permissionSet) : [];
        const script = category.id === "execution" && Object.hasOwn(permissionSet.entries, SCRIPT_SUBJECT);
        const runners = category.id === "execution" && holdsRunners(permissionSet);
        if (locked && held.length === 0 && groups.length === 0 && !script && !runners) return null;
        return (
          <CategoryRow key={category.id} first={isFirst()} category={category} granted={sectionCountOf(permissionSet, category.id)} open={open.has(category.id)} onOpen={() => toggle(category.id)}>
            {held.map((tool) => (
              <ToolRow
                key={tool.name}
                tool={tool}
                spec={TOOL_SPEC_BY_NAME.get(tool.name)}
                mode={toolModeOf(permissionSet, NO_PARKED, tool.name)}
                impl={toolImplementationOf(permissionSet, NO_PARKED, tool.name)}
                readOnly={locked}
                onRemove={locked ? undefined : () => write(withToolHeld(permissionSet, NO_PARKED, tool.name, false))}
                onMode={(next) => write(withSubjectMode(permissionSet, tool.name, next))}
                onImpl={(next) => write(withToolImplementation(permissionSet, tool.name, next))}
              />
            ))}
            {groups.map((group) => (
              <CommandGroupRow
                key={group.program}
                group={group}
                permissionSet={permissionSet}
                open={open.has(programFold(group.program))}
                onOpen={() => toggle(programFold(group.program))}
                readOnly={locked}
                onRemove={locked ? undefined : () => write(withoutProgram(permissionSet, group.program))}
                onMode={(next) => write(withSubject(permissionSet, group.program, next))}
              >
                {group.subs.map((sub) => (
                  <SubjectRow
                    key={sub.subject}
                    subject={sub.subject}
                    mode={sub.mode}
                    readOnly={locked}
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
                onRunnerMode={(program, next) => write(withSubject(permissionSet, runnerSubject(program), next))}
                onRemoveRunner={(program) => write(withoutSubject(permissionSet, runnerSubject(program)))}
              />
            ) : null}
            {script ? (
              <SubjectRow
                subject={SCRIPT_SUBJECT}
                hint={SCRIPT_HINT}
                mode={permissionSet.entries[SCRIPT_SUBJECT]?.mode ?? MODE_WHEN_UNSET}
                readOnly={locked}
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
      <PlainCategory
        first={false}
        name="Other"
        hint="anything not listed above — an agent's own tools with no equal here included"
        control={<ModePicker head mode={permissionSet.other ?? MODE_WHEN_UNSET} title="Anything this permission set has no line for" readOnly={locked} onMode={(next) => write(withOther(permissionSet, next))} />}
      />
    </View>
  );
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
  const held = holdsMcpServer(permissionSet, group.server) || lines.length > 0;
  const listed = new Map((group.status?.tools ?? []).map((tool) => [tool.name, tool]));
  const unnamed = unnamedMcpTools(permissionSet, group);
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
        <ModePicker head mode={mcpGroupModeOf(permissionSet, group.server)} title={`${group.server}: any ${group.server} tool not named under it`} onMode={(next) => write(withMcpServerMode(permissionSet, group.server, next))} readOnly={locked} />
      </View>
      {open ? (
        <FoldBody sub>
          {lines.map((line) => {
            const mode = line.mode ?? MODE_WHEN_UNSET;
            const hint = mcpToolHint(listed.get(line.tool));
            return (
              <SubjectRow
                key={line.subject}
                subject={line.tool}
                icon="tool"
                mono
                hint={hint}
                mode={mode}
                readOnly={locked}
                {...(locked ? {} : { onRemove: () => write(withoutSubject(permissionSet, line.subject)) })}
                onMode={(next) => write(withSubjectMode(permissionSet, line.subject, next))}
              />
            );
          })}
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

void modeMeta;
