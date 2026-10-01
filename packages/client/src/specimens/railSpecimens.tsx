import type { ComponentType, JSX, ReactNode } from "react";
import { View } from "@tamagui/core";
import type { RailStep } from "@jaira/ui/rail";
import { RailedRows, useTokens } from "@jaira/universal";

/**
 * The conversation's rail on its own (`components/panel/Rail.tsx`, the copy of `railView.tsx`'s `RailedRows`),
 * on the page's grey (`.sb`'s --bg), in the shapes the seeded world never draws:
 *
 *  - `rail-deep` — a run sixteen states deep, whose shallow lanes fall under two pixels apart and are
 *    drawn as ONE striped column (`stackPaint`), the deepest lanes kept at full pitch;
 *  - `rail-rolled` — a lane folded with no host to say what it holds: the standing `.rail-rolled` line
 *    (its name, the tag, how many states it holds) and the knot's stack of rings.
 */
export interface RailSpecimen {
  width: number;
  rn: ComponentType;
}

const KEYS = "abcdefghijklmnop".split("");
/** Into a state at every depth, then back out: a straight line of forks, a straight line of joins. */
const DEEP: RailStep[] = [
  ...KEYS.map((_, i) => ({ key: `s${i}`, stateId: `wf/${KEYS.slice(0, i + 1).join("/")}`, at: KEYS.slice(0, i + 1), opens: true })),
  { key: "leaf", stateId: "wf/leaf", at: [...KEYS, "leaf"], opens: true },
  { key: "after", stateId: "wf/after", at: ["after"], opens: true },
];
/** A plan with three states under it, then a review; the plan's lane folded. */
const ROLLED: RailStep[] = [
  { key: "plan", stateId: "feature/plan", at: ["plan"], opens: true },
  { key: "goals", stateId: "feature/plan/goals", at: ["plan", "goals"], opens: true },
  { key: "context", stateId: "feature/plan/context", at: ["plan", "context"], opens: true },
  { key: "critique", stateId: "feature/plan/critique", at: ["plan", "critique"], opens: true },
  { key: "review", stateId: "feature/review", at: ["review"], opens: true },
];
const SHUT: ReadonlySet<string> = new Set(["plan"]);

function Page({ children }: { children: ReactNode }): JSX.Element {
  const t = useTokens();
  return (
    <View backgroundColor={t.v("bg") as never} paddingTop={14} paddingHorizontal={16} paddingBottom={22}>
      {children}
    </View>
  );
}

const nothing = (): null => null;

export const RAIL_SPECIMENS: Record<string, RailSpecimen> = {
  "rail-deep": {
    width: 420,
    rn: () => (
      <Page>
        <RailedRows steps={DEEP} renderStep={nothing} />
      </Page>
    ),
  },
  "rail-rolled": {
    width: 420,
    rn: () => (
      <Page>
        <RailedRows steps={ROLLED} renderStep={nothing} shut={SHUT} />
      </Page>
    ),
  },
};
