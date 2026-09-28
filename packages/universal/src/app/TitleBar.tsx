import type { JSX } from "react";
import { Uncopied } from "./Uncopied";
import { useShell } from "./shell";

/**
 * What stands in the title bar (`.title-bar`, `App.tsx`): the ADDRESS of what is open. In Tasks, the
 * task address bar (`taskBar.tsx`, with `crumbs.tsx`); in Files, the file address bar; in Chat, the
 * conversation's name. The bar itself — 34 tall, `--panel`, a `--line` under it — is `UniversalApp`'s.
 */
export function ShellTitleBar(): JSX.Element {
  const { state } = useShell();
  return <Uncopied name={state.view === "tasks" ? "TaskAddressBar" : `${state.view} address`} flex={1} />;
}
