import type { JSX, ReactNode } from "react";
import { View } from "@tamagui/core";
import type { SessionView } from "@jaira/shared/browser";
import type { TranscriptEntry } from "@jaira/ui/transcript";
import { ValuePanelContext, type ValuePanel } from "@jaira/ui/valuePanel";
import { Transcript, useTokens } from "@jaira/universal";

/**
 * The badge on a message the person did not type, in the three places it stands: over a message the
 * workflow wrote (named, and a button opening its definition where the shell can), over one JaiRA
 * wrote, and beside an aside's role on its line.
 *
 *  - `message-source` — with a panel that opens a state's definition: "From <workflow>" is a button.
 *  - `message-source-plain` — with a panel that cannot: the same words, a pill.
 */

const T0 = new Date(2026, 8, 21, 10, 0, 0).getTime();

const ENTRIES: TranscriptEntry[] = [
  { kind: "message", role: "system", text: "You review plans. Be brief.", at: T0, turn: 0, by: "host" },
  { kind: "message", role: "user", text: "Review the plan document. Find significant weaknesses.", at: T0 + 1000, turn: 1, by: "workflow" },
  { kind: "message", role: "assistant", text: "Two weaknesses: the sync lint ignores renames, and there is no test for an empty board.", at: T0 + 4000, turn: 2 },
  { kind: "message", role: "user", text: "Carry on with the second one.", at: T0 + 9000, turn: 3, by: "host" },
];

/** The conversation's session, as far as the badge reads it: the state that opened it. */
const SESSION = { stateId: "feature/plan/critique", status: "completed", turns: [], sidechains: {} } as unknown as SessionView;

const OPENS = { open: () => undefined, openState: () => undefined } as unknown as ValuePanel;
const PLAIN = { open: () => undefined } as unknown as ValuePanel;

function RnSheet({ panel, children }: { panel: ValuePanel; children: ReactNode }): JSX.Element {
  const t = useTokens();
  return (
    <ValuePanelContext.Provider value={panel}>
      <View backgroundColor={t.v("panel") as never}>{children}</View>
    </ValuePanelContext.Provider>
  );
}

const pair = (panel: ValuePanel) => ({
  width: 640,
  rn: () => (
    <RnSheet panel={panel}>
      <Transcript session={SESSION} entries={ENTRIES} rails />
    </RnSheet>
  ),
});

export const MESSAGE_SOURCE_SPECIMENS = {
  "message-source": pair(OPENS),
  "message-source-plain": pair(PLAIN),
};
