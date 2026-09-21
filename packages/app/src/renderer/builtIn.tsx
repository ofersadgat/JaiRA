/**
 * What the renderer says about the built-in layer (decision 0006) — the third, read-only layer that
 * ships with the app — in the three places it has to say something:
 *
 *  - the state editor's top bar ({@link LayerBar}): a shipped file is "built in · read-only" and is
 *    changed by overriding it; a person's file of an id that also ships "overrides built in" and can
 *    be compared with what ships;
 *  - the Files tree's "Built in" root, which carries the offer to delete the copies earlier builds
 *    installed ({@link leftoversAsk});
 *  - the Debug pane's rows, which name the layer each self-test state loads from.
 *
 * The DECISIONS are plain functions of plain data ({@link layerBarOf}, {@link leftoversAsk}) and the
 * components only draw them. That is where the logic has to live in a package with no DOM test
 * infrastructure, and it is also the honest split: which buttons a file offers is a fact about the
 * file, not about a bar.
 */
import type { JSX } from "react";
import type { BuiltInLeftover, BuiltInStanding, WorkflowLayer, WritableLayer } from "@jaira/shared/browser";
import type { AskSpec } from "./menu";

/** What a layer is called where a sentence names one. */
export const LAYER_WORDS: Record<WorkflowLayer, string> = {
  project: "this project",
  base: "the shared root",
  system: "what ships",
};

/** One thing the top bar offers. `disabled` carries the reason, which is the button's tooltip. */
export interface LayerBarAction {
  id: "override-base" | "override-project" | "compare" | "delete-copy";
  label: string;
  title: string;
  disabled?: boolean;
}

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
 *     click away. When its value is one JaiRA itself wrote, deleting it is offered too — the copy
 *     changes nothing, or pins an old version nobody chose.
 *  3. A shared file of an id that does not ship: the warning the bar has always carried.
 */
export function layerBarOf(
  source: { layer: WorkflowLayer; builtIn?: BuiltInStanding | undefined },
  hasProject: boolean,
): LayerBarModel | null {
  const standing = source.builtIn;
  if (source.layer === "system") {
    const has = (layer: WorkflowLayer): boolean => standing?.layers.includes(layer) === true;
    return {
      chip: {
        text: "built in · read-only",
        tone: "plain",
        title: "This file ships with JaiRA and cannot be edited. Override it to change what runs.",
      },
      actions: [
        {
          id: "override-base",
          label: "Override for all projects",
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
      ],
    };
  }
  if (standing !== undefined) {
    const actions: LayerBarAction[] = [
      { id: "compare", label: "Compare with what ships", title: "Show this file beside the built-in one it overrides" },
    ];
    // The SHARED copy only. That is where the install steps wrote, so it is the one place a copy can
    // be there without anybody having decided it should be; a project's copy is in somebody's
    // repository, and whether it stays is a question for a commit.
    const leftover = source.layer === "base" ? standing.identical : undefined;
    if (leftover !== undefined) {
      actions.push({
        id: "delete-copy",
        label: "Delete this copy",
        title:
          leftover === "current"
            ? "This file is identical to the built-in one, so it changes nothing. Deleting it goes back to what ships."
            : "This file is identical to a version an earlier JaiRA installed. Deleting it goes back to what ships now.",
      });
    }
    return {
      chip: {
        text: leftover === undefined ? "overrides built in" : "overrides built in · identical copy",
        tone: source.layer === "base" ? "warn" : "plain",
        title:
          source.layer === "base"
            ? "The shared copy of a state JaiRA ships. Every project that has not overridden it runs this file."
            : "This project's copy of a state JaiRA ships. It runs here instead of the built-in one.",
      },
      actions,
    };
  }
  if (source.layer === "base") {
    return {
      chip: {
        text: "shared copy",
        tone: "warn",
        title: "Editing the shared copy. Every project that has not overridden this state will see the change.",
      },
      actions: [],
    };
  }
  return null;
}

/** Which layer an override action copies into. */
export function overrideTarget(id: LayerBarAction["id"]): WritableLayer | null {
  return id === "override-base" ? "base" : id === "override-project" ? "project" : null;
}

/** The layer half of the state editor's top bar — the mockup's chip and `link` buttons, drawn from a model. */
export function LayerBar({
  model,
  busy,
  comparing,
  onAction,
}: {
  model: LayerBarModel | null;
  busy: boolean;
  /** True while the body below is the comparison, so the button reads as the way back. */
  comparing: boolean;
  onAction: (id: LayerBarAction["id"]) => void;
}): JSX.Element | null {
  if (model === null) return null;
  return (
    <>
      <span className={model.chip.tone === "warn" ? "chip chip-warn" : "chip"} title={model.chip.title}>
        {model.chip.text}
      </span>
      {model.actions.map((action) => (
        <button
          key={action.id}
          type="button"
          className="link"
          title={action.title}
          disabled={busy || action.disabled === true}
          aria-pressed={action.id === "compare" ? comparing : undefined}
          onClick={() => onAction(action.id)}
        >
          {action.id === "compare" && comparing ? "Back to the file" : action.label}
        </button>
      ))}
    </>
  );
}

/**
 * The question asked before any copy of a built-in is deleted — never silently (decision 0006).
 *
 * Every file is NAMED, by absolute path: "three files" is not something a person can agree to, and
 * the shared root is theirs. The note says what deleting changes, which for a `current` copy is
 * nothing and for a `superseded` one is "you get the version that ships now".
 */
export function leftoversAsk(leftovers: readonly BuiltInLeftover[], onConfirm: () => void): AskSpec {
  const n = leftovers.length;
  const old = leftovers.filter((left) => left.identical === "superseded").length;
  const them = n === 1 ? "it" : "them";
  const what =
    old === 0
      ? `identical to what ships now, so deleting ${them} changes nothing that runs`
      : old === n
        ? `identical to a version an earlier JaiRA installed, so deleting ${them} goes back to what ships now`
        : `identical to a version JaiRA shipped — now or earlier — so deleting ${them} goes back to what ships now`;
  return {
    title: n === 1 ? "Delete 1 copy of a built-in state?" : `Delete ${n} copies of built-in states?`,
    note: `JaiRA used to install its own states into the shared root. ${n === 1 ? "This file is" : "These files are"} ${what}. Nothing else is touched. ${leftovers
      .map((left) => left.file)
      .join(" · ")}`,
    confirmLabel: n === 1 ? "Delete the copy" : `Delete ${n} copies`,
    danger: true,
    onConfirm,
  };
}
