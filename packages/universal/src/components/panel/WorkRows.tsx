import { useMemo, useState, type JSX, type ReactNode } from "react";
import { Platform } from "react-native";
import { Text, View } from "@tamagui/core";
import type { JsonValue } from "@declarative-ai/json";
import { choicesOfQuestions, toolDisplayOf, workflowOutcomeOf, type AgentQuestion, type SettledByView, type WorkflowOutcome } from "@jaira/shared/browser";
import { answersOfValue, type Answer } from "@jaira/ui/choices";
import { hueOf, lineSegments } from "@jaira/ui/approvalModel";
import { sizeOf, thoughtTime } from "@jaira/ui/liveStatusModel";
import { clockOf, useElapsed } from "@jaira/ui/runActivityModel";
import { iconOf, takenApartOf, type ThoughtEntry, type ToolEntry, type TranscriptEntry, type WorkEntry, type WritingEntry } from "@jaira/ui/transcript";
import { isApprovalCall } from "@jaira/ui/workSummary";
import { askedOf, producedArtifact, toolLineOf, type CallSurface, type RowMark, type RowTone } from "@jaira/ui/transcriptRows";
import type { ArtifactSurface } from "@jaira/ui/transcriptView";
import { Press, Txt, edge, lengthToken } from "../../primitives";
import { useTokens, type Tokens } from "../../tokens";
import { colorOf } from "../Sidebar";
import { ChoiceList, ChoiceSteps, FieldFrame } from "../floats/Choices";
import { Pulse } from "../chat/Paper";
import { Button } from "../settings/Button";
import { Icon } from "./Icon";
import { ValueView } from "./ValueView";

/**
 * `transcriptView.tsx`'s work rows, universal (decision 0015): one line of work — a call, a thought, a
 * call being written, a journal fact — its glyph, what it was, when, whether it worked, and what opens
 * under it. What each line says is `transcriptRows.ts`'s `toolLineOf` (the desktop's own reading), the
 * glyph `transcript.ts`'s `iconOf`. The rules, from `styles.css`:
 *
 *   .ts-work         column, margin 6 −6 10
 *   .ts-row          radius 6
 *   .ts-row-line     row, centred, gap 7, padding 3 6, radius 6, the body's 13/12.5 on 1.5;
 *                    can-open: hover --accent 9% over transparent
 *   .ts-icon         16 wide, centred, --dim (muted --tok-hint; warn --warn; bad --bad); the glyph 14
 *   .ts-name         flex 0 1 auto, ellipsed, app 12/12.5 600 --text (muted --dim, bad --bad)
 *   .ts-server       padding 0 5, radius 4, --panel-2, app 500 10.5/12.5 on 16, --dim
 *   .ts-preview      flex 1, ellipsed, data 11.5/12 --dim (prose: app 12/12.5; warn/bad their hue)
 *   .ts-note         row, centred, gap 5, app 11/12.5 --dim, tabular; .ts-think-live --accent
 *   .ts-at           data 11/12 --dim, tabular
 *   .ts-chev         14 wide, --tok-hint, the chevron 13 (turned 180° open)
 *   .ts-mark         14 wide, --ok (bad --bad), the glyph 13; "–" for a call that never answered
 *   .ts-row-body     margin 1 0 6 28, padding-left 12, a 1px --rule on the left
 *   .ts-row-shown    margin 2 0 10 28
 *   .ts-payload      padding 4 0 6; -empty app 11.5/12.5 italic --tok-hint
 *   .ts-think-text   padding 4 0 6, app 12.5/12.5 on 1.6, italic, pre-wrap, --dim
 *   .shell-line      a part on its hue at 13% (padding 0 2 in a row), --text; what joins them --tok-hint
 */

/** Draws a subagent's conversation — the transcript's own component, handed in (it holds this file). */
export type TranscriptOf = (props: { entries: TranscriptEntry[]; working?: boolean | undefined; onOpenSidechain?: OpenSidechain | undefined; artifacts?: ArtifactSurface | undefined }) => JSX.Element;

/** Walk into a subagent's conversation: the call that spawned it, and its name. */
export type OpenSidechain = (call: string, name: string) => void;

/** A command line in the colours of its parts (`shellLine.tsx`): nested text, so it ellipses as one line. */
export function ShellLine({ line, padding = 2 }: { line: string; padding?: number }): JSX.Element {
  const t = useTokens();
  const segments = useMemo(() => lineSegments(line, takenApartOf(line).requests.map((request) => ({ span: request.span, matched: [] }))), [line]);
  return (
    <>
      {segments.map((segment, at) =>
        segment.kind === "glue" ? (
          <Text key={at} color={t.v("tok-hint") as never}>
            {segment.text}
          </Text>
        ) : (
          <Text
            key={at}
            color={t.v("text") as never}
            backgroundColor={t.mix(colorOf(t, hueOf(segment.part)), 13, "transparent") as never}
            {...((Platform.OS === "web" ? { paddingHorizontal: padding, borderRadius: 4, style: { boxDecorationBreak: "clone", WebkitBoxDecorationBreak: "clone" } } : {}) as object)}
          >
            {segment.pieces.map((piece) => piece.text).join("")}
          </Text>
        ),
      )}
    </>
  );
}

const INK: Record<RowTone, { icon: string; name: string; preview: string }> = {
  plain: { icon: "dim", name: "text", preview: "dim" },
  muted: { icon: "tok-hint", name: "dim", preview: "dim" },
  warn: { icon: "warn", name: "text", preview: "warn" },
  bad: { icon: "bad", name: "bad", preview: "bad" },
};

/** `Row`: one line of work, whatever produced it. */
export function Row({
  entry,
  name,
  called,
  server,
  preview,
  command,
  tone,
  mark,
  prose = false,
  note,
  body,
  shown,
}: {
  entry: WorkEntry;
  name?: string | undefined;
  called?: string | undefined;
  server?: string | undefined;
  preview: string;
  command?: string | undefined;
  tone: RowTone;
  mark?: RowMark | undefined;
  prose?: boolean;
  note?: ReactNode;
  body?: ReactNode;
  shown?: ReactNode;
}): JSX.Element {
  const t = useTokens();
  const [open, setOpen] = useState(false);
  const canOpen = body !== undefined;
  const ink = INK[tone];
  const markInk = tone === "bad" ? "bad" : "ok";
  const line = (
    <>
      <View width={16} flexShrink={0} alignItems="center" justifyContent="center">
        <Icon name={iconOf(entry)} size={14} color={String(t.v(ink.icon))} />
      </View>
      {name !== undefined ? (
        <Txt spec={{ voice: "app", scale: 12 / 12.5, weight: 600, color: ink.name }} ellip flexShrink={1} minWidth={0} {...(called !== undefined && called !== name ? { title: called } : {})}>
          {name}
        </Txt>
      ) : null}
      {server !== undefined ? (
        <View flexShrink={0} paddingHorizontal={5} borderRadius={4} backgroundColor={t.v("panel-2") as never}>
          <Txt spec={{ voice: "app", scale: 10.5 / 12.5, weight: 500, color: "dim", lineHeight: { px: 16 } }} numberOfLines={1}>
            {server}
          </Txt>
        </View>
      ) : null}
      <Txt spec={prose ? { voice: "app", scale: 12 / 12.5, color: ink.preview } : { voice: "data", scale: 11.5 / 12, color: ink.preview }} ellip flex={1} minWidth={0}>
        {command !== undefined ? <ShellLine line={command} /> : preview}
      </Txt>
      {note !== undefined ? note : null}
      <Txt spec={{ voice: "data", scale: 11 / 12, color: "dim", tabular: true }} flexShrink={0}>
        {clockOf(entry.at)}
      </Txt>
      <View width={14} flexShrink={0} flexDirection="row">
        {canOpen ? (
          <View transform={open ? [{ rotate: "180deg" }] : []}>
            <Icon name="chevron" size={13} color={String(t.v("tok-hint"))} />
          </View>
        ) : null}
      </View>
      <View width={14} flexShrink={0} flexDirection="row">
        {mark === "ok" ? (
          <Icon name="check" size={13} color={String(t.v(markInk))} />
        ) : mark === "bad" ? (
          <Icon name="cross" size={13} color={String(t.v("bad"))} />
        ) : mark === "cut" ? (
          <Txt spec={{ voice: "app", scale: 13 / 12.5, color: markInk }} title="No result was recorded">
            –
          </Txt>
        ) : null}
      </View>
    </>
  );
  const box = { flexDirection: "row", alignItems: "center", gap: 7, width: "100%", minWidth: 0, paddingVertical: 3, paddingHorizontal: 6, borderRadius: 6 } as const;
  return (
    <View borderRadius={6} minWidth={0}>
      {canOpen ? (
        <Press onPress={() => setOpen((v) => !v)} {...({ "aria-expanded": open } as object)} {...box} box={({ hovered }) => ({ backgroundColor: hovered ? t.mix(t.v("accent"), 9, "transparent") : "transparent" })}>
          {line}
        </Press>
      ) : (
        <View {...box}>{line}</View>
      )}
      {open && canOpen ? (
        <View marginTop={1} marginBottom={6} marginLeft={28} paddingLeft={12} minWidth={0} {...(edge(t, { left: 1 }, "rule") as object)}>
          {body}
        </View>
      ) : null}
      {shown !== undefined ? (
        <View marginTop={2} marginBottom={10} marginLeft={28} minWidth={0}>
          {shown}
        </View>
      ) : null}
    </View>
  );
}

/** `.ts-note` and its two moods: a live count (`.ts-think-live`, a pulse) and a settled figure. */
function Note({ live, children }: { live: boolean; children: string }): JSX.Element {
  return (
    <View flexShrink={0} flexDirection="row" alignItems="center" gap={5}>
      {live ? <Pulse /> : null}
      <Txt spec={{ voice: "app", scale: 11 / 12.5, color: live ? "accent" : "dim", tabular: true }} numberOfLines={1}>
        {children}
      </Txt>
    </View>
  );
}

/** `Payload`: a payload block, or the honest statement that the record kept none. */
function Payload({ label, value, hint, artifacts }: { label: string; value: JsonValue | undefined; hint?: string | undefined; artifacts?: ArtifactSurface | undefined }): JSX.Element {
  if (value === undefined) return <EmptyPayload>{`no ${label} was recorded`}</EmptyPayload>;
  return (
    <View paddingTop={4} paddingBottom={6} minWidth={0}>
      <ValueView value={value} label={label} {...(hint !== undefined ? { hint: { mime: hint } } : {})} {...served(artifacts)} />
    </View>
  );
}

function EmptyPayload({ children }: { children: string }): JSX.Element {
  return (
    <Txt spec={{ voice: "app", scale: 11.5 / 12.5, italic: true, color: "tok-hint" }} paddingTop={4} paddingBottom={6}>
      {children}
    </Txt>
  );
}

/**
 * What lets an artifact in a payload RUN (the desktop's `ArtifactSurface`), as a value view's props: the
 * grant, and where a message from it goes — the second only where the surface has a composer.
 */
function served(artifacts: ArtifactSurface | undefined): { serve?: ArtifactSurface["serve"]; onPrompt?: (text: string) => void } {
  if (artifacts === undefined) return {};
  return { serve: artifacts.serve, ...(artifacts.onPrompt !== undefined ? { onPrompt: artifacts.onPrompt } : {}) };
}

/** `Tool`: one tool call — a line, both its halves when asked for, and what it made, drawn unasked. */
function Tool({ entry, open, sidechainOf, onOpenSidechain, artifacts, calls, transcript }: { entry: ToolEntry; open: boolean; sidechainOf?: ((call: string) => TranscriptEntry[]) | undefined; onOpenSidechain?: OpenSidechain | undefined; artifacts?: ArtifactSurface | undefined; calls?: CallSurface | undefined; transcript: TranscriptOf }): JSX.Element {
  const sub = entry.sidechain !== undefined && sidechainOf !== undefined ? sidechainOf(entry.sidechain) : undefined;
  // A doorway is drawn for a chain that is here to unfold, or one the host can walk into.
  const line = toolLineOf(entry, open, sub !== undefined || onOpenSidechain !== undefined, calls);
  const { running, unanswered, pathMime } = line;
  const head = { entry, name: line.name, called: line.called, server: line.server, preview: line.preview, command: line.command, prose: line.prose, tone: line.tone, mark: line.mark };
  // The approval prompt: its line is the whole of it (`Tool`'s first branch).
  if (isApprovalCall(entry)) return <Row {...head} />;
  const shown = ((): ReactNode => {
    if (line.shown === "sidechain") return <SidechainDoor call={entry.sidechain!} name={line.chainName} entries={sub} running={running} transcript={transcript} onOpen={onOpenSidechain} artifacts={artifacts} />;
    if (line.shown === "outcome") {
      const outcome = workflowOutcomeOf(entry.result!);
      return outcome === undefined ? null : <OutcomeNote outcome={outcome} />;
    }
    if (line.shown === "asked") {
      const asked = askedOf(entry)!;
      return (
        <>
          <AskedQuestions key={asked.answers === undefined ? "asking" : "answered"} questions={asked.questions} answers={asked.answers} />
          {entry.settledBy !== undefined ? <AnsweredForYou by={entry.settledBy} {...(calls?.onAnswerYourself !== undefined ? { onAnswerYourself: () => calls.onAnswerYourself!(entry.settledBy!) } : {})} /> : null}
        </>
      );
    }
    if (line.shown === "produced") return <ValueView value={producedArtifact(entry.result)} {...served(artifacts)} />;
    if (line.shown === "output") return <ValueView value={entry.output!.value} label={entry.output!.name ?? "output"} {...(entry.output!.schema !== undefined ? { hint: { schema: entry.output!.schema } } : {})} />;
    return undefined;
  })();
  return (
    <Row
      {...head}
      {...(shown !== undefined ? { shown } : {})}
      body={
        <>
          <Payload label="arguments" value={entry.args} artifacts={artifacts} />
          {unanswered ? (
            <EmptyPayload>{running ? "still running" : "no result was recorded — the conversation went on without this call answering"}</EmptyPayload>
          ) : (
            <Payload label="result" value={entry.result} hint={pathMime} artifacts={artifacts} />
          )}
          {entry.detail !== undefined ? <Payload label="record" value={entry.detail} hint={pathMime} artifacts={artifacts} /> : null}
        </>
      }
    />
  );
}

/** `Thought`: one block of reasoning, and how long it took. */
function Thought({ entry, narrated, open }: { entry: ThoughtEntry; narrated?: boolean | undefined; open: boolean }): JSX.Element {
  const live = entry.live === true && open && narrated !== true;
  const elapsed = useElapsed(entry.startedAt, live);
  const shown = live ? elapsed : entry.durationMs;
  const took = shown !== undefined ? `${live ? "Thinking for" : "Thought for"} ${thoughtTime(shown)}` : undefined;
  return (
    <Row
      entry={entry}
      name="thinking"
      preview={entry.text.replace(/\s+/g, " ").trim()}
      tone="muted"
      prose
      {...(live || took !== undefined ? { note: <Note live={live}>{took ?? "Thinking…"}</Note> } : {})}
      {...(entry.text.length > 0
        ? {
            body: (
              <Txt spec={{ voice: "app", scale: 12.5 / 12.5, italic: true, color: "dim", lineHeight: 1.6 }} whiteSpace="pre-wrap" paddingTop={4} paddingBottom={6} {...({ overflowWrap: "anywhere" } as object)}>
                {entry.text}
              </Txt>
            ),
          }
        : {})}
    />
  );
}

/** `Writing`: a call being written — this tool, this path, this much so far. */
function Writing({ entry, open }: { entry: WritingEntry; open: boolean }): JSX.Element {
  return (
    <Row
      entry={entry}
      name={toolDisplayOf(entry.name).title}
      called={entry.name}
      preview={entry.path ?? ""}
      tone="plain"
      note={open ? <Note live>{`writing${entry.chars > 0 ? ` ${sizeOf(entry.chars)}` : "…"}`}</Note> : <Note live={false}>{`stopped while being written${entry.chars > 0 ? ` (${sizeOf(entry.chars)})` : ""}`}</Note>}
    />
  );
}

/** `Work`: one entry of work, dispatched by kind. All four land on the same {@link Row}. */
export function Work({
  entry,
  open,
  sidechainOf,
  onOpenSidechain,
  artifacts,
  narrated,
  calls,
  transcript,
}: {
  entry: WorkEntry;
  open: boolean;
  sidechainOf?: ((call: string) => TranscriptEntry[]) | undefined;
  onOpenSidechain?: OpenSidechain | undefined;
  /** How an artifact in a payload runs, and where its messages go (the desktop's `artifacts`). */
  artifacts?: ArtifactSurface | undefined;
  narrated?: boolean | undefined;
  calls?: CallSurface | undefined;
  transcript: TranscriptOf;
}): JSX.Element {
  if (entry.kind === "tool") return <Tool entry={entry} open={open} sidechainOf={sidechainOf} onOpenSidechain={onOpenSidechain} artifacts={artifacts} calls={calls} transcript={transcript} />;
  if (entry.kind === "thought") return <Thought entry={entry} open={open} narrated={narrated} />;
  if (entry.kind === "writing") return <Writing entry={entry} open={open} />;
  return (
    <Row
      entry={entry}
      preview={entry.text}
      tone={entry.tone === "plain" ? "muted" : entry.tone}
      prose
      {...(entry.detail !== undefined ? { body: <Payload label="detail" value={entry.detail} artifacts={artifacts} /> } : {})}
    />
  );
}

/** `.ts-work`: the column rows stand in, pulled out by their own padding. */
export function WorkColumn({ children, ...box }: { children: ReactNode } & Record<string, unknown>): JSX.Element {
  return (
    <View flexDirection="column" minWidth={0} marginTop={6} marginHorizontal={-6} marginBottom={10} {...box}>
      {children}
    </View>
  );
}

/**
 * `SidechainDoor`: a subagent's conversation under the call that spawned it — a line naming it that
 * unfolds it here (the same transcript, one step further in). Walking into it is the host's: `onOpen`,
 * handed on to the conversation inside, whose own doorways walk further in.
 *
 *   .ts-sidechain        margin 2 0 6, padding 2 0 2 12 (open: 6 above)
 *   .ts-sidechain-head   row, centred, gap 8, app 11/12.5, upper, 0.04em, --dim; 4 under while open
 *   .ts-sidechain-fold   inline row, centred, gap 4, hovered --text; the chevron turned −90° shut
 *   .ts-sidechain-open   pushed right, padding 0 2, --accent ("walk in →")
 */
function SidechainDoor({ call, name, entries, running, transcript: Inner, onOpen, artifacts }: { call: string; name: string; entries: TranscriptEntry[] | undefined; running: boolean; transcript: TranscriptOf; onOpen?: OpenSidechain | undefined; artifacts?: ArtifactSurface | undefined }): JSX.Element {
  const t = useTokens();
  const [open, setOpen] = useState(false);
  const messages = entries?.filter((entry) => entry.kind === "message").length ?? 0;
  const words = { voice: "app" as const, scale: 11 / 12.5, color: "dim", upper: true, ls: 0.04 };
  return (
    <View minWidth={0} marginTop={2} marginBottom={6} paddingTop={open ? 6 : 2} paddingBottom={2} paddingLeft={12}>
      <View flexDirection="row" alignItems="center" gap={8} marginBottom={open ? 4 : 0} minWidth={0}>
        {entries !== undefined ? (
          <Press onPress={() => setOpen((was) => !was)} {...({ "aria-expanded": open } as object)} flexDirection="row" alignItems="center" gap={4} flexShrink={1} minWidth={0}>
            {({ hovered }) => (
              <>
                <View width={14} flexShrink={0} transform={open ? [] : [{ rotate: "-90deg" }]}>
                  <Icon name="chevron" size={13} color={String(t.v("tok-hint"))} />
                </View>
                <Txt spec={{ ...words, color: hovered ? "text" : "dim" }} numberOfLines={1}>
                  {`Subagent conversation · ${messages === 1 ? "1 message" : `${messages} messages`}${running ? " · working" : ""}`}
                </Txt>
              </>
            )}
          </Press>
        ) : (
          <Txt spec={words}>Subagent conversation</Txt>
        )}
        {onOpen !== undefined ? (
          <Press onPress={() => onOpen(call, name)} marginLeft="auto" flexShrink={0} paddingHorizontal={2}>
            <Txt spec={{ ...words, color: "accent" }} numberOfLines={1}>
              walk in →
            </Txt>
          </Press>
        ) : null}
      </View>
      {open && entries !== undefined ? <Inner entries={entries} working={running} onOpenSidechain={onOpen} artifacts={artifacts} /> : null}
    </View>
  );
}

/**
 * `AskedQuestions`: the agent's question as the person saw it, with what they answered — the same
 * chooser the dialog drew, inert (`.gate-settled.ts-asked`: its first block 0 above, its options 10).
 */
function AskedQuestions({ questions, answers }: { questions: AgentQuestion[]; answers: Record<string, JsonValue> | undefined }): JSX.Element {
  const choices = useMemo(() => choicesOfQuestions(questions), [questions]);
  const [state, setState] = useState<Record<string, Answer>>(() => answersOfValue(choices, answers === undefined ? undefined : { answers }));
  return (
    // `.ts-asked .question-block`: 6 above, which collapses with the shown row's 2 — the chooser's own 14
    // less 8. Several questions start at their step line, 0 above; the stepper spaces itself (`asked`).
    // Not in a gate's frame: a field's label is the global `.field`'s, 0 above and --text.
    <FieldFrame.Provider value={false}>
    <View testID="asked" minWidth={0} marginTop={choices.length > 1 ? 0 : -10}>
      {choices.length > 1 ? (
        <ChoiceSteps choices={choices} answers={state} onAnswer={(question, next) => setState((prev) => ({ ...prev, [question]: next }))} onSubmit={() => undefined} readOnly asked />
      ) : (
        <ChoiceList choices={choices} answers={state} onAnswer={(question, next) => setState((prev) => ({ ...prev, [question]: next }))} readOnly />
      )}
    </View>
    </FieldFrame.Provider>
  );
}

/**
 * `AnsweredForYou`: a question the control conversation answered — who, how sure, and the way back.
 *
 *   .gate-settled-by            row, gap 8, 8 above, padding 8 10, radius --control-radius, app 12.5/12.5
 *   .by-control                 centred; --accent 8% into --panel, 1px --accent 32% into --line; the
 *                               glyph 14 --accent; `b` 700; `.conf` data at app 11/12.5, --dim
 */
export function AnsweredForYou({ by, onAnswerYourself }: { by: SettledByView; onAnswerYourself?: (() => void) | undefined }): JSX.Element {
  const t = useTokens();
  const words = { voice: "app" as const, scale: 1, color: "text" };
  return (
    <View
      testID="answered-for-you"
      flexDirection="row"
      alignItems="center"
      gap={8}
      marginTop={8}
      paddingVertical={8}
      paddingHorizontal={10}
      borderRadius={lengthToken(t, "control-radius", 7) as never}
      borderWidth={1}
      borderStyle="solid"
      borderColor={t.mix(t.v("accent"), 32, t.v("line")) as never}
      backgroundColor={t.mix(t.v("accent"), 8, t.v("panel")) as never}
    >
      <Icon name="think" size={14} color={String(t.v("accent"))} />
      <Txt spec={words} flexShrink={1}>
        Answered for you by <Txt spec={{ ...words, weight: 700 }}>the conversation</Txt>{" "}
        <Txt spec={{ voice: "data", scale: 11 / 12.5, color: "dim" }} fontSize={t.scaled("size-app", 11 / 12.5)}>
          · confidence {by.confidence.toFixed(2)}
        </Txt>
      </Txt>
      <View flex={1} />
      {onAnswerYourself !== undefined ? (
        <Button kind="quiet" onPress={onAnswerYourself}>
          Answer it yourself
        </Button>
      ) : null}
    </View>
  );
}

/**
 * `OutcomeNote`: what a `move` or a `start` DID — the note the rail draws, under the call.
 *
 *   .sb-note.step.sb-connected   row, baseline, gap 8, padding 4, app 11.5/12.5, --dim; the glyph 1em,
 *                                centred; `b` 600 --text; the state ellipsed, at most 30% (`.mono`
 *                                names no face of its own)
 */
export function OutcomeNote({ outcome }: { outcome: WorkflowOutcome }): JSX.Element {
  const t = useTokens();
  const { verb, standsAt: where, workflow, adoptedAs, held, through } = outcome;
  const size = Number(t.scaled("size-app", 11.5 / 12.5)) || 11.5;
  const words = { voice: "app" as const, scale: 11.5 / 12.5, color: "dim" };
  const b = { ...words, weight: 600, color: "text" };
  const state = (text: string): JSX.Element => (
    <Txt spec={words} ellip flexShrink={0} maxWidth="30%" title={text}>
      {text}
    </Txt>
  );
  return (
    <View role="note" flexDirection="row" alignItems="baseline" gap={8} padding={4} minWidth={0}>
      <Icon name="workflow" size={size} color={String(t.v("dim"))} box={{ alignSelf: "center" }} />
      <Txt spec={words} flexShrink={0}>
        {verb}
      </Txt>
      {verb === "fast-forwarding to" ? (
        <>
          <Txt spec={words} minWidth={0} flexShrink={1} {...({ overflowWrap: "anywhere" } as object)}>
            <Txt spec={b}>{where.split("/").pop()}</Txt>
            {through !== undefined && through.length > 0 ? ` · through ${through.join(", ")}` : null}
          </Txt>
          {workflow !== undefined ? state(workflow) : null}
        </>
      ) : (
        <>
          {adoptedAs !== undefined && workflow !== undefined ? (
            <Txt spec={words} minWidth={0} flexShrink={1} {...({ overflowWrap: "anywhere" } as object)}>
              <Txt spec={b}>{workflow}</Txt> as {adoptedAs} · standing at
            </Txt>
          ) : held === true ? (
            <Txt spec={words} minWidth={0} flexShrink={1}>
              one task per element, held · standing at
            </Txt>
          ) : null}
          {state(where)}
        </>
      )}
    </View>
  );
}

export type { Tokens };
