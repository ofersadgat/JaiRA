import { useState, type JSX, type ReactNode } from "react";
import { View } from "@tamagui/core";
import {
  holdsTool,
  MODE_WHEN_UNSET,
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
import { SCRIPT_HINT, SHELL_HINT, TOOL_ICONS, modeMeta } from "@jaira/ui/permissionSetWords";
import { Press, Txt, edge, useHover } from "../../primitives";
import { useTokens } from "../../tokens";
import type { IconName } from "../panel/Icon";
import { AddLine, ChipIcon, CommandGroupRow, Count, FoldBody, ImplPicker, ModePicker, OptText } from "../settings/permissions/rows";
import { CardHint } from "./ComposerCards";

/**
 * The composer's Tools card: the categories — each a fold with the mode its tools share, its tools
 * ticked in or out with their mode and implementation, Execution's commands under their program,
 * `script`, the line that adds a command — and `Other`. Every edit is `composerPermissionSet.ts`'s;
 * the rows are `settings/permissions/rows.tsx`'s parts where they are the same, and a tick where the
 * composer's line is one.
 *
 *   the categories     column
 *   a category         a --line above (not the first); its head row, centred, gap 4
 *   its fold           row, gap 6, grows, padding 5 4, radius 5 (hovered --panel-2): › 10 wide (turned a
 *                      quarter open), the words, the count
 *   empty, and Other   the head padded 5 0 5 20; empty: its name --tok-hint
 *   a tool             row, centred, gap 4, radius 7; hovered --text 7%; ticked --accent 13%
 *   its tick           row, gap 8, padding 5 7, grows; ✓ 10 wide (--ok); its words --dim (ticked or
 *                      hovered --text)
 */
export function ToolsBody({
  offered,
  map,
  parked,
  cliRoute,
  write,
  setParked,
  initiallyOpen = [],
}: {
  offered: readonly ToolChoice[];
  map: PermissionSet;
  parked: Parked;
  cliRoute: string | undefined;
  write: (next: PermissionSet, nextParked?: Parked) => void;
  setParked: (next: Parked) => void;
  initiallyOpen?: readonly string[];
}): JSX.Element {
  const [openCats, setOpenCats] = useState<ReadonlySet<string>>(new Set(initiallyOpen));
  const toggleCat = (id: string): void =>
    setOpenCats((was) => {
      const next = new Set(was);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <>
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
                  onGrant={() => write(withToolHeld(map, parked, tool.name, !holdsTool(map, tool.name)))}
                  onMode={(next) => (holdsTool(map, tool.name) ? write(withSubjectMode(map, tool.name, next)) : setParked({ ...parked, [tool.name]: { ...parked[tool.name], mode: next } }))}
                  onImpl={(next) => (holdsTool(map, tool.name) ? write(withToolImplementation(map, tool.name, next)) : setParked({ ...parked, [tool.name]: { ...parked[tool.name], implementation: next } }))}
                />
              ))}
              {category.id === "execution" ? (
                <>
                  {commandGroupsOf(map).map((group) => (
                    <CommandGroupRow key={group.program} group={group} permissionSet={map} open={openCats.has(`program:${group.program}`)} onOpen={() => toggleCat(`program:${group.program}`)} onMode={(next) => write(withSubject(map, group.program, next))}>
                      {group.subs.map((sub) => (
                        <TickedSubject key={sub.subject} subject={sub.subject} held mode={sub.mode} onHeld={() => write(withoutSubject(map, sub.subject))} onMode={(next) => write(withSubjectMode(map, sub.subject, next))} />
                      ))}
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
                    </CommandGroupRow>
                  ))}
                  <TickedSubject
                    subject={SCRIPT_SUBJECT}
                    hint={SCRIPT_HINT}
                    held={Object.hasOwn(map.entries, SCRIPT_SUBJECT)}
                    mode={map.entries[SCRIPT_SUBJECT]?.mode ?? parked[SCRIPT_SUBJECT]?.mode ?? MODE_WHEN_UNSET}
                    onHeld={() => write(Object.hasOwn(map.entries, SCRIPT_SUBJECT) ? withoutSubject(map, SCRIPT_SUBJECT) : withSubject(map, SCRIPT_SUBJECT, parked[SCRIPT_SUBJECT]?.mode ?? MODE_WHEN_UNSET))}
                    onMode={(next) => (Object.hasOwn(map.entries, SCRIPT_SUBJECT) ? write(withSubjectMode(map, SCRIPT_SUBJECT, next)) : setParked({ ...parked, [SCRIPT_SUBJECT]: { mode: next } }))}
                  />
                  <AddLine
                    label="add a command"
                    example="git status"
                    onAdd={(typed) => {
                      const named = commandSubjectOf(typed);
                      if ("problem" in named) return named.problem;
                      write(withCommand(map, named.subject));
                      setOpenCats((was) => new Set([...was, `program:${named.subject.split(" ")[0]!}`]));
                      return undefined;
                    }}
                  />
                </>
              ) : null}
            </CxCategory>
          );
        })}
        <PlainCat
          first={false}
          name="Other"
          hint="anything not listed above — an agent's own tools with no equal here included"
          control={<ModePicker head mode={map.other ?? MODE_WHEN_UNSET} title="Anything this project has no name for" onMode={(next) => write(withOther(map, next))} />}
        />
      </View>
      <CardHint>{offered.length === 0 ? "This project registers no tools." : "Ticking a tool offers it; the mode beside it is what happens when it is called. A shell line is taken apart, and each part answers to its own line here."}</CardHint>
    </>
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
function CxCategory({ first, category, granted, mode, open, onOpen, onMode, children }: { first: boolean; category: ToolCategory; granted: number; mode: PermissionSetMode | undefined; open: boolean; onOpen: () => void; onMode: (next: PermissionSetMode) => void; children: ReactNode }): JSX.Element {
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
        <ModePicker head mode={mode} title={`${category.label}: sets every tool under it`} onMode={onMode} />
      </View>
      {open ? <FoldBody>{children}</FoldBody> : null}
    </View>
  );
}

/** A tool's row with its tick: a line of the map the composer offers or not. */
function TickLine({ on, onPress, icon, name, hint, title, trail }: { on: boolean; onPress: () => void; icon: IconName; name: string; hint: string; title: string; trail: ReactNode }): JSX.Element {
  const t = useTokens();
  const [hovered, hover] = useHover();
  return (
    <View flexDirection="row" alignItems="center" gap={4} borderRadius={7} position="relative" backgroundColor={(on ? t.mix(t.v("accent"), 13, "transparent") : hovered ? t.mix(t.v("text"), 7, "transparent") : "transparent") as never} {...hover}>
      <Press onPress={onPress} title={title} flexGrow={1} flexShrink={1} flexBasis="auto" minWidth={0} flexDirection="row" alignItems="center" gap={8} paddingVertical={5} paddingHorizontal={7} borderRadius={7}>
        {({ hovered: over }) => (
          <>
            <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "ok" }} width={10} flexShrink={0}>
              {on ? "✓" : ""}
            </Txt>
            <ChipIcon name={icon} />
            <OptText name={name} hint={hint} nameColor={on || over ? "text" : "dim"} />
          </>
        )}
      </Press>
      {trail}
    </View>
  );
}

/** `ToolRow`, ticked: the tool's tick, its words, the implementation (where the answering agent has its own) and the mode. */
function TickedTool({ tool, spec, granted, mode, impl, cliRoute, onGrant, onMode, onImpl }: { tool: ToolChoice; spec?: ToolSpec | undefined; granted: boolean; mode: PermissionSetMode; impl: ToolImplementation; cliRoute: string | undefined; onGrant: () => void; onMode: (next: PermissionSetMode) => void; onImpl: (next: ToolImplementation) => void }): JSX.Element {
  const native = cliRoute !== undefined ? tool.natives?.[cliRoute] : undefined;
  const hint = tool.name === SHELL_TOOL ? SHELL_HINT : spec?.unserved === true ? `${spec.hint} · not served yet` : (spec?.hint ?? tool.name);
  return (
    <TickLine
      on={granted}
      onPress={onGrant}
      icon={(TOOL_ICONS[tool.name] ?? "tool") as IconName}
      name={spec?.label ?? tool.name}
      hint={hint}
      title={hint}
      trail={
        <>
          {native !== undefined ? <ImplPicker value={impl} native={native} onPick={onImpl} /> : null}
          <ModePicker mode={mode} title={`${tool.name}: ${modeMeta(mode).hint}`} onMode={onMode} />
        </>
      }
    />
  );
}

/** `SubjectRow`, ticked: a command the map names (or `script`), in or out, and its mode. */
function TickedSubject({ subject, hint, held, mode, onHeld, onMode }: { subject: string; hint?: string; held: boolean; mode: PermissionSetMode; onHeld: () => void; onMode: (next: PermissionSetMode) => void }): JSX.Element {
  const script = subject === SCRIPT_SUBJECT;
  return <TickLine on={held} onPress={onHeld} icon={script ? "script" : "terminal"} name={subject} hint={hint ?? ""} title={hint ?? subject} trail={<ModePicker mode={mode} title={`${subject}: ${modeMeta(mode).hint}`} onMode={onMode} />} />;
}
