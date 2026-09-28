import type { JSX } from "react";
import { View } from "@tamagui/core";
import type { StateView } from "@jaira/shared/browser";
import { Txt } from "../../primitives";
import { useTokens } from "../../tokens";
import { Chip, NoneRow, PanelRow, PanelSection, RowWords, SectionCount } from "./PanelViews";

/**
 * `panelViews.tsx`'s `StateChecks`, universal (decision 0015): a state's Checks tab — whether it lints,
 * what it runs on, where it goes next, what it is made of, who it names and who names it, and whether
 * tasks are pinned to an older copy. One section each, in the panel's settings shape (`PanelViews.tsx`).
 *
 *   .notice          --tint-accent, radius --control-radius, padding 7 9, app 11/12.5 --dim
 *   .pv-bad/.pv-warn the name in --bad / --warn
 */
export function StateChecks({
  state,
  onRevealIssue,
  onOpenConfig,
  onOpenState,
}: {
  state: StateView;
  onRevealIssue?: ((path: string) => void) | undefined;
  onOpenConfig?: (() => void) | undefined;
  onOpenState?: ((stateId: string) => void) | undefined;
}): JSX.Element {
  const t = useTokens();
  return (
    <>
      {state.fileOnly ? (
        <View backgroundColor={t.v("tint-accent") as never} borderRadius={t.v("control-radius") as never} paddingVertical={7} paddingHorizontal={9}>
          <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }}>Read from the file alone, with no project open. Lint results, dependants, drift and runs are not known — open a project to see them.</Txt>
        </View>
      ) : null}
      <PanelSection title="Validation" action={state.issues.length > 0 ? <SectionCount>{state.issues.length}</SectionCount> : undefined}>
        {state.issues.length === 0
          ? [<NoneRow key="none">{state.fileOnly ? "not checked" : "lints clean"}</NoneRow>]
          : state.issues.map((issue, i) => (
              <PanelRow
                key={i}
                name={issue.path === "" ? "this file" : issue.path}
                nameInk={issue.severity === "error" ? "bad" : "warn"}
                value={issue.message}
                {...(onRevealIssue !== undefined && issue.path.length > 0 ? { onPress: () => onRevealIssue(issue.path), title: "show the control this is about" } : {})}
              />
            ))}
      </PanelSection>

      <PanelSection title="Environment">
        {state.environment.executor === undefined ? (
          <NoneRow>no executor named — inherited or not a function operation</NoneRow>
        ) : (
          <PanelRow
            name="executor"
            value={
              <>
                <RowWords>{state.environment.executor} </RowWords>
                <Chip tone={state.environment.available ? "ok" : "bad"}>{state.environment.available ? "available" : "not available"}</Chip>
              </>
            }
          />
        )}
        {state.environment.executor !== undefined && state.environment.from !== undefined ? <PanelRow name="from" value={state.environment.from} mono /> : null}
        {state.operation?.model !== undefined ? <PanelRow name="model" value={state.operation.model} mono /> : null}
        {onOpenConfig !== undefined ? <PanelRow name="effective configuration" value="read ›" onPress={onOpenConfig} /> : null}
      </PanelSection>

      {state.transitions.length > 0 ? (
        <PanelSection title="Transitions" action={<SectionCount>{state.transitions.length}</SectionCount>}>
          {state.transitions.map((one, i) => (
            <PanelRow key={i} name={one.when} value={`→ ${one.to.split("/").pop()}${one.loops ? " ↺" : ""}`} mono />
          ))}
        </PanelSection>
      ) : null}

      {state.children.length > 0 ? (
        <PanelSection title="Children" action={<SectionCount>in run order</SectionCount>}>
          {state.children.map((child) => (
            <PanelRow key={child.key} name={child.key} value={child.hasChildren ? "composite" : undefined} />
          ))}
        </PanelSection>
      ) : null}

      {state.references.length > 0 ? (
        <PanelSection title="References">
          {state.references.map((ref) => (
            <PanelRow key={ref.ref} name={ref.ref} value={ref.resolved ? "resolves" : <RowWords ink="bad">missing</RowWords>} />
          ))}
        </PanelSection>
      ) : null}

      {state.referencedBy.length > 0 ? (
        <PanelSection title="Referenced by">
          {state.referencedBy.map((id) => (
            <PanelRow key={id} name={id} {...(onOpenState !== undefined ? { value: "open ›", onPress: () => onOpenState(id) } : {})} />
          ))}
        </PanelSection>
      ) : null}

      {state.driftedTasks.length > 0 ? (
        <PanelSection title="Snapshot drift">
          <NoneRow ink="warn">{state.driftedTasks.length} task(s) here are pinned to an older snapshot and will not see an edit until they are re-run.</NoneRow>
        </PanelSection>
      ) : null}
    </>
  );
}
