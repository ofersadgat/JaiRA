/**
 * What `PermissionSetLines` (`packages/universal/src/components/workflow/ToolsField.tsx`) decides — the
 * lines a state writes over its permission set, what its one add line offers, and what each pick writes.
 */
import { MODE_WHEN_UNSET, OTHER_SUBJECT, SCRIPT_SUBJECT, SHELL_TOOL, TOOL_SPEC_BY_NAME, type PermissionSet, type ToolChoice } from "@jaira/shared/browser";
import { addableScript, commandSubjectOf, withCommand, withOther, withSubject, withToolHeld } from "./composerPermissionSet";
import { SCRIPT_HINT, SHELL_HINT, TOOL_ICONS } from "./permissionSetWords";

/** One thing the add line offers (an `AddOption`, as `AddMenu` takes it). */
export interface LineOption {
  subject: string;
  label: string;
  hint?: string | undefined;
  icon?: string | undefined;
  mono?: boolean | undefined;
}

const NO_PARKED = {};

/** A tool as the add menu names it. */
export function toolLineOption(name: string): LineOption {
  const spec = TOOL_SPEC_BY_NAME.get(name);
  return {
    subject: name,
    label: spec?.label ?? name,
    hint: name === SHELL_TOOL ? SHELL_HINT : spec?.unserved === true ? `${spec.hint} · not served yet` : spec?.hint,
    icon: TOOL_ICONS[name] ?? "tool",
  };
}

export const SCRIPT_LINE_OPTION: LineOption = { subject: SCRIPT_SUBJECT, label: "script", hint: SCRIPT_HINT, icon: "script" };

/** What the one add line offers: the tools not yet written, `script`, and `other` while it is unwritten. */
export function lineOptionsOf(permissionSet: PermissionSet, tools: readonly ToolChoice[]): LineOption[] {
  return [
    ...tools.filter((tool) => !Object.hasOwn(permissionSet.entries, tool.name)).map((tool) => toolLineOption(tool.name)),
    ...(addableScript(permissionSet) ? [SCRIPT_LINE_OPTION] : []),
    ...(permissionSet.other === undefined ? [{ subject: OTHER_SUBJECT, label: "other", hint: "anything no line names", icon: "shield" }] : []),
  ];
}

/** What picking one writes. */
export function withLinePicked(permissionSet: PermissionSet, subject: string): PermissionSet {
  if (subject === OTHER_SUBJECT) return withOther(permissionSet, MODE_WHEN_UNSET);
  if (subject === SCRIPT_SUBJECT) return withSubject(permissionSet, SCRIPT_SUBJECT, MODE_WHEN_UNSET);
  return withToolHeld(permissionSet, NO_PARKED, subject, true);
}

/** A typed command as a line — or what is wrong with it. */
export function withLineTyped(permissionSet: PermissionSet, typed: string): { next: PermissionSet } | { problem: string } {
  const named = commandSubjectOf(typed);
  if ("problem" in named) return { problem: named.problem };
  return { next: withCommand(permissionSet, named.subject) };
}

/** `other`, written, taken back out. */
export function withoutOther(permissionSet: PermissionSet): PermissionSet {
  const { other: _gone, ...rest } = permissionSet;
  return rest;
}

/** The typed command's line, as the add menu offers it. */
export const TYPED_LINE = { label: "add a command", example: "git commit" } as const;
