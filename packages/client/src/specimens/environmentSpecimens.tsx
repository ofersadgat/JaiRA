import type { ComponentType, JSX, ReactNode } from "react";
import { Text, View } from "@tamagui/core";
import type { EnvironmentView, PlacementAsk, PlacementNote, QueuedPlacement } from "@jaira/shared/browser";
import { facesOf, type EnvironmentStage, type MachineFace } from "@jaira/ui/environmentModel";
import { placementSummaryOf } from "@jaira/ui/placementSummary";
import { clockOf } from "@jaira/ui/runActivityModel";
import { Composer, EnvironmentBar, EnvironmentRows, MachineIcon, PlacementSummary, QueuedMessage, WorkRing, useTokens } from "@jaira/universal";

/**
 * Where a conversation runs, as specimens (decision 0013 §5, ruled 2026-10-02), each from a fixture:
 *
 *  - `machine-icons` — a machine's icon in every shape, with each system's mark and each dot, large and
 *    at the sizes it is used; and the work ring.
 *  - `environment-bar` — the bar tucked under the composer in each stage: nothing decided, a machine
 *    chosen, a workspace chosen (its checkout on the right), being placed, waiting, running.
 *  - `environment-list` — the list the bar opens: Automatic, each machine with its load, each workspace
 *    with its work ring and checkout, a machine connecting and one offline.
 *  - `placement-placing`, `placement-waiting`, `placement-starting`, `placement-started` — the summary
 *    above the message in each stage, with the message under it: not sent (dashed), queued (amber, its
 *    pill and verbs), and — once it has somewhere to run — sent.
 */
export interface EnvironmentSpecimen {
  width: number;
  rn: ComponentType;
}

const NOOP = (): void => undefined;
const GB = 1024 ** 3;
/** A fixed morning, in the reader's own zone, so every run prints the same clocks. */
const T0 = new Date(2026, 8, 29, 8, 36, 5).getTime();
const HERE = "C:/code/mist-server-3";
const MAIN = "C:/code/mist-server";
const MAC = "jaira-remote:m-mac:/Users/o/code/mist-server";

const VIEW: EnvironmentView = {
  identity: "gitlab.com/mist/mist-server",
  machines: [
    {
      id: "m-self",
      label: "desk",
      self: true,
      os: "windows",
      form: "desktop",
      state: "online",
      cores: 16,
      cpu: 0.12,
      memoryFree: 37 * GB,
      memoryTotal: 128 * GB,
      workspaces: [
        { project: MAIN, dir: MAIN, label: "mist-server", running: 2, queued: 0, git: { branch: "main" } },
        {
          project: HERE,
          dir: HERE,
          label: "mist-server-3",
          running: 0,
          queued: 0,
          git: { branch: "feature/session-cache", ahead: 2, added: 128, removed: 34, mergeRequest: { provider: "gitlab", number: 17, url: "https://gitlab.com/mist/mist-server/-/merge_requests/17", state: "open" } },
        },
      ],
    },
    {
      id: "m-mac",
      label: "mac-mini",
      self: false,
      os: "mac",
      form: "mini",
      state: "online",
      cores: 8,
      cpu: 0.93,
      memoryFree: 9 * GB,
      memoryTotal: 16 * GB,
      workspaces: [{ project: MAC, dir: "/Users/o/code/mist-server", label: "mist-server", running: 1, queued: 2, git: { branch: "main", added: 12, removed: 2 } }],
    },
    { id: "m-bb", label: "build-box", self: false, os: "linux", form: "server", state: "connecting", workspaces: [{ project: "jaira-remote:m-bb:/srv/mist-server", dir: "/srv/mist-server", label: "mist-server", running: 0, queued: 0, git: { branch: "main" } }] },
    { id: "m-tp", label: "thinkpad", self: false, os: "linux", form: "laptop", state: "offline", workspaces: [{ project: "jaira-remote:m-tp:/home/o/src/mist-server", dir: "/home/o/src/mist-server", label: "mist-server", running: 0, queued: 0, git: { branch: "main" } }] },
  ],
};

const ask = (project: string, dir: string, why?: string, machineId = "m-self", label = "desk", at = T0): PlacementAsk => ({ at, project, machineId, label, dir, ...(why !== undefined ? { why } : {}) });
const queued = (over: Partial<QueuedPlacement>): QueuedPlacement => ({ taskId: "t-1", project: HERE, requires: [], since: T0, phase: "waiting", asked: 0, refused: 0, waits: 0, asks: [], ...over });

const PLACING = queued({ phase: "placing" });
const WAITING = queued({
  target: { machine: "m-self" },
  asked: 28,
  refused: 28,
  waits: 13,
  asks: [ask(MAIN, MAIN, "low on memory", "m-self", "desk", T0 + 130_000), ask(HERE, HERE, "low on memory", "m-self", "desk", T0 + 130_000)],
  askedAt: T0 + 130_000,
  nextAt: T0 + 140_000,
});
const NOTE: PlacementNote = {
  since: T0,
  at: T0 + 800,
  asked: 3,
  refused: 2,
  waits: 0,
  asks: [ask(MAIN, MAIN, "2 of 2 running"), ask(MAC, "/Users/o/code/mist-server", "CPU at 93%", "m-mac", "mac-mini"), ask(HERE, HERE)],
  on: { project: HERE, machineId: "m-self", label: "desk", dir: HERE },
  steps: [
    { at: T0 + 800, kind: "workspace", what: "jaira/t-1", tookMs: 400 },
    { at: T0 + 1_200, kind: "pin", what: "chat/session", tookMs: 200 },
  ],
};
const MESSAGE = "Do a code review of merge request 17";

/** The sheet's ground (--panel), which a conversation is printed on. */
function Sheet({ children }: { children: ReactNode }): JSX.Element {
  const t = useTokens();
  return (
    <View backgroundColor={t.v("panel") as never} paddingVertical={6} paddingHorizontal={14}>
      {children}
    </View>
  );
}

/** A message as it is once sent: the bubble a queued one becomes. */
function Sent(): JSX.Element {
  const t = useTokens();
  return (
    <View alignSelf="flex-end" maxWidth="78%" marginTop={14} marginBottom={10} paddingVertical={8} paddingHorizontal={13} borderTopLeftRadius={16} borderTopRightRadius={16} borderBottomLeftRadius={16} borderBottomRightRadius={5} borderWidth={1} borderStyle="solid" borderColor={t.mix(t.v("accent"), 24, t.v("line")) as never} backgroundColor={t.mix(t.v("accent"), 13, t.v("panel")) as never}>
      <Text fontFamily={t.v("font-app") as never} fontSize={t.scaled("size-app", 13 / 12.5) as never} lineHeight={"1.6" as never} color={t.v("text") as never}>
        {MESSAGE}
      </Text>
    </View>
  );
}

function Label({ children }: { children: string }): JSX.Element {
  const t = useTokens();
  return (
    <Text fontFamily={t.v("font-app") as never} fontSize={t.scaled("size-app", 11 / 12.5) as never} color={t.v("dim") as never} textAlign="center">
      {children}
    </Text>
  );
}

function Cell({ face, a, b }: { face: MachineFace; a: string; b: string }): JSX.Element {
  return (
    <View width={100} alignItems="center" gap={8}>
      <MachineIcon face={face} size={36} />
      <View>
        <Label>{a}</Label>
        <Label>{b}</Label>
      </View>
    </View>
  );
}

function Icons(): JSX.Element {
  const t = useTokens();
  return (
    <View backgroundColor={t.v("panel") as never} padding={22} gap={26}>
      <View flexDirection="row" alignItems="flex-start">
        <Cell face={{ shape: "desktop", mark: "windows", dot: "on" }} a="desktop · Windows" b="connected" />
        <Cell face={{ shape: "laptop", mark: "linux", dot: "slow" }} a="laptop · Linux" b="connecting" />
        <Cell face={{ shape: "mini", mark: "mac", dot: "off" }} a="mini · macOS" b="offline" />
        <Cell face={{ shape: "server", mark: "linux", dot: "on" }} a="server · Linux" b="connected" />
        <Cell face={{ shape: "phone", mark: "android", dot: "on" }} a="phone · Android" b="connected" />
        <Cell face={{ shape: "phone", mark: "ios", dot: "on" }} a="phone · iOS" b="connected" />
        <Cell face={{ shape: "auto" }} a="not decided" b="automatic" />
      </View>
      <View flexDirection="row" alignItems="center" gap={26}>
        <MachineIcon face={{ shape: "desktop", mark: "windows", dot: "on" }} size={14} />
        <MachineIcon face={{ shape: "mini", mark: "mac", dot: "off" }} size={16} />
        <MachineIcon face={{ shape: "laptop", mark: "linux", dot: "slow" }} size={18} />
        <MachineIcon face={{ shape: "server", mark: "linux", dot: "on" }} size={20} />
        <MachineIcon face={{ shape: "auto" }} size={18} />
        <WorkRing count={1} size={40} />
        <WorkRing count={3} size={40} />
        <WorkRing count={12} size={40} />
        <WorkRing count={2} />
        <WorkRing count={12} />
      </View>
    </View>
  );
}

/** The composer with the bar tucked under it, in one stage. */
function Bar({ stage, placeholder, disabled }: { stage: EnvironmentStage; placeholder?: string; disabled?: string }): JSX.Element {
  return (
    <Composer
      plan={null}
      overrides={{}}
      onOverrides={NOOP}
      onSend={NOOP}
      value=""
      onValue={NOOP}
      {...(placeholder !== undefined ? { placeholder } : {})}
      {...(disabled !== undefined ? { disabled } : {})}
      tray={<EnvironmentBar view={VIEW} stage={stage} onChoose={stage.kind === "choosing" || stage.kind === "waiting" ? NOOP : undefined} />}
    />
  );
}

function Bars(): JSX.Element {
  return (
    <View>
      <Bar stage={{ kind: "choosing" }} placeholder="Ask for a change, or a question about the code…" />
      <Bar stage={{ kind: "choosing", target: { machine: "m-mac" } }} placeholder="Ask for a change, or a question about the code…" />
      <Bar stage={{ kind: "choosing", target: { project: HERE } }} placeholder="Ask for a change, or a question about the code…" />
      <Bar stage={{ kind: "placing", queued: PLACING }} disabled="Finding somewhere for this conversation to run…" />
      <Bar stage={{ kind: "waiting", queued: WAITING }} disabled="This conversation starts when a workspace has room." />
      <Bar stage={{ kind: "running", project: HERE, placed: NOTE }} placeholder="Reply…" />
    </View>
  );
}

function List(): JSX.Element {
  const t = useTokens();
  return (
    <View padding={10}>
      <View padding={6} borderWidth={1} borderStyle="solid" borderColor={t.v("line") as never} borderRadius={12} backgroundColor={t.v("panel") as never}>
        <EnvironmentRows view={VIEW} target={{ project: HERE }} onChoose={NOOP} />
      </View>
    </View>
  );
}

const FACES = facesOf(VIEW);

export const ENVIRONMENT_SPECIMENS: Record<string, EnvironmentSpecimen> = {
  "machine-icons": { width: 760, rn: Icons },
  "environment-bar": { width: 760, rn: Bars },
  "environment-list": { width: 710, rn: List },
  "placement-placing": {
    width: 760,
    rn: () => (
      <Sheet>
        <PlacementSummary summary={placementSummaryOf({ queued: PLACING, selfId: "m-self" })!} faces={FACES} clock={clockOf} at={T0 + 400} />
        <QueuedMessage message={MESSAGE} since={T0} waiting={false} at={T0 + 400} />
      </Sheet>
    ),
  },
  "placement-waiting": {
    width: 760,
    rn: () => (
      <Sheet>
        <PlacementSummary summary={placementSummaryOf({ queued: WAITING, selfId: "m-self" })!} faces={FACES} clock={clockOf} at={T0 + 134_000} />
        <QueuedMessage message={MESSAGE} since={T0} waiting onEdit={NOOP} onDelete={NOOP} at={T0 + 134_000} />
      </Sheet>
    ),
  },
  "placement-starting": {
    width: 760,
    rn: () => (
      <Sheet>
        <PlacementSummary summary={placementSummaryOf({ placed: NOTE, starting: true, agent: "codex-cli", selfId: "m-self" })!} faces={FACES} clock={clockOf} at={T0 + 1_700} />
        <Sent />
      </Sheet>
    ),
  },
  "placement-started": {
    width: 760,
    rn: () => (
      <Sheet>
        <PlacementSummary summary={placementSummaryOf({ placed: NOTE, starting: false, agent: "codex-cli", selfId: "m-self" })!} faces={FACES} clock={clockOf} />
        <Sent />
      </Sheet>
    ),
  },
};
