import { useEffect, useState, type ComponentType, type JSX, type ReactNode } from "react";
import { View } from "@tamagui/core";
import { GALLERY_DOCUMENT, GALLERY_SURFACES, remoteProjectKey, type JairaBridge, type MachinesView, type PendingInteraction, type TaskChangeLog } from "@jaira/shared/browser";
import type { JsonValue } from "@declarative-ai/json";
import { reportLooseError } from "@jaira/ui/crashReport";
import { initialState, interactionOf, parsedDoc } from "@jaira/ui/galleryModel";
import { setBridge } from "@jaira/ui/store";
import { ValuePanelContext, type ValuePanel } from "@jaira/ui/valuePanel";
import { ChangesPanel, CrashScreen, DisconnectedLine, GateSurface, LooseErrorBanner, OfflineBanner, Toast } from "@jaira/universal";

/**
 * What the window says about itself, a settled gate, and a conversation's foot, as specimens (decision
 * 0015), each from a fixture.
 *
 *  - `toast-error`, `toast-info` — the shell's toast; `crash-screen`, `crash-banner` — the two nets
 *    under a render that threw; `disconnected` — the line of a lost socket. Each is fixed to the window,
 *    so each is drawn in a stage of its own that stands in for it, and takes `staged` (placed in its
 *    box rather than the window).
 *  - `gate-settled-<gate>` — a gate as it was answered, in a state's panel (`.st-block`, the copy `plain`):
 *    a tool call's approval, an artifact reviewed (decided in silence, sent back with a comment, approved
 *    edited) and an artifact edited, each from its gallery card.
 *  - `offline-banner` — the foot of a conversation whose machine is away; `changes-commands`,
 *    `changes-git` — the Changes tab with commands in their parts' colours and a state's definition a
 *    press away. Their reads are answered here: `machines:view` and `task:changes` go to the fixture
 *    below, everything else to the window's bridge.
 */
export interface ShellSpecimen {
  width: number;
  rn: ComponentType;
}

const NOOP = (): void => undefined;

/** A box what is `staged` is placed in, as it is in the window. */
function RnStage({ height, children }: { height: number; children: ReactNode }): JSX.Element {
  return (
    <View position="relative" height={height}>
      {children}
    </View>
  );
}

const FAILED = "Could not start the task: the workflow feature/plan has no state named draft.";
const NOTICE = "Runs on build box.";

/** A render that threw, with a stack that says the same on every run. */
const THROWN = Object.assign(new TypeError("Cannot read properties of undefined (reading 'map')"), {
  stack: [
    "TypeError: Cannot read properties of undefined (reading 'map')",
    "    at BoardColumn (http://127.0.0.1:8081/src/app/BoardColumn.tsx:88:31)",
    "    at renderWithHooks (http://127.0.0.1:8081/node_modules/.vite/deps/react-dom_client.js:5524:24)",
    "    at updateFunctionComponent (http://127.0.0.1:8081/node_modules/.vite/deps/react-dom_client.js:7461:21)",
  ].join("\n"),
});
const WHERE = ["", "    at BoardColumn", "    at Frame", "    at UniversalApp"].join("\n");

/** Reports a loose failure once the banner under it listens (a parent's effect runs after its children's). */
function Reported({ text, children }: { text: string; children: ReactNode }): JSX.Element {
  useEffect(() => reportLooseError({ at: 0, text }), [text]);
  return <>{children}</>;
}
const LOOSE = "TypeError: Failed to fetch\n    at connect (socketBridge.ts:41:9)";

// --- the reads answered from the fixture --------------------------------------------------------------

const PEER_KEY = remoteProjectKey("m-mini", "/Users/me/work/checkout");
const MACHINES = {
  self: { id: "m-here", label: "this machine", os: "windows", tags: [] },
  machines: [{ id: "m-mini", label: "mac-mini", os: "macos", tags: [], state: "offline", lastSeenAt: Date.now() - 3 * 3_600_000, canReachHere: true }],
} as unknown as MachinesView;

const AT = new Date("2026-09-30T09:41:00").getTime();
const CHANGES: TaskChangeLog = {
  files: [],
  execution: [
    { call: "c1", said: "Ran the checks", command: "npm test -- --run && npx tsc --noEmit -p packages/app", at: AT },
    { call: "c2", said: "Ran", command: "git stash && git pull --rebase origin main | tee pull.log", at: AT + 60_000 },
  ],
  web: [],
  git: {
    requests: [],
    steps: [
      { call: "g1", kind: "commit", subject: "3f2a1c9", detail: "cache the availability probe", at: AT + 120_000 },
      { call: "g2", kind: "other", command: "git rebase origin/main", at: AT + 180_000 },
    ],
    uncommitted: [],
  },
  tasks: [],
  mcp: [],
  other: [{ call: "o1", said: "Changed the state", subject: "feature/plan/draft", open: { stateId: "feature/plan/draft" }, at: AT + 240_000 }],
};

/** The window's bridge, with some reads answered from the fixture. Installed as the specimen renders. */
function useAnswered(answers: Record<string, unknown>): void {
  useState(() => {
    const window_ = (globalThis as { jaira?: JairaBridge }).jaira;
    const bridge: JairaBridge = {
      invoke: ((channel: string, request: unknown) =>
        channel in answers ? Promise.resolve(answers[channel]) : window_ !== undefined ? window_.invoke(channel as never, request as never) : Promise.reject(new Error("no bridge"))) as JairaBridge["invoke"],
      subscribe: (listener) => (window_ !== undefined ? window_.subscribe(listener) : NOOP),
    };
    setBridge(bridge);
    return true;
  });
}
function Answered({ answers, children }: { answers: Record<string, unknown>; children: ReactNode }): JSX.Element {
  useAnswered(answers);
  return <>{children}</>;
}

/** "Open its definition" is offered where there is a context panel to open it in. */
const PANEL: ValuePanel = { open: NOOP, openState: NOOP };

// --- settled gates ----------------------------------------------------------------------------------

function gateOf(id: string): PendingInteraction {
  const surface = GALLERY_SURFACES.find((s) => s.id === id)!;
  return interactionOf(surface, parsedDoc(initialState(surface).text).doc!).pending;
}
const EDITED = GALLERY_DOCUMENT.replace("the only one a", "the one a");

const settled = (id: string, value: JsonValue): ShellSpecimen => {
  const pending = gateOf(id);
  return {
    width: 560,
    rn: () => (
      <View flexDirection="column">
        <GateSurface pending={pending} onSubmit={NOOP} settled={{ value }} plain />
      </View>
    ),
  };
};

export const SHELL_SPECIMENS: Record<string, ShellSpecimen> = {
  "toast-error": {
    width: 520,
    rn: () => (
      <RnStage height={160}>
        <Toast staged error={FAILED} notice={null} onDismissError={NOOP} onDismissNotice={NOOP} />
      </RnStage>
    ),
  },
  "toast-info": {
    width: 520,
    rn: () => (
      <RnStage height={100}>
        <Toast staged error={null} notice={NOTICE} onDismissError={NOOP} onDismissNotice={NOOP} />
      </RnStage>
    ),
  },
  "crash-screen": {
    width: 760,
    rn: () => (
      <RnStage height={560}>
        <CrashScreen staged error={THROWN} where={WHERE} onReload={NOOP} />
      </RnStage>
    ),
  },
  "crash-banner": {
    width: 520,
    rn: () => (
      <RnStage height={90}>
        <Reported text={LOOSE}>
          <LooseErrorBanner staged />
        </Reported>
      </RnStage>
    ),
  },
  disconnected: {
    width: 520,
    rn: () => (
      <RnStage height={60}>
        <DisconnectedLine staged lost="the socket closed (1006)" />
      </RnStage>
    ),
  },
  "offline-banner": {
    width: 560,
    rn: () => (
      <Answered answers={{ "machines:view": MACHINES }}>
        <OfflineBanner project={PEER_KEY} />
      </Answered>
    ),
  },
  "changes-commands": {
    width: 420,
    rn: () => (
      <Answered answers={{ "task:changes": { ...CHANGES, git: { requests: [], steps: [], uncommitted: [] } } }}>
        <ValuePanelContext.Provider value={PANEL}>
          <ChangesPanel taskId="t-fixture" signal={0} />
        </ValuePanelContext.Provider>
      </Answered>
    ),
  },
  "changes-git": {
    width: 420,
    rn: () => (
      <Answered answers={{ "task:changes": { ...CHANGES, execution: [], other: [] } }}>
        <ChangesPanel taskId="t-fixture" signal={0} />
      </Answered>
    ),
  },
  "gate-settled-approval": settled("approve_tool_call/basic", { decision: "allow" }),
  "gate-settled-review": settled("review_artifact/basic", { decision: "approve" }),
  "gate-settled-review-sent-back": settled("review_artifact/comments", { decision: "reject", comments: "Say what the interval is, and who sets it." }),
  "gate-settled-review-edited": settled("review_artifact/editable", { decision: "approve", content: EDITED }),
  "gate-settled-edit": settled("edit_artifact/basic", { content: EDITED }),
};
