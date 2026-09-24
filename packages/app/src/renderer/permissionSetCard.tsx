/**
 * A permission set ON THE PAGE — the composer's Tools card, standing still (decision 0007 §6).
 *
 * Two render functions over the rows of `permissionSetRows.tsx` and the edits of `composerPermissionSet.ts`:
 *
 *  - {@link PermissionSetCard} is the whole card, the way the composer draws it — the sections, a line per
 *    subject with its implementation and its mode, commands grouped under their program, `Other`
 *    last — for Settings → Permission sets;
 *  - {@link PermissionSetLines} is the same rows with no sections, for the few lines a STATE writes over
 *    the permission set it starts from.
 *
 * Where they differ from the composer is the one way a settings page has to: the composer lists
 * every tool and TICKS the held ones, because it is answering "what will this message run under";
 * a permission set on the page lists what it HOLDS, because it is a file, and absent is how a file says not
 * offered. So a held line starts with a red minus, and each section and each program ends with a
 * line that adds one — the card's own submenu, listing what that section does not hold yet.
 *
 * Neither holds anything but which folds are open. The permission set arrives, and the next one leaves
 * through `onChange`, whole: a permission set is one statement.
 */
import { useState, type JSX } from "react";
import {
  holdsTool,
  MODE_WHEN_UNSET,
  OTHER_SUBJECT,
  SCRIPT_SUBJECT,
  SHELL_TOOL,
  TOOL_CATEGORIES,
  TOOL_SPEC_BY_NAME,
  type ToolChoice,
  type PermissionSet,
} from "@jaira/shared/browser";
import type { McpServerStatus } from "@jaira/shared/browser";
import { McpBucket } from "./mcpBucket";
import {
  addableScript,
  addableTools,
  commandGroupsOf,
  commandSubjectOf,
  sectionCountOf,
  suggestedPrograms,
  suggestedSubcommands,
  toolImplementationOf,
  toolModeOf,
  withCommand,
  withOther,
  withoutProgram,
  withoutSubject,
  withSubject,
  withSubjectMode,
  withToolHeld,
  withToolImplementation,
} from "./composerPermissionSet";
import { AddMenu, CategoryRow, CommandGroupRow, ModePicker, SCRIPT_HINT, SHELL_HINT, SubjectRow, TOOL_ICONS, ToolRow, type AddOption } from "./permissionSetRows";

const NO_PARKED = {};

/** The key a program's fold is kept under, beside the section ids. */
export const programFold = (program: string): string => `program:${program}`;

/** What a tool's row in an add-menu says: its label, its sentence, its glyph. */
function toolOption(name: string): AddOption {
  const spec = TOOL_SPEC_BY_NAME.get(name);
  return {
    subject: name,
    label: spec?.label ?? name,
    hint: name === SHELL_TOOL ? SHELL_HINT : spec?.unserved === true ? `${spec.hint} · not served yet` : spec?.hint,
    icon: TOOL_ICONS[name] ?? "tool",
  };
}

const SCRIPT_OPTION: AddOption = { subject: SCRIPT_SUBJECT, label: "script", hint: SCRIPT_HINT, icon: "script" };

/** The sections a permission set opens on: the ones that hold a line. An empty one is a heading and a count of nothing. */
export function openSectionsOf(permissionSet: PermissionSet): string[] {
  return TOOL_CATEGORIES.filter((category) => sectionCountOf(permissionSet, category.id) > 0).map((category) => category.id);
}

export interface PermissionSetCardProps {
  permissionSet: PermissionSet;
  /** Every tool a line can be written for, with what each agent calls its own. */
  tools: readonly ToolChoice[];
  /** The next permission set, whole. Absent with `readOnly`. */
  onChange?: ((next: PermissionSet) => void) | undefined;
  /** What ships, read: the same rows, no minus, no add lines, nothing that opens. */
  readOnly?: boolean | undefined;
  /** Which folds are open — section ids and {@link programFold} keys. Absent ⇒ the card keeps its own. */
  folds?: ReadonlySet<string> | undefined;
  onFold?: ((id: string, open: boolean) => void) | undefined;
  /** An add-menu drawn open from the first render, by its fold key — for a still picture. */
  startAdding?: string | undefined;
  /** A tool line's mode menu drawn open from the first render — on its words or on the function form — for a still picture. */
  startMode?: { subject: string; open: "menu" | "function" } | undefined;
  /** The configured MCP servers, as the tools probe last found them — the MCP section's groups (`mcpBucket.tsx`). */
  mcp?: readonly McpServerStatus[] | undefined;
}

export function PermissionSetCard({ permissionSet, tools, onChange, readOnly, folds, onFold, startAdding, startMode, mcp }: PermissionSetCardProps): JSX.Element {
  const [own, setOwn] = useState<ReadonlySet<string>>(() => new Set(openSectionsOf(permissionSet)));
  const open = folds ?? own;
  const toggle = (id: string, to?: boolean): void => {
    const next = to ?? !open.has(id);
    if (onFold !== undefined) onFold(id, next);
    else setOwn((was) => new Set(next ? [...was, id] : [...was].filter((one) => one !== id)));
  };
  const locked = readOnly === true || onChange === undefined;
  const write = (next: PermissionSet): void => onChange?.(next);
  const offered = tools.map((tool) => tool.name);

  return (
    <div className={`cx-cats${locked ? " set-readonly" : ""}`}>
      {TOOL_CATEGORIES.map((category) => {
        // MCP: one group per configured server — its own line, and a line per tool it names.
        if (category.id === "mcp") {
          return (
            <McpBucket
              key={category.id}
              category={category}
              permissionSet={permissionSet}
              servers={mcp}
              locked={locked}
              write={write}
              open={open}
              toggle={toggle}
              startAdding={startAdding}
            />
          );
        }
        const inCategory = tools.filter((tool) => TOOL_SPEC_BY_NAME.get(tool.name)?.category === category.id);
        if (inCategory.length === 0) {
          return (
            <div key={category.id} className="cx-cat cx-cat-empty">
              <div className="cx-cat-head">
                <span className="cx-opt-text">
                  <span className="cx-opt-name ellip">{category.label}</span>
                  <span className="cx-opt-hint ellip">nothing here</span>
                </span>
              </div>
            </div>
          );
        }
        const held = inCategory.filter((tool) => holdsTool(permissionSet, tool.name));
        const groups = category.id === "execution" ? commandGroupsOf(permissionSet) : [];
        const script = category.id === "execution" && Object.hasOwn(permissionSet.entries, SCRIPT_SUBJECT);
        // Read-only, a section that holds nothing has nothing under it to fold over: what ships says
        // nothing about Web, and a chevron that opens onto an empty box says less.
        if (locked && held.length === 0 && groups.length === 0 && !script) return null;
        return (
          <CategoryRow
            key={category.id}
            category={category}
            granted={sectionCountOf(permissionSet, category.id)}
            total={inCategory.length}
            mode={undefined}
            open={open.has(category.id)}
            onOpen={() => toggle(category.id)}
          >
            {held.map((tool) => (
              <ToolRow
                key={tool.name}
                held
                tool={tool}
                spec={TOOL_SPEC_BY_NAME.get(tool.name)}
                granted
                mode={toolModeOf(permissionSet, NO_PARKED, tool.name)}
                impl={toolImplementationOf(permissionSet, NO_PARKED, tool.name)}
                readOnly={locked}
                onRemove={locked ? undefined : () => write(withToolHeld(permissionSet, NO_PARKED, tool.name, false))}
                onMode={(next) => write(withSubjectMode(permissionSet, tool.name, next))}
                onImpl={(next) => write(withToolImplementation(permissionSet, tool.name, next))}
                modeOpen={startMode?.subject === tool.name ? startMode.open : undefined}
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
                    line
                    subject={sub.subject}
                    held
                    mode={sub.mode}
                    readOnly={locked}
                    onRemove={locked ? undefined : () => write(withoutSubject(permissionSet, sub.subject))}
                    onMode={(next) => write(withSubjectMode(permissionSet, sub.subject, next))}
                  />
                ))}
                {locked ? null : (
                  <AddMenu
                    label={`add a ${group.program} subcommand`}
                    startOpen={startAdding === programFold(group.program)}
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
            {script ? (
              <SubjectRow
                line
                subject={SCRIPT_SUBJECT}
                hint={SCRIPT_HINT}
                held
                mode={permissionSet.entries[SCRIPT_SUBJECT]?.mode ?? MODE_WHEN_UNSET}
                readOnly={locked}
                onRemove={locked ? undefined : () => write(withoutSubject(permissionSet, SCRIPT_SUBJECT))}
                onMode={(next) => write(withSubjectMode(permissionSet, SCRIPT_SUBJECT, next))}
              />
            ) : null}
            {locked ? null : category.id === "execution" ? (
              <AddMenu
                label="add a command, the shell, or script"
                startOpen={startAdding === category.id}
                options={[
                  ...addableTools(permissionSet, category.id, offered).map(toolOption),
                  ...(addableScript(permissionSet) ? [SCRIPT_OPTION] : []),
                  ...suggestedPrograms(permissionSet).map((program) => ({
                    subject: program,
                    label: program,
                    hint: `every ${program} command — then name the ones that differ`,
                    icon: "terminal" as const,
                    mono: true,
                  })),
                ]}
                onPick={(subject) => {
                  if (subject === SCRIPT_SUBJECT) write(withSubject(permissionSet, SCRIPT_SUBJECT, MODE_WHEN_UNSET));
                  else if (TOOL_SPEC_BY_NAME.has(subject)) write(withToolHeld(permissionSet, NO_PARKED, subject, true));
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
                    // Open the group it landed in, so the line that was just added is on screen.
                    toggle(programFold(named.subject.split(" ")[0]!), true);
                    return undefined;
                  },
                }}
              />
            ) : (
              <AddMenu
                label="add a tool"
                startOpen={startAdding === category.id}
                options={addableTools(permissionSet, category.id, offered).map(toolOption)}
                onPick={(subject) => write(withToolHeld(permissionSet, NO_PARKED, subject, true))}
              />
            )}
          </CategoryRow>
        );
      })}

      <div className="cx-cat cx-cat-other">
        <div className="cx-cat-head">
          <span className="cx-opt-text">
            <span className="cx-opt-name ellip">Other</span>
            <span className="cx-opt-hint ellip">anything not listed above — an agent's own tools with no equal here included</span>
          </span>
          <ModePicker mode={permissionSet.other ?? MODE_WHEN_UNSET} title="Anything this permission set has no line for" readOnly={locked} onMode={(next) => write(withOther(permissionSet, next))} />
        </div>
      </div>
    </div>
  );
}

export interface PermissionSetLinesProps {
  /**
   * The lines, as a permission set. `other` is a line here like any other — present only when written —
   * which is why it arrives beside the permission set rather than inside it: a `Permission set` cannot say whether
   * its `other` was written or is merely what an unset one reads as.
   */
  permissionSet: PermissionSet;
  tools: readonly ToolChoice[];
  onChange?: ((next: PermissionSet) => void) | undefined;
  readOnly?: boolean | undefined;
  /** Said under every line's name: what these lines ARE, in this host. */
  note: string;
  addLabel: string;
  startAdding?: boolean | undefined;
}

/**
 * The same rows, flat: a few lines with no sections — what a state writes over its permission set.
 *
 * Every line is held (that is what being listed means), so every line has its minus; one last line
 * adds a tool, `script`, `other`, or a command that is typed.
 */
export function PermissionSetLines({ permissionSet, tools, onChange, readOnly, note, addLabel, startAdding }: PermissionSetLinesProps): JSX.Element {
  const locked = readOnly === true || onChange === undefined;
  const write = (next: PermissionSet): void => onChange?.(next);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const clearOther = (): void => {
    const { other: _gone, ...rest } = permissionSet;
    write(rest);
  };
  return (
    <div className={`set-card${locked ? " set-readonly" : ""}`}>
      <div className="cx-cat-body set-flat">
        {Object.entries(permissionSet.entries).map(([subject, entry]) =>
          entry.kind === "tool" ? (
            <ToolRow
              key={subject}
              held
              note={note}
              tool={byName.get(subject) ?? { name: subject }}
              spec={TOOL_SPEC_BY_NAME.get(subject)}
              granted
              mode={entry.mode ?? MODE_WHEN_UNSET}
              impl={entry.implementation ?? "app"}
              readOnly={locked}
              onRemove={locked ? undefined : () => write(withoutSubject(permissionSet, subject))}
              onMode={(next) => write(withSubjectMode(permissionSet, subject, next))}
              onImpl={(next) => write(withToolImplementation(permissionSet, subject, next))}
            />
          ) : (
            <SubjectRow
              key={subject}
              line
              subject={subject}
              hint={note}
              held
              mode={entry.mode ?? MODE_WHEN_UNSET}
              readOnly={locked}
              onRemove={locked ? undefined : () => write(withoutSubject(permissionSet, subject))}
              onMode={(next) => write(withSubjectMode(permissionSet, subject, next))}
            />
          ),
        )}
        {permissionSet.other !== undefined ? (
          <SubjectRow
            line
            subject={OTHER_SUBJECT}
            hint="anything no line names"
            held
            mode={permissionSet.other}
            readOnly={locked}
            onRemove={locked ? undefined : clearOther}
            onMode={(next) => write(withOther(permissionSet, next))}
          />
        ) : null}
        {locked ? null : (
          <AddMenu
            label={addLabel}
            startOpen={startAdding}
            options={[
              ...tools.filter((tool) => !Object.hasOwn(permissionSet.entries, tool.name)).map((tool) => toolOption(tool.name)),
              ...(addableScript(permissionSet) ? [SCRIPT_OPTION] : []),
              ...(permissionSet.other === undefined ? [{ subject: OTHER_SUBJECT, label: "other", hint: "anything no line names", icon: "shield" as const }] : []),
            ]}
            onPick={(subject) => {
              if (subject === OTHER_SUBJECT) write(withOther(permissionSet, MODE_WHEN_UNSET));
              else if (subject === SCRIPT_SUBJECT) write(withSubject(permissionSet, SCRIPT_SUBJECT, MODE_WHEN_UNSET));
              else write(withToolHeld(permissionSet, NO_PARKED, subject, true));
            }}
            typed={{
              label: "add a command",
              example: "git commit",
              onAdd: (typed) => {
                const named = commandSubjectOf(typed);
                if ("problem" in named) return named.problem;
                write(withCommand(permissionSet, named.subject));
                return undefined;
              },
            }}
          />
        )}
      </div>
    </div>
  );
}
