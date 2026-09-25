/**
 * What a model field runs as on this machine, and what that model takes for reasoning — asked of main
 * (`model:parameters`, decision 0009) for whatever model a control is showing.
 *
 * One hook so every control that offers a reasoning level offers the SAME levels for the same model:
 * the composer's Thinking chip, a preset's Reasoning, a state's model settings. A preset resolves in
 * main exactly as a run's call would, so the levels are those of the model that would answer here.
 */
import { useEffect, useState } from "react";
import type { ModelParametersView } from "@jaira/shared/browser";
import { invoke } from "./store";

/** The answer for `model` (a model id or a preset's name), or `undefined` until it lands or when none is named. */
export function useModelParameters(model: string | undefined, project?: string): ModelParametersView | undefined {
  const [view, setView] = useState<ModelParametersView | undefined>(undefined);
  useEffect(() => {
    if (model === undefined || model.length === 0) {
      setView(undefined);
      return;
    }
    let live = true;
    void invoke("model:parameters", { model, ...(project !== undefined ? { project } : {}) })
      .then((next) => live && setView(next))
      // A view main could not produce is an unknown model: the controls offer the usual levels.
      .catch(() => live && setView(undefined));
    return () => {
      live = false;
    };
  }, [model, project]);
  return view;
}

/** The footer under a level list: where the levels come from, or that they are not known. */
export function levelsFooter(view: ModelParametersView | undefined): string {
  if (view?.levels !== undefined && view.from !== undefined) return `levels from ${view.from}`;
  return "levels not known — a level it lacks is lowered at the call";
}
