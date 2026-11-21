import { useEffect, useState, type JSX, type ReactNode } from "react";
import { View, isWeb } from "@tamagui/core";
import type {
  MachinesView,
  WorkspaceCreateRequest,
  WorkspacePlan,
  WorkspaceSource,
} from "@jaira/shared/browser";
import { faceOf } from "@jaira/ui/environmentModel";
import type { FloatRect } from "@jaira/ui/floatPlace";
import {
  addLines,
  bringChoices,
  needWords,
  type BringPlace,
  type WorkspaceJob,
} from "@jaira/ui/openProjectModel";
import { invoke } from "@jaira/ui/store";
import { Press, Txt, edge } from "../../primitives";
import { TokenScope, useTokens } from "../../tokens";
import { MachineIcon } from "../MachineIcon";
import { MenuLayer } from "../MenuLayer";
import { Icon } from "../panel/Icon";
import { Button } from "../settings/Button";
import { BrandIcon } from "../settings/bits";
import { Float } from "./Float";

type Source = WorkspaceSource & { label: string };
type PlanState = WorkspacePlan | { error: string } | "loading";

interface AddProps {
  anchor: FloatRect;
  source: Source;
  /** The project's name, for the title. */
  name: string;
  /** The machine it goes to. */
  machine: string;
  /** The machines holding a workspace of the project: where Bring can take the files git ignores from. */
  places: readonly BringPlace[];
  machines: MachinesView | undefined;
  jobs: Record<string, WorkspaceJob>;
  onCreate: (
    request: WorkspaceCreateRequest,
    label: string,
  ) => Promise<string | undefined>;
  onCancelJob: (jobId: string) => void;
  /** The full form at a step, everything filled in — or at Go, following the job. */
  onFull: (step: "project" | "where" | "how", job?: string) => void;
  onClose: () => void;
  /** The plan, given (the gallery): nothing is asked of the engine. */
  plan?: WorkspacePlan;
  /** A job already running (the gallery). */
  job?: string;
}

/**
 * Add, from a machine's row in the project's machine menu (decision 0027): another workspace of the
 * project on that machine, in four lines that are the full form's answers — and one button. How it looks:
 *
 *   the card       400 wide (the window less 16 at most), padding 8, radius 10, --panel ground, a --line
 *                  border, --lift shadow; under the menu it came from, where that menu stood
 *   the title      app 12.5 700, padding 4 8 8
 *   the lines      each a row, padding 7 8, radius 7 (hovered --fill-ghost-hover): its name in a 56 column
 *                  (app 10.5 600 caps, --dim), its answer (icons 14, app 12.5; the place --dim, a path in
 *                  data 11.5), at its right › (Project, Where: the full form at that step, filled in) or
 *                  ▾ (Bring, Then: open under the line)
 *   the foot       row, gap 6, padding 8 4 2, a --line above: More… (`ghost`: the full form at How), then
 *                  Cancel and `Add <machine>` (`primary`) at the right
 *
 * Once Add is pressed the card follows the job in place: Bring and Then give way to the phases (✓ done
 * --ok, ◌ running --accent, · to come --dim), the step running, and the last line it printed; the foot
 * has Details (the full form at Go, following it) and Stop — Done once it ends.
 */
export function AddWorkspacePop(props: AddProps): JSX.Element {
  // The card carries the tokens of the place it was opened from, the sidebar's: its ground and its inks.
  return (
    <MenuLayer onClose={props.onClose} closeOnResize={false}>
      <TokenScope scope="sidebar">
        <AddCard {...props} />
      </TokenScope>
    </MenuLayer>
  );
}

function AddCard({
  anchor,
  source,
  name,
  machine,
  places,
  machines,
  jobs,
  onCreate,
  onCancelJob,
  onFull,
  onClose,
  plan: given,
  job: givenJob,
}: AddProps): JSX.Element {
  const t = useTokens();
  const selfId = machines?.self.id;
  const [plan, setPlan] = useState<PlanState>(given ?? "loading");
  const [open, setOpen] = useState<"bring" | "then" | null>(null);
  const [jobId, setJobId] = useState<string | undefined>(givenJob);
  useEffect(() => {
    if (given !== undefined) return;
    invoke("workspace:plan", {
      source,
      ...(machine !== selfId ? { machine } : {}),
    }).then(setPlan, (e: unknown) =>
      setPlan({ error: e instanceof Error ? e.message : String(e) }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, machine]);

  const peer = machines?.machines.find((m) => m.id === machine);
  const label =
    machine === selfId
      ? (machines?.self.label ?? "this machine")
      : (peer?.label ?? machine);
  const at = machine === selfId ? machines?.self : peer;
  const face =
    at !== undefined
      ? faceOf({ form: at.form, os: at.os, state: peer?.state ?? "online" })
      : undefined;
  const fromAt =
    source.kind === "machine"
      ? source.machine === selfId
        ? machines?.self
        : machines?.machines.find((m) => m.id === source.machine)
      : undefined;
  const ready = plan !== "loading" && !("error" in plan) ? plan : undefined;
  // Where Bring takes the files from: said on its line, and sent, so the line is what happens.
  const from = bringChoices(source, machine, places)[0];
  const lines =
    ready !== undefined ? addLines(source, label, ready, from) : undefined;
  const job = jobId !== undefined ? jobs[jobId] : undefined;

  const add = async (): Promise<void> => {
    if (ready === undefined) return;
    const id = await onCreate(
      {
        source,
        ...(machine !== selfId ? { machine } : {}),
        ...(from !== undefined ? { bringFrom: from.machine } : {}),
      },
      `${ready.name} on ${label}`,
    );
    if (id !== undefined) setJobId(id);
  };

  const card = {
    width: 400,
    maxWidth: isWeb ? "calc(100vw - 16px)" : "95%",
    flexDirection: "column",
    gap: 1,
    padding: 8,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: t.v("line"),
    borderRadius: 10,
    backgroundColor: t.v("panel"),
    boxShadow: t.v("lift"),
    role: "dialog",
    "aria-label": `Add ${name} on ${label}`,
  };
  return (
    <Float anchor={anchor} side="below" align="start" settle {...card}>
      <Txt
        spec={{ voice: "app", scale: 1, weight: 700 }}
        paddingHorizontal={8}
        paddingTop={4}
        paddingBottom={8}
        ellip
      >
        {`Add ${name} on ${label}`}
      </Txt>
      {plan === "loading" ? (
        <Quiet>Reading the project's setup there…</Quiet>
      ) : null}
      {plan !== "loading" && "error" in plan ? (
        <Quiet bad>{plan.error}</Quiet>
      ) : null}
      {lines !== undefined ? (
        <>
          <Line
            name="Project"
            end="›"
            title="Choose another project or branch"
            onPress={() => onFull("project")}
          >
            {lines.project.mark === "github" ||
            lines.project.mark === "gitlab" ? (
              <BrandIcon name={lines.project.mark} size={14} />
            ) : lines.project.mark === "machine" && fromAt !== undefined ? (
              <MachineIcon
                face={faceOf({
                  form: fromAt.form,
                  os: fromAt.os,
                  state: "online",
                })}
                size={14}
              />
            ) : (
              <Icon name="git" size={14} color={String(t.v("dim"))} />
            )}
            <Txt spec={{ voice: "app", scale: 1, color: "dim" }} flexShrink={0}>
              {lines.project.place}
            </Txt>
            <Icon
              name={lines.project.mark === "machine" ? "folder" : "git"}
              size={13}
              color={String(t.v("dim"))}
              box={{ flexShrink: 0, marginLeft: 4 }}
            />
            <Txt
              spec={{ voice: "app", scale: 1, weight: 600 }}
              ellip
              flexShrink={1}
              minWidth={0}
            >
              {lines.project.name}
              {lines.project.branch !== undefined ? (
                <Txt
                  spec={{ voice: "app", scale: 1, color: "dim", weight: 400 }}
                >{` / ${lines.project.branch}`}</Txt>
              ) : null}
            </Txt>
          </Line>
          <Line
            name="Where"
            end="›"
            title="Choose another machine or folder"
            onPress={() => onFull("where")}
            sub={lines.where.note}
          >
            {face !== undefined ? <MachineIcon face={face} size={14} /> : null}
            <Txt spec={{ voice: "app", scale: 1 }} flexShrink={0}>
              {lines.where.machine}
            </Txt>
            <Icon
              name="folder"
              size={13}
              color={String(t.v("dim"))}
              box={{ flexShrink: 0, marginLeft: 4 }}
            />
            <Txt
              spec={{ voice: "data", scale: 11.5 / 12 }}
              ellip
              flexShrink={1}
              minWidth={0}
              {...({ title: lines.where.dir } as object)}
            >
              {tailPath(lines.where.dir)}
            </Txt>
          </Line>
          {job === undefined ? (
            <>
              <Line
                name="Bring"
                end={
                  lines.bring.patterns.length === 0
                    ? undefined
                    : open === "bring"
                      ? "▴"
                      : "▾"
                }
                onPress={
                  lines.bring.patterns.length === 0
                    ? undefined
                    : () => setOpen(open === "bring" ? null : "bring")
                }
              >
                <Txt
                  spec={{
                    voice: "app",
                    scale: 1,
                    color: lines.bring.patterns.length === 0 ? "dim" : "text",
                  }}
                  ellip
                  flexShrink={1}
                  minWidth={0}
                >
                  {lines.bring.text}
                </Txt>
              </Line>
              {open === "bring" ? (
                <Under>
                  {lines.bring.patterns.map((p) => (
                    <Txt key={p} spec={{ voice: "data", scale: 11.5 / 12 }}>
                      {p}
                    </Txt>
                  ))}
                  <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }}>
                    Files git ignores that the code alone doesn't have. More…
                    chooses where they come from.
                  </Txt>
                </Under>
              ) : null}
              <Line
                name="Then"
                end={
                  lines.then.count === 0
                    ? undefined
                    : open === "then"
                      ? "▴"
                      : "▾"
                }
                onPress={
                  lines.then.count === 0
                    ? undefined
                    : () => setOpen(open === "then" ? null : "then")
                }
              >
                <Txt
                  spec={{
                    voice: "app",
                    scale: 1,
                    color: lines.then.count === 0 ? "dim" : "text",
                  }}
                  ellip
                  flexShrink={1}
                  minWidth={0}
                >
                  {lines.then.text}
                </Txt>
              </Line>
              {open === "then" && ready !== undefined ? (
                <Under>
                  {ready.setup.steps
                    .filter((s) => s.status !== "brings")
                    .map((s, i) => {
                      const words = needWords(s);
                      return (
                        <View
                          key={`${s.label}-${i}`}
                          flexDirection="row"
                          alignItems="center"
                          gap={8}
                        >
                          <Txt
                            spec={{
                              voice: "data",
                              scale: 10 / 12,
                              color: "dim",
                            }}
                            width={14}
                            flexShrink={0}
                          >
                            {String(i + 1)}
                          </Txt>
                          <Txt
                            spec={{ voice: "app", scale: 12 / 12.5 }}
                            ellip
                            flexGrow={1}
                            flexShrink={1}
                            minWidth={0}
                          >
                            {s.label}
                          </Txt>
                          <Txt
                            spec={{
                              voice: "app",
                              scale: 11 / 12.5,
                              color: words.tone,
                            }}
                            flexShrink={0}
                            maxWidth="45%"
                            ellip
                          >
                            {words.text}
                          </Txt>
                        </View>
                      );
                    })}
                  {ready.setup.problems?.map((p) => (
                    <Txt
                      key={p}
                      spec={{ voice: "app", scale: 11 / 12.5, color: "bad" }}
                    >
                      {p}
                    </Txt>
                  ))}
                </Under>
              ) : null}
            </>
          ) : (
            <Progress job={job} />
          )}
        </>
      ) : null}
      <View
        flexDirection="row"
        alignItems="center"
        gap={6}
        paddingTop={8}
        paddingHorizontal={4}
        paddingBottom={2}
        marginTop={6}
        {...(edge(t, { top: 1 }) as object)}
      >
        {job === undefined ? (
          <>
            <Button kind="ghost" onPress={() => onFull("how")}>
              More…
            </Button>
            <View flexGrow={1} />
            <Button kind="ghost" onPress={onClose}>
              Cancel
            </Button>
            <Button
              kind="primary"
              disabled={
                ready === undefined || ready.setup.readiness === "cannot"
              }
              onPress={() => void add()}
            >
              {`Add ${label}`}
            </Button>
          </>
        ) : (
          <>
            <Button kind="ghost" onPress={() => onFull("how", job.jobId)}>
              Details
            </Button>
            <View flexGrow={1} />
            {job.finished === undefined ? (
              <Button kind="danger" onPress={() => onCancelJob(job.jobId)}>
                Stop
              </Button>
            ) : (
              <Button kind="primary" onPress={onClose}>
                Done
              </Button>
            )}
          </>
        )}
      </View>
    </Float>
  );
}

/** A path as the card shows it: its last three folders. */
function tailPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length <= 3 ? path : `…/${parts.slice(-3).join("/")}`;
}

function Line({
  name,
  end,
  title,
  onPress,
  sub,
  children,
}: {
  name: string;
  end?: string | undefined;
  title?: string;
  onPress?: (() => void) | undefined;
  sub?: string | undefined;
  children: ReactNode;
}): JSX.Element {
  const t = useTokens();
  const body = (
    <>
      <View flexDirection="row" alignItems="center" gap={10} minWidth={0}>
        <Txt
          spec={{
            voice: "app",
            scale: 10.5 / 12.5,
            weight: 600,
            ls: 0.02,
            upper: true,
            color: "dim",
          }}
          width={56}
          flexShrink={0}
        >
          {name}
        </Txt>
        <View
          flexDirection="row"
          alignItems="center"
          gap={6}
          flexGrow={1}
          flexShrink={1}
          minWidth={0}
        >
          {children}
        </View>
        {end !== undefined ? (
          <Txt
            spec={{ voice: "app", scale: 1, color: "dim" }}
            width={12}
            flexShrink={0}
            textAlign="center"
          >
            {end}
          </Txt>
        ) : null}
      </View>
      {sub !== undefined ? (
        <Txt
          spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }}
          paddingLeft={66}
          ellip
        >
          {sub}
        </Txt>
      ) : null}
    </>
  );
  if (onPress === undefined) {
    return (
      <View
        flexDirection="column"
        gap={2}
        paddingVertical={7}
        paddingHorizontal={8}
      >
        {body}
      </View>
    );
  }
  return (
    <Press
      onPress={onPress}
      label={`${name}${title !== undefined ? ` — ${title}` : ""}`}
      {...(title !== undefined ? { title } : {})}
      flexDirection="column"
      gap={2}
      paddingVertical={7}
      paddingHorizontal={8}
      borderRadius={7}
      box={({ hovered }) => ({
        backgroundColor: hovered ? t.v("fill-ghost-hover") : "transparent",
      })}
    >
      {body}
    </Press>
  );
}

function Under({ children }: { children: ReactNode }): JSX.Element {
  return (
    <View
      flexDirection="column"
      gap={5}
      paddingLeft={74}
      paddingRight={8}
      paddingBottom={6}
    >
      {children}
    </View>
  );
}

function Quiet({
  children,
  bad = false,
}: {
  children: string;
  bad?: boolean;
}): JSX.Element {
  return (
    <Txt
      spec={{
        voice: "app",
        scale: 11.5 / 12.5,
        lineHeight: 1.4,
        color: bad ? "bad" : "dim",
      }}
      paddingHorizontal={8}
      paddingVertical={6}
    >
      {children}
    </Txt>
  );
}

/** The job, in place of Bring and Then: its phases, the step running, the last line it printed. */
function Progress({ job }: { job: WorkspaceJob }): JSX.Element {
  const phases: { key: WorkspaceJob["phase"]; label: string }[] = [
    {
      key: "fetch",
      label: job.request.source.kind === "forge" ? "Clone" : "Copy",
    },
    { key: "open", label: "Open" },
    { key: "setup", label: "Set up" },
  ];
  const at = phases.findIndex((p) => p.key === job.phase);
  const done = job.finished;
  const running = [...job.steps].reverse().find((s) => s.status === "running");
  const last = job.text.trimEnd().split("\n").pop() ?? "";
  return (
    <View
      flexDirection="column"
      gap={6}
      paddingVertical={8}
      paddingHorizontal={8}
    >
      <View flexDirection="row" alignItems="center" gap={14}>
        {phases.map((p, i) => {
          const state =
            done !== undefined && done.ok
              ? "done"
              : i < at
                ? "done"
                : i === at
                  ? done !== undefined
                    ? "failed"
                    : "running"
                  : "waiting";
          return (
            <View key={p.key} flexDirection="row" alignItems="center" gap={5}>
              <Txt
                spec={{
                  voice: "app",
                  scale: 1,
                  color:
                    state === "done"
                      ? "ok"
                      : state === "failed"
                        ? "bad"
                        : state === "running"
                          ? "accent"
                          : "dim",
                }}
              >
                {state === "done"
                  ? "✓"
                  : state === "failed"
                    ? "✕"
                    : state === "running"
                      ? "◌"
                      : "·"}
              </Txt>
              <Txt
                spec={{
                  voice: "app",
                  scale: 1,
                  weight: state === "running" ? 600 : 400,
                  color: state === "waiting" ? "dim" : "text",
                }}
              >
                {p.label}
              </Txt>
            </View>
          );
        })}
      </View>
      {done === undefined && running !== undefined ? (
        <Txt spec={{ voice: "app", scale: 12 / 12.5 }} ellip>
          {running.label}
        </Txt>
      ) : null}
      {done !== undefined ? (
        <Txt
          spec={{
            voice: "app",
            scale: 12 / 12.5,
            color: done.ok && done.setup?.ok !== false ? "ok" : "warn",
          }}
          minWidth={0}
          {...((isWeb ? { style: { whiteSpace: "pre-wrap", overflowWrap: "anywhere" } } : {}) as object)}
        >
          {done.ok
            ? done.setup !== undefined && !done.setup.ok
              ? `Made and open; its setup stopped: ${done.setup.reason ?? "a step failed"}.`
              : `${job.label} is ready.`
            : (done.reason ?? "It stopped.")}
        </Txt>
      ) : last !== "" ? (
        <Txt spec={{ voice: "data", scale: 11 / 12, color: "dim" }} ellip>
          {last}
        </Txt>
      ) : null}
    </View>
  );
}
