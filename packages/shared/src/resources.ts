/**
 * RESOURCES on a permission set line (decision 0023 §3.1, amended 2026-11-23): a line can decide by
 * several kinds of place at once, and a resource is answered by all of them.
 *
 * A System tool touches resources — a process, a window, a service, a package, a setting, the machine
 * itself — and each resource has a place of several kinds: a process has a program (`node`), an owner
 * (`session`) and a machine (`desk`). A line writes a rule map per kind:
 *
 *     "stop_process": {
 *       "owner":   { "session": "allow", "**": "ask" },
 *       "program": { "node": "allow", "**": "ask" },
 *       "**": "ask"
 *     }
 *
 * kept flat on the line's places as `owner=session`, `owner=**` and `node` — the tool's own kind (its
 * `ToolSpec.scope`) is written bare, as it always was. A resource is answered by the STRICTEST of its
 * kinds' answers: every kind must allow it (the person: "permissions are combined via intersection").
 * Within a kind, the most specific place that matches answers, as one map always did (§3.2–§3.4); a
 * kind nothing matches says nothing, and the line's own mode — its `**` — or the next line answers.
 *
 * A value nothing could read (`(pid 4242)`, a pointer's window) could be anything: every place of that
 * kind could answer for it, so it takes the strictest of them, and the line's own mode too.
 *
 * What the agent ASKED for — `list_processes`' `scope`, its `name` filter — never matches a permission:
 * it only narrows what the call touches. A list is judged row by row (`ToolSpec.lists`).
 */
import { modeStrictness, type PermissionSetMode } from "./operationVocabulary";
import {
  OWNER_ALIAS,
  PLACE_ANYWHERE,
  callPlacesOf,
  focusedWindowOf,
  idsOf,
  inputActionsOf,
  isUnreadPlace,
  areaRank,
  resolvePlace,
  unknownProgramPlace,
  type MachineFacts,
  type PlaceOptions,
  type ProcessFacts,
} from "./places";
import { PLACE_KINDS, type PlaceKind, type ToolSpec } from "./toolVocabulary";

/** What joins a kind to its place on a line's places: `owner=session`. */
export const KIND_JOIN = "=";

/** A place of another kind than the line's own, as a line's places keep it: `owner=session`. */
export function kindedPlace(kind: PlaceKind, place: string): string {
  return `${kind}${KIND_JOIN}${place}`;
}

/**
 * The kind and place a key of a line's places names: `owner=session` is the owner `session`, where the
 * tool's resources have owners; anything else — a bare place, or one whose prefix is no kind of the tool
 * (a path `a=b`) — is the tool's own kind. `program=node`, the tool's own kind spelled out, is `node`.
 */
export function placeOfKey(key: string, spec: Pick<ToolSpec, "scope" | "dimensions"> | undefined): { kind: PlaceKind | undefined; place: string } {
  const at = key.indexOf(KIND_JOIN);
  if (at > 0) {
    const kind = key.slice(0, at).trim() as PlaceKind;
    if ((spec?.dimensions ?? []).includes(kind) || kind === spec?.scope) return { kind, place: key.slice(at + 1).trim() };
  }
  return { kind: spec?.scope, place: key };
}

/** Whether a key names a kind at all (`owner=…`), whatever the tool — what the linter checks a line's against. */
export function kindOfKey(key: string): PlaceKind | undefined {
  const at = key.indexOf(KIND_JOIN);
  if (at <= 0) return undefined;
  const kind = key.slice(0, at).trim();
  return (PLACE_KINDS as readonly string[]).includes(kind) ? (kind as PlaceKind) : undefined;
}

/** A line's places split by kind, each kind's map keyed by its own places (`session`, `**`). */
export function placesByKind<M extends PermissionSetMode>(places: Readonly<Record<string, M>>, spec: Pick<ToolSpec, "scope" | "dimensions"> | undefined): Map<PlaceKind, Record<string, M>> {
  const out = new Map<PlaceKind, Record<string, M>>();
  for (const [key, decision] of Object.entries(places)) {
    const { kind, place } = placeOfKey(key, spec);
    if (kind === undefined) continue;
    const map = out.get(kind) ?? {};
    map[place] = decision;
    out.set(kind, map);
  }
  return out;
}

/** A resource's places, by kind: a process's `{ program: ["node"], owner: ["session"], machine: ["desk"] }`. */
export type ResourcePlaces = Partial<Record<PlaceKind, readonly string[]>>;

/** What one line says about one resource, and which kind and place said it. */
export interface ResourceAnswer<M extends PermissionSetMode = PermissionSetMode> {
  /** The strictest answer any kind gave; `undefined` when none did. */
  decision?: M | undefined;
  kind?: PlaceKind | undefined;
  place?: string | undefined;
  /**
   * True when some kind the line decides by had a value no place of it matched, or none at all, or one
   * nothing could read: the line's own mode (its `**`), or the next line, answers for that part too.
   */
  unmatched: boolean;
}

/**
 * What a line's places say about one resource: for each kind the line decides by, the most specific of
 * its places that matches each of the resource's values of that kind (a value nothing could read, every
 * place of the kind); the strictest of all of them. See the module header.
 */
export function resolveResource<M extends PermissionSetMode>(
  places: Readonly<Record<string, M>>,
  spec: Pick<ToolSpec, "scope" | "dimensions"> | undefined,
  resource: ResourcePlaces,
  options: PlaceOptions = {},
): ResourceAnswer<M> {
  const out: ResourceAnswer<M> = { unmatched: false };
  const consider = (decision: M, kind: PlaceKind, place: string): void => {
    if (out.decision === undefined || modeStrictness(decision) > modeStrictness(out.decision)) Object.assign(out, { decision, kind, place });
  };
  for (const [kind, map] of placesByKind(places, spec)) {
    const values = resource[kind];
    // A kind the resource does not have at all (`open_app` launching opens no file) says nothing of it;
    // one it has, with no value read, is unmatched.
    if (values === undefined) continue;
    if (values.length === 0) {
      out.unmatched = true;
      continue;
    }
    for (const value of values) {
      if (isUnreadPlace(value)) {
        for (const [place, decision] of Object.entries(map)) consider(decision, kind, place);
        out.unmatched = true;
        continue;
      }
      // A part of the machine read whole (`environment/**`): every place under it, and every one holding it.
      if (kind === "area" && value.endsWith("/**")) {
        const under = value.slice(0, -3);
        const held = resolvePlace(map, kind, under, options);
        if (held !== undefined) consider(held.decision, kind, held.place);
        else out.unmatched = true;
        for (const [place, decision] of Object.entries(map)) if (areaRank(place, `${under}/x`) !== undefined || place.trim().toLowerCase().replace(/\\/g, "/").startsWith(`${under.toLowerCase()}/`)) consider(decision, kind, place);
        continue;
      }
      const match = resolvePlace(map, kind, value, options);
      if (match === undefined) out.unmatched = true;
      else consider(match.decision, kind, match.place);
    }
  }
  return out;
}

/** Whose a setting is (an OWNER place): the user's (`HKCU`, the user's variables) or the machine's. */
function settingOwners(tool: string, args: Record<string, unknown>): string[] {
  const text = (name: string): string | undefined => (typeof args[name] === "string" && (args[name] as string).trim() !== "" ? (args[name] as string).trim() : undefined);
  const area = text("area");
  if (area === "registry") {
    const key = text("key");
    if (key === undefined) return ["user", "system"];
    const hive = key.replace(/^registry::/i, "").split(/[\\/]+/)[0]!.replace(/:$/, "").toLowerCase();
    return hive === "hkcu" || hive === "hkey_current_user" ? ["user"] : ["system"];
  }
  if (area === "environment") return tool === "write_settings" ? [text("scope") === "machine" ? "system" : "user"] : ["user", "system"];
  if (area === "defaults") return ["user"];
  if (area === "time" || area === "time_zone") return ["system"];
  return [unknownProgramPlace("owner")];
}

/** The programs and owners of what a call reaches through the machine: the processes, windows and keys it names. */
function reached(spec: ToolSpec, args: Record<string, unknown>, facts: MachineFacts | undefined): { program: string[]; owner: string[] } | undefined {
  const subjects: Array<{ facts: ProcessFacts | undefined; unread: string }> = [];
  for (const pid of idsOf(args, spec.pidArgs)) subjects.push({ facts: facts?.process?.(pid), unread: unknownProgramPlace(pid) });
  for (const id of idsOf(args, spec.windowArgs)) subjects.push({ facts: facts?.window?.(id), unread: unknownProgramPlace(`window ${id}`) });
  // Keys go to the window that has the keyboard; a pointer to whichever window is under it, which could
  // be any on the screen.
  const input = (spec.inputArgs ?? []).map((name) => inputActionsOf(args[name]));
  const onScreen = (): void => {
    const ids = facts?.onScreen?.();
    if (ids === undefined) subjects.push({ facts: undefined, unread: unknownProgramPlace("a window on the screen") });
    else for (const id of ids) subjects.push({ facts: facts?.window?.(id), unread: unknownProgramPlace(`window ${id}`) });
  };
  if (input.some((i) => i.keys)) subjects.push({ facts: focusedWindowOf(facts), unread: unknownProgramPlace("focused window") });
  if (input.some((i) => i.pointer)) onScreen();
  // A picture of a whole display shows every window on it.
  if (spec.name === "screenshot" && idsOf(args, spec.windowArgs).length === 0) onScreen();
  if (subjects.length === 0) return undefined;
  return {
    program: subjects.map((s) => (s.facts?.program !== undefined && s.facts.program !== "" ? s.facts.program : s.unread)),
    // One value per process: its owner's names are one owner's (`user;account:ofer`).
    owner: subjects.map((s) => (s.facts?.owner !== undefined && s.facts.owner.length > 0 ? s.facts.owner.join(OWNER_ALIAS) : s.unread)),
  };
}

/** What a call does, as ACTION places. */
function actionsOf(tool: string, args: Record<string, unknown>, spec: ToolSpec): string[] {
  const text = (name: string): string | undefined => (typeof args[name] === "string" && (args[name] as string).trim() !== "" ? (args[name] as string).trim() : undefined);
  switch (tool) {
    case "stop_process":
      return [text("signal") === "interrupt" ? "interrupt" : "stop", ...(args["force"] === true ? ["force"] : []), ...(args["tree"] === true ? ["tree"] : [])];
    case "write_settings":
      return [args["delete"] === true ? "delete" : "set"];
    case "control_input": {
      const input = (spec.inputArgs ?? []).map((name) => inputActionsOf(args[name]));
      return [...(input.some((i) => i.keys) ? ["keys"] : []), ...(input.some((i) => i.pointer) ? ["pointer"] : [])];
    }
    default: {
      const action = text("action");
      return [action ?? unknownProgramPlace("action")];
    }
  }
}

/**
 * The places, of every kind, one direct call to a standard tool is about: its own kind's as
 * {@link callPlacesOf} reads them, and each of its {@link ToolSpec.dimensions}' — the owners and the
 * machine of what it reaches, what it does, the manager that does it, the file or link it opens. What
 * nothing could read is {@link unknownProgramPlace}. A tool that LISTS is about the rows it shows, which
 * the tool judges; its call names none here.
 */
export function resourceOfCall(spec: ToolSpec | undefined, input: unknown, root?: string, options: PlaceOptions = {}): ResourcePlaces {
  if (spec?.scope === undefined) return {};
  const args: Record<string, unknown> = input !== null && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const out: ResourcePlaces = {};
  const facts = options.facts;
  const through = spec.scope === "program" && spec.lists !== true ? reached(spec, args, facts) : undefined;
  // The tool's own kind.
  if (spec.scope === "machine") out.machine = [facts?.machine?.() ?? unknownProgramPlace("machine")];
  else if (spec.scope === "action") out.action = actionsOf(spec.name, args, spec);
  else if (through !== undefined) out.program = [...callPlacesOf({ ...spec, pidArgs: [], windowArgs: [], inputArgs: [] }, args, root, options), ...through.program];
  // A file or a link opened in no named app opens in whatever app the machine picks.
  else if (spec.name === "open_app" && typeof args["target"] === "string" && callPlacesOf(spec, args, root, options).length === 0) out.program = [unknownProgramPlace("the app it opens in")];
  else if (spec.lists !== true) {
    const own = callPlacesOf(spec, args, root, options);
    if (own.length > 0) out[spec.scope] = own;
  }
  for (const kind of spec.dimensions ?? []) {
    switch (kind) {
      case "machine":
        out.machine = [facts?.machine?.() ?? unknownProgramPlace("machine")];
        break;
      case "owner":
        if (spec.scope === "area") out.owner = settingOwners(spec.name, args);
        else if (through !== undefined) out.owner = through.owner;
        // What `open_app` launches or opens is this session's.
        else if (spec.name === "open_app") out.owner = ["session"];
        break;
      case "action":
        out.action = actionsOf(spec.name, args, spec);
        break;
      case "manager": {
        const manager = typeof args["manager"] === "string" && args["manager"].trim() !== "" ? args["manager"].trim() : undefined;
        out.manager = [manager ?? unknownProgramPlace("the default manager")];
        break;
      }
      case "path":
      case "site": {
        const target = typeof args["target"] === "string" && args["target"].trim() !== "" ? args["target"].trim() : undefined;
        if (target === undefined) break;
        const link = /^[a-z][a-z0-9+.-]*:/i.test(target) && !/^[a-z]:[\\/]/i.test(target) && !/^file:/i.test(target);
        if (link === (kind === "site")) out[kind] = [target.replace(/^file:\/\//i, "")];
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/** Whether a line decides by places at all — and so whether a resource needs reading to answer it. */
export function decidesByPlaces(places: Readonly<Record<string, unknown>> | undefined): boolean {
  return places !== undefined && Object.keys(places).some((key) => key !== PLACE_ANYWHERE);
}
