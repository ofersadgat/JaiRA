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
   * Offered behind the bar's `Elsewhere…` rather than as a link of its own: the settings' four
   * newer layers (decision 0023, amended 2026-11-18), after the two the bar has always offered.
   */
  more?: true;
}

/** The settings' four newer layers, as the bar offers a copy into them — most specific first. */
const MORE_LAYERS: ReadonlyArray<{ layer: WritableLayer; label: string; dir: string; project: boolean }> = [
  { layer: "projectYou", label: "Edit a copy for you in this project", dir: "~/.jaira/projects/…", project: true },
  { layer: "you", label: "Edit a copy for just you", dir: "~/.jaira/personal", project: false },
  { layer: "projectMachine", label: "Edit a copy in this project on this machine", dir: ".jaira/local", project: true },
  { layer: "machine", label: "Edit a copy on this machine", dir: "~/.jaira/machine", project: false },
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
 *  1. A SHIPPED file. Read-only, with the two places it can be overridden. A layer that already has
 *     its copy is offered disabled rather than hidden: "Override here" greyed out with "this project
 *     already overrides it" answers the question the button's absence would raise.
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
    return {
      chip: copyOnEdit
        ? {
            text: "built in · an edit copies it to Shared",
            tone: "plain",
            title: "This file ships with JaiRA. The first change you make copies it into ~/.jaira with the change in it, and the copy is what runs.",
          }
        : {
            text: "built in · read-only",
            tone: "plain",
            title: has("base")
              ? "Shared already has a copy of this state, and it is the one that runs — edit that."
              : "This file ships with JaiRA and cannot be edited. Override it to change what runs.",
          },
      actions: [
        {
          id: "override-base",
          // Editing a built-in is making a copy in Shared (the panel rulings, 2026-09-24): the verb
          // says what the person wants, and the title says what it does.
          label: "Edit a copy in Shared",
          title: has("base")
            ? "The shared root already has a copy of this state, and it is the one that loads"
            : "Copy this file into the shared root (~/.jaira) and open the copy",
          ...(has("base") ? { disabled: true } : {}),
        },
        {
          id: "override-project",
          label: "Override here",
          title: !hasProject
            ? "Open a project to override this state for it alone"
            : has("project")
              ? "This project already has a copy of this state, and it is the one that loads"
              : "Copy this file into this project's .jaira/ and open the copy",
          ...(!hasProject || has("project") ? { disabled: true } : {}),
        },
        // The same rules: a layer that already has its copy is offered disabled, and a project's with none open.
        ...MORE_LAYERS.map(({ layer, label, dir, project }): LayerBarAction => ({
          id: `override-${layer}`,
          label,
          title:
            project && !hasProject
              ? "Open a project to copy this state into one of its layers"
              : has(layer)
                ? "That layer already has a copy of this state"
                : `Copy this file into ${dir} and open the copy`,
          ...((project && !hasProject) || has(layer) ? { disabled: true } : {}),
          more: true,
        })),
      ],
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
