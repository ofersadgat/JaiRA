import { useState, type JSX, type ReactNode } from "react";
import { ScrollView } from "react-native";
import { View, isWeb } from "@tamagui/core";
import type { AvailabilitySnapshot, ConversationView, SessionRef, SessionView, TaskDetail, WorkflowLayer } from "@jaira/shared/browser";
import { BADGE } from "@jaira/ui/panelFaceModel";
import { debugFileStatus, debugViewOf, readinessOf, verdictWord } from "@jaira/ui/debugModel";
import { SELF_TEST_ROOT } from "@jaira/ui/debugWorkflow";
import type { DebugFile, DebugState } from "@jaira/ui/store";
import { PLAIN_SCROLLER, Press, Txt, appCh, edge, lengthToken, scrollbarProps, useHover, type FontSpec } from "../../primitives";
import { useTokens } from "../../tokens";
import { Button } from "../settings/Button";
import { Conversation } from "./Conversation";
import { SessionPanel } from "./SessionPanel";

/**
 * The Debug room's page: the self-test — what it runs, where its state files come from, the buttons that
 * run it, and its result. What it derives is `debugModel.ts`. What was said under a result is
 * `SessionPanel.tsx`; the journal under it is `Conversation.tsx`. The side panel beside it is the
 * shell's (`PanelColumn`), handed in by `DebugView.tsx`. How it looks:
 *
 *   the page           --bg, scrolls, padding 12 14, column, gap 16; sections column, gap 8
 *   its heading        700, app at 15/12.5, 4 below;  the words under it at most 70ch, line 1.5
 *   a section's head   700, app at 11/12.5, 0.09em, uppercase, --dim, 8 below (not collapsing: a
 *                      flex column)
 *   the stages         20 in on the left, column, gap 6; each app at 12/12.5 on 1.6, its number
 *                      outside; its names data at 11/12, the words between them --dim
 *   the state files    a summary, app at 12/12.5 --dim, a disclosure triangle before it; open: each
 *                      file's name (--dim, the data face at app 11/12.5) and text (an output box), 8 apart
 *   a notice           --tint-accent, radius --control-radius, padding 7 9, app at 11/12.5, --dim;
 *                      warn --tint-warn/--warn, bad --tint-bad/--bad; a clickable one is a button
 *   a file's row       row, gap 8, centred, padding 4 6, radius 4, app at 12/12.5; hovered --panel-2;
 *                      the dot 7 round (--ok, --bad, --dim); its name data at 11/12; a chip; a link
 *   the actions        row, centred, gap 6, wrapping
 *   the verdict        row, gap 10, baseline, padding 10 12, radius --card-radius, the tone's tint; the
 *                      word 700 at app 18/12.5, 0.06em, the tone's colour
 *   a field            column, gap 4; its label app at 11/12.5, --dim, 0.04em, uppercase
 *   an output box      --bg, 1px --line, radius 8, padding 8, data at 11/12, at most 220 tall, pre-wrap
 */
export interface DebugPaneProps {
  debug: DebugState;
  detail: TaskDetail | null;
  /** The selected task's journal, read as turns (`state.conversation`). */
  conversation: ConversationView | null;
  /** The states the task ran, the one on screen and the answer being written (the shell's state). */
  sessionHistory: SessionRef[];
  session: SessionView | null;
  sessionInstance: string | null;
  liveTurn: { sessionId?: string; seq?: number; text: string } | null;
  onShowSession: (instanceId: string | null) => void;
  availability: AvailabilitySnapshot;
  hasProject: boolean;
  onRun: (options: { scripted?: boolean; fresh?: boolean }) => void;
  onCancel: () => void;
  onRecheck: () => void;
  onDismissError: () => void;
  onOpenState: (stateId: string, layer: WorkflowLayer) => void;
  /** The shell's side panel column. */
  panel?: ReactNode;
}

const SUB: FontSpec = { voice: "app", scale: 11 / 12.5, color: "dim" };

export function DebugPane({
  debug,
  detail,
  conversation,
  sessionHistory,
  session,
  sessionInstance,
  liveTurn,
  onShowSession,
  availability,
  hasProject,
  onRun,
  onCancel,
  onRecheck,
  onDismissError,
  onOpenState,
  panel,
}: DebugPaneProps): JSX.Element {
  const t = useTokens();
  const { mine, run, result, running, missing, overridden } = debugViewOf(debug, detail);
  const verdict = verdictWord(result.passed);
  return (
    <View flex={1} minWidth={0} minHeight={0} flexDirection="row">
      <ScrollView
        style={{ flex: 1, minWidth: 0, backgroundColor: t.v("bg") as string, ...PLAIN_SCROLLER } as never}
        contentContainerStyle={{ paddingVertical: 12, paddingHorizontal: 14, gap: 16, ...PLAIN_SCROLLER } as never}
        {...scrollbarProps(t)}
      >
        <View>
          <Txt spec={{ voice: "app", scale: 15 / 12.5, weight: 700 }} marginBottom={4}>
            Workflow self-test
          </Txt>
          <Txt spec={{ ...SUB, lineHeight: 1.5 }} maxWidth={appCh(t, 11 / 12.5, 70) as number}>
            Two prompt states run in sequence. The first is asked to say hello world; the second takes what it said as a declared input and reports whether it did. A pass means the model answered{" "}
            <Txt spec={{ ...SUB, lineHeight: 1.5, italic: true }}>and</Txt> that its output was validated, bound and carried into the next state.
          </Txt>
        </View>

        <Section title="What it runs">
          <View paddingLeft={20} flexDirection="column" gap={6}>
            <Stage n={1}>
              <Mono>{`${SELF_TEST_ROOT}/say`}</Mono>
              <StageSub>asks for the greeting, publishes it as </StageSub>
              <Mono>greeting: string</Mono>
            </Stage>
            <Stage n={2}>
              <Mono>{`${SELF_TEST_ROOT}/check`}</Mono>
              <StageSub>reads </StageSub>
              <Mono>.children.say.output.greeting</Mono>
              <StageSub>, publishes </StageSub>
              <Mono>passed: boolean</Mono>
              <StageSub> and </StageSub>
              <Mono>verdict: string</Mono>
            </Stage>
          </View>
          <Disclosure summary="The state files, as they load">
            {debug.files.map((f) => (
              <View key={f.stateId} marginTop={8}>
                <Txt spec={{ voice: "data", scale: 11 / 12, color: "dim" }} fontSize={t.scaled("size-app", 11 / 12.5)}>
                  {f.file || `${f.stateId}.json`}
                </Txt>
                <Outputs>{f.text}</Outputs>
              </View>
            ))}
          </Disclosure>
        </Section>

        <Section title="Where it comes from">
          <Notice>
            The self-test ships with JaiRA, so there is nothing to install and it runs with nothing in the shared root. A copy of one of its states in <Code>~/.jaira</Code> wins over the built-in one, as an override of any built-in does.
          </Notice>
          {debug.files.map((f) => (
            <FileRow key={f.stateId} file={f} onOpen={() => (f.layer === null ? undefined : onOpenState(f.stateId, f.layer))} />
          ))}
          {missing > 0 ? (
            <Notice tone="bad">
              {missing === 1 ? "One state was" : `${missing} states were`} found in no layer, so the run cannot start. The built-in layer is missing from this build.
            </Notice>
          ) : null}
          {overridden.length > 0 ? (
            <Notice tone="warn">
              {overridden.length === 1 ? "One state loads" : `${overridden.length} states load`} from the shared root instead of from what ships, and a run uses what loads.
            </Notice>
          ) : null}
          <Actions>
            <Button kind="ghost" disabled={debug.busy} onPress={onRecheck}>
              Re-check
            </Button>
          </Actions>
        </Section>

        <Section title="Run it">
          <Readiness availability={availability} />
          {!hasProject ? <Notice tone="warn">No project is open. A task belongs to a checkout, so open one from Settings before running.</Notice> : null}
          <Actions>
            <Button disabled={debug.busy || running || !hasProject} onPress={() => onRun({})}>
              Run (live LLM)
            </Button>
            <Button kind="ghost" disabled={debug.busy || running || !hasProject} onPress={() => onRun({ scripted: true })} title="Replaces the model with canned replies — exercises everything except the provider">
              Run scripted
            </Button>
            <Button kind="ghost" disabled={debug.busy || running || !hasProject || debug.taskId === null} onPress={() => onRun({ fresh: true })} title="A new task, rather than another run on the last one">
              New task
            </Button>
            <Button kind="ghost" disabled={!running} onPress={onCancel}>
              Cancel
            </Button>
          </Actions>
          {debug.error !== null ? (
            <Press onPress={onDismissError} alignSelf="stretch" borderRadius={lengthToken(t, "control-radius", 7)} paddingVertical={7} paddingHorizontal={9} box={({ hovered }) => ({ backgroundColor: hovered ? t.tint("bad", 18) : t.v("tint-bad") })}>
              <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "bad" }}>{debug.error}</Txt>
            </Press>
          ) : null}
        </Section>

        {mine !== null ? (
          <Section title="Result">
            {run === undefined ? (
              <Txt spec={{ voice: "app", scale: 13 / 12.5, color: "dim" }} paddingVertical={8}>
                Started — no run has settled yet.
              </Txt>
            ) : (
              <>
                <View flexDirection="row" gap={10} alignItems="baseline" paddingVertical={10} paddingHorizontal={12} borderRadius={lengthToken(t, "card-radius", 10)} backgroundColor={t.v(verdict.tone === "good" ? "tint-ok" : verdict.tone === "bad" ? "tint-bad" : "tint-warn") as never}>
                  <Badge status={mine.status} />
                  <Txt spec={{ voice: "app", scale: 18 / 12.5, weight: 700, ls: 0.06, color: verdict.tone === "good" ? "ok" : verdict.tone === "bad" ? "bad" : "warn" }}>{verdict.word}</Txt>
                  <Txt spec={SUB}>{run.outcome}</Txt>
                </View>
                {result.greeting !== undefined ? <Field label="the greeting">{result.greeting}</Field> : null}
                {result.verdict !== undefined ? <Field label="the judgement">{result.verdict}</Field> : null}
                {result.passed === null && run.outcome !== "running" ? (
                  <Notice tone="warn">The run settled without publishing a verdict — look at the instance tree and the events beside it for where it stopped.</Notice>
                ) : null}
                {run.failure !== undefined ? <Outputs>{JSON.stringify(run.failure, null, 2)}</Outputs> : null}
              </>
            )}
          </Section>
        ) : null}

        {mine !== null ? (
          <Section title="What was actually said">
            {/* The prompts and replies verbatim, per state (320 tall). */}
            <SessionPanel history={sessionHistory} session={session} showing={sessionInstance} live={liveTurn} onShow={onShowSession} />
          </Section>
        ) : null}
        {mine !== null ? (
          <Section title="Journal">
            <Conversation conversation={conversation} />
          </Section>
        ) : null}
      </ScrollView>
      {panel}
    </View>
  );
}


/** A section: its heading, then what it holds, 8 apart. */
function Section({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <View flexDirection="column" gap={8}>
      <Txt spec={{ voice: "app", scale: 11 / 12.5, weight: 700, ls: 0.09, upper: true, color: "dim" }} marginBottom={8}>
        {title}
      </Txt>
      {children}
    </View>
  );
}

/** One stage of the numbered list: its number outside, its words on a line of 1.6. */
function Stage({ n, children }: { n: number; children: ReactNode }): JSX.Element {
  const t = useTokens();
  const spec: FontSpec = { voice: "app", scale: 12 / 12.5, lineHeight: 1.6 };
  const size = t.scaled("size-app", 12 / 12.5);
  const space = 0.26 * (typeof size === "number" ? size : 12);
  return (
    // The number stands where a list item's outside marker would: right-aligned in the list's 20px, a
    // space short of the words (DM Sans's space: 0.26 of the size). On web it is hung in the flow from a
    // box of no size, so the item is not positioned (a positioned box is painted after what is not).
    isWeb ? (
      <View>
        <View width={0} height={0}>
          <Txt spec={spec} flexShrink={0} marginLeft={-20} width={20 - space} textAlign="right" whiteSpace="nowrap">
            {`${n}.`}
          </Txt>
        </View>
        <Txt spec={spec}>{children}</Txt>
      </View>
    ) : (
      <View position="relative">
        <Txt spec={spec} position="absolute" left={-20} top={0} width={20 - space} textAlign="right" numberOfLines={1}>
          {`${n}.`}
        </Txt>
        <Txt spec={spec}>{children}</Txt>
      </View>
    )
  );
}
function Mono({ children }: { children: ReactNode }): JSX.Element {
  return <Txt spec={{ voice: "data", scale: 11 / 12, lineHeight: 1.6 }}>{children}</Txt>;
}
function StageSub({ children }: { children: ReactNode }): JSX.Element {
  return <Txt spec={{ voice: "app", scale: 12 / 12.5, lineHeight: 1.6, color: "dim" }}>{children}</Txt>;
}

/** Code inside a notice: the data face at 11/12, in the notice's colour. */
function Code({ children }: { children: ReactNode }): JSX.Element {
  return <Txt spec={{ voice: "data", scale: 11 / 12, color: "dim" }}>{children}</Txt>;
}

/** A notice: a wash and a sentence. */
function Notice({ tone, children }: { tone?: "warn" | "bad"; children: ReactNode }): JSX.Element {
  const t = useTokens();
  return (
    <View borderRadius={lengthToken(t, "control-radius", 7)} paddingVertical={7} paddingHorizontal={9} backgroundColor={t.v(tone === "warn" ? "tint-warn" : tone === "bad" ? "tint-bad" : "tint-accent") as never}>
      <Txt spec={{ voice: "app", scale: 11 / 12.5, color: tone ?? "dim" }} {...((isWeb ? { style: { overflowWrap: "anywhere" } } : {}) as object)}>
        {children}
      </Txt>
    </View>
  );
}

/** `Readiness`: who could answer the live run, as the last check found it. */
function Readiness({ availability }: { availability: AvailabilitySnapshot }): JSX.Element {
  const ready = readinessOf(availability);
  if (ready.kind === "unchecked") return <Notice tone="warn">Nothing has been checked yet, so a live run may find no provider. The scripted run needs none.</Notice>;
  if (ready.kind === "none")
    return <Notice tone="warn">Nothing here reported healthy, so a live run will probably fail to find a model — see Settings › Connections. The scripted run needs none, and is the better first test anyway.</Notice>;
  return (
    <Notice>
      A live run goes to whatever <Code>models.default</Code> resolves to. Reported healthy: {ready.names.join(", ")}.
    </Notice>
  );
}

function Actions({ children }: { children: ReactNode }): JSX.Element {
  return (
    <View flexDirection="row" alignItems="center" gap={6} flexWrap="wrap">
      {children}
    </View>
  );
}

const DOT: Record<string, string> = { success: "ok", error: "bad", unknown: "dim" };

/** `FileRow`: which copy of a state loads, and where it is. */
function FileRow({ file, onOpen }: { file: DebugFile; onOpen: () => void }): JSX.Element {
  const t = useTokens();
  const [hovered, hover] = useHover();
  const status = debugFileStatus(file);
  const off = file.layer === null;
  return (
    <View flexDirection="row" gap={8} alignItems="center" paddingVertical={4} paddingHorizontal={6} borderRadius={4} backgroundColor={(hovered ? t.v("panel-2") : "transparent") as never} {...hover}>
      <View width={7} height={7} borderRadius={999} flexShrink={0} backgroundColor={t.v(DOT[status.tone]!) as never} />
      <Txt spec={{ voice: "data", scale: 11 / 12 }} flex={1} minWidth={0} ellip {...((isWeb ? { title: file.file || file.stateId } : {}) as object)}>
        {file.stateId}
      </Txt>
      <Chip>{status.word}</Chip>
      <Press onPress={onOpen} disabled={off} flexShrink={0} {...(off ? { opacity: 0.5 } : {})}>
        {({ hovered: over }) => (
          <Txt spec={{ voice: "data", scale: 11 / 12, color: "accent" }} {...(over && !off ? { textDecorationLine: "underline" } : {})}>
            open ↗
          </Txt>
        )}
      </Press>
    </View>
  );
}

/** A chip: app at 10/12.5, --dim, a 1px --line pill, padding 0 6. */
export function Chip({ children, tone }: { children: ReactNode; tone?: "ok" | "bad" | "warn" }): JSX.Element {
  const t = useTokens();
  return (
    <View flexShrink={0} paddingHorizontal={6} borderRadius={999} {...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }, tone ?? "line") as object)}>
      <Txt spec={{ voice: "app", scale: 10 / 12.5, color: tone ?? "dim" }} numberOfLines={1}>
        {children}
      </Txt>
    </View>
  );
}

/** An output box: a value in the data face, in a box that scrolls past 220. */
export function Outputs({ children }: { children: string }): JSX.Element {
  const t = useTokens();
  return (
    <ScrollView
      style={{ maxHeight: 220, flexGrow: 0, borderRadius: 8, backgroundColor: t.v("bg") as string, ...(edge(t, { top: 1, right: 1, bottom: 1, left: 1 }) as object), ...PLAIN_SCROLLER } as never}
      contentContainerStyle={{ padding: 8, ...PLAIN_SCROLLER } as never}
      {...scrollbarProps(t)}
    >
      <Txt spec={{ voice: "data", scale: 11 / 12 }}>{children}</Txt>
    </ScrollView>
  );
}

/** A field: a label over a value. */
function Field({ label, children }: { label: string; children: string }): JSX.Element {
  return (
    <View flexDirection="column" gap={4}>
      <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim", ls: 0.04, upper: true }}>{label}</Txt>
      <Outputs>{children}</Outputs>
    </View>
  );
}

/** A task's status glyph (`BADGE`), 16 wide, in the status's colour. */
function Badge({ status }: { status: string }): JSX.Element {
  const hue = status === "running" || status === "interrupted" ? "accent" : status === "waiting_for_user" ? "warn" : status === "completed" ? "ok" : status === "failed" || status === "blocked" || status === "timeout" ? "bad" : "dim";
  return (
    <Txt spec={{ voice: "app", scale: 13 / 12.5, color: hue }} width={16} textAlign="center" flexShrink={0}>
      {BADGE[status] ?? "·"}
    </Txt>
  );
}

/**
 * A disclosure: a triangle and the words, the content under them when open. The triangle is the one
 * Chromium draws before a `summary`, in the words' colour.
 */
function Disclosure({ summary, children }: { summary: string; children: ReactNode }): JSX.Element {
  const t = useTokens();
  const [open, setOpen] = useState(false);
  const spec: FontSpec = { voice: "app", scale: 12 / 12.5, color: "dim" };
  return (
    <View>
      <Press onPress={() => setOpen((o) => !o)} alignSelf="stretch" flexDirection="row" {...({ "aria-expanded": open } as object)}>
        {/* Chromium's disclosure triangle: filled in the summary's colour, 6 × 8 pointing right (8 × 6
            down, open), 4.4 below the line's top, in a marker 11.11 wide (the words begin 11.11 in). */}
        <View width={11.11} flexShrink={0} position="relative">
          <View
            position="absolute"
            left={0}
            top={open ? 6.4 : 4.43}
            width={0}
            height={0}
            borderStyle="solid"
            borderColor="transparent"
            {...(open
              ? { borderTopWidth: 6, borderLeftWidth: 4, borderRightWidth: 4, borderBottomWidth: 0, borderTopColor: t.v("dim") }
              : { borderLeftWidth: 6, borderTopWidth: 4, borderBottomWidth: 4, borderRightWidth: 0, borderLeftColor: t.v("dim") })}
          />
        </View>
        <Txt spec={spec}>{summary}</Txt>
      </Press>
      {open ? children : null}
    </View>
  );
}
