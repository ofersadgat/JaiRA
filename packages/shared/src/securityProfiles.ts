/**
 * The security profiles JaiRA ships (`permission-sets/security/`): ordinary permission sets of lines a
 * person can read, copy and change — `guarded` refuses what destroys work, `standard` (over it) asks
 * before what leaves the machine, `strict` (over that) refuses it. A stack is meant as a base
 * (`base/allow-all`, `base/ask-all`, …), a security profile over it, and the project's own lines on top
 * (the person, 2026-11-25: "a base layer for allow/deny/ask, then a security layer, then a project
 * layer").
 *
 * Nothing JaiRA judges is a rule in code any more: what the built-in floor used to refuse or ask about
 * is these files' lines. The one place they are read without a stack naming them is
 * {@link LINES_NO_SET_JUDGES}: a line no permission set judges at all (a state that declares none, the
 * CLI's `run_command`) is judged by `base/allow-all` under `security/standard` — what the built-ins
 * were for it before.
 */
import allowAll from "../builtin/permission-sets/base/allow-all.json";
import guarded from "../builtin/permission-sets/security/guarded.json";
import standard from "../builtin/permission-sets/security/standard.json";
import strict from "../builtin/permission-sets/security/strict.json";
import { parsePermissionSet, resolvePermissionSetDecl, type PermissionSet, type PermissionSetIssue, type PermissionSetReader } from "./permissionSets";

/** The shipped profiles, by the reference a set names them with. */
export const SECURITY_PROFILES = {
  guarded: "$SYSTEM/permission-sets/security/guarded",
  standard: "$SYSTEM/permission-sets/security/standard",
  strict: "$SYSTEM/permission-sets/security/strict",
} as const;

const SHIPPED: Readonly<Record<string, unknown>> = {
  "$SYSTEM/permission-sets/base/allow-all": allowAll,
  [SECURITY_PROFILES.guarded]: guarded,
  [SECURITY_PROFILES.standard]: standard,
  [SECURITY_PROFILES.strict]: strict,
};

/** The shipped files, read from what was bundled — no disk, no layer of the person's in between. */
const readShipped: PermissionSetReader = (reference) => {
  const value = SHIPPED[reference];
  if (value === undefined) throw new Error(`'${reference}' is not a set JaiRA ships`);
  return { value, key: reference, from: reference };
};

/** A shipped stack, oldest layer first, as one set. */
export function shippedStack(references: readonly string[]): PermissionSet {
  const issues: PermissionSetIssue[] = [];
  const decl = resolvePermissionSetDecl({ layers: [...references] }, readShipped, "", issues);
  const broken = issues.find((issue) => issue.severity === "error");
  if (broken !== undefined || decl === undefined) throw new Error(`the shipped security profiles do not read: ${broken?.message ?? "nothing came back"}`);
  return parsePermissionSet(decl).permissionSet;
}

/** What a line no permission set judges answers to: `base/allow-all` under `security/standard`. */
export const LINES_NO_SET_JUDGES: PermissionSet = shippedStack(["$SYSTEM/permission-sets/base/allow-all", SECURITY_PROFILES.standard]);
