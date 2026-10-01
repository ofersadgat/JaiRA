import { useEffect, useMemo, useState, type JSX, type ReactNode } from "react";
import { ScrollView } from "react-native";
import { View, isWeb } from "@tamagui/core";
import type { Change, SyncDirection, WorkflowSyncEdit, WorkflowSyncResult } from "@jaira/shared/browser";
import { docKey } from "@jaira/ui/drafts";
import type { FileSurfaceProps } from "@jaira/ui/fileTypes";
import { SYNC_HINT, SYNC_LABEL, agoOf, driftOf, plural, syncSentence } from "@jaira/ui/syncState";
import { PLAIN_SCROLLER, Txt, edge, lengthToken, scrollbarProps, type FontSpec } from "../../primitives";
import { useTokens, type Tokens } from "../../tokens";
import { ChangesView, type ChangeOutcome } from "../panel/ValueReadings";
import { Button } from "../settings/Button";
import { LinkButton } from "../workflow/controls";

/**
 * A workflow description's viewer — whether the description and the workflows still agree, the two
 * buttons that bring them back together, and the report a sync leaves (or the description rendered,
 * `preview`). What it says is `syncState.ts`'s; the panel's bag is `context.sync` (built from the
 * store by `syncSurfaceOf`). How it looks:
 *
 *   the panel            column, flex 1 1 auto, padding 10 15 0
 *   its head             column, gap 6, padding 2 2 8, 1px --line under
 *   the sentence         row, baseline, gap 8, app 13/12.5; "last synced" 11/12.5 --dim
 *   the buttons          row, centred, gap 6, wraps; `Button` plain or `ghost` (disabled 0.5); the
 *                        Report/Preview toggle pushed to the end
 *   what is delegated    11/12.5 --dim, 2px --line on its left, padding-left 8, line 1.5; a root's
 *                        name 600; a document's an inline link: data 11/12, --accent
 *   the progress         column, gap 4; the steps data 11/12, --dim, as written, 140 at most
 *   the body             the rest, scrolls, 8 above
 *   a section            14 under; its heading a row spaced between, baseline, gap 6, 6 under, app 700
 *                        at 11/12.5, 0.06em, uppercase, --dim; a count 400; a bad count --bad on
 *                        12% of it
 *   the verdict          row, centred, gap 8, 10 under
 *   a finding, a change  padding 5 2, 1px --line above, app 12/12.5; their heads a row, baseline,
 *                        gap 6; a finding's id 700
 *   the states           data 11/12
 *   a chip               app 10/12.5, --dim, 1px --line, radius 999, padding 0 6, one line; ok, warn
 *                        and bad in their colour, ring and all
 *   a notice             --tint-accent, radius --control-radius, padding 7 9, app 11/12.5, --dim, wraps
 *                        anywhere; warn and bad their tint and colour
 *   an empty note        --dim, 8 above and below, a paragraph's margins (1em of the body's 13)
 */

const DIRECTIONS: SyncDirection[] = ["document", "states"];

/** Worst first, so the reason the sync was run is at the top rather than under what already passes. */
const STATUS_ORDER = ["contradicted", "missing", "partial", "satisfied"];
const STATUS_TONE: Record<string, Tone> = { satisfied: "ok", partial: "warn", missing: "bad", contradicted: "bad" };

type Tone = "ok" | "warn" | "bad" | undefined;
const SUB: FontSpec = { voice: "app", scale: 11 / 12.5, color: "dim" };
const WRAP = { style: { overflowWrap: "anywhere" } } as object;

export function WorkflowSyncPanel({ doc, busy, context, preview }: FileSurfaceProps & { preview: ReactNode }): JSX.Element {
  const t = useTokens();
  const sync = context.sync;
  // Which half the reader asked for, remembered only against the result it was asked ABOUT.
  const [preferred, setPreferred] = useState<{ for: WorkflowSyncResult | null; view: "report" | "preview" } | null>(null);
  const held = context.drafts?.[docKey(doc.layer, doc.path)];
  const dirty = held !== undefined && held !== doc.text;
  // The store's stable action, not the bag (rebuilt on every render of the shell).
  const refresh = sync?.refresh;
  useEffect(() => {
    refresh?.(doc.layer, doc.path);
  }, [refresh, doc.layer, doc.path]);

  const result = sync?.result ?? null;
  const showing = preferred !== null && preferred.for === result ? preferred.view : result !== null ? "report" : "preview";
  const status = sync?.status ?? null;
  const drift = driftOf(status, dirty);
  const running = sync?.running === true;
  const blocked = status?.blocked;

  return (
    <View flexGrow={1} flexShrink={1} flexBasis="auto" minHeight={0} flexDirection="column" paddingTop={10} paddingHorizontal={15}>
      <View flexDirection="column" gap={6} paddingTop={2} paddingHorizontal={2} paddingBottom={8} {...(edge(t, { bottom: 1 }) as object)}>
        <View flexDirection="row" alignItems="baseline" gap={8}>
          <Txt spec={{ voice: "app", scale: 13 / 12.5 }} flex={1} minWidth={0}>
            {syncSentence(status, drift)}
          </Txt>
          {status?.synced && status.at !== undefined ? (
            <Txt spec={SUB} {...(isWeb ? { title: new Date(status.at).toLocaleString() } : {})}>
              last synced {agoOf(status.at, Date.now())}
            </Txt>
          ) : null}
        </View>

        <View flexDirection="row" alignItems="center" gap={6} flexWrap="wrap">
          {DIRECTIONS.map((direction) => (
            <Button key={direction} kind={drift.suggested === direction ? "plain" : "ghost"} disabled={running || busy || blocked !== undefined || sync === undefined} title={SYNC_HINT[direction]} onPress={() => sync?.run(direction)}>
              {SYNC_LABEL[direction]}
            </Button>
          ))}
          {running ? (
            <Button kind="ghost" onPress={() => sync?.cancel()}>
              Cancel
            </Button>
          ) : null}
          {result !== null || running ? (
            <Button kind="ghost" marginLeft="auto" disabled={result === null} onPress={() => setPreferred({ for: result, view: showing === "report" ? "preview" : "report" })}>
              {showing === "report" ? "Preview" : "Report"}
            </Button>
          ) : null}
          {result?.changeset !== undefined && sync?.reviewChangeset !== undefined ? (
            // The same proposals through the changeset gate: the reviewer pops as a pending interaction.
            <Button
              kind="ghost"
              disabled={running || busy}
              title="Decide each proposed file — merge, revert, or comment — and apply the merged ones"
              onPress={() => sync.reviewChangeset!(doc.layer, doc.path, result.changeset!, result.taskId)}
            >
              Review as changeset
            </Button>
          ) : null}
        </View>

        {/* What this document is NOT answerable for — above the buttons' consequences, not in the report. */}
        {status?.delegated?.length ? (
          <View paddingLeft={8} {...(edge(t, { left: 2 }) as object)}>
            <Txt spec={{ ...SUB, lineHeight: 1.5 }}>
              {"Described elsewhere:"}
              {" "}
              {status.delegated.map((d, i) => (
                <Txt key={d.document} spec={{ ...SUB, lineHeight: 1.5 }}>
                  {i > 0 ? " · " : ""}
                  <Txt spec={{ ...SUB, lineHeight: 1.5, weight: 600 }}>{d.root}</Txt>
                  {" ("}
                  {plural(d.states, "state")}
                  {") by"}
                  {" "}
                  {sync?.openDocument ? (
                    <InlineLink onPress={() => sync?.openDocument?.(doc.layer, d.document)}>{d.document}</InlineLink>
                  ) : (
                    d.document
                  )}
                </Txt>
              ))}
            </Txt>
          </View>
        ) : null}

        {running ? (
          <View flexDirection="column" gap={4}>
            <Txt spec={SUB}>Reading the workflows and the description…</Txt>
            {(sync?.progress ?? []).length > 0 ? (
              <View maxHeight={140} {...((isWeb ? { overflow: "auto" } : { overflow: "hidden" }) as object)}>
                <Txt spec={{ voice: "data", scale: 11 / 12, color: "dim" }} {...({ style: { whiteSpace: "pre-wrap" } } as object)}>
                  {(sync?.progress ?? []).slice(-8).join("\n")}
                </Txt>
              </View>
            ) : null}
          </View>
        ) : null}
        {sync?.error ? <Notice tone="bad" t={t}>{sync.error}</Notice> : null}
        {status?.pending !== undefined && !running ? <Txt spec={SUB}>A proposal from this session is still unsaved — the baseline moves when you save it.</Txt> : null}
      </View>

      <View flex={1} minHeight={0}>
        <ScrollView style={PLAIN_SCROLLER} contentContainerStyle={{ ...PLAIN_SCROLLER, paddingTop: 8 }} {...scrollbarProps(t)}>
          {showing === "report" && result !== null ? <Report result={result} t={t} {...(sync?.openEdit ? { onOpenEdit: sync.openEdit } : {})} /> : preview}
        </ScrollView>
      </View>
    </View>
  );
}

/** A section of the report: its heading (the words, then the counts, spread across), and what it holds. */
function Section({ title, counts, children }: { title: string; counts?: ReactNode; children: ReactNode }): JSX.Element {
  const h3: FontSpec = { voice: "app", scale: 11 / 12.5, weight: 700, ls: 0.06, upper: true, color: "dim" };
  return (
    <View marginBottom={14}>
      <View flexDirection="row" alignItems="baseline" justifyContent="space-between" gap={6} marginBottom={6}>
        <Txt spec={h3}>{title}</Txt>
        {counts}
      </View>
      {children}
    </View>
  );
}

/** A count in a section's heading: --dim at 400; a bad one --bad on a 12% wash of it. */
function Count({ children, bad = false, t }: { children: ReactNode; bad?: boolean; t: Tokens }): JSX.Element {
  return (
    <Txt spec={{ voice: "app", scale: 11 / 12.5, ls: 0.06, upper: true, color: bad ? "bad" : "dim" }} {...(bad ? { backgroundColor: t.tint("bad", 12) } : {})}>
      {children}
    </Txt>
  );
}

function Report({ result, onOpenEdit, t }: { result: WorkflowSyncResult; onOpenEdit?: (edit: WorkflowSyncEdit) => void; t: Tokens }): JSX.Element {
  return (
    <View>
      <View flexDirection="row" alignItems="center" gap={8} marginBottom={10}>
        <Chip tone={result.verdict === "conforms" ? "ok" : "warn"} t={t}>
          {result.verdict}
        </Chip>
        <Txt spec={SUB}>
          against {result.workflows.join(", ")}
          {result.costUsd !== undefined ? ` · $${result.costUsd.toFixed(3)}` : ""}
        </Txt>
      </View>

      {result.document !== undefined ? (
        <Section title="Changes to this document" counts={<Count t={t}>{String(result.document.changes.length)}</Count>}>
          {/* The rewritten text is sitting in the editor below, unsaved. */}
          <Notice t={t}>The rewritten description is in the editor below, unsaved. Read it, then Save or Revert.</Notice>
          {result.document.changes.map((change, i) => (
            <Row key={i} t={t}>
              <View flexDirection="row" alignItems="baseline" gap={6}>
                <Txt spec={{ voice: "app", scale: 12 / 12.5 }} flex={1} minWidth={0}>
                  {change.summary}
                </Txt>
                {change.requirements.length > 0 ? <Txt spec={SUB}>{change.requirements.join(", ")}</Txt> : null}
              </View>
            </Row>
          ))}
        </Section>
      ) : null}

      {result.edits !== undefined ? <Edits edits={result.edits} t={t} {...(result.changeset !== undefined ? { changeset: result.changeset } : {})} {...(onOpenEdit ? { onOpen: onOpenEdit } : {})} /> : null}

      {result.notes.length > 0 ? (
        <Section title="Notes">
          {result.notes.map((note, i) => (
            <Notice key={i} tone="warn" t={t}>
              {note}
            </Notice>
          ))}
        </Section>
      ) : null}

      <Findings result={result} t={t} />

      {result.extras.length > 0 ? (
        <Section title="Not described by the document" counts={<Count t={t}>{String(result.extras.length)}</Count>}>
          {result.extras.map((extra, i) => (
            <Row key={i} t={t}>
              <Txt spec={{ voice: "app", scale: 12 / 12.5 }}>{extra.detail}</Txt>
              {extra.states.length > 0 ? <Txt spec={{ voice: "data", scale: 11 / 12, color: "dim" }}>{extra.states.join(" · ")}</Txt> : null}
            </Row>
          ))}
        </Section>
      ) : null}
    </View>
  );
}

function Findings({ result, t }: { result: WorkflowSyncResult; t: Tokens }): JSX.Element {
  const sorted = [...result.findings].sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status));
  return (
    <Section title="Requirements" counts={<Count t={t}>{String(result.findings.length)}</Count>}>
      {/* The note's margins collapse into the heading's 6 above it and the section's 14 below (`collapsed`). */}
      {sorted.length === 0 ? <Empty t={t} collapsed>The check returned no findings.</Empty> : null}
      {sorted.map((finding) => (
        <Row key={finding.id} t={t}>
          <View flexDirection="row" alignItems="baseline" gap={6}>
            <Chip tone={STATUS_TONE[finding.status]} t={t}>
              {finding.status}
            </Chip>
            <Txt spec={{ voice: "app", scale: 12 / 12.5, weight: 700 }}>{finding.id}</Txt>
            <Txt spec={{ voice: "app", scale: 12 / 12.5 }} flex={1} minWidth={0}>
              {finding.requirement}
            </Txt>
          </View>
          {finding.detail === "" ? null : <Txt spec={SUB}>{finding.detail}</Txt>}
          {finding.states.length > 0 ? <Txt spec={{ voice: "data", scale: 11 / 12, color: "dim" }}>{finding.states.join(" · ")}</Txt> : null}
        </Row>
      ))}
    </Section>
  );
}

/** The proposed files, as the diff they are (`ChangesView`), each row keeping its way to the tree. */
function Edits({ edits, changeset, onOpen, t }: { edits: WorkflowSyncEdit[]; changeset?: WorkflowSyncResult["changeset"] | undefined; onOpen?: (edit: WorkflowSyncEdit) => void; t: Tokens }): JSX.Element {
  const refused = edits.filter((edit) => !edit.applicable).length;
  const byPath = useMemo(() => new Map(edits.map((edit) => [edit.path, edit] as const)), [edits]);
  const changes = useMemo<Change[]>(() => {
    const pinned = new Map((changeset?.changes ?? []).map((change) => [change.path, change] as const));
    return edits.map((edit, i) => {
      const from = pinned.get(edit.path);
      return {
        id: from?.id ?? `e${i + 1}`,
        path: edit.path,
        action: edit.action,
        ...(from?.before !== undefined ? { before: from.before } : {}),
        after: edit.text,
        ...(edit.reason !== "" ? { reason: edit.reason } : {}),
      };
    });
  }, [edits, changeset]);
  const outcomes = useMemo(() => Object.fromEntries(edits.map((edit) => [edit.path, { ok: edit.applicable, ...(edit.blocked !== undefined ? { note: edit.blocked } : {}) }])) as Record<string, ChangeOutcome>, [edits]);
  return (
    <Section
      title="Proposed files"
      counts={
        <>
          <Count t={t}>{String(edits.length)}</Count>
          {/* Counted in the heading: a run whose every proposal was refused must not read as a success. */}
          {refused > 0 ? (
            <Count bad t={t}>
              {refused} not applied
            </Count>
          ) : null}
        </>
      }
    >
      {refused === edits.length && refused > 0 ? (
        <Notice tone="bad" t={t}>
          The model wrote {refused === 1 ? "this file" : `all ${refused} of these files`} and JaiRA declined {refused === 1 ? "it" : "them"} — nothing here was proposed for review. Each row says why.
        </Notice>
      ) : null}
      <ChangesView
        changes={changes}
        outcomes={outcomes}
        empty="Nothing to change."
        rowAction={(change) => {
          const edit = byPath.get(change.path);
          if (edit === undefined || !edit.applicable || onOpen === undefined) return null;
          return (
            <LinkButton title={`Open ${edit.stateId ?? edit.path}`} onPress={() => onOpen(edit)}>
              Open
            </LinkButton>
          );
        }}
      />
    </Section>
  );
}

/**
 * A link standing in a line of text ("Described elsewhere"): data 11/12 in --accent, underlined while
 * hovered — a run of the line rather than a box, so it keeps the line's baseline.
 */
function InlineLink({ children, onPress }: { children: string; onPress: () => void }): JSX.Element {
  const [hovered, setHovered] = useState(false);
  return (
    <Txt
      spec={{ voice: "data", scale: 11 / 12, color: "accent", lineHeight: 1.5 }}
      onPress={onPress}
      {...((isWeb ? { role: "button", onMouseEnter: () => setHovered(true), onMouseLeave: () => setHovered(false), style: { cursor: "pointer", whiteSpace: "nowrap", ...(hovered ? { textDecorationLine: "underline" } : {}) } } : {}) as object)}
    >
      {children}
    </Txt>
  );
}

/** A finding or a change in the report: padding 5 2, a rule above, app 12/12.5. */
function Row({ children, t }: { children: ReactNode; t: Tokens }): JSX.Element {
  return (
    <View paddingVertical={5} paddingHorizontal={2} {...(edge(t, { top: 1 }) as object)}>
      {children}
    </View>
  );
}

/** A word in a pill, in its tone's colour (ok, warn, bad; --dim without one). */
function Chip({ tone, children, t }: { tone: Tone; children: ReactNode; t: Tokens }): JSX.Element {
  return (
    <View flexShrink={0} paddingHorizontal={6} borderRadius={999} borderWidth={1} borderStyle="solid" borderColor={t.v(tone ?? "line") as never}>
      <Txt spec={{ voice: "app", scale: 10 / 12.5, color: tone ?? "dim" }} numberOfLines={1}>
        {children}
      </Txt>
    </View>
  );
}

/** A notice, on its tone's tint (accent, warn or bad). */
function Notice({ tone, children, t }: { tone?: "warn" | "bad"; children: ReactNode; t: Tokens }): JSX.Element {
  return (
    <View borderRadius={lengthToken(t, "control-radius", 7)} paddingVertical={7} paddingHorizontal={9} backgroundColor={t.v(tone === "warn" ? "tint-warn" : tone === "bad" ? "tint-bad" : "tint-accent") as never}>
      <Txt spec={{ voice: "app", scale: 11 / 12.5, color: tone ?? "dim" }} {...WRAP}>
        {children}
      </Txt>
    </View>
  );
}

/** An empty note: --dim, 8 above and below, and a paragraph's margins (1em of the body's 13) — or those collapsed. */
function Empty({ children, t, collapsed = false }: { children: ReactNode; t: Tokens; collapsed?: boolean }): JSX.Element {
  const em = t.scaled("size-app", 13 / 12.5) as number;
  return (
    <Txt spec={{ voice: "app", scale: 13 / 12.5, color: "dim" }} paddingVertical={8} {...(collapsed ? { marginTop: Math.max(0, em - 6), marginBottom: 0 } : { marginVertical: em })}>
      {children}
    </Txt>
  );
}
