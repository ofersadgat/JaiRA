/**
 * The usage readings, drawn (docs/engineering/contracts/usage-readings.md, "What the screens show").
 *
 *  - {@link ContextMeter} — the composer's right edge: a ring for how full THIS conversation is, and
 *    its popover (the breakdown, where the agent compacts by itself, Compact now).
 *  - {@link AllowanceNumber} — right after the model chip: the percent of the account's tightest
 *    window used, and the account's popover (every window, when each resets, the other accounts).
 *  - {@link SpentNotice} — the line over the composer when the account has nothing left.
 *  - {@link TurnContext} — on each answer's rail: the context after that turn.
 *  - {@link CompactionLine} — a compaction, as a line of its own.
 *  - {@link WaitingLine} — under a message or a run waiting for the allowance.
 *  - {@link AccountAllowance} — a sign-in card's ring: the WEEKLY window and when it resets.
 *
 * Render functions (SHELL's standing rule): everything arrives as props or from the limits store, so
 * each state is one static render. Numbers are written for a person by `@jaira/shared`'s formatters.
 */
import { useEffect, useRef, useState, type JSX, type ReactNode } from "react";
import {
  contextFill,
  formatAge,
  formatResetAt,
  formatTokens,
  formatUntil,
  isSpent,
  spentUntil,
  toneOfContext,
  toneOfPercent,
  usedPercentFor,
  weeklyWindow,
  windowIsCurrent,
  windowStatus,
  type ContextPart,
  type ContextReading,
  type LimitAccountView,
  type LimitWindow,
  type WaitingItem,
} from "@jaira/shared/browser";
import { BrandIcon, Icon } from "./icons";
import { accountFor, actOnWaiting, refreshAccount, useLimits, useLimitsWatch, useNow } from "./limitsStore";

// --- the pieces everything here is drawn from -----------------------------------------------

/** Open on a click, closed by a click elsewhere or Escape — the composer chips' own behaviour. */
function usePop(startOpen = false): { open: boolean; setOpen: (v: boolean | ((was: boolean) => boolean)) => void; ref: React.RefObject<HTMLDivElement | null> } {
  const [open, setOpen] = useState(startOpen);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent): void => {
      if (ref.current !== null && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const esc = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  return { open, setOpen, ref };
}

/** A ring `pct` of the way round, in a tone; an empty dashed ring when there is no figure. */
export function Ring({ pct, tone, size = "md" }: { pct: number | null; tone: string; size?: "sm" | "md" | "lg" }): JSX.Element {
  return (
    <svg className={`um-ring um-${tone} um-ring-${size}`} viewBox="0 0 20 20" aria-hidden>
      <circle className={`um-ring-track${pct === null ? " is-empty" : ""}`} cx="10" cy="10" r="7" />
      {pct === null ? null : (
        <circle className="um-ring-fill" cx="10" cy="10" r="7" pathLength={100} strokeDasharray={`${Math.max(0, Math.min(100, pct))} 100`} transform="rotate(-90 10 10)" />
      )}
    </svg>
  );
}

function Bar({ pct, tone }: { pct: number | null; tone: string }): JSX.Element {
  return (
    <span className={`um-bar um-${tone}`}>
      <i style={{ width: `${Math.max(0, Math.min(100, pct ?? 0))}%` }} />
    </span>
  );
}

const round = (n: number): number => Math.round(n);

/** The colour of the n-th category in a breakdown — the rail palette, then the accent. */
const PART_COLOURS = ["var(--p3)", "var(--p2)", "var(--um-teal)", "var(--p1)", "var(--accent)", "var(--p4, var(--dim))"];
function colourOf(name: string, index: number): string {
  const key = name.toLowerCase();
  if (key.includes("message")) return "var(--accent)";
  return PART_COLOURS[index % (PART_COLOURS.length - 1)]!;
}

// --- the context: composer ring, its popover, the turn badge, the compaction line -------------

/**
 * How full the open conversation is — the composer's right edge.
 *
 * The ring alone at rest; it says its number from 80%, where the agent is about to compact. With no
 * reading yet the ring is empty and dashed, and with no known window it says the tokens instead.
 */
export function ContextMeter({
  context,
  route,
  busy,
  onCompact,
  startOpen,
}: {
  /** The conversation's last reading, or none yet. */
  context: ContextReading | null | undefined;
  /** The route the conversation runs on — decides whether Compact now is offered, and codex's baseline. */
  route?: string | undefined;
  /** A turn is in flight: Compact now waits for it to end. */
  busy?: boolean | undefined;
  /** Send the agent's own `/compact`, with what to keep. Absent where the agent cannot compact on request. */
  onCompact?: ((focus?: string) => void) | undefined;
  startOpen?: boolean | undefined;
}): JSX.Element {
  const { open, setOpen, ref } = usePop(startOpen === true);
  const fill = context ? contextFill(context, route) : null;
  const tone = context ? toneOfContext(fill) : "none";
  const text = context === null || context === undefined ? null : fill === null ? formatTokens(context.used, true) : fill >= 80 ? `${round(fill)}%` : null;
  const title =
    context === null || context === undefined
      ? "No reading yet — it fills after the first reply"
      : fill === null
        ? `This conversation holds ${formatTokens(context.used)} tokens`
        : `This conversation: ${round(fill)}% of the context (${formatTokens(context.used)} of ${formatTokens(context.window ?? 0)} tokens)`;
  return (
    <div className="cx-chip-wrap um-wrap" ref={ref}>
      <button type="button" className={`um-meter${open ? " on" : ""}`} aria-expanded={open} title={title} onClick={() => setOpen((v) => !v)}>
        <Ring pct={fill} tone={tone} />
        {text !== null ? <span className={`um-meter-text um-t-${tone}`}>{text}</span> : null}
      </button>
      {open ? (
        <div className="cx-pop um-pop um-pop-context">
          <div className="cx-pop-head">
            <span className="cx-pop-title">Context</span>
          </div>
          <ContextDetail context={context} route={route} busy={busy} onCompact={onCompact} />
        </div>
      ) : null}
    </div>
  );
}

/** The popover's body: the figure, the breakdown with its hover detail, and Compact now. */
export function ContextDetail({
  context,
  route,
  busy,
  onCompact,
  hover,
}: {
  context: ContextReading | null | undefined;
  route?: string | undefined;
  busy?: boolean | undefined;
  onCompact?: ((focus?: string) => void) | undefined;
  /** Draw a category's detail open — for a still picture. */
  hover?: string | undefined;
}): JSX.Element {
  const [shown, setShown] = useState<string | undefined>(hover);
  const [focusing, setFocusing] = useState(false);
  const [focus, setFocus] = useState("");
  if (context === null || context === undefined) {
    return (
      <section className="um-sec">
        <p className="um-note">No reading yet — it fills after the first reply.</p>
      </section>
    );
  }
  const fill = contextFill(context, route);
  const tone = toneOfContext(fill);
  const window = context.window;
  const parts = context.breakdown ?? [];
  const total = window ?? Math.max(context.used, 1);
  const open = parts.find((p) => p.name === shown);
  return (
    <section className={`um-sec um-${tone}`}>
      <div className="um-sec-head">
        <span className="um-sec-title">This conversation</span>
        <span className="um-sec-sub mono ellip">{context.model}</span>
      </div>
      <div className="um-big">
        <span className={`um-big-n um-t-${tone}`}>{fill === null ? formatTokens(context.used, true) : `${round(fill)}%`}</span>
        <span className="um-big-of">{window === null ? `${formatTokens(context.used)} tokens · the window is not known` : `${formatTokens(context.used)} of ${formatTokens(window)} tokens`}</span>
      </div>
      <div className="um-stack um-stack-tick" role="img" aria-label="what the context holds">
        {parts.length > 0 ? (
          parts.map((p, k) => <i key={p.name} style={{ width: `${(p.tokens / total) * 100}%`, background: colourOf(p.name, k) }} title={`${p.name}: ${formatTokens(p.tokens)}`} />)
        ) : (
          <i style={{ width: `${Math.min(100, (context.used / total) * 100)}%`, background: "var(--um-c)" }} />
        )}
        {context.autoCompactAt !== undefined && window !== null ? <b className="um-tick" style={{ left: `${(context.autoCompactAt / window) * 100}%` }} title="the agent compacts by itself here" /> : null}
      </div>
      {context.autoCompactAt !== undefined || onCompact !== undefined ? (
        <div className="um-autoline">
          {context.autoCompactAt !== undefined ? (
            <span>
              auto-compacts at {formatTokens(context.autoCompactAt, true)}
              {window !== null ? ` (${round((context.autoCompactAt / window) * 100)}%)` : ""}
            </span>
          ) : null}
          <span className="grow" />
          {onCompact !== undefined ? (
            <span className="um-split">
              <button type="button" className="ghost um-compact-btn" onClick={() => onCompact()} title={busy === true ? "Sent when the answer in progress ends" : "Compact the conversation now"}>
                <Icon name="fold" />
                {busy === true ? "Compact after this turn" : "Compact now"}
              </button>
              <button type="button" className="ghost um-split-more" aria-label="Compact with a focus" aria-expanded={focusing} onClick={() => setFocusing((v) => !v)}>
                ▾
              </button>
            </span>
          ) : null}
        </div>
      ) : null}
      {focusing && onCompact !== undefined ? (
        <div className="um-focus">
          <textarea
            className="um-focus-text"
            rows={3}
            value={focus}
            placeholder="What to keep — the decisions, the file names, …"
            onChange={(e) => setFocus(e.target.value)}
          />
          <div className="um-focus-foot">
            <span className="um-fly-sub">sent as the agent's own /compact, with these words</span>
            <span className="grow" />
            <button
              type="button"
              className="primary"
              onClick={() => {
                onCompact(focus.trim().length > 0 ? focus.trim() : undefined);
                setFocusing(false);
                setFocus("");
              }}
            >
              Compact
            </button>
          </div>
        </div>
      ) : null}
      {parts.length > 0 ? (
        <div className="um-cats-host">
          <div className="um-cats">
            {parts.map((p, k) => (
              <button
                key={p.name}
                type="button"
                className={`um-cat${shown === p.name ? " on" : ""}`}
                onMouseEnter={() => setShown(p.name)}
                onFocus={() => setShown(p.name)}
                onMouseLeave={() => setShown((was) => (was === p.name ? undefined : was))}
              >
                <b style={{ background: colourOf(p.name, k) }} />
                <span className="um-cat-name ellip">{p.name}</span>
                <span className="um-cat-n mono">{formatTokens(p.tokens, true)}</span>
                <span className="um-cat-pct">{window !== null ? `${((p.tokens / window) * 100).toFixed(1)}%` : ""}</span>
                <span className="um-cat-more">{p.parts !== undefined && p.parts.length > 0 ? "›" : ""}</span>
              </button>
            ))}
          </div>
          {open !== undefined && open.parts !== undefined && open.parts.length > 0 ? <PartFlyout part={open} window={window} /> : null}
        </div>
      ) : null}
    </section>
  );
}

/** One category opened: what it is made of, grouped where the parts are groups. */
function PartFlyout({ part, window }: { part: ContextPart; window: number | null }): JSX.Element {
  const max = Math.max(1, ...(part.parts ?? []).flatMap((p) => [p.tokens, ...(p.parts ?? []).map((q) => q.tokens)]));
  const row = (p: ContextPart): JSX.Element => (
    <div key={`${p.name}:${p.tokens}`} className={`um-fly-row${p.tokens === 0 ? " is-dim" : ""}`}>
      <span className="ellip">{p.name}</span>
      {p.note !== undefined ? <span className="um-fly-rsub ellip">{p.note}</span> : <span />}
      <span className="um-fly-bar">
        <i style={{ width: `${(p.tokens / max) * 100}%` }} />
      </span>
      <span className="um-cat-n mono">{formatTokens(p.tokens, true)}</span>
    </div>
  );
  return (
    <div className="um-fly" role="tooltip">
      <div className="um-fly-head">
        <span className="um-fly-title">{part.name}</span>
        <span className="um-fly-sub">
          {formatTokens(part.tokens, true)}
          {window !== null ? ` · ${((part.tokens / window) * 100).toFixed(1)}%` : ""}
        </span>
      </div>
      {(part.parts ?? []).map((p) =>
        p.parts !== undefined && p.parts.length > 0 ? (
          <div key={p.name} className="um-fly-groupwrap">
            <div className="um-fly-group">{p.name}</div>
            {p.parts.map(row)}
          </div>
        ) : (
          row(p)
        ),
      )}
    </div>
  );
}

/** On an answer's rail: how full the conversation was after it, with the breakdown on hover. */
export function TurnContext({ context, before, route }: { context: ContextReading; before?: ContextReading | undefined; route?: string | undefined }): JSX.Element {
  const fill = contextFill(context, route);
  const tone = toneOfContext(fill);
  const prior = before !== undefined ? contextFill(before, route) : null;
  const window = context.window;
  const parts = context.breakdown ?? [];
  return (
    <span className={`um-turn um-${tone}`} tabIndex={0} aria-label={fill === null ? `${formatTokens(context.used)} tokens in context after this reply` : `${round(fill)}% of the context after this reply`}>
      <Ring pct={fill} tone={tone} size="sm" />
      <span className="um-turn-n">{fill === null ? formatTokens(context.used, true) : `${round(fill)}%`}</span>
      <span className="um-tip" role="tooltip">
        <span className="um-tip-head">
          <b className={`um-t-${tone}`}>{fill === null ? formatTokens(context.used, true) : `${round(fill)}%`}</b> after this reply ·{" "}
          {window !== null ? `${formatTokens(context.used)} of ${formatTokens(window)}` : `${formatTokens(context.used)} tokens`}
        </span>
        {window !== null ? (
          <span className="um-stack">
            {parts.length > 0 ? (
              parts.map((p, k) => <i key={p.name} style={{ width: `${(p.tokens / window) * 100}%`, background: colourOf(p.name, k) }} />)
            ) : (
              <i style={{ width: `${(context.used / window) * 100}%`, background: "var(--accent)" }} />
            )}
          </span>
        ) : null}
        {fill !== null && prior !== null ? (
          <span className="um-tip-row">
            {fill >= prior ? "+" : "−"}
            {round(Math.abs(fill - prior))}% since the reply before
          </span>
        ) : null}
        <span className="um-tip-row mono">{context.model}</span>
      </span>
    </span>
  );
}

/**
 * A compaction, as a line of its own: what the context went from and to, and what caused it — the
 * agent's own report (`compact_boundary`) when it made one, else only that the context got smaller.
 */
export function CompactionLine({
  trigger,
  before,
  after,
  durationMs,
  window,
  derived,
}: {
  trigger?: string | undefined;
  before?: number | undefined;
  after?: number | undefined;
  durationMs?: number | undefined;
  window?: number | null | undefined;
  /** Worked out from one reading being lower than the one before — the agent said nothing. */
  derived?: boolean | undefined;
}): JSX.Element {
  const pct = (n: number | undefined): string | undefined => (n === undefined ? undefined : window !== null && window !== undefined && window > 0 ? `${round((n / window) * 100)}%` : formatTokens(n, true));
  const from = pct(before);
  const to = pct(after);
  const sub =
    derived === true
      ? "the context got smaller — the agent didn't say why"
      : trigger === "manual"
        ? "compacted at your request"
        : `compacted automatically${before !== undefined ? ` at ${formatTokens(before, true)}` : ""}${durationMs !== undefined ? ` · took ${round(durationMs / 1000)} s` : ""}`;
  return (
    <div className="um-compact" role="note">
      <Icon name="fold" />
      <span>
        context{" "}
        <b>
          {from ?? "?"} → {to ?? "?"}
        </b>
      </span>
      <span className="um-compact-sub">{sub}</span>
    </div>
  );
}

// --- the allowance: the number by the model, the account popover, the spent line ---------------

/**
 * The account's allowance, right after the model chip: the percent used of the window the next call
 * would hit first. Ink at rest, amber from 80%, red at 100%. Clicking it opens the account.
 */
export function AllowanceNumber({ route, model, startOpen }: { route: string | undefined; model?: string | undefined; startOpen?: boolean | undefined }): JSX.Element | null {
  const limits = useLimits();
  const now = useNow();
  const account = accountFor(limits, route);
  const { open, setOpen, ref } = usePop(startOpen === true);
  if (account === undefined) return null;
  const pct = usedPercentFor(account.reading, model, now);
  const tone = toneOfPercent(pct);
  const title =
    account.reading === null
      ? `${account.brand}: no usage reading yet`
      : `${account.brand} · ${pct === null ? "no figure yet" : `${round(pct)}% of the tightest window used`}`;
  return (
    <div className="cx-chip-wrap um-numwrap" ref={ref}>
      <button type="button" className={`um-num um-t-${tone}${open ? " on" : ""}`} aria-expanded={open} title={title} onClick={() => setOpen((v) => !v)}>
        {pct === null ? "–" : `${round(pct)}%`}
      </button>
      {open ? <AccountPopover account={account} model={model} others={limits.accounts.filter((a) => a.key !== account.key)} now={now} /> : null}
    </div>
  );
}

/** Split a window's label into its name and what it counts ("Weekly · Opus" → Weekly, Opus only). */
function windowName(w: LimitWindow, hasModelWindows: boolean): { name: string; sub?: string } {
  const [name, model] = w.label.split(" · ");
  if (model !== undefined) return { name: name!, sub: `${model} only` };
  return hasModelWindows && w.minutes === 10080 ? { name: w.label, sub: "all models" } : { name: w.label };
}

/** Every window of one account, when each resets, how old the reading is — and the other accounts. */
export function AccountPopover({
  account,
  model,
  others,
  now,
  className,
}: {
  account: LimitAccountView;
  model?: string | undefined;
  others: readonly LimitAccountView[];
  now: number;
  className?: string | undefined;
}): JSX.Element {
  useLimitsWatch(true);
  const reading = account.reading;
  const windows = (reading?.windows ?? []).filter((w) => windowIsCurrent(w, now) || windowStatus(w) === "exhausted");
  const hasModelWindows = windows.some((w) => w.model !== undefined);
  return (
    <div className={`cx-pop um-pop um-acctpop${className !== undefined ? ` ${className}` : ""}`}>
      <div className="cx-pop-head">
        <span className="cx-pop-title">Usage</span>
      </div>
      <section className="um-sec">
        <div className="um-sec-head">
          <span className="um-sec-icon">
            <BrandIcon name={account.brand} />
          </span>
          <span className="um-sec-title ellip">
            {account.brand}
            {account.who !== undefined ? ` · ${account.who}` : ""}
          </span>
          {account.plan !== null && account.plan !== undefined ? <span className="um-sec-sub">{capital(account.plan)}</span> : null}
        </div>
        {windows.length === 0 ? (
          <p className="um-note">{reading === null ? "No reading yet — it arrives with the first reply, or a refresh." : "The last reading named no windows."}</p>
        ) : (
          <div className="um-rows">
            {windows.map((w) => {
              const spent = windowStatus(w) === "exhausted";
              const pct = spent ? 100 : w.usedPercent;
              const tone = toneOfPercent(pct);
              const { name, sub } = windowName(w, hasModelWindows);
              const passed = !windowIsCurrent(w, now);
              return (
                <div key={w.id} className={`um-row${passed ? " is-passed" : ""}`}>
                  <span className="um-row-name">
                    <span className="ellip">{name}</span>
                    {sub !== undefined ? <span className="um-row-sub ellip">{sub}</span> : null}
                  </span>
                  <Bar pct={pct} tone={passed ? "none" : tone} />
                  <span className={`um-row-val um-t-${passed ? "none" : tone}`}>{spent && w.usedPercent === null ? "spent" : pct === null ? "–" : `${round(pct)}%`}</span>
                  <span className="um-row-reset" title={w.resetsAt !== null ? `${formatUntil(w.resetsAt, now)}` : undefined}>
                    {w.resetsAt === null ? "" : passed ? `passed ${formatResetAt(w.resetsAt, now)}` : `resets ${formatResetAt(w.resetsAt, now)}`}
                  </span>
                </div>
              );
            })}
          </div>
        )}
        {reading?.overage === true ? (
          <div className="um-extra">
            <span>
              <b>Extra usage</b> is on for this account: messages still go through, paid from credits.
            </span>
          </div>
        ) : null}
        {account.unavailable !== undefined ? <p className="um-note um-note-warn">{account.unavailable}</p> : null}
        <div className="um-foot">
          <span className="um-age">
            {account.updatedAt === null ? "never read" : `updated ${formatAge(account.updatedAt, now)}`}
            {reading !== null ? `, ${sourceWords(reading.source)}` : ""}
          </span>
          <span className="grow" />
          {account.refreshing ? (
            <span className="um-refreshing">
              <span className="um-spin" />
              refreshing…
            </span>
          ) : account.refreshable ? (
            <button type="button" className="ghost um-refresh" onClick={() => refreshAccount(account.key)}>
              <Icon name="refresh" />
              Refresh
            </button>
          ) : null}
        </div>
      </section>
      {others.length > 0 ? (
        <section className="um-sec">
          <div className="um-sec-head">
            <span className="um-sec-title">Your other accounts</span>
          </div>
          <div className="um-others">
            {others.map((o) => {
              const pct = usedPercentFor(o.reading, undefined, now);
              return (
                <div key={o.key} className={`um-other${pct === null ? " is-dim" : ""}`}>
                  <span className="um-sec-icon">
                    <BrandIcon name={o.brand} />
                  </span>
                  <span className="ellip">
                    {o.brand}
                    {o.who !== undefined ? ` · ${o.who}` : ""}
                  </span>
                  {pct === null ? (
                    <span className="um-other-n">no reading</span>
                  ) : (
                    <>
                      <Bar pct={pct} tone={toneOfPercent(pct)} />
                      <span className={`um-row-val um-t-${toneOfPercent(pct)}`}>{round(pct)}%</span>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function sourceWords(source: string): string {
  switch (source) {
    case "stream":
      return "from a conversation";
    case "query":
      return "asked directly";
    case "file":
      return "from codex's session file";
    case "headers":
      return "from the last call";
    default:
      return source;
  }
}

const capital = (s: string): string => (s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1));

/** Over the composer, while the account has nothing left: what happens to a message sent now. */
export function SpentNotice({ route }: { route: string | undefined }): JSX.Element | null {
  const limits = useLimits();
  const now = useNow();
  const account = accountFor(limits, route);
  if (account === undefined || !isSpent(account.reading, now)) return null;
  const until = spentUntil(account.reading, now);
  return (
    <div className="um-limitline" role="status">
      <Icon name="clock" />
      <span>
        <b>{account.brand} has no usage left</b>
        {until !== null ? ` until ${formatResetAt(until, now)}` : ""}. What you send now waits until then.
      </span>
    </div>
  );
}

/** Is the account behind this route out of allowance right now? */
export function useSpent(route: string | undefined): boolean {
  const limits = useLimits();
  const now = useNow();
  const account = accountFor(limits, route);
  return account !== undefined && isSpent(account.reading, now);
}

// --- waiting messages and runs ------------------------------------------------------------------

/**
 * Under a message (or a run) waiting for the allowance. `waiting`: it goes by itself at the reset,
 * with Send now anyway. `refused`: the provider refused it, and "Try again at …" decides whether it
 * goes again at the reset. Deleting the message cancels it — there is no Cancel here.
 */
export function WaitingLine({ item, run, onStop }: { item: WaitingItem; run?: boolean | undefined; onStop?: (() => void) | undefined }): JSX.Element {
  const limits = useLimits();
  const now = useNow();
  const account = limits.accounts.find((a) => a.key === item.account);
  const who = account?.brand ?? item.account;
  const at = item.until !== null ? formatResetAt(item.until, now) : undefined;
  return (
    <div className={`um-under${run === true ? " um-under-run" : ""}`}>
      {item.state === "waiting" ? (
        <span className="um-under-why">
          <Icon name="clock" />
          <span>
            Waiting: sends{at !== undefined ? <> at <b>{at}</b></> : " when the limit resets"}, when {who}'s limit resets
          </span>
        </span>
      ) : (
        <>
          <span className="um-under-why um-t-bad">
            <Icon name="clock" />
            <span>{run === true ? "Refused mid-turn" : "Refused"}: {who} has no usage left.</span>
          </span>
          <label className="um-check">
            <input type="checkbox" checked={item.retry} onChange={(e) => actOnWaiting(item.id, "retry", e.target.checked)} />
            <span>{at !== undefined ? <>Try again at <b>{at}</b></> : "Try again when the limit resets"}</span>
          </label>
        </>
      )}
      <button type="button" className="ghost um-sm" onClick={() => actOnWaiting(item.id, "sendNow")}>
        Send now anyway
      </button>
      {run === true && onStop !== undefined ? (
        <button type="button" className="ghost um-sm" onClick={onStop}>
          Stop the run
        </button>
      ) : null}
    </div>
  );
}

/** A waiting message, drawn as the bubble it will be — faded and dashed — with its line under it. */
export function WaitingMessage({ item }: { item: WaitingItem }): JSX.Element {
  return (
    <div className="ts-msg ts-msg-user um-waiting-msg">
      <div className="ts-bubble um-bubble-wait">
        <div className="vv">
          <div className="vv-body">
            <pre className="vv-source">{item.message ?? ""}</pre>
          </div>
        </div>
      </div>
      <WaitingLine item={item} />
      <div className="ts-rail">
        <span className="grow" />
        <button type="button" className="ts-act" title="Delete this message — it will not be sent" onClick={() => actOnWaiting(item.id, "drop")}>
          Delete
        </button>
      </div>
    </div>
  );
}

// --- the sign-in card ---------------------------------------------------------------------------

/**
 * A sign-in card's allowance: a ring with the WEEKLY window's percent on the plan line, and on the
 * line under it when that week resets ("Weekly · resets Mon 09:00"), red once it is used up. Clicking
 * the ring opens the account's popover — the same one the composer's number opens.
 */
export function AccountAllowance({ account, plan, startOpen }: { account: LimitAccountView | undefined; plan?: ReactNode; startOpen?: boolean | undefined }): JSX.Element {
  const limits = useLimits();
  const now = useNow();
  const { open, setOpen, ref } = usePop(startOpen === true);
  const week = account?.reading !== null && account?.reading !== undefined ? weeklyWindow(account.reading) : undefined;
  const spent = week !== undefined && windowStatus(week) === "exhausted";
  const pct = week === undefined ? null : spent ? 100 : week.usedPercent;
  const tone = toneOfPercent(pct);
  return (
    <>
      <div className="um-c-line">
        <span className="um-c-plan">{plan}</span>
        {account !== undefined ? (
          <div className="um-c-ringwrap" ref={ref}>
            <button type="button" className={`um-c-ringbtn um-t-${tone}${open ? " on" : ""}`} aria-expanded={open} title={week === undefined ? "No weekly reading yet — click for every window" : `Weekly window, ${pct === null ? "no figure" : `${round(pct)}% used`} — click for every window`} onClick={() => setOpen((v) => !v)}>
              <Ring pct={pct} tone={tone} size="md" />
              <span>{pct === null ? "–" : `${round(pct)}%`}</span>
            </button>
            {open ? <AccountPopover account={account} others={limits.accounts.filter((a) => a.key !== account.key)} now={now} className="um-cpop" /> : null}
          </div>
        ) : null}
      </div>
      {week !== undefined && week.resetsAt !== null ? (
        <div className="um-c-line um-c-line2">
          <span className={`um-rs${spent ? " is-spent" : ""}`} title={formatUntil(week.resetsAt, now)}>
            Weekly · resets {formatResetAt(week.resetsAt, now)}
          </span>
        </div>
      ) : null}
    </>
  );
}

// --- the model menu -----------------------------------------------------------------------------

/**
 * On a route row of the model menu: the account's tightest window, as a bar and a number — the
 * allowance belongs to the account behind the route. Red, with the time it comes back, once spent.
 */
export function RouteLeft({ route }: { route: string }): JSX.Element | null {
  const limits = useLimits();
  const now = useNow();
  const account = accountFor(limits, route);
  if (account === undefined || account.reading === null) return null;
  const spent = isSpent(account.reading, now);
  const pct = usedPercentFor(account.reading, undefined, now);
  if (pct === null && !spent) return null;
  const tone = spent ? "bad" : toneOfPercent(pct);
  const until = spent ? spentUntil(account.reading, now) : null;
  return (
    <span className={`um-route um-${tone}`} title={spent ? `no usage left until ${formatResetAt(until, now)}` : `${round(pct ?? 0)}% of the tightest window used`}>
      {spent ? null : <Bar pct={pct} tone={tone} />}
      <span className={`um-route-n um-t-${tone}`}>{spent ? (until !== null ? formatResetAt(until, now) : "spent") : `${round(pct ?? 0)}%`}</span>
    </span>
  );
}

/**
 * On a model row: the window that counts THIS model alone (a weekly Opus window), as the same bar
 * and number a route row carries — no words; the hover says which window. Nothing for a model with
 * no window of its own.
 */
export function ModelWindow({ route, model }: { route: string; model: string }): JSX.Element | null {
  const limits = useLimits();
  const now = useNow();
  const account = accountFor(limits, route);
  const id = model.toLowerCase();
  const own = (account?.reading?.windows ?? []).filter((w) => w.model !== undefined && id.includes(w.model.toLowerCase()) && windowIsCurrent(w, now));
  if (own.length === 0) return null;
  const w = own.reduce((a, b) => ((b.usedPercent ?? 0) > (a.usedPercent ?? 0) ? b : a));
  const pct = windowStatus(w) === "exhausted" ? 100 : w.usedPercent;
  const tone = toneOfPercent(pct);
  return (
    <span className={`um-route um-modelmark um-${tone}`} title={`${w.label}: ${pct === null ? "no figure" : `${round(pct)}% used`}${w.resetsAt !== null ? `, resets ${formatResetAt(w.resetsAt, now)}` : ""}`}>
      <Bar pct={pct} tone={tone} />
      <span className={`um-route-n um-t-${tone}`}>{pct === null ? "–" : `${round(pct)}%`}</span>
    </span>
  );
}
