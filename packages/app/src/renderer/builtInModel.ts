/**
 * What the renderer says about the built-in layer (decision 0006) — the decisions `LayerBar`
 * (`WorkflowEditor.tsx`) draws: which chip a file wears and which layer buttons it offers. Plain
 * functions of plain data.
 */
import type { BuiltInStanding, WorkflowLayer, WritableLayer } from "@jaira/shared/browser";

/** One thing the top bar offers. `disabled` carries the reason, which is the button's tooltip. */
export interface LayerBarAction {
  /** `override-<layer>`: copy the shipped file into that layer and open the copy. */
  id: `override-${WritableLayer}` | "compare";
  label: string;
  title: string;
  disabled?: boolean;
  /**
   * Offered behind the bar's `Copy to…` menu rather than as a link of its own — every copy a built-in
   * offers is (2026-11-24: one menu, so the bar stays short enough for the tab toggle beside it).
   */
  more?: true;
}

/** Every layer a person owns, as the bar's `Copy to…` menu offers a copy into it — Shared and this project first. */
const COPY_LAYERS: ReadonlyArray<{ layer: WritableLayer; label: string; dir: string; project: boolean }> = [
  { layer: "base", label: "Shared", dir: "the shared root (~/.jaira)", project: false },
  { layer: "project", label: "This project", dir: "this project's .jaira/", project: true },
  { layer: "projectYou", label: "You in this project", dir: "~/.jaira/projects/…", project: true },
  { layer: "you", label: "Just you", dir: "~/.jaira/personal", project: false },
  { layer: "projectMachine", label: "This project on this machine", dir: ".jaira/local", project: true },
  { layer: "machine", label: "This machine", dir: "~/.jaira/machine", project: false },
];

/** The top bar's layer half: one chip, and the actions beside it. */
export interface LayerBarModel {
  chip: { text: string; tone: "plain" | "warn"; title: string };
  actions: LayerBarAction[];
}

/**
 * What the editor's top bar says about where a file came from, or `null` for a project file of a
 * state nothing else supplies — which is most files, and they say nothing.
 *
 * Three readings, in the order they are tested:
 *
 *  1. A SHIPPED file. "built in", and a copy into each layer a person owns behind one menu. A layer
 *     that already has its copy is offered disabled rather than hidden: "This project" greyed out with
 *     "that layer already has a copy" answers the question the item's absence would raise.
 *  2. A person's file whose id also ships. It "overrides built in", and what it overrides is one
 *     click away.
 *  3. A shared file of an id that does not ship: the warning the bar has always carried.
 */
export function layerBarOf(
  source: { layer: WorkflowLayer; builtIn?: BuiltInStanding | undefined },
  hasProject: boolean,
  /** The editor copies on the first edit — see `WorkflowEditor`'s copy-on-edit. */
  copyOnEdit = false,
): LayerBarModel | null {
  const standing = source.builtIn;
  if (source.layer === "system") {
    const has = (layer: WorkflowLayer): boolean => standing?.layers.includes(layer) === true;
    // Short on purpose (the person, 2026-11-24: the bar was "overly verbose, unreadable, and when the
    // column shrinks, it completely hides the form/json/graph toggle"): the chip says only "built in", its
    // title says the rest, and every copy is one menu — `Copy to…` — rather than a row of links.
    return {
      chip: {
        text: "built in",
        tone: "plain",
        title: copyOnEdit
          ? "This ships with JaiRA. Your first change asks where to copy it — Shared, this project, just you… — and that copy, with the change in it, is what runs there."
          : has("base")
            ? "Shared already has a copy of this state, and it is the one that runs — edit that."
            : "This ships with JaiRA and cannot be edited here. Copy it to change what runs.",
      },
      // The same rules for each: a layer that already has its copy is offered disabled, and a project's with none open.
      actions: COPY_LAYERS.map(({ layer, label, dir, project }): LayerBarAction => ({
        id: `override-${layer}`,
        label,
        title:
          project && !hasProject
            ? "Open a project to copy this state into one of its layers"
            : has(layer)
              ? "That layer already has a copy of this state, and it is the one that loads there"
              : `Copy this file into ${dir} and open the copy`,
        ...((project && !hasProject) || has(layer) ? { disabled: true } : {}),
        more: true,
      })),
    };
  }
  if (standing !== undefined) {
    const actions: LayerBarAction[] = [
      { id: "compare", label: "Compare with what ships", title: "Show this file beside the built-in one it overrides" },
    ];
    return {
      chip: {
        text: "overrides built in",
        tone: WIDE.has(source.layer) ? "warn" : "plain",
        title: source.layer === "project" ? "This project's copy of a state JaiRA ships. It runs here instead of the built-in one." : `${COPY_OF[source.layer]} of a state JaiRA ships. ${READ_BY[source.layer]}`,
      },
      actions,
    };
  }
  if (source.layer !== "project") {
    return {
      chip: { text: CHIP[source.layer], tone: WIDE.has(source.layer) ? "warn" : "plain", title: `Editing ${COPY_OF[source.layer].toLowerCase()}. ${READ_BY[source.layer]}` },
      actions: [],
    };
  }
  return null;
}

/** The layers whose file is read by more than one project — what an edit there reaches is wider than this one. */
const WIDE: ReadonlySet<WorkflowLayer> = new Set(["base", "machine", "you"]);

/** A person's layer's chip, for a file whose id does not ship (decision 0023, amended 2026-11-18). */
const CHIP: Readonly<Record<Exclude<WorkflowLayer, "project" | "system">, string>> = {
  base: "shared copy",
  machine: "this machine's copy",
  projectMachine: "this project on this machine",
  you: "your copy",
  projectYou: "your copy in this project",
};

/** "The shared copy", as a sentence's subject. */
const COPY_OF: Readonly<Record<Exclude<WorkflowLayer, "project" | "system">, string>> = {
  base: "The shared copy",
  machine: "This machine's copy",
  projectMachine: "This project's copy on this machine",
  you: "Your own copy",
  projectYou: "Your own copy for this project",
};

/** Who reads a person's layer's file — what a change there reaches. */
const READ_BY: Readonly<Record<Exclude<WorkflowLayer, "project" | "system">, string>> = {
  base: "Every project that has not overridden this state will see the change.",
  machine: "Every project on this machine that has not its own copy will see the change.",
  projectMachine: "Only this project, on this machine, runs it.",
  you: "Every project of yours that has not its own copy for you will see the change.",
  projectYou: "Only this project, for you, runs it.",
};

/** Which layer an override action copies into. */
export function overrideTarget(id: LayerBarAction["id"]): WritableLayer | null {
  return id.startsWith("override-") ? (id.slice("override-".length) as WritableLayer) : null;
}

/** What an action's button says: the compare button reads as the way back while the comparison is up. */
export function layerActionLabel(action: LayerBarAction, comparing: boolean): string {
  return action.id === "compare" && comparing ? "Back to the file" : action.label;
}

/** One place a change to a built-in can be copied to, as copy-on-edit asks: the layer, and why not. */
export interface CopyChoice {
  layer: WritableLayer;
  label: string;
  title: string;
  disabled?: boolean;
}

/** Where each layer is, in the words copy-on-edit's question offers it. */
const COPY_WORDS: ReadonlyArray<{ layer: WritableLayer; label: string; dir: string; project: boolean }> = [
  { layer: "base", label: "Shared", dir: "~/.jaira — every project that has not overridden it", project: false },
  { layer: "project", label: "This project", dir: "this project's .jaira/", project: true },
  { layer: "projectYou", label: "You in this project", dir: "~/.jaira/projects/…", project: true },
  { layer: "you", label: "Just you", dir: "~/.jaira/personal", project: false },
  { layer: "projectMachine", label: "This project on this machine", dir: ".jaira/local", project: true },
  { layer: "machine", label: "This machine", dir: "~/.jaira/machine", project: false },
];

/**
 * Where COPY-ON-EDIT may put a built-in's copy (the person, 2026-11-24: copy on change "prompts me when I
 * make a change for where I want this change to be made and makes a copy there"): every layer a person
 * owns, by the rules the bar's override buttons follow — a layer that already has its copy is offered
 * disabled, and so is a project's with none open.
 */
export function copyChoicesOf(source: { builtIn?: BuiltInStanding | undefined }, hasProject: boolean): CopyChoice[] {
  const has = (layer: WorkflowLayer): boolean => source.builtIn?.layers.includes(layer) === true;
  return COPY_WORDS.map(({ layer, label, dir, project }) => ({
    layer,
    label,
    ...(project && !hasProject
      ? { title: "Open a project to copy this state into one of its layers", disabled: true }
      : has(layer)
        ? { title: "That layer already has a copy of this state, and it is the one that loads there", disabled: true }
        : { title: `Copy it into ${dir}, with this change in it` }),
  }));
}
