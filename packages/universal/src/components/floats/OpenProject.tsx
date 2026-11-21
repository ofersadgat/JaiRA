import { useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from "react";
import { ScrollView } from "react-native";
import { View, isWeb } from "@tamagui/core";
import type {
  FolderListing,
  ForgeBranch,
  ForgeRepositoriesView,
  ForgeRepositoryRow,
  MachinesView,
  WorkspaceCreateRequest,
  WorkspacePlan,
  WorkspaceSource,
} from "@jaira/shared/browser";
import { parseRemoteProjectKey } from "@jaira/shared/browser";
import {
  OPEN_STEPS,
  OPEN_STEP_LABELS,
  bringChoices,
  folderChip,
  folderNote,
  needWords,
  placeGroupsOf,
  planSentence,
  jobBlocks,
  readinessWords,
  sourceName,
  standingOf,
  standingWords,
  type BringPlace,
  type ChosenSource,
  type OpenFlowStart,
  type OpenStep,
  type WorkspaceJob,
} from "@jaira/ui/openProjectModel";
import { invoke } from "@jaira/ui/store";
import { dirOf, groupOf, type ProjectGroup } from "@jaira/ui/workspaceGroups";
import { Press, Txt, edge, lengthToken, scrollbarProps } from "../../primitives";
import { useTokens } from "../../tokens";
import { Chip } from "../files/Chip";
import { Button } from "../settings/Button";
import { TextField } from "../settings/fields";
import { ModalBox } from "./Modal";
import { Icon } from "../panel/Icon";
import { TermLog, plainOf } from "../terminal/TermLog";
import { IconButton } from "../terminal/TermParts";
import { copyText } from "../../clipboard";

type Source = ChosenSource;
type Place = { kind: "machine"; id: string; label: string } | { kind: "forge"; host: string; label: string };
type PlanState = WorkspacePlan | { error: string } | "loading";

/**
 * Open (decision 0027): a project from a forge or a folder on any machine, taken to any machine — in
 * four steps that keep their answers across the top. How it looks:
 *
 *   the dialog       min(1000px, 94vw) wide, 640 tall, a column
 *   the steps        row, padding 12 20, --panel-2 ground, a --line under: each a 20 circle (done --ok
 *                    with ✓, current --accent with its number, to come a --rule ring), its name (data
 *                    10.5, --dim; --accent when current) over its answer (app 12.5 600); a 1px --rule
 *                    line between steps, growing
 *   the column       232 wide, padding 10 8, --bg ground, a --line right: headers (app 10.5 600 caps,
 *                    --dim) and rows (padding 5 8, radius 6; the chosen one --tint-accent, 600), each
 *                    with its status at the right (app 10.5: ready --ok, installs --accent, password
 *                    --warn, can't / offline --dim)
 *   the pane         padding 14 18; its lists bordered (1px --line, radius 7), rows padding 6 10
 *   the foot         row, padding 12 20, a --line above: back (`ghost`), the rest, Cancel, the step's
 *                    primary
 *
 * Opened to add a workspace, it starts at Where it goes with the project chosen, and its primary says
 * `Add <machine>` from that step on: everything after it is filled in.
 *
 * A project chosen is said against the person's (`standingOf`), in a note above the foot: a folder or
 * repository of a project they have joins it as another workspace — a folder of it not yet open is added
 * where it is, nothing copied — and Add takes nothing that is not the project it adds to.
 */
export function OpenProject({
  start,
  machines,
  jobs,
  onClose,
  onCreate,
  onCancelJob,
  onOpenThere,
  placesOf,
  groups = [],
  staged = false,
}: {
  start: OpenFlowStart;
  machines: MachinesView | undefined;
  /** The person's projects, as the sidebar groups them: what a chosen project is said against. */
  groups?: readonly ProjectGroup[];
  jobs: Record<string, WorkspaceJob>;
  /** The machines holding a workspace of the project a source is: where Bring can take files from. */
  placesOf?: (source: Source) => readonly BringPlace[];
  onClose: () => void;
  onCreate: (request: WorkspaceCreateRequest, label: string) => Promise<string | undefined>;
  onCancelJob: (jobId: string) => void;
  /** Open a folder where it is, as a project there: nothing copied. */
  onOpenThere: (machineId: string, dir: string) => void;
  staged?: boolean;
}): JSX.Element {
  const selfId = machines?.self.id;
  const [step, setStep] = useState<OpenStep>(start.job !== undefined ? "go" : (start.step ?? (start.source !== undefined ? "where" : "project")));
  const [source, setSource] = useState<Source | undefined>(start.source);
  const [target, setTarget] = useState<string | undefined>(start.machine ?? (start.mode === "add" ? undefined : selfId));
  const [folder, setFolder] = useState<{ parent: string; name: string } | undefined>(undefined);
  const [bringFrom, setBringFrom] = useState<string | undefined>(undefined);
  const [plans, setPlans] = useState<Record<string, PlanState>>({});
  const [jobId, setJobId] = useState<string | undefined>(start.job);
  const machineLabel = (id: string | undefined): string =>
    id === undefined ? "" : id === selfId ? (machines?.self.label ?? "this machine") : (machines?.machines.find((m) => m.id === id)?.label ?? id);
  const online = useMemo(
    () => (machines === undefined ? [] : [machines.self.id, ...machines.machines.filter((m) => m.state === "online").map((m) => m.id)]),
    [machines],
  );

  // Every reachable machine's plan for the chosen project: its status beside it in Where it goes.
  useEffect(() => {
    if (source === undefined || (step !== "where" && step !== "how")) return;
    for (const id of online) {
      if (plans[id] !== undefined) continue;
      setPlans((was) => ({ ...was, [id]: "loading" }));
      invoke("workspace:plan", { source, ...(id !== selfId ? { machine: id } : {}) }).then(
        (plan) => setPlans((was) => ({ ...was, [id]: plan })),
        (e: unknown) => setPlans((was) => ({ ...was, [id]: { error: e instanceof Error ? e.message : String(e) } })),
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, step, online.join(",")]);

  // A folder of the person's own: the target's plan again, for that folder.
  const [customPlan, setCustomPlan] = useState<PlanState | undefined>(undefined);
  const chosenFolder = folder !== undefined ? joinPath(folder.parent, folder.name) : undefined;
  useEffect(() => {
    if (source === undefined || target === undefined || chosenFolder === undefined || step !== "how") return;
    setCustomPlan("loading");
    invoke("workspace:plan", { source, folder: chosenFolder, ...(target !== selfId ? { machine: target } : {}) }).then(setCustomPlan, (e: unknown) =>
      setCustomPlan({ error: e instanceof Error ? e.message : String(e) }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, target, chosenFolder, step]);

  const targetPlan = (chosenFolder !== undefined ? customPlan : target !== undefined ? plans[target] : undefined) as PlanState | undefined;
  const plan = isPlan(targetPlan) ? targetPlan : undefined;
  const adding = start.mode === "add";
  // The project a workspace is added to, as the sidebar has it now.
  const addingTo = adding && start.project !== undefined ? groupOf(groups, start.project) : undefined;
  const standingFor = (s: Source) => standingOf(s, groups, selfId, addingTo);
  const standing = source !== undefined ? standingFor(source) : undefined;
  // A folder taken to the machine it is on opens there — unless it is already a workspace of the project
  // being added to: that machine then takes a second workspace, a copy of it beside it.
  const stays = source?.kind === "machine" && standing !== undefined && standing.kind !== "other" && !(adding && standing.kind === "workspace");
  const openThere = stays && source?.kind === "machine" && target === source.machine && chosenFolder === undefined;
  const job = jobId !== undefined ? jobs[jobId] : undefined;
  // The project's name while it is the one the dialog was opened for; another chosen at Project, that one's.
  const projectName =
    addingTo?.label ?? (source === undefined ? undefined : ((source === start.source ? start.name : undefined) ?? plan?.name ?? sourceName(source)));
  const title = adding ? `Add a workspace to ${projectName ?? start.name ?? "the project"}` : "Open a project";
  const refused = standing?.kind === "other";
  // A folder already on a machine is looked for beside the project's workspace there, where its other
  // clones most likely sit; with none there, from the machine's home.
  const held = start.browse !== undefined ? addingTo?.members.find((m) => (parseRemoteProjectKey(m.project)?.machineId ?? m.machine?.id ?? selfId) === start.browse) : undefined;
  const browseFrom = held !== undefined ? parentOf(dirOf(held.project)) : undefined;
  const said = source !== undefined && standing !== undefined && step !== "go" ? standingWords(standing, source, adding, openThere) : undefined;
  // Where Bring takes the files git ignores from: the one chosen, else the first it would take them from —
  // sent either way, so How it gets there says what happens.
  const choices = source !== undefined && target !== undefined ? bringChoices(source, target, placesOf?.(source) ?? []) : [];
  const bringPlace = choices.find((c) => c.machine === bringFrom) ?? choices[0];

  const go = async (): Promise<void> => {
    if (source === undefined || target === undefined) return;
    if (openThere && source.kind === "machine") {
      onOpenThere(source.machine, source.dir);
      onClose();
      return;
    }
    const request: WorkspaceCreateRequest = {
      source,
      ...(target !== selfId ? { machine: target } : {}),
      ...(chosenFolder !== undefined ? { folder: chosenFolder } : {}),
      ...(bringPlace !== undefined ? { bringFrom: bringPlace.machine } : {}),
    };
    const id = await onCreate(request, `${plan?.name ?? source.label} on ${machineLabel(target)}`);
    if (id !== undefined) {
      setJobId(id);
      setStep("go");
    }
  };

  const verb = source?.kind === "forge" ? "Clone" : "Copy";
  const name = plan?.name ?? source?.label.split("/").pop() ?? "it";
  const folderName = source?.kind === "machine" ? (source.dir.split(/[\\/]/).filter(Boolean).pop() ?? source.dir) : name;
  // Opening a folder where it is: added to the project it joins, gone to when it is open already.
  const openLabel =
    standing?.kind === "joins"
      ? `Add ${folderName} to ${standing.group.label}`
      : standing?.kind === "workspace"
        ? `Go to ${folderName}`
        : `Open ${name} on ${machineLabel(target)}`;
  const secondary: { label: string; onPress: () => void } | undefined =
    step === "where" && adding && target !== undefined && !openThere ? { label: "Next: how it gets there", onPress: () => setStep("how") } : undefined;
  const primary: { label: string; disabled: boolean; onPress: () => void } =
    step === "project"
      ? adding && openThere
        ? { label: openLabel, disabled: false, onPress: () => void go() }
        : { label: "Next: where it goes", disabled: source === undefined || refused, onPress: () => setStep("where") }
      : step === "where"
        ? openThere
          ? { label: openLabel, disabled: false, onPress: () => void go() }
          : adding && target !== undefined
            ? { label: `Add ${machineLabel(target)}`, disabled: refused || plan === undefined || plan.setup.readiness === "cannot", onPress: () => void go() }
            : { label: "Next: how it gets there", disabled: refused || target === undefined, onPress: () => setStep("how") }
        : step === "how"
          ? { label: adding ? `Add ${machineLabel(target)}` : `${verb} ${name} to ${machineLabel(target)}`, disabled: refused || plan === undefined || plan.setup.readiness === "cannot", onPress: () => void go() }
          : job?.finished !== undefined
            ? { label: "Done", disabled: false, onPress: onClose }
            : { label: "Hide — it carries on", disabled: false, onPress: onClose };

  const answers: Record<OpenStep, string | undefined> = {
    project: source?.label,
    where: target !== undefined && (plan !== undefined || openThere) ? `${machineLabel(target)} · ${shortPath(openThere && source?.kind === "machine" ? source.dir : (chosenFolder ?? plan?.dir ?? ""))}` : undefined,
    how: plan !== undefined && step !== "where" && step !== "project" ? howAnswer(plan) : undefined,
    go: undefined,
  };

  return (
    <ModalBox staged={staged} onDismiss={onClose} label={title} width={isWeb ? "min(1000px, 94vw)" : "96%"}>
      <View flexDirection="column" height={isWeb ? 640 : undefined} margin={-16} minHeight={0}>
        <Stepper step={step} answers={answers} onStep={(s) => (s !== "go" && OPEN_STEPS.indexOf(s) < OPEN_STEPS.indexOf(step) ? setStep(s) : undefined)} />
        <View flexDirection="row" flexGrow={1} flexShrink={1} minHeight={0}>
          {step === "project" ? (
            <ProjectStep
              machines={machines}
              source={source}
              projects={groups}
              {...(start.browse !== undefined ? { browse: start.browse } : {})}
              {...(browseFrom !== undefined ? { from: browseFrom } : {})}
              {...(addingTo !== undefined ? { addingTo } : {})}
              onSource={(s) => {
                setSource(s);
                setPlans({});
                setFolder(undefined);
                // A folder of the project being added to, not yet one of its workspaces: added where it is.
                if (adding && s.kind === "machine" && standingFor(s).kind === "joins") setTarget(s.machine);
              }}
            />
          ) : null}
          {step === "where" && source !== undefined ? (
            <WhereStep
              machines={machines}
              source={source}
              stays={stays}
              target={target}
              plans={plans}
              folder={folder}
              onTarget={(id) => {
                setTarget(id);
                setFolder(undefined);
              }}
              onFolder={setFolder}
            />
          ) : null}
          {step === "how" && source !== undefined && target !== undefined ? (
            <HowStep source={source} target={machineLabel(target)} plan={targetPlan} choices={choices} bringFrom={bringPlace?.machine} onBringFrom={setBringFrom} />
          ) : null}
          {step === "go" ? <GoStep job={job} onCancel={() => jobId !== undefined && onCancelJob(jobId)} /> : null}
        </View>
        {said !== undefined ? (
          <View paddingHorizontal={20} paddingBottom={10}>
            <Note tone={said.tone === "bad" ? "warn" : said.tone}>{said.text}</Note>
          </View>
        ) : null}
        <Foot
          back={step === "where" ? "‹ Project" : step === "how" ? "‹ Where it goes" : undefined}
          onBack={() => setStep(step === "how" ? "where" : "project")}
          onCancel={onClose}
          primary={primary}
          {...(secondary !== undefined ? { secondary } : {})}
          cancel={step !== "go"}
        />
      </View>
    </ModalBox>
  );
}

function isPlan(plan: PlanState | undefined): plan is WorkspacePlan {
  return plan !== undefined && plan !== "loading" && !("error" in plan);
}

function howAnswer(plan: WorkspacePlan): string {
  const bring = plan.bring.length > 0 ? `${plan.bring.length === 1 ? plan.bring[0] : `${plan.bring.length} patterns`} brought` : undefined;
  const steps = plan.setup.steps.filter((s) => s.status !== "brings").length;
  return [bring, steps > 0 ? `then ${steps} step${steps === 1 ? "" : "s"}` : "nothing to set up"].filter(Boolean).join(" · ");
}

/** A path as the steps show it: its last two folders. */
function shortPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length <= 2 ? path : `…/${parts.slice(-2).join("/")}`;
}

function joinPath(parent: string, name: string): string {
  const sep = parent.includes("\\") && !parent.includes("/") ? "\\" : "/";
  return `${parent.replace(/[\\/]+$/, "")}${sep}${name}`;
}

// --- the steps across the top ----------------------------------------------------------------------

function Stepper({ step, answers, onStep }: { step: OpenStep; answers: Record<OpenStep, string | undefined>; onStep: (s: OpenStep) => void }): JSX.Element {
  const t = useTokens();
  const at = OPEN_STEPS.indexOf(step);
  return (
    <View flexDirection="row" alignItems="center" gap={10} paddingVertical={12} paddingHorizontal={20} backgroundColor={t.v("panel-2") as never} {...(edge(t, { bottom: 1 }) as object)}>
      {OPEN_STEPS.map((s, i) => {
        const done = i < at && answers[s] !== undefined;
        const current = i === at;
        return (
          <View key={s} flexDirection="row" alignItems="center" gap={10} flexGrow={i < OPEN_STEPS.length - 1 ? 1 : 0} flexShrink={s === "go" ? 0 : 1} minWidth={0}>
            <Press onPress={() => onStep(s)} disabled={!done} label={OPEN_STEP_LABELS[s]} flexDirection="row" alignItems="center" gap={9} fill={false} flexShrink={1} minWidth={0}>
              <View
                width={20}
                height={20}
                borderRadius={10}
                alignItems="center"
                justifyContent="center"
                flexShrink={0}
                backgroundColor={(done ? t.v("ok") : current ? t.v("accent") : "transparent") as never}
                {...(!done && !current ? (edge(t, { top: 1.5, right: 1.5, bottom: 1.5, left: 1.5 }, "rule") as object) : {})}
              >
                <Txt spec={{ voice: "app", scale: 10.5 / 12.5, weight: 700, color: done || current ? "on-accent" : "dim" }}>{done ? "✓" : String(i + 1)}</Txt>
              </View>
              <View flexDirection="column" minWidth={0} flexShrink={1}>
                <Txt spec={{ voice: "app", scale: 10.5 / 12.5, color: current ? "accent" : "dim", weight: current ? 600 : 400 }} whiteSpace="nowrap">
                  {OPEN_STEP_LABELS[s]}
                </Txt>
                {s !== "go" ? (
                  <Txt spec={{ voice: "app", scale: 1, weight: 600, color: answers[s] !== undefined ? "text" : "dim" }} ellip minWidth={0} maxWidth={280}>
                    {answers[s] ?? "—"}
                  </Txt>
                ) : null}
              </View>
            </Press>
            {i < OPEN_STEPS.length - 1 ? <View flexGrow={1} height={1} minWidth={14} backgroundColor={t.v("rule") as never} /> : null}
          </View>
        );
      })}
    </View>
  );
}

function Foot({
  back,
  onBack,
  onCancel,
  primary,
  secondary,
  cancel,
}: {
  back: string | undefined;
  onBack: () => void;
  onCancel: () => void;
  primary: { label: string; disabled: boolean; onPress: () => void };
  secondary?: { label: string; onPress: () => void };
  cancel: boolean;
}): JSX.Element {
  const t = useTokens();
  return (
    <View flexDirection="row" alignItems="center" gap={8} paddingVertical={12} paddingHorizontal={20} {...(edge(t, { top: 1 }) as object)}>
      {back !== undefined ? (
        <Button kind="ghost" onPress={onBack}>
          {back}
        </Button>
      ) : null}
      <View flexGrow={1} />
      {cancel ? (
        <Button kind="ghost" onPress={onCancel}>
          Cancel
        </Button>
      ) : null}
      {secondary !== undefined ? <Button onPress={secondary.onPress}>{secondary.label}</Button> : null}
      <Button kind="primary" disabled={primary.disabled} onPress={primary.onPress}>
        {primary.label}
      </Button>
    </View>
  );
}

// --- the column of places --------------------------------------------------------------------------

const HEAD = { voice: "app", scale: 10.5 / 12.5, weight: 600, ls: 0.02, upper: true, color: "dim" } as const;

function Column({ children }: { children: ReactNode }): JSX.Element {
  const t = useTokens();
  return (
    <ScrollView
      {...(scrollbarProps(t) as object)}
      style={{ width: 232, flexGrow: 0, flexShrink: 0, backgroundColor: t.v("bg"), ...(edge(t, { right: 1 }) as object) } as never}
      contentContainerStyle={{ paddingVertical: 10, paddingHorizontal: 8, gap: 1 } as never}
    >
      {children}
    </ScrollView>
  );
}

function PlaceRow({
  label,
  chosen,
  onPress,
  right,
  dim = false,
  indent = false,
}: {
  label: string;
  chosen: boolean;
  onPress: () => void;
  right?: { text: string; tone: string } | undefined;
  dim?: boolean;
  indent?: boolean;
}): JSX.Element {
  const t = useTokens();
  return (
    <Press
      onPress={onPress}
      label={label}
      flexDirection="row"
      alignItems="center"
      gap={8}
      paddingVertical={5}
      paddingHorizontal={8}
      paddingLeft={indent ? 18 : 8}
      borderRadius={6}
      box={({ hovered }) => ({ backgroundColor: chosen ? t.v("tint-accent") : hovered ? t.v("fill-ghost-hover") : "transparent" })}
    >
      <Txt spec={{ voice: "app", scale: 1, weight: chosen ? 600 : 400, color: dim ? "dim" : "text" }} ellip flexGrow={1} flexShrink={1} minWidth={0}>
        {label}
      </Txt>
      {right !== undefined ? (
        <Txt spec={{ voice: "app", scale: 10.5 / 12.5, color: right.tone }} flexShrink={0}>
          {right.text}
        </Txt>
      ) : null}
    </Press>
  );
}

// --- 1 · the project ---------------------------------------------------------------------------------

function ProjectStep({
  machines,
  source,
  projects,
  browse,
  from,
  addingTo,
  onSource,
}: {
  machines: MachinesView | undefined;
  source: Source | undefined;
  projects: readonly ProjectGroup[];
  /** The machine whose folders it opens at, whatever is chosen. */
  browse?: string;
  /** The folder on `browse` it opens at. */
  from?: string;
  addingTo?: ProjectGroup;
  onSource: (s: Source) => void;
}): JSX.Element {
  // It opens where the project chosen is — its forge, or the machine its folder is on — so going back to
  // it shows that choice; with none, this machine's folders. Asked for a folder already on a machine, that
  // machine's.
  const [place, setPlace] = useState<Place | undefined>(
    browse !== undefined
      ? { kind: "machine", id: browse, label: labelOf(machines, browse) }
      : source?.kind === "forge"
      ? { kind: "forge", host: source.host, label: source.host }
      : source?.kind === "machine"
        ? { kind: "machine", id: source.machine, label: labelOf(machines, source.machine) }
        : machines !== undefined
          ? { kind: "machine", id: machines.self.id, label: machines.self.label }
          : undefined,
  );
  const [forges, setForges] = useState<ForgeRepositoriesView | { error: string } | undefined>(undefined);
  useEffect(() => {
    invoke("forge:repositories", {}).then(setForges, (e: unknown) => setForges({ error: e instanceof Error ? e.message : String(e) }));
  }, []);
  const hosts = forges !== undefined && !("error" in forges) ? [...new Map(forges.connections.map((c) => [c.host, c])).values()] : [];
  // The chosen project's forge, when no connection serves it: listed still, so the choice is shown.
  const unserved = source?.kind === "forge" && forges !== undefined && !hosts.some((c) => c.host === source.host) ? source.host : undefined;
  const groups = placeGroupsOf(machines);
  return (
    <>
      <Column>
        {groups.map((group) => (
          <View key={group.title} flexDirection="column" gap={1}>
            <Txt spec={HEAD} paddingTop={8} paddingHorizontal={8} paddingBottom={3}>
              {group.title === "This machine" ? "This machine" : group.title}
            </Txt>
            {group.machines.map((m) => (
              <PlaceRow
                key={m.id}
                label={m.label}
                chosen={place?.kind === "machine" && place.id === m.id}
                dim={!m.online}
                right={m.online ? undefined : { text: "offline", tone: "dim" }}
                onPress={() => (m.online ? setPlace({ kind: "machine", id: m.id, label: m.label }) : undefined)}
              />
            ))}
          </View>
        ))}
        <Txt spec={HEAD} paddingTop={12} paddingHorizontal={8} paddingBottom={3}>
          Forges
        </Txt>
        {hosts.map((c) => (
          <PlaceRow
            key={c.host}
            label={c.provider === "github" ? `GitHub${c.host !== "github.com" ? ` · ${c.host}` : ""}` : `GitLab${c.host !== "gitlab.com" ? ` · ${c.host}` : ""}`}
            chosen={place?.kind === "forge" && place.host === c.host}
            right={c.error !== undefined ? { text: "can't list", tone: "dim" } : undefined}
            onPress={() => setPlace({ kind: "forge", host: c.host, label: c.host })}
          />
        ))}
        {unserved !== undefined ? (
          <PlaceRow
            label={forgeLabel(unserved)}
            chosen={place?.kind === "forge" && place.host === unserved}
            right={{ text: "not signed in", tone: "dim" }}
            onPress={() => setPlace({ kind: "forge", host: unserved, label: unserved })}
          />
        ) : null}
        {forges !== undefined && hosts.length === 0 ? (
          <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim", lineHeight: 1.4 }} paddingHorizontal={8} paddingTop={2}>
            {"error" in forges ? forges.error : "No forge is signed in. Settings → Connections → Forges signs one in, or `gh auth login` / `glab auth login` on this machine."}
          </Txt>
        ) : null}
      </Column>
      <View flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0} gap={10} paddingVertical={14} paddingHorizontal={18}>
        {place?.kind === "machine" ? (
          <FolderPane
            key={place.id}
            machineId={place.id}
            self={place.id === machines?.self.id}
            selfId={machines?.self.id}
            label={place.label}
            source={source}
            groups={projects}
            {...(from !== undefined && place.id === browse ? { from } : {})}
            {...(addingTo !== undefined ? { addingTo } : {})}
            onSource={onSource}
          />
        ) : null}
        {place?.kind === "forge" && forges !== undefined ? (
          <RepoPane
            host={place.host}
            repos={"error" in forges ? [] : forges.repositories.filter((r) => r.host === place.host)}
            served={hosts.some((c) => c.host === place.host)}
            source={source}
            onSource={onSource}
          />
        ) : null}
      </View>
    </>
  );
}

function FolderPane({
  machineId,
  self,
  selfId,
  label,
  source,
  groups,
  from,
  addingTo,
  onSource,
}: {
  machineId: string;
  self: boolean;
  selfId: string | undefined;
  label: string;
  source: Source | undefined;
  groups: readonly ProjectGroup[];
  /** The folder it opens at, when nothing chosen is here. */
  from?: string;
  addingTo?: ProjectGroup;
  onSource: (s: Source) => void;
}): JSX.Element {
  const [listing, setListing] = useState<FolderListing | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const browse = (dir?: string): void => {
    setError(undefined);
    invoke("files:browse", { ...(self ? {} : { machine: machineId }), ...(dir !== undefined ? { dir } : {}) }).then(setListing, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };
  const chosenHere = source?.kind === "machine" && source.machine === machineId ? source.dir : undefined;
  useEffect(() => {
    setListing(undefined);
    browse(chosenHere !== undefined ? parentOf(chosenHere) : from);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machineId]);
  const choose = (dir: string, identity: string | undefined): void =>
    onSource({ kind: "machine", machine: machineId, dir, label: `${label} · ${dir.split(/[\\/]/).filter(Boolean).pop() ?? dir}`, ...(identity !== undefined ? { identity } : {}) });
  const hereName = listing !== undefined ? (listing.dir.split(/[\\/]/).filter(Boolean).pop() ?? listing.dir) : "";
  return (
    <>
      <View flexDirection="row" alignItems="center" gap={8}>
        <Txt spec={{ voice: "app", scale: 1, weight: 600 }}>{label}</Txt>
        <Txt spec={{ voice: "data", scale: 11 / 12, color: "dim" }} ellip flexShrink={1} minWidth={0}>
          {listing?.dir ?? ""}
        </Txt>
        <View flexGrow={1} />
        {listing?.here?.git === true ? (
          <Button kind={chosenHere === listing.dir ? "primary" : "ghost"} onPress={() => choose(listing.dir, listing.here?.identity)}>
            {chosenHere === listing.dir ? `${hereName} chosen` : `Choose ${hereName}`}
          </Button>
        ) : null}
        {listing?.roots.map((root) => (
          <Button key={root} kind="ghost" onPress={() => browse(root)}>
            {root}
          </Button>
        ))}
      </View>
      <List>
        {listing?.parent !== undefined ? <ListRow glyph="↑" name=".." onPress={() => browse(listing.parent)} /> : null}
        {(listing?.entries ?? []).map((entry) => (
          <ListRow
            key={entry.path}
            glyph="▸"
            name={entry.name}
            chosen={chosenHere === entry.path}
            chip={folderChip(entry, machineId, groups, selfId)}
            onPress={() => browse(entry.path)}
            action={{ label: chosenHere === entry.path ? "Chosen" : "Choose", onPress: () => choose(entry.path, entry.identity) }}
          />
        ))}
        {listing === undefined && error === undefined ? <Hint>Reading {label}…</Hint> : null}
        {listing?.entries.length === 0 ? <Hint>No folders here.</Hint> : null}
      </List>
      <Hint bad={error !== undefined}>
        {error ??
          (addingTo !== undefined
            ? `A folder of ${addingTo.label} on ${label} that isn't one of its workspaces yet is added where it is, nothing copied. One that is already a workspace is copied to make another.`
            : `A folder on ${label} is copied as it is: everything git doesn't ignore, with its commits and changes. Chosen and taken to ${label} itself, it opens there. A folder of a project you have becomes another of its workspaces.`)}
      </Hint>
    </>
  );
}

function RepoPane({
  host,
  repos,
  served,
  source,
  onSource,
}: {
  host: string;
  repos: ForgeRepositoryRow[];
  /** A connection serves the host: its repositories are listed. */
  served: boolean;
  source: Source | undefined;
  onSource: (s: Source) => void;
}): JSX.Element {
  const [search, setSearch] = useState("");
  const [branches, setBranches] = useState<ForgeBranch[] | undefined>(undefined);
  const chosen = source?.kind === "forge" && source.host === host ? source : undefined;
  // A forge's names are not case-sensitive: the remote a workspace was cloned by may spell one otherwise.
  const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
  const repoOf = (project: string): ForgeRepositoryRow | undefined => repos.find((r) => same(r.project, project));
  const shown = repos.filter((r) => search.trim() === "" || r.project.toLowerCase().includes(search.trim().toLowerCase())).slice(0, 200);
  // A project added from its remote names no branch: it is cloned at the default one.
  const branch = chosen !== undefined ? (chosen.branch ?? repoOf(chosen.project)?.defaultBranch) : undefined;
  useEffect(() => {
    setBranches(undefined);
    if (chosen === undefined || !served) return;
    invoke("forge:branches", { host, project: chosen.project }).then(setBranches, () => setBranches([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chosen?.project, served]);
  const pick = (repo: ForgeRepositoryRow, branch?: string): void =>
    onSource({ kind: "forge", host, project: repo.project, url: repo.cloneUrl, branch: branch ?? repo.defaultBranch, label: `${repo.project} · ${branch ?? repo.defaultBranch}` });
  const branchRow = branches ?? (branch !== undefined ? [{ name: branch, head: "" }] : []);
  return (
    <>
      <View flexDirection="row" alignItems="center" gap={8}>
        <Txt spec={{ voice: "app", scale: 1, weight: 600 }}>{host}</Txt>
        <Txt spec={{ voice: "app", scale: 11.5 / 12.5, color: "dim" }}>{served ? `${repos.length} repositories` : "not signed in"}</Txt>
        <View flexGrow={1} />
        {served ? <TextField value={search} onChange={setSearch} placeholder="Find a repository" label="Find a repository" width={200} /> : null}
      </View>
      <List>
        {chosen !== undefined && repoOf(chosen.project) === undefined ? <ListRow glyph="▸" name={chosen.project} chosen onPress={() => undefined} /> : null}
        {shown.map((repo) => (
          <ListRow
            key={repo.project}
            glyph="▸"
            name={repo.project}
            chosen={chosen !== undefined && same(chosen.project, repo.project)}
            chip={repo.private ? "private" : undefined}
            onPress={() => pick(repo)}
          />
        ))}
        {served && repos.length === 0 ? <Hint>No repositories this connection can reach.</Hint> : null}
      </List>
      {chosen !== undefined && branchRow.length > 0 ? (
        <View flexDirection="row" flexWrap="wrap" alignItems="center" gap={6}>
          <Txt spec={{ voice: "app", scale: 12 / 12.5, color: "dim" }}>Branch</Txt>
          {branchRow.slice(0, 12).map((b) => (
            <Button key={b.name} kind={b.name === branch ? "primary" : "ghost"} onPress={() => repoOf(chosen.project) && pick(repoOf(chosen.project)!, b.name)}>
              {b.name}
            </Button>
          ))}
        </View>
      ) : null}
      <Hint>
        {served
          ? "A repository is cloned at its branch, clean; Bring then adds the files git ignores from one of your machines."
          : `No forge connection serves ${host}, so its repositories aren't listed here and git clones ${chosen?.project ?? "one"} with what it has on the machine it goes to. Settings → Connections → Forges signs one in, or signing in to ${host} with gh or glab on this machine.`}
      </Hint>
    </>
  );
}

/** A forge host as the column names it: GitHub, GitLab (with the host when it is their own), else the host. */
function forgeLabel(host: string): string {
  if (/(^|\.)github\./.test(host)) return host === "github.com" ? "GitHub" : `GitHub · ${host}`;
  if (/(^|\.)gitlab\./.test(host)) return host === "gitlab.com" ? "GitLab" : `GitLab · ${host}`;
  return host;
}

/** The folder a folder is in, for browsing to it: `/srv/work/atlas` → `/srv/work`, `C:\src\atlas` → `C:\src`. */
function parentOf(dir: string): string | undefined {
  const cut = dir.replace(/[\\/]+$/, "").replace(/[\\/][^\\/]*$/, "");
  if (cut === "") return dir.startsWith("/") ? "/" : undefined;
  return /^[A-Za-z]:$/.test(cut) ? `${cut}\\` : cut;
}

// --- 2 · where it goes ---------------------------------------------------------------------------------

function WhereStep({
  machines,
  source,
  stays,
  target,
  plans,
  folder,
  onTarget,
  onFolder,
}: {
  machines: MachinesView | undefined;
  source: Source;
  /** The folder opens where it is when taken to its own machine — not one Add copies to make another. */
  stays: boolean;
  target: string | undefined;
  plans: Record<string, PlanState>;
  folder: { parent: string; name: string } | undefined;
  onTarget: (id: string) => void;
  onFolder: (f: { parent: string; name: string } | undefined) => void;
}): JSX.Element {
  const groups = placeGroupsOf(machines);
  // A folder that stays (`stays`): the machine it is on opens it where it is. One Add copies — already a
  // workspace of the project — has its machine as a place a copy goes, with its status like the rest.
  const itIs = stays && source.kind === "machine" ? source.machine : undefined;
  const statusOf = (id: string, onlineNow: boolean): { text: string; tone: string } | undefined => {
    if (!onlineNow) return { text: "offline", tone: "dim" };
    const plan = plans[id];
    if (plan === "loading" || plan === undefined) return { text: "…", tone: "dim" };
    if ("error" in plan) return { text: "can't", tone: "dim" };
    return readinessWords(plan);
  };
  const plan = target !== undefined ? plans[target] : undefined;
  const label = target === machines?.self.id ? machines?.self.label : machines?.machines.find((m) => m.id === target)?.label;
  return (
    <>
      <Column>
        {itIs !== undefined ? (
          <View flexDirection="column" gap={1}>
            <Txt spec={HEAD} paddingTop={8} paddingHorizontal={8} paddingBottom={3}>
              Where it is
            </Txt>
            <PlaceRow label={labelOf(machines, itIs)} chosen={target === itIs} right={{ text: "open it there", tone: "accent" }} onPress={() => onTarget(itIs)} />
          </View>
        ) : null}
        {groups.map((group) => {
          const rows = group.machines.filter((m) => m.id !== itIs);
          if (rows.length === 0) return null;
          return (
            <View key={group.title} flexDirection="column" gap={1}>
              <Txt spec={HEAD} paddingTop={8} paddingHorizontal={8} paddingBottom={3}>
                {itIs !== undefined && group.title === "This machine" ? "Copy it to" : group.title}
              </Txt>
              {rows.map((m) => (
                <PlaceRow key={m.id} label={m.label} chosen={target === m.id} dim={!m.online} right={statusOf(m.id, m.online)} onPress={() => (m.online ? onTarget(m.id) : undefined)} />
              ))}
            </View>
          );
        })}
      </Column>
      <View flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0} gap={10} paddingVertical={14} paddingHorizontal={18}>
        {target === undefined ? <Hint>Choose the machine it goes to.</Hint> : null}
        {target !== undefined && target === itIs && source.kind === "machine" ? (
          <Note tone="plain">{`It stays where it is: ${source.dir} on ${label ?? "that machine"} opens as a project there. Nothing is copied.`}</Note>
        ) : null}
        {target !== undefined && target !== itIs ? (
          plan === undefined || plan === "loading" ? (
            <Hint>Asking {label}…</Hint>
          ) : "error" in plan ? (
            <Hint bad>{plan.error}</Hint>
          ) : (
            <WherePane machineId={target} self={target === machines?.self.id} label={label ?? ""} plan={plan} folder={folder} onFolder={onFolder} />
          )
        ) : null}
      </View>
    </>
  );
}

function labelOf(machines: MachinesView | undefined, id: string): string {
  return id === machines?.self.id ? machines.self.label : (machines?.machines.find((m) => m.id === id)?.label ?? id);
}

/**
 * Where on the chosen machine the workspace's folder is made: the folder it goes in, browsed in columns
 * (the folder above it, it, and the folder being made), with the path across the top. How it looks:
 *
 *   a note           only when the machine can't simply take it (password, can't): --tint-warn
 *   the path         row, centred, gap 2, one line: each folder from the root a button (padding 3 6,
 *                    radius 6, --dim; hovered --panel-2), a "›" in --rule between; the folder it goes in
 *                    --text 600 on --panel-2; last, the new folder's name in --accent on --tint-accent
 *   the columns      row, filling the pane, 1px --line, radius 9, clipped; three columns 1 : 1 : 1.05,
 *                    a --line between
 *   a folder column  its folder's name (caps, 10.5 600, --dim, padding 8 10 6), then its folders,
 *                    scrolling: rows 27 tall, padding 0 8, gap 8, a 15 folder glyph (--dim), the name
 *                    (app 1, cut with "…"), a git or JaiRA project mark (12; JaiRA --accent), a "›"
 *                    (--dim); hovered --fill-ghost-hover. The left column is the folder above, the one
 *                    it goes in on --tint-accent with its glyph --accent; at a root, the machine's roots.
 *                    The middle column is the folder it goes in, the new folder among its folders where
 *                    it sorts: --tint-accent, a 2px --accent bar at its left, a folder-with-plus glyph,
 *                    its name --accent 600
 *   the new folder   padding 18 16, gap 10, a --panel-2 wash: the glyph at 40 in --accent, its name (app
 *                    15/12.5 700; while renaming a field), `made here` (--accent ground, --on-accent
 *                    600), why it's named so (folderNote, or "taken" in --warn when the folder it goes in
 *                    has one of that name already), its whole path (data, --text, wrapping anywhere),
 *                    and Rename at the foot
 *
 * In a pane narrower than 560 it is one column at a time: the folder it goes in, the new folder under it.
 */
function WherePane({
  machineId,
  self,
  label,
  plan,
  folder,
  onFolder,
}: {
  machineId: string;
  self: boolean;
  label: string;
  plan: WorkspacePlan;
  folder: { parent: string; name: string } | undefined;
  onFolder: (f: { parent: string; name: string } | undefined) => void;
}): JSX.Element {
  const t = useTokens();
  const [here, setHere] = useState<FolderListing | undefined>(undefined);
  const [up, setUp] = useState<FolderListing | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [renaming, setRenaming] = useState(false);
  const [narrow, setNarrow] = useState(false);
  // Only the answer to the latest click is shown: an earlier one arriving late is dropped.
  const asked = useRef(0);
  const defaultName = plan.dir.split(/[\\/]/).filter(Boolean).pop() ?? plan.name;
  const name = folder?.name ?? defaultName;
  const parent = folder?.parent ?? plan.projectsFolder;
  const ask = (dir: string): Promise<FolderListing> => invoke("files:browse", { ...(self ? {} : { machine: machineId }), dir });
  const go = (dir: string): void => {
    const n = ++asked.current;
    setError(undefined);
    ask(dir).then(
      (l) => {
        if (n !== asked.current) return;
        setHere(l);
        onFolder(l.dir === plan.projectsFolder && name === defaultName ? undefined : { parent: l.dir, name });
        if (l.parent === undefined) setUp(undefined);
        else
          ask(l.parent).then(
            (p) => n === asked.current && setUp(p),
            () => n === asked.current && setUp(undefined),
          );
      },
      (e: unknown) => n === asked.current && setError(e instanceof Error ? e.message : String(e)),
    );
  };
  useEffect(() => {
    go(parent);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machineId]);
  const rename = (v: string): void => onFolder({ parent: here?.dir ?? parent, name: v });
  const dir = here?.dir ?? parent;
  const full = joinPath(dir, name);
  const taken = here?.entries.some((e) => e.name === name) === true;
  const hereName = lastOf(dir);
  // The folder it goes in, with the new one where it sorts among its folders.
  const rows: ({ kind: "folder"; entry: FolderListing["entries"][number] } | { kind: "new" })[] = (here?.entries ?? []).map((entry) => ({ kind: "folder" as const, entry }));
  if (!taken) {
    const at = rows.findIndex((r) => r.kind === "folder" && r.entry.name.localeCompare(name, undefined, { sensitivity: "base" }) > 0);
    rows.splice(at === -1 ? rows.length : at, 0, { kind: "new" });
  } else rows.push({ kind: "new" });
  const middle = (
    <FolderColumn title={hereName} grow={1}>
      {rows.map((r) =>
        r.kind === "new" ? (
          <FolderCell key="+new" name={name} made onPress={() => setRenaming(true)} />
        ) : (
          <FolderCell key={r.entry.path} name={r.entry.name} git={r.entry.git} project={r.entry.project} onPress={() => go(r.entry.path)} />
        ),
      )}
      {here === undefined && error === undefined ? <Hint>Reading {label}…</Hint> : null}
    </FolderColumn>
  );
  const made = (
    <View
      flexBasis={0}
      flexGrow={narrow ? 0 : 1.05}
      flexShrink={1}
      minWidth={0}
      gap={10}
      paddingVertical={narrow ? 12 : 18}
      paddingHorizontal={16}
      backgroundColor={t.v("panel-2") as never}
      {...(narrow ? (edge(t, { top: 1 }) as object) : {})}
    >
      {narrow ? null : <Icon name="folderAdd" size={40} color={String(t.v("accent"))} />}
      {renaming ? (
        <TextField value={name} mono autoFocus label="Folder name" width="100%" onChange={rename} onSubmit={() => setRenaming(false)} onBlur={() => setRenaming(false)} />
      ) : (
        <Txt spec={{ voice: "app", scale: 15 / 12.5, weight: 700 }} ellip minWidth={0}>
          {name}
        </Txt>
      )}
      <View flexDirection="row">
        <View paddingHorizontal={7} borderRadius={99} backgroundColor={t.v("fill-accent") as never}>
          <Txt spec={{ voice: "app", scale: 10.5 / 12.5, weight: 600, color: "on-accent", lineHeight: 1.55 }}>made here</Txt>
        </View>
      </View>
      <Txt spec={{ voice: "app", scale: 11.5 / 12.5, lineHeight: 1.45, color: taken ? "warn" : "dim" }}>
        {taken ? `${hereName} already has a ${name}: rename it, or choose another folder.` : folder === undefined ? `A new folder: ${folderNote(plan)}.` : "A new folder, where you chose."}
      </Txt>
      <Txt spec={{ voice: "data", scale: 11.5 / 12, lineHeight: 1.45 }} minWidth={0} {...((isWeb ? { style: { overflowWrap: "anywhere" } } : {}) as object)}>
        {full}
      </Txt>
      <View flexGrow={1} />
      <View flexDirection="row">
        <Button kind="ghost" onPress={() => setRenaming(true)}>
          Rename
        </Button>
      </View>
    </View>
  );
  return (
    <>
      {plan.setup.readiness === "password" ? <Note tone="warn">{`Something ${plan.name} needs is installed with a password on ${label}; you'll be told the command.`}</Note> : null}
      {plan.setup.readiness === "cannot" ? <Note tone="warn">{`${label} can't set ${plan.name} up: ${plan.setup.steps.find((s) => s.status === "cannot")?.detail ?? "a step cannot run there"}.`}</Note> : null}
      <View flexDirection="row" alignItems="center" gap={2} minWidth={0} overflow="hidden">
        {crumbsOf(dir).map((c, i, all) => (
          <View key={c.path} flexDirection="row" alignItems="center" gap={2} flexShrink={i === all.length - 1 ? 0 : 1} minWidth={0}>
            {i > 0 ? <Txt spec={{ voice: "app", scale: 1, color: "rule" }}>›</Txt> : null}
            <Press
              onPress={() => go(c.path)}
              label={c.path}
              paddingVertical={3}
              paddingHorizontal={6}
              borderRadius={6}
              minWidth={0}
              box={({ hovered }) => ({ backgroundColor: i === all.length - 1 || hovered ? t.v("panel-2") : "transparent" })}
            >
              <Txt spec={{ voice: "app", scale: 1, weight: i === all.length - 1 ? 600 : 400, color: i === all.length - 1 ? "text" : "dim" }} ellip minWidth={0}>
                {c.label}
              </Txt>
            </Press>
          </View>
        ))}
        <Txt spec={{ voice: "app", scale: 1, color: "rule" }}>›</Txt>
        <Press onPress={() => setRenaming(true)} label={`Rename ${name}`} paddingVertical={3} paddingHorizontal={6} borderRadius={6} flexShrink={0} box={() => ({ backgroundColor: t.v("tint-accent") })}>
          <Txt spec={{ voice: "app", scale: 1, weight: 600, color: "accent" }}>{name}</Txt>
        </Press>
      </View>
      <View
        flexDirection={narrow ? "column" : "row"}
        flexGrow={1}
        flexShrink={1}
        minHeight={0}
        borderRadius={9}
        overflow="hidden"
        {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }) as object)}
        onLayout={(e: { nativeEvent: { layout: { width: number } } }) => setNarrow(e.nativeEvent.layout.width < 560)}
      >
        {narrow ? null : (
          <FolderColumn title={up !== undefined ? lastOf(up.dir) : label} grow={1}>
            {up !== undefined
              ? up.entries.map((e) => <FolderCell key={e.path} name={e.name} git={e.git} project={e.project} chosen={e.path === here?.dir} onPress={() => go(e.path)} />)
              : (here?.roots ?? []).map((root) => <FolderCell key={root} name={root} chosen={root === here?.dir} onPress={() => go(root)} />)}
          </FolderColumn>
        )}
        {middle}
        {made}
      </View>
      {error !== undefined ? <Hint bad>{error}</Hint> : null}
    </>
  );
}

/** A folder's own name, as a column heads it: `/srv/work` → `work`; a root is itself. */
function lastOf(dir: string): string {
  return dir.split(/[\\/]/).filter(Boolean).pop() ?? dir;
}

/** Each folder from the root down to `dir`, to go to: `/srv/work` → `/`, `srv`, `work`; `C:\src` → `C:`, `src`. */
function crumbsOf(dir: string): { label: string; path: string }[] {
  const windows = /^[A-Za-z]:/.test(dir);
  const sep = windows ? "\\" : "/";
  const parts = dir.split(/[\\/]/).filter(Boolean);
  const out: { label: string; path: string }[] = windows ? [] : [{ label: "/", path: "/" }];
  let at = windows ? "" : "";
  parts.forEach((p, i) => {
    at = windows ? (i === 0 ? `${p}${sep}` : joinPath(at, p)) : `${at}${sep}${p}`;
    out.push({ label: p, path: at });
  });
  return out;
}

function FolderColumn({ title, grow, children }: { title: string; grow: number; children: ReactNode }): JSX.Element {
  const t = useTokens();
  return (
    <View flexBasis={0} flexGrow={grow} flexShrink={1} minWidth={0} minHeight={0} {...(edge(t, { right: 1 }) as object)}>
      <Txt spec={HEAD} paddingTop={8} paddingHorizontal={10} paddingBottom={6} ellip>
        {title}
      </Txt>
      <ScrollView {...(scrollbarProps(t) as object)} style={{ flexGrow: 1, flexShrink: 1 } as never} contentContainerStyle={{ paddingBottom: 6 } as never}>
        {children}
      </ScrollView>
    </View>
  );
}

function FolderCell({
  name,
  git = false,
  project = false,
  chosen = false,
  made = false,
  onPress,
}: {
  name: string;
  git?: boolean;
  project?: boolean;
  chosen?: boolean;
  made?: boolean;
  onPress: () => void;
}): JSX.Element {
  const t = useTokens();
  const lit = chosen || made;
  return (
    <Press
      onPress={onPress}
      label={made ? `Rename ${name}` : name}
      flexDirection="row"
      alignItems="center"
      gap={8}
      height={27}
      paddingHorizontal={8}
      {...(made ? { borderLeftWidth: 2, borderLeftColor: t.v("accent"), borderStyle: "solid" } : {})}
      box={({ hovered }) => ({ backgroundColor: lit ? t.v("tint-accent") : hovered ? t.v("fill-ghost-hover") : "transparent" })}
    >
      <Icon name={made ? "folderAdd" : "folder"} size={15} color={String(t.v(lit ? "accent" : "dim"))} />
      <Txt spec={{ voice: "app", scale: 1, weight: made ? 600 : 400, color: made ? "accent" : "text" }} ellip flexGrow={1} flexShrink={1} minWidth={0}>
        {name}
      </Txt>
      {project ? <Icon name="diamond" size={12} color={String(t.v("accent"))} /> : git ? <Icon name="git" size={12} color={String(t.v("dim"))} /> : null}
      {made ? null : <Txt spec={{ voice: "app", scale: 1, color: "dim" }}>›</Txt>}
    </Press>
  );
}

// --- 3 · how it gets there --------------------------------------------------------------------------------

function HowStep({
  source,
  target,
  plan,
  choices,
  bringFrom,
  onBringFrom,
}: {
  source: Source;
  target: string;
  plan: PlanState | undefined;
  /** The machines Bring can take the files from (`bringChoices`): a copy's own first, then the project's others. */
  choices: readonly BringPlace[];
  /** The one it takes them from. */
  bringFrom: string | undefined;
  onBringFrom: (id: string) => void;
}): JSX.Element {
  const t = useTokens();
  if (plan === undefined || plan === "loading") return <Hint>Reading the project's setup…</Hint>;
  if ("error" in plan) return <Hint bad>{plan.error}</Hint>;
  const then = plan.setup.steps.filter((s) => s.status !== "brings");
  return (
    <ScrollView {...(scrollbarProps(t) as object)} style={{ flexGrow: 1 } as never} contentContainerStyle={{ paddingVertical: 16, paddingHorizontal: 28, gap: 18 } as never}>
      <Txt spec={{ voice: "app", scale: 13 / 12.5, lineHeight: 1.5 }}>{planSentence(source, target, plan)}</Txt>
      {source.kind === "machine" && plan.checkout !== undefined ? (
        <Section title={`Copied from ${source.label.split(" · ")[0]}`} sub="Everything git doesn't ignore, as it is right now">
          <View flexDirection="row" flexWrap="wrap" gap={18} paddingTop={8}>
            <Fact title={plan.checkout.branch ?? "a detached HEAD"} sub={plan.checkout.ahead > 0 ? `with ${plan.checkout.ahead} commit${plan.checkout.ahead === 1 ? "" : "s"} not pushed` : "nothing unpushed"} />
            <Fact title="Not committed yet" sub={`${plan.checkout.changed} changed, ${plan.checkout.untracked} new`} />
            <Fact title="Left behind" sub="what git ignores: dependencies, build output, the .env files" />
          </View>
        </Section>
      ) : null}
      {plan.bring.length > 0 ? (
        <Section title="Bring" sub="Files git ignores, which the code alone doesn't have">
          <View flexDirection="column" gap={6} paddingTop={6}>
            {plan.bring.map((pattern) => (
              <Txt key={pattern} spec={{ voice: "data", scale: 11.5 / 12 }}>
                {pattern}
              </Txt>
            ))}
            {choices.length > 0 ? (
              <View flexDirection="row" flexWrap="wrap" alignItems="center" gap={6}>
                <Txt spec={{ voice: "app", scale: 11.5 / 12.5, color: "dim" }}>from</Txt>
                {choices.map((m) => (
                  <Button key={m.machine} kind={bringFrom === m.machine ? "primary" : "ghost"} onPress={() => onBringFrom(m.machine)}>
                    {m.label}
                  </Button>
                ))}
              </View>
            ) : (
              <Txt spec={{ voice: "app", scale: 11.5 / 12.5, color: "dim" }}>There is no other workspace of it to bring them from.</Txt>
            )}
          </View>
        </Section>
      ) : null}
      <Section title="Then" sub={plan.setup.from === "file" ? "From the project's setup file, in this order" : plan.setup.from === "found" ? "Found in the project — it has no setup file" : "Nothing to set up"}>
        <View flexDirection="column" paddingTop={4}>
          {then.map((need, i) => {
            const words = needWords(need);
            return (
              <View key={`${need.label}-${i}`} flexDirection="row" alignItems="center" gap={10} paddingVertical={7} {...(edge(t, { bottom: 1 }) as object)}>
                <Txt spec={{ voice: "data", scale: 10 / 12, color: "dim" }} width={18}>
                  {String(i + 1)}
                </Txt>
                <View flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
                  <Txt spec={{ voice: "app", scale: 1 }} ellip>
                    {need.label}
                  </Txt>
                  {need.source !== undefined ? <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }}>{need.source}</Txt> : null}
                </View>
                <Txt spec={{ voice: "app", scale: 11 / 12.5, color: words.tone }} flexShrink={0} maxWidth="40%" ellip>
                  {words.text}
                </Txt>
              </View>
            );
          })}
          {plan.setup.problems?.map((p) => (
            <Hint key={p} bad>
              {p}
            </Hint>
          ))}
        </View>
      </Section>
    </ScrollView>
  );
}

function Section({ title, sub, children }: { title: string; sub: string; children: ReactNode }): JSX.Element {
  const t = useTokens();
  return (
    <View flexDirection="column">
      <View flexDirection="column" gap={2} paddingBottom={8} {...(edge(t, { bottom: 1 }) as object)}>
        <Txt spec={{ voice: "app", scale: 14 / 12.5, weight: 700 }}>{title}</Txt>
        <Txt spec={{ voice: "app", scale: 11.5 / 12.5, color: "dim" }}>{sub}</Txt>
      </View>
      {children}
    </View>
  );
}

function Fact({ title, sub }: { title: string; sub: string }): JSX.Element {
  return (
    <View flexDirection="column" gap={2} minWidth={160} flexShrink={1}>
      <Txt spec={{ voice: "app", scale: 1, weight: 600 }}>{title}</Txt>
      <Txt spec={{ voice: "app", scale: 11.5 / 12.5, color: "dim" }}>{sub}</Txt>
    </View>
  );
}

// --- 4 · go ------------------------------------------------------------------------------------------

function GoStep({ job, onCancel }: { job: WorkspaceJob | undefined; onCancel: () => void }): JSX.Element {
  const text = job?.text ?? "";
  const blocks = useMemo(() => jobBlocks(text), [text]);
  if (job === undefined) return <Hint>Starting…</Hint>;
  const phases: { key: WorkspaceJob["phase"]; label: string }[] = [
    { key: "fetch", label: job.request.source.kind === "forge" ? "Clone" : "Copy" },
    { key: "open", label: "Open as a project" },
    { key: "setup", label: "Set up" },
  ];
  const at = phases.findIndex((p) => p.key === job.phase);
  const done = job.finished;
  return (
    <View flexDirection="column" flexGrow={1} gap={12} paddingVertical={16} paddingHorizontal={28} minHeight={0} minWidth={0}>
      <View flexDirection="row" alignItems="center" gap={10}>
        <Txt spec={{ voice: "app", scale: 15 / 12.5, weight: 700 }} flexGrow={1} flexShrink={1} minWidth={0} ellip>
          {done === undefined ? `Making ${job.label}` : done.ok ? `${job.label} is ready` : `${job.label} stopped`}
        </Txt>
        <IconButton icon="copy" label="Copy the output" onPress={() => void copyText(blocks.map((b) => [...(b.command !== undefined ? [`$ ${b.command}`] : []), plainOf(b.text)].join("\n").replace(/\n+$/, "")).join("\n"))} />
        {done === undefined ? (
          <Button kind="danger" onPress={onCancel}>
            Stop
          </Button>
        ) : null}
      </View>
      <View flexDirection="column" gap={6}>
        {phases.map((p, i) => {
          const state = done !== undefined && done.ok ? "done" : i < at ? "done" : i === at ? (done !== undefined ? "failed" : "running") : "waiting";
          return (
            <View key={p.key} flexDirection="row" alignItems="center" gap={8}>
              <Txt spec={{ voice: "app", scale: 1, color: state === "done" ? "ok" : state === "failed" ? "bad" : state === "running" ? "accent" : "dim" }} width={16}>
                {state === "done" ? "✓" : state === "failed" ? "✕" : state === "running" ? "◌" : "·"}
              </Txt>
              <Txt spec={{ voice: "app", scale: 1, weight: state === "running" ? 600 : 400, color: state === "waiting" ? "dim" : "text" }}>{p.label}</Txt>
            </View>
          );
        })}
        {job.steps.map((s) => (
          <View key={s.index} flexDirection="row" alignItems="center" gap={8} paddingLeft={24}>
            <Txt spec={{ voice: "app", scale: 1, color: s.status === "done" || s.status === "skipped" ? "ok" : s.status === "failed" ? "bad" : "accent" }} width={16}>
              {s.status === "done" ? "✓" : s.status === "skipped" ? "–" : s.status === "failed" ? "✕" : "◌"}
            </Txt>
            <Txt spec={{ voice: "app", scale: 12 / 12.5 }} ellip flexShrink={1}>
              {s.label}
            </Txt>
            {s.detail !== undefined ? (
              <Txt spec={{ voice: "app", scale: 11 / 12.5, color: s.status === "failed" ? "bad" : "dim" }} ellip flexShrink={1}>
                {s.detail}
              </Txt>
            ) : null}
          </View>
        ))}
      </View>
      {done !== undefined && !done.ok ? <Note tone="warn">{done.reason ?? "It stopped."}</Note> : null}
      {done?.setup !== undefined && !done.setup.ok ? <Note tone="warn">{`It is made and open; its setup stopped: ${done.setup.reason ?? "a step failed"}.`}</Note> : null}
      <TermLog blocks={blocks} reset={job.jobId} fill minHeight={120} />
    </View>
  );
}

// --- bits ----------------------------------------------------------------------------------------------

function List({ children }: { children: ReactNode }): JSX.Element {
  const t = useTokens();
  return (
    <ScrollView
      {...(scrollbarProps(t) as object)}
      style={{ maxHeight: 300, flexGrow: 0, borderRadius: lengthToken(t, "control-radius", 7) as number, ...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }) as object) } as never}
      contentContainerStyle={{ paddingVertical: 4, paddingHorizontal: 6, gap: 1 } as never}
    >
      {children}
    </ScrollView>
  );
}

function ListRow({
  glyph,
  name,
  chip,
  chosen = false,
  dashed = false,
  onPress,
  action,
}: {
  glyph: string;
  name: string;
  chip?: string | undefined;
  chosen?: boolean;
  dashed?: boolean;
  onPress: () => void;
  action?: { label: string; onPress: () => void };
}): JSX.Element {
  const t = useTokens();
  return (
    <View flexDirection="row" alignItems="center" gap={6}>
      <Press
        onPress={onPress}
        label={name}
        flexDirection="row"
        alignItems="center"
        gap={8}
        paddingVertical={6}
        paddingHorizontal={10}
        borderRadius={5}
        flexGrow={1}
        flexShrink={1}
        minWidth={0}
        {...(dashed ? { borderWidth: 1.5, borderStyle: "dashed", borderColor: t.v("accent") } : {})}
        box={({ hovered }) => ({ backgroundColor: chosen ? t.v("tint-accent") : hovered ? t.v("panel-2") : "transparent" })}
      >
        <Txt spec={{ voice: "app", scale: 13 / 12.5, color: dashed ? "accent" : "dim" }} width={12} flexShrink={0}>
          {glyph}
        </Txt>
        <Txt spec={{ voice: "app", scale: 13 / 12.5, weight: chosen ? 600 : 400 }} ellip flexGrow={1} flexShrink={1} minWidth={0}>
          {name}
        </Txt>
        {chip !== undefined ? <Chip>{chip}</Chip> : null}
      </Press>
      {action !== undefined ? (
        <Button kind={chosen ? "primary" : "ghost"} onPress={action.onPress}>
          {action.label}
        </Button>
      ) : null}
    </View>
  );
}

function Hint({ children, bad = false }: { children: string | (string | undefined)[]; bad?: boolean }): JSX.Element {
  return (
    <Txt spec={{ voice: "app", scale: 11 / 12.5, lineHeight: 1.4, color: bad ? "bad" : "dim" }} padding={4}>
      {Array.isArray(children) ? children.join("") : children}
    </Txt>
  );
}

function Note({ children, tone }: { children: string; tone: "ok" | "warn" | "plain" }): JSX.Element {
  const t = useTokens();
  return (
    <View
      paddingVertical={9}
      paddingHorizontal={12}
      borderRadius={8}
      minWidth={0}
      flexShrink={0}
      backgroundColor={t.v(tone === "ok" ? "tint-ok" : tone === "warn" ? "tint-warn" : "panel-2") as never}
    >
      <Txt
        spec={{ voice: "app", scale: 12 / 12.5, lineHeight: 1.45, color: tone === "ok" ? "ok" : tone === "warn" ? "warn" : "text" }}
        minWidth={0}
        {...((isWeb ? { style: { whiteSpace: "pre-wrap", overflowWrap: "anywhere" } } : {}) as object)}
      >
        {children}
      </Txt>
    </View>
  );
}
