import { useEffect, useMemo, useState, type JSX, type ReactNode } from "react";
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
import {
  OPEN_STEPS,
  OPEN_STEP_LABELS,
  folderNote,
  needWords,
  placeGroupsOf,
  planSentence,
  readinessWords,
  type OpenFlowStart,
  type OpenStep,
  type WorkspaceJob,
} from "@jaira/ui/openProjectModel";
import { invoke } from "@jaira/ui/store";
import { Press, Txt, edge, lengthToken, scrollbarProps } from "../../primitives";
import { useTokens } from "../../tokens";
import { Chip } from "../files/Chip";
import { Button } from "../settings/Button";
import { TextField } from "../settings/fields";
import { ModalBox } from "./Modal";

type Source = WorkspaceSource & { label: string };
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
 */
export function OpenProject({
  start,
  machines,
  jobs,
  onClose,
  onCreate,
  onCancelJob,
  onOpenThere,
  staged = false,
}: {
  start: OpenFlowStart;
  machines: MachinesView | undefined;
  jobs: Record<string, WorkspaceJob>;
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
  const openThere = source?.kind === "machine" && target === source.machine && chosenFolder === undefined;
  const job = jobId !== undefined ? jobs[jobId] : undefined;
  const title = start.mode === "add" ? `Add a workspace to ${start.name ?? source?.label ?? "the project"}` : "Open a project";

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
      ...(bringFrom !== undefined ? { bringFrom } : {}),
    };
    const id = await onCreate(request, `${plan?.name ?? source.label} on ${machineLabel(target)}`);
    if (id !== undefined) {
      setJobId(id);
      setStep("go");
    }
  };

  const verb = source?.kind === "forge" ? "Clone" : "Copy";
  const name = plan?.name ?? source?.label.split("/").pop() ?? "it";
  const secondary: { label: string; onPress: () => void } | undefined =
    step === "where" && start.mode === "add" && target !== undefined && !openThere ? { label: "Next: how it gets there", onPress: () => setStep("how") } : undefined;
  const primary: { label: string; disabled: boolean; onPress: () => void } =
    step === "project"
      ? { label: "Next: where it goes", disabled: source === undefined, onPress: () => setStep("where") }
      : step === "where"
        ? openThere
          ? { label: `Open ${name} on ${machineLabel(target)}`, disabled: false, onPress: () => void go() }
          : start.mode === "add" && target !== undefined
            ? { label: `Add ${machineLabel(target)}`, disabled: plan === undefined, onPress: () => void go() }
            : { label: "Next: how it gets there", disabled: target === undefined, onPress: () => setStep("how") }
        : step === "how"
          ? { label: start.mode === "add" ? `Add ${machineLabel(target)}` : `${verb} ${name} to ${machineLabel(target)}`, disabled: plan === undefined || plan.setup.readiness === "cannot", onPress: () => void go() }
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
            <ProjectStep machines={machines} source={source} onSource={(s) => {
              setSource(s);
              setPlans({});
            }} />
          ) : null}
          {step === "where" && source !== undefined ? (
            <WhereStep
              machines={machines}
              source={source}
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
            <HowStep source={source} target={machineLabel(target)} plan={targetPlan} machines={machines} bringFrom={bringFrom} onBringFrom={setBringFrom} />
          ) : null}
          {step === "go" ? <GoStep job={job} onCancel={() => jobId !== undefined && onCancelJob(jobId)} /> : null}
        </View>
        <Foot
          back={step === "where" && start.mode !== "add" ? "‹ Project" : step === "how" ? "‹ Where it goes" : undefined}
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

function ProjectStep({ machines, source, onSource }: { machines: MachinesView | undefined; source: Source | undefined; onSource: (s: Source) => void }): JSX.Element {
  const [place, setPlace] = useState<Place | undefined>(machines !== undefined ? { kind: "machine", id: machines.self.id, label: machines.self.label } : undefined);
  const [forges, setForges] = useState<ForgeRepositoriesView | { error: string } | undefined>(undefined);
  useEffect(() => {
    invoke("forge:repositories", {}).then(setForges, (e: unknown) => setForges({ error: e instanceof Error ? e.message : String(e) }));
  }, []);
  const hosts = forges !== undefined && !("error" in forges) ? [...new Map(forges.connections.map((c) => [c.host, c])).values()] : [];
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
        {forges !== undefined && hosts.length === 0 ? (
          <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim", lineHeight: 1.4 }} paddingHorizontal={8} paddingTop={2}>
            {"error" in forges ? forges.error : "No forge is signed in. Settings → Connections → Forges."}
          </Txt>
        ) : null}
      </Column>
      <View flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0} gap={10} paddingVertical={14} paddingHorizontal={18}>
        {place?.kind === "machine" ? <FolderPane machineId={place.id} self={place.id === machines?.self.id} label={place.label} source={source} onSource={onSource} /> : null}
        {place?.kind === "forge" && forges !== undefined && !("error" in forges) ? (
          <RepoPane host={place.host} repos={forges.repositories.filter((r) => r.host === place.host)} source={source} onSource={onSource} />
        ) : null}
      </View>
    </>
  );
}

function FolderPane({ machineId, self, label, source, onSource }: { machineId: string; self: boolean; label: string; source: Source | undefined; onSource: (s: Source) => void }): JSX.Element {
  const [listing, setListing] = useState<FolderListing | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const browse = (dir?: string): void => {
    setError(undefined);
    invoke("files:browse", { ...(self ? {} : { machine: machineId }), ...(dir !== undefined ? { dir } : {}) }).then(setListing, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };
  useEffect(() => {
    setListing(undefined);
    browse();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machineId]);
  const chosenHere = source?.kind === "machine" && source.machine === machineId ? source.dir : undefined;
  const choose = (dir: string): void => onSource({ kind: "machine", machine: machineId, dir, label: `${label} · ${dir.split(/[\\/]/).filter(Boolean).pop() ?? dir}` });
  return (
    <>
      <View flexDirection="row" alignItems="center" gap={8}>
        <Txt spec={{ voice: "app", scale: 1, weight: 600 }}>{label}</Txt>
        <Txt spec={{ voice: "data", scale: 11 / 12, color: "dim" }} ellip flexShrink={1} minWidth={0}>
          {listing?.dir ?? ""}
        </Txt>
        <View flexGrow={1} />
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
            chip={entry.project ? "JaiRA project" : entry.git ? "git" : undefined}
            onPress={() => browse(entry.path)}
            action={{ label: chosenHere === entry.path ? "Chosen" : "Choose", onPress: () => choose(entry.path) }}
          />
        ))}
        {listing === undefined && error === undefined ? <Hint>Reading {label}…</Hint> : null}
        {listing?.entries.length === 0 ? <Hint>No folders here.</Hint> : null}
      </List>
      <Hint bad={error !== undefined}>
        {error ?? `A folder on ${label} is copied as it is: everything git doesn't ignore, with its commits and changes. Chosen and taken to ${label} itself, it opens there.`}
      </Hint>
    </>
  );
}

function RepoPane({ host, repos, source, onSource }: { host: string; repos: ForgeRepositoryRow[]; source: Source | undefined; onSource: (s: Source) => void }): JSX.Element {
  const [search, setSearch] = useState("");
  const [branches, setBranches] = useState<ForgeBranch[] | undefined>(undefined);
  const chosen = source?.kind === "forge" && source.host === host ? source : undefined;
  const shown = repos.filter((r) => search.trim() === "" || r.project.toLowerCase().includes(search.trim().toLowerCase())).slice(0, 200);
  useEffect(() => {
    setBranches(undefined);
    if (chosen === undefined) return;
    invoke("forge:branches", { host, project: chosen.project }).then(setBranches, () => setBranches([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chosen?.project]);
  const pick = (repo: ForgeRepositoryRow, branch?: string): void =>
    onSource({ kind: "forge", host, project: repo.project, url: repo.cloneUrl, branch: branch ?? repo.defaultBranch, label: `${repo.project} · ${branch ?? repo.defaultBranch}` });
  const repoOf = (project: string): ForgeRepositoryRow | undefined => repos.find((r) => r.project === project);
  return (
    <>
      <View flexDirection="row" alignItems="center" gap={8}>
        <Txt spec={{ voice: "app", scale: 1, weight: 600 }}>{host}</Txt>
        <Txt spec={{ voice: "app", scale: 11.5 / 12.5, color: "dim" }}>{repos.length} repositories</Txt>
        <View flexGrow={1} />
        <TextField value={search} onChange={setSearch} placeholder="Find a repository" label="Find a repository" width={200} />
      </View>
      <List>
        {shown.map((repo) => (
          <ListRow
            key={repo.project}
            glyph="▸"
            name={repo.project}
            chosen={chosen?.project === repo.project}
            chip={repo.private ? "private" : undefined}
            onPress={() => pick(repo)}
          />
        ))}
        {repos.length === 0 ? <Hint>No repositories this connection can reach.</Hint> : null}
      </List>
      {chosen !== undefined ? (
        <View flexDirection="row" flexWrap="wrap" alignItems="center" gap={6}>
          <Txt spec={{ voice: "app", scale: 12 / 12.5, color: "dim" }}>Branch</Txt>
          {(branches ?? [{ name: chosen.branch ?? "main", head: "" }]).slice(0, 12).map((b) => (
            <Button key={b.name} kind={b.name === chosen.branch ? "primary" : "ghost"} onPress={() => repoOf(chosen.project) && pick(repoOf(chosen.project)!, b.name)}>
              {b.name}
            </Button>
          ))}
        </View>
      ) : null}
      <Hint>A repository is cloned at its branch, clean; Bring then adds the files git ignores from one of your machines.</Hint>
    </>
  );
}

// --- 2 · where it goes ---------------------------------------------------------------------------------

function WhereStep({
  machines,
  source,
  target,
  plans,
  folder,
  onTarget,
  onFolder,
}: {
  machines: MachinesView | undefined;
  source: Source;
  target: string | undefined;
  plans: Record<string, PlanState>;
  folder: { parent: string; name: string } | undefined;
  onTarget: (id: string) => void;
  onFolder: (f: { parent: string; name: string } | undefined) => void;
}): JSX.Element {
  const groups = placeGroupsOf(machines);
  const statusOf = (id: string, onlineNow: boolean): { text: string; tone: string } | undefined => {
    if (!onlineNow) return { text: "offline", tone: "dim" };
    if (source.kind === "machine" && source.machine === id) return { text: "has it", tone: "dim" };
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
        {source.kind === "machine" ? (
          <View flexDirection="column" gap={1}>
            <Txt spec={HEAD} paddingTop={8} paddingHorizontal={8} paddingBottom={3}>
              Where it is
            </Txt>
            <PlaceRow label={labelOf(machines, source.machine)} chosen={target === source.machine} right={{ text: "open it there", tone: "accent" }} onPress={() => onTarget(source.machine)} />
          </View>
        ) : null}
        {groups.map((group) => {
          const rows = group.machines.filter((m) => !(source.kind === "machine" && m.id === source.machine));
          if (rows.length === 0) return null;
          return (
            <View key={group.title} flexDirection="column" gap={1}>
              <Txt spec={HEAD} paddingTop={8} paddingHorizontal={8} paddingBottom={3}>
                {source.kind === "machine" && group.title === "This machine" ? "Copy it to" : group.title}
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
        {target !== undefined && source.kind === "machine" && target === source.machine ? (
          <Note tone="plain">{`It stays where it is: ${source.dir} on ${label ?? "that machine"} opens as a project there. Nothing is copied.`}</Note>
        ) : null}
        {target !== undefined && !(source.kind === "machine" && target === source.machine) ? (
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
  const [listing, setListing] = useState<FolderListing | undefined>(undefined);
  const defaultName = plan.dir.split(/[\\/]/).filter(Boolean).pop() ?? plan.name;
  const name = folder?.name ?? defaultName;
  const parent = folder?.parent ?? plan.projectsFolder;
  const browse = (dir: string): void => {
    invoke("files:browse", { ...(self ? {} : { machine: machineId }), dir }).then(
      (l) => {
        setListing(l);
        onFolder(l.dir === plan.projectsFolder && name === defaultName ? undefined : { parent: l.dir, name });
      },
      () => setListing(undefined),
    );
  };
  useEffect(() => {
    browse(parent);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machineId]);
  const words = readinessWords(plan);
  const full = joinPath(listing?.dir ?? parent, name);
  return (
    <>
      <View flexDirection="row" alignItems="center" gap={8}>
        <Txt spec={{ voice: "app", scale: 1, weight: 600 }} flexShrink={0} whiteSpace="nowrap">
          {label}
        </Txt>
        {words !== undefined ? (
          <Txt spec={{ voice: "app", scale: 11.5 / 12.5, color: words.tone }} flexShrink={0}>
            {words.text}
          </Txt>
        ) : null}
        <View flexGrow={1} />
        <Txt spec={{ voice: "data", scale: 11 / 12, color: "dim" }} ellip flexShrink={1} minWidth={0}>
          {listing?.dir ?? parent}
        </Txt>
      </View>
      {plan.setup.readiness === "ready" ? <Note tone="ok">{`Ready for ${plan.name}: what it needs is already on ${label}.`}</Note> : null}
      {plan.setup.readiness === "password" ? <Note tone="warn">{`Something ${plan.name} needs is installed with a password on ${label}; you'll be told the command.`}</Note> : null}
      {plan.setup.readiness === "cannot" ? <Note tone="warn">{`${label} can't set ${plan.name} up: ${plan.setup.steps.find((s) => s.status === "cannot")?.detail ?? "a step cannot run there"}.`}</Note> : null}
      <List>
        {listing?.parent !== undefined ? <ListRow glyph="↑" name=".." onPress={() => browse(listing.parent!)} /> : null}
        {(listing?.entries ?? []).map((entry) => (
          <ListRow key={entry.path} glyph="▸" name={entry.name} chip={entry.project ? "JaiRA project" : entry.git ? "git" : undefined} onPress={() => browse(entry.path)} />
        ))}
        <ListRow glyph="+" name={`${name} — made here`} chosen dashed onPress={() => undefined} />
      </List>
      <View flexDirection="row" alignItems="center" gap={10}>
        <Txt spec={{ voice: "app", scale: 11.5 / 12.5, color: "dim" }} width={84}>
          Folder name
        </Txt>
        <TextField value={name} mono onChange={(v) => onFolder({ parent: listing?.dir ?? parent, name: v })} label="Folder name" width={240} />
      </View>
      <View flexDirection="row" alignItems="center" gap={10}>
        <Txt spec={{ voice: "app", scale: 11.5 / 12.5, color: "dim" }} width={84}>
          Full path
        </Txt>
        <Txt spec={{ voice: "data", scale: 11.5 / 12 }} ellip flexShrink={1} minWidth={0}>
          {full}
        </Txt>
        <Txt spec={{ voice: "app", scale: 11.5 / 12.5, color: "dim" }} ellip flexShrink={1} minWidth={0}>
          {folder === undefined ? `· ${folderNote(plan)}` : "· a folder of your own"}
        </Txt>
      </View>
      <Hint>To put it somewhere else, open any folder above. {label}'s projects folder is set in Settings → Machines.</Hint>
    </>
  );
}

// --- 3 · how it gets there --------------------------------------------------------------------------------

function HowStep({
  source,
  target,
  plan,
  machines,
  bringFrom,
  onBringFrom,
}: {
  source: Source;
  target: string;
  plan: PlanState | undefined;
  machines: MachinesView | undefined;
  bringFrom: string | undefined;
  onBringFrom: (id: string | undefined) => void;
}): JSX.Element {
  const t = useTokens();
  if (plan === undefined || plan === "loading") return <Hint>Reading the project's setup…</Hint>;
  if ("error" in plan) return <Hint bad>{plan.error}</Hint>;
  const then = plan.setup.steps.filter((s) => s.status !== "brings");
  const from = [{ id: undefined as string | undefined, label: source.kind === "machine" ? source.label.split(" · ")[0]! : "automatic" }, ...(machines !== undefined ? [machines.self, ...machines.machines.filter((m) => m.state === "online")].map((m) => ({ id: m.id as string | undefined, label: m.label })) : [])];
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
            <View flexDirection="row" flexWrap="wrap" alignItems="center" gap={6}>
              <Txt spec={{ voice: "app", scale: 11.5 / 12.5, color: "dim" }}>from</Txt>
              {from.map((m) => (
                <Button key={m.id ?? "auto"} kind={bringFrom === m.id ? "primary" : "ghost"} onPress={() => onBringFrom(m.id)}>
                  {m.label}
                </Button>
              ))}
            </View>
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
  const t = useTokens();
  if (job === undefined) return <Hint>Starting…</Hint>;
  const phases: { key: WorkspaceJob["phase"]; label: string }[] = [
    { key: "fetch", label: job.request.source.kind === "forge" ? "Clone" : "Copy" },
    { key: "open", label: "Open as a project" },
    { key: "setup", label: "Set up" },
  ];
  const at = phases.findIndex((p) => p.key === job.phase);
  const done = job.finished;
  return (
    <View flexDirection="column" flexGrow={1} gap={12} paddingVertical={16} paddingHorizontal={28} minHeight={0}>
      <View flexDirection="row" alignItems="center" gap={10}>
        <Txt spec={{ voice: "app", scale: 15 / 12.5, weight: 700 }} flexGrow={1}>
          {done === undefined ? `Making ${job.label}` : done.ok ? `${job.label} is ready` : `${job.label} stopped`}
        </Txt>
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
      <ScrollView
        {...(scrollbarProps(t) as object)}
        style={{ flexGrow: 1, flexShrink: 1, minHeight: 120, borderRadius: lengthToken(t, "control-radius", 7) as number, backgroundColor: t.v("panel-2"), ...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }) as object) } as never}
        contentContainerStyle={{ padding: 10 } as never}
      >
        <Txt spec={{ voice: "data", scale: 11 / 12, color: "dim" }}>{job.text.split("\n").slice(-200).join("\n")}</Txt>
      </ScrollView>
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
      backgroundColor={t.v(tone === "ok" ? "tint-ok" : tone === "warn" ? "tint-warn" : "panel-2") as never}
    >
      <Txt spec={{ voice: "app", scale: 12 / 12.5, lineHeight: 1.45, color: tone === "ok" ? "ok" : tone === "warn" ? "warn" : "text" }}>{children}</Txt>
    </View>
  );
}
