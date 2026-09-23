/**
 * A run's conversation as SESSIONS laid out in time — the model behind the panelled transcript.
 *
 * The view this replaced was organised by STATE: the run's own words, then a card per child run. That
 * is the shape of the workflow, and it is the wrong shape for reading a conversation, because a
 * conversation is not a property of a state. Several states share one session on purpose — that is
 * what `environment.session` is for — and a state that shares a session with its sibling is
 * continuing the same thread, not starting a new one. Organised by state, the one fact the reader
 * came for (which of these were talking to the same context?) is the one fact nothing on screen says.
 *
 * So the unit here is the session, and the layout rule is that **vertical space is time**:
 *
 *  - Every operation in the subtree contributes a {@link SessionPiece} — its session, and the span
 *    the call occupied.
 *  - Pieces whose spans overlap are one {@link SessionBand}. A band is a slice of wall clock, and
 *    everything in it happened at the same time, so it is laid out ACROSS rather than down.
 *  - Inside a band, one {@link SessionSegment} per session — that is a panel.
 *  - A session appearing in more than one band was interrupted, and its segments say so: the earlier
 *    one is marked {@link SessionSegment.paused}, the later {@link SessionSegment.resumed}.
 *
 * ## Why "adjacent bands with the same sessions" merge
 *
 * Three states running one after another in one session are three non-overlapping pieces, so the
 * clustering above makes them three bands — and rendering them as three panels would claim two pauses
 * that never happened. A pause is only a pause when something ELSE ran in the gap, which is exactly
 * the case the merge leaves alone: adjacent bands survive as two only when their session sets differ.
 *
 * ## Pieces with no session
 *
 * A function op runs no model call, and an operation still in flight has not written its position
 * yet — neither has a session id, and both are things that happened and must be visible. They become
 * their own single-piece segments, keyed by instance, and never carry pause or resume marks: a
 * conversation that does not exist cannot be interrupted.
 *
 * ## States with no piece at all
 *
 * A state that never RAN has no piece and no panel — and a run fails precisely by producing those.
 * What it has instead is a {@link BandNote}: a journal failure placed in the same time order the
 * bands are in, drawn on the background between them. See {@link notesOf}.
 */
import {
  type ConversationTurn,
  type InstanceAddress,
  type InstanceNode,
  type MadeBatch,
  type SequentialBatchLayout,
  type SessionRef,
  type WorkflowOutcome,
} from "@jaira/shared/browser";

/**
 * One operation, and the conversation position it wrote.
 *
 * The span is the OPERATION's, not the instance's, wherever the journal recorded it — see
 * `SessionRef.startedAt`. For a composite that both delegates and speaks those differ by the whole of
 * its subtree, and using the instance's envelope would put its children inside its own band.
 */
export interface SessionPiece {
  node: InstanceNode;
  /**
   * The instance the RECORD is filed under — where the words actually are.
   *
   * Usually the node's own id, and different exactly where a record was written by something the
   * tree holds no node for: a chat child filed under `chat:<host>`, or history synthesised below.
   */
  instanceId?: string;
  /** Absent ⇒ this operation ran in no conversation, or has not finished writing its position. */
  sessionId?: string;
  /** Where this operation's record sits in its session. Absent with {@link sessionId}. */
  seq?: number;
  startedAt: number;
  /** Absent ⇒ still running, which overlaps everything that starts after it. */
  endedAt?: number;
  /** How the call ended, when it settled — what names a side of a fork. See {@link forksOf}. */
  status?: "success" | "error" | "interrupted" | "running";
  /** Where this conversation left another — `SessionRef.branch`, carried through unchanged. */
  branch?: { parent: string; at: number };
  /**
   * The STRETCH of this operation's transcript the piece draws, when a note cut the turn at a tool
   * call (see {@link splitAtNotes}). Absent ⇒ all of it.
   */
  part?: PiecePart;
}

/**
 * A stretch of one turn's transcript, bounded by tool calls (by the model's id for each): the entries
 * after the call `after`, up to and including the call `through`. Absent bounds are the turn's ends.
 */
export interface PiecePart {
  after?: string;
  through?: string;
}

/** One session's contribution to one band — a panel. */
export interface SessionSegment {
  /** The key this segment is grouped under: the session id, or `#<instance>` for a piece with none. */
  key: string;
  /** Absent for a piece that ran in no conversation. */
  sessionId?: string;
  pieces: SessionPiece[];
  /** This session ran earlier and something interrupted it — the top bar. */
  resumed: boolean;
  /** Something else runs next and this session comes back afterwards — the bottom bar. */
  paused: boolean;
}

/** A slice of wall clock in which everything overlapped. One band draws across; bands stack down. */
export interface SessionBand {
  startedAt: number;
  segments: SessionSegment[];
}

/** What a segment is grouped by. A piece with no session is its own thread and cannot be shared. */
function keyOf(piece: SessionPiece): string {
  return piece.sessionId ?? `#${piece.node.instanceId}`;
}

/**
 * Every operation under one run, oldest first — the whole subtree, at every depth.
 *
 * Flattened rather than nested because the sessions are: a grandchild continuing its grandparent's
 * conversation belongs in that conversation's panel, and a view that nested by state would put it
 * two boxes away from the turns it is answering.
 *
 * A state is a piece when it RAN something. A composite that only orchestrates contributes nothing —
 * it has no session, and the panel it used to get was filled by whichever conversation happened to be
 * last in the task, which is the bug this rewrite exists to fix. A leaf is always a piece even with
 * no session row, because "this state ran no model call" is an answer and dropping it would lose a
 * run from the picture entirely.
 */
export function piecesOf(root: InstanceNode | undefined, history: readonly SessionRef[]): SessionPiece[] {
  if (root === undefined) return [];
  /**
   * By INSTANCE ID, which is durable and continues across a stop and its resume (Identity and
   * Resume �05) — so a node collects every call its instance ever made, however many stretches of
   * execution they span. History with no node in the tree (a chat child, a legacy attempt the
   * machine-root filter dropped) is synthesised below rather than lost.
   */
  const byInstance = new Map<string, SessionRef[]>();
  for (const ref of history) {
    const list = byInstance.get(ref.instanceId);
    if (list === undefined) byInstance.set(ref.instanceId, [ref]);
    else list.push(ref);
  }

  const out: SessionPiece[] = [];
  const visit = (node: InstanceNode): void => {
    // An element that became a task (decision 0003) has no conversation here: it is a line in the
    // grey, and its panels are the task's own.
    if (node.made !== undefined) return;
    const found = byInstance.get(node.instanceId);
    // In the order they happened, which within one instance is position order.
    const refs = [...(found ?? [])].sort((a, b) => a.seq - b.seq);
    for (const ref of refs) {
      out.push({
        node,
        instanceId: ref.instanceId,
        sessionId: ref.sessionId,
        seq: ref.seq,
        // The instance's entry is the fallback, and it is only ever wrong by being generous: a run
        // recorded before `operation.started` was projected has nothing finer to offer.
        startedAt: ref.startedAt ?? node.startedAt,
        endedAt: ref.at,
        ...(ref.status !== undefined ? { status: ref.status } : {}),
        ...(ref.branch !== undefined ? { branch: ref.branch } : {}),
      });
    }
    // A leaf that wrote no position still ran. A composite that wrote none said nothing.
    if (refs.length === 0 && node.children.length === 0) {
      out.push({ node, startedAt: node.startedAt, ...(node.endedAt !== undefined ? { endedAt: node.endedAt } : {}) });
    }
    /**
     * EVERY child, superseded ones included.
     *
     * A superseded instance used to be skipped, on the reading that the engine had disowned it and
     * its conversation was "words from a branch that no longer happened". That reading is wrong,
     * and the loop is where it shows: `explore` running a second time supersedes the first pass the
     * moment its key is re-entered (`projection.ts`), so looping back to it deleted the whole
     * previous iteration from the transcript — panels that had been read, and answers a later state
     * was still working from. The branch DID happen. It ran, it cost money, and it is what the next
     * pass is a response to.
     *
     * `superseded` is a fact about EXPRESSION RESOLUTION, not about history: a superseded instance
     * no longer answers `children.<key>`, and the projection says in as many words that its history
     * is kept. Every other reader already treats it that way — the run board draws a card per
     * execution, the notes between the panels name every pass — and the transcript was the one
     * surface that took it as a reason to forget.
     *
     * Nothing is claimed about which pass is CURRENT. The panels are laid out in time order, so an
     * earlier iteration is above the one that replaced it, which is what it is.
     */
    for (const child of node.children) visit(child);
  };
  visit(root);

  /**
   * Operations the TREE has no node for — a chat child filed beside its host, or a legacy
   * attempt's work the machine-root filter keeps out of the tree. The call is still in the history,
   * still cost money and still said things, and without this it is on screen nowhere.
   *
   * Synthesised from the ref, which carries everything a panel needs — the state, the span. A node
   * built here is never walked into: it has no children by construction, because a composite writes
   * no session ref.
   */
  const drawn = new Set(out.map((piece) => `${piece.instanceId ?? piece.node.instanceId}:${piece.seq ?? ""}`));
  for (const ref of history) {
    if (drawn.has(`${ref.instanceId}:${ref.seq}`)) continue;
    out.push({
      node: {
        instanceId: ref.instanceId,
        stateId: ref.stateId,
        status: ref.status === "error" ? "failed" : ref.status === "interrupted" ? "canceled" : "completed",
        index: 0,
        superseded: false,
        startedAt: ref.startedAt ?? ref.at,
        endedAt: ref.at,
        ...(ref.address !== undefined ? { address: ref.address } : {}),
        children: [],
      },
      sessionId: ref.sessionId,
      seq: ref.seq,
      startedAt: ref.startedAt ?? ref.at,
      endedAt: ref.at,
      ...(ref.status !== undefined ? { status: ref.status } : {}),
      ...(ref.branch !== undefined ? { branch: ref.branch } : {}),
    });
  }

  // `localeCompare` as the last tiebreak: instance ids are UUIDv7 strings, whose lexicographic
  // order IS mint order — which is what the numeric subtraction used to buy.
  out.sort(
    (a, b) => a.startedAt - b.startedAt || (a.seq ?? 0) - (b.seq ?? 0) || a.node.instanceId.localeCompare(b.node.instanceId),
  );
  return out;
}

/**
 * The BATCH a piece belongs to, when it is (or is under) an element of a fan-out: the mount's own
 * address — every step down to the element's, with the element position dropped — so the elements
 * of one entry share it and a later pass of the same mount does not. Read off the node's address,
 * which the projection stamps, because that is the one place the element position is written down.
 */
function batchOf(piece: SessionPiece): string | undefined {
  const address = piece.node.address;
  if (address === undefined) return undefined;
  let at = -1;
  for (const [i, step] of address.entries()) if (step.element !== undefined) at = i;
  if (at < 0) return undefined;
  return address
    .slice(0, at + 1)
    .map((step, i) => (i === at ? `${step.childKey}#${step.occurrence}` : `${step.childKey}[${step.element ?? ""}]#${step.occurrence}`))
    .join("/");
}

/** The keys in a cluster, so two adjacent clusters can be asked whether they hold the same threads. */
function keysOf(cluster: readonly SessionPiece[]): string {
  return [...new Set(cluster.map(keyOf))].sort().join(" ");
}

/**
 * Group pieces into bands, and mark where a session was interrupted.
 *
 * Overlap is tested with `>=` on the boundary — a piece starting at the exact millisecond another
 * finished is a HANDOFF, not concurrency, and treating touching spans as overlapping would collapse
 * every sequential run into one band and lose the pause marks entirely.
 */
export function bandsOf(pieces: readonly SessionPiece[], options: { batches?: SequentialBatchLayout | undefined } = {}): SessionBand[] {
  const clusters: SessionPiece[][] = [];
  let end = -Infinity;
  /** The batches the open cluster holds pieces of — what a sequential element joins across time. */
  let batches = new Set<string>();
  for (const piece of pieces) {
    const stop = piece.endedAt ?? Infinity;
    const last = clusters[clusters.length - 1];
    // The elements of one fan-out batch are ONE band when the reader asked for that
    // (`JairaSettings.conversation`), whether or not they overlapped: siblings across, not passes
    // down. A batch whose elements overlapped is across either way, by the overlap rule alone.
    const batch = options.batches === "band" ? batchOf(piece) : undefined;
    if (last === undefined || (piece.startedAt >= end && !(batch !== undefined && batches.has(batch)))) {
      clusters.push([piece]);
      end = stop;
      batches = new Set(batch !== undefined ? [batch] : []);
      continue;
    }
    last.push(piece);
    end = Math.max(end, stop);
    if (batch !== undefined) batches.add(batch);
  }

  // See the module comment: consecutive bands holding the same threads are one stretch of that
  // conversation, and splitting them would draw a pause into an uninterrupted run of states.
  const merged: SessionPiece[][] = [];
  for (const cluster of clusters) {
    const prev = merged[merged.length - 1];
    if (prev !== undefined && keysOf(prev) === keysOf(cluster)) prev.push(...cluster);
    else merged.push([...cluster]);
  }

  const bands: SessionBand[] = merged.map((cluster) => {
    const bySegment = new Map<string, SessionSegment>();
    for (const piece of cluster) {
      const key = keyOf(piece);
      const segment = bySegment.get(key);
      if (segment !== undefined) segment.pieces.push(piece);
      else {
        bySegment.set(key, {
          key,
          ...(piece.sessionId !== undefined ? { sessionId: piece.sessionId } : {}),
          pieces: [piece],
          resumed: false,
          paused: false,
        });
      }
    }
    const segments = [...bySegment.values()].sort((a, b) => a.pieces[0]!.startedAt - b.pieces[0]!.startedAt);
    return { startedAt: cluster[0]!.startedAt, segments };
  });

  // A session's segments in band order. Everything but the last is followed by an interruption, and
  // everything but the first follows one — which is precisely the pair of bars.
  const threads = new Map<string, SessionSegment[]>();
  for (const band of bands) {
    for (const segment of band.segments) {
      if (segment.sessionId === undefined) continue;
      const list = threads.get(segment.key);
      if (list === undefined) threads.set(segment.key, [segment]);
      else list.push(segment);
    }
  }
  for (const list of threads.values()) {
    for (const [i, segment] of list.entries()) {
      segment.resumed = i > 0;
      segment.paused = i < list.length - 1;
    }
  }
  return bands;
}

/**
 * What identifies one operation's PLACE in a conversation — and so the panel it is drawn in.
 *
 * A session id alone is not enough: several operations share one conversation on purpose, and the
 * two sides of a fork differ by position rather than by name — the attempt that failed and the one
 * that replaced it both sit at the same seq, in a parent and its branch. Absent for a piece that ran
 * in no conversation, which cannot be a side of anything.
 */
export function placeOf(piece: SessionPiece): string | undefined {
  return piece.sessionId === undefined || piece.seq === undefined ? undefined : `${piece.sessionId}@${piece.seq}`;
}

/**
 * Every fork in a run: for each operation that is a SIDE of one, all the sides in the order they ran.
 *
 * A retried state re-enters a position the failed attempt already claimed, so it forks (SESSIONS.md
 * §4) — and the two attempts arrive here as two ordinary pieces with unrelated session ids, one of
 * them silently carrying the other's whole prefix. The lineage each piece now carries (`branch`) is
 * what pairs them back up: a fork POINT is the position a branch left, and its sides are the piece
 * that was already sitting there plus every piece that branched away from it.
 *
 * Keyed by {@link placeOf} rather than by session, because both facts a panel needs are per-position:
 * whether this operation is a side at all, and which of them it is. Every side of one fork gets the
 * same array, so `sides.indexOf(piece)` is the answer to "which".
 *
 * A point with fewer than two sides drawn is not reported. That is not the ordinary case — a failed
 * attempt is recorded exactly as a successful one is, so both sides are pieces — but a side that is
 * not on the page cannot be offered, and "1 of 1" would be a fork mark over something that never
 * divided.
 */
export function forksOf(pieces: readonly SessionPiece[]): Map<string, SessionPiece[]> {
  const at = new Map<string, SessionPiece[]>();
  for (const piece of pieces) {
    if (piece.branch === undefined) continue;
    const point = `${piece.branch.parent}@${piece.branch.at}`;
    const sides = at.get(point);
    if (sides === undefined) at.set(point, [piece]);
    else sides.push(piece);
  }
  // The side the branches LEFT: the record already at that position, which keeps the parent's name.
  for (const piece of pieces) {
    const place = placeOf(piece);
    if (place === undefined) continue;
    at.get(place)?.unshift(piece);
  }

  const out = new Map<string, SessionPiece[]>();
  for (const sides of at.values()) {
    if (sides.length < 2) continue;
    sides.sort((a, b) => a.startedAt - b.startedAt);
    for (const side of sides) {
      const place = placeOf(side);
      if (place !== undefined) out.set(place, sides);
    }
  }
  return out;
}

/** Whether two addresses name the same place. Structural, because an address is not a string. */
export function sameAddress(a: InstanceAddress | undefined, c: InstanceAddress | undefined): boolean {
  if (a === undefined || c === undefined) return a === c;
  // The element too: the members of a fan-out share a key and an occurrence and are different places.
  return (
    a.length === c.length &&
    a.every((step, i) => step.childKey === c[i]?.childKey && step.occurrence === c[i]?.occurrence && step.element === c[i]?.element)
  );
}

/**
 * The piece that OPENED each session, keyed the way segments are.
 *
 * A session is not started by a workflow so much as by a state running in it first — everything
 * after that is joining a conversation already in progress. That first state is what a panel's
 * gutter names beside the session id, and it has to be found across the whole run rather than
 * within one segment: a session that was interrupted and resumed has two panels, and the second one
 * did not start anything.
 */
export function startersOf(bands: readonly SessionBand[]): Map<string, SessionPiece> {
  const first = new Map<string, SessionPiece>();
  for (const band of bands) {
    for (const segment of band.segments) {
      for (const piece of segment.pieces) {
        const held = first.get(segment.key);
        if (held === undefined || piece.startedAt < held.startedAt) first.set(segment.key, piece);
      }
    }
  }
  return first;
}

/** Every instance whose transcript the panels will need — what the host has to have fetched. */
export function instancesOf(bands: readonly SessionBand[]): Array<{ instanceId: string }> {
  const seen = new Map<string, { instanceId: string }>();
  for (const band of bands) {
    for (const segment of band.segments) {
      for (const piece of segment.pieces) {
        const at = recordAt(piece);
        seen.set(at.instanceId, at);
      }
    }
  }
  return [...seen.values()];
}

/**
 * Where a piece's transcript is filed — the ONE answer, so the fetch and the read cannot disagree.
 *
 * The piece's own instance before the node's: a chat child's record is filed under `chat:<host>`,
 * which the tree holds no node for. Falling back to the node is right for a leaf with no session at
 * all, where there is nothing else to name.
 */
export function recordAt(piece: SessionPiece): { instanceId: string } {
  return { instanceId: piece.instanceId ?? piece.node.instanceId };
}

// --- what no panel can hold ---------------------------------------------------

/**
 * A failure with nowhere to appear.
 *
 * A panel is a session, and a session is something a state OPENED — so a state that never got that
 * far has no panel, and an error about it had no place on this page at all. Those are precisely the
 * errors a person opens a failed run to read: the child whose input never resolved and so never
 * became an instance, and the composite that gave up because one of its children did. Both are in
 * the journal; neither says a word inside a transcript, because neither ran a model call.
 *
 * So they are drawn on the BACKGROUND, between the panels, at the point in the run where they
 * happened — which is the one place that is both in time order and not inside a conversation that
 * did not have them.
 */
export interface BandNote {
  /** The journal seq, so two notes in the same millisecond keep the order they were recorded in. */
  seq: number;
  at: number;
  /**
   * What this note IS, because the two read differently and are not the same news.
   *
   * `entered` and `transition` are the machine MOVING, which is not an error and must not be drawn
   * as one: the first is a state the run walked into, the second a RULE firing and sending control
   * somewhere. Both are needed, because they are recorded separately and neither implies the other —
   * a sequence walking from one child to the next emits no `transition.taken` at all, so a path drawn
   * from transitions alone would be empty for a run that fell straight down its spine, which is
   * precisely the run someone opens to ask how far it got.
   *
   * `blocked` is a child that could not be entered AT ALL, and reads as the negative of `entered` —
   * "could not enter X" — rather than as a bare reason, because that is what it is. `failure` is
   * everything else that went wrong: a call that failed, a state that gave up.
   */
  kind: "failure" | "blocked" | "entered" | "transition" | "made" | "skipped" | "moved";
  /** The state DEFINITION the note is about, when the journal named one — what the title shows. */
  stateId?: string;
  /** For a `made` note: the runs the batch's elements became — see `MadeBatch`. */
  made?: MadeBatch;
  /**
   * For a `moved` note: what the conversation's `start_task` / `move_task` did, from the host's
   * `jaira.moved` row — the row the mockup draws beside the panel, in the tool note's own words.
   */
  moved?: WorkflowOutcome;
  /** For a `moved` note: the tool call that did it, when the row names it — where {@link splitAtNotes} cuts. */
  toolCallId?: string;
  /**
   * For a `skipped` note that stands for SEVERAL states never entered: their child keys, in the order
   * they were stepped over, the first being the note's own. One Skip steps over a run of siblings, and
   * "skipped · never entered · ui, engineering" is one fact about one gesture — a row per state read
   * as three things happening. Absent on an interrupted state, which keeps its own row.
   */
  keys?: string[];
  /**
   * The instance the note is about, when it became one.
   *
   * The rail's lane identity — see `rail.ts`. It has to be the instance and not the state, because
   * `explore` running twice is two lanes with one colour, and a rail keyed on the name would draw the
   * second pass as a continuation of the first. Absent on a `blocked` note by construction: a child
   * that could not be entered never became an instance, which is what blocked means.
   */
  instanceId?: string;
  /**
   * Where it happened, as the chain of child keys from the run's root — `product/explore`.
   *
   * This and not `stateId` is what a row is addressed by. `explore` is one state file mounted under
   * all six phases of the feature workflow: its id says which FILE, and only the mount says which of
   * the six was running it. The empty string is the root, i.e. the module already being looked at.
   */
  path: string;
  /** A failure's reason, or a transition's TARGET — the child key the rule went to. Empty for `entered`. */
  text: string;
}

/**
 * Whether the instance a turn names ran an OPERATION — the one fact the error routing turns on.
 *
 * ## The rule
 *
 * **A failure is drawn in a panel if and only if its instance has an operation. Everything else goes
 * on the grey.** Both halves read this, and neither reads anything else.
 *
 * It is not a new rule. It is the one this module already gives for why the grey exists — "a panel
 * is a session, and a session is something a state OPENED, so a state that never got that far has no
 * panel" — stated for blocked children and then never applied to failures, which is how a failed
 * call came to be written in both places at once.
 *
 * ## Why it is a lookup and not a test
 *
 * The three questions this replaces could not be answered from a turn at all. *Is this a composite?*
 * — a turn has no children. *Was this termination already reported by its operation?* — that is a
 * backwards scan through a list merged from two streams and sorted by clock. *Is this turn a state
 * being entered?* — that was `text === "entered"`, a discriminated union spelled as a magic string.
 *
 * Against the tree, all three collapse into this: `projection.ts` sets `node.operation` on
 * `operation.started` and on `operation.failed`, and on nothing else. So an instance that dispatched
 * always has one and an instance that did not never does, and the routing is a fact rather than an
 * inference.
 *
 * A turn with NO instance is a `blocked` child — it never became one, which is what blocked means —
 * and answers `false`, correctly: there is no panel and there never will be.
 */
function ranAnOperation(turn: ConversationTurn, byInstance: Map<string, InstanceNode>): boolean {
  if (turn.instanceId === undefined) return false;
  return byInstance.get(turn.instanceId)?.operation !== undefined;
}

/** Every instance in a run, by id — the index the rule above is a lookup into. */
function instancesById(root: InstanceNode | undefined): Map<string, InstanceNode> {
  const out = new Map<string, InstanceNode>();
  const visit = (node: InstanceNode): void => {
    out.set(node.instanceId, node);
    for (const child of node.children) visit(child);
  };
  if (root !== undefined) visit(root);
  return out;
}

/**
 * The reason, without the state id the engine prefixed it with.
 *
 * `feature/product/draft: input 'framing': producer output has no 'winner'` is one sentence with its
 * subject stated twice once the note carries the state beside it.
 */
function reasonOf(turn: ConversationTurn): string {
  const text = (turn.text ?? "").trim();
  const prefix = `${turn.stateId ?? ""}: `;
  return turn.stateId !== undefined && text.startsWith(prefix) ? text.slice(prefix.length) : text;
}

/**
 * Where one instance sits in the run, as the chain of child KEYS from the root.
 *
 * The same walk `conversationView` does over the events, done here over the tree, because the view
 * knows which instance is being READ and the projection does not. A run walked into two levels deep
 * needs its notes shown relative to where it is standing, not to the root of the workflow.
 */
export function mountPathOf(instances: readonly InstanceNode[], instanceId: string): string {
  const walk = (nodes: readonly InstanceNode[], base: string): string | undefined => {
    for (const node of nodes) {
      const here = node.childKey === undefined ? base : base === "" ? node.childKey : `${base}/${node.childKey}`;
      if (node.instanceId === instanceId) return here;
      const found = walk(node.children, here);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return walk(instances, "") ?? "";
}

/**
 * A mount path as it reads from the module being looked at: `product → explore`.
 *
 * Two things happen here. The path is trimmed to the module — a page opened on `feature` already
 * says `feature`, and repeating it on every row pushes the half that varies off the end of a narrow
 * column. And the separator becomes an ARROW, because that is what the segments are: `product` then
 * `explore` is the run going one step further in, not a file sitting in a folder.
 *
 * The module itself is the empty string. Nothing to draw — you are looking at it.
 */
export function pathFrom(path: string, root: string): string {
  return segmentsFrom(path, root).join(" → ");
}

/**
 * The same trim, as the segments themselves — what the rail counts depth in.
 *
 * A path that is not underneath `root` is left whole rather than being made relative to something it
 * is not under. That is the honest reading of a note whose mount the projection did not record: it
 * says where it says it is, and the rail draws it at that depth.
 */
export function segmentsFrom(path: string, root: string): string[] {
  const inner = root === "" ? path : path === root ? "" : path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
  return inner === "" ? [] : inner.split("/");
}

/**
 * What the panels cannot carry, oldest first: the MACHINE's failures, and its own moves.
 *
 * Both are journal facts about STATES, and a panel is a SESSION — so a composite that never opened a
 * conversation has nowhere to say either, however much of the run it decided.
 *
 * ## What is no longer here
 *
 * An operation's own failure. It used to be, and a state that spoke and then failed said so twice —
 * once as a grey note and once, now, as a red panel. That is one event written in two places, and
 * the note is the worse of the two: it has the reason and none of the context, no retry, and no
 * relation to the call that produced it.
 *
 * So the split is by {@link ranAnOperation}: a turn whose instance dispatched belongs to that
 * instance's sheet and is dropped here. What is left is exactly what has no sheet — a child that was
 * blocked before it could run, and a composite that gave up because one of its children did.
 *
 * `root` is the instance tree the notes are being read against. ABSENT means no tree was available
 * — a projection that has not landed yet — and then nothing is dropped, because the alternative is
 * silently hiding a run's only error while the panel that would have shown it does not exist either.
 *
 * Failures are de-duplicated on state and text — a run that is retried re-blocks the same child for
 * the same reason, and a column of identical sentences says no more than one does. TRANSITIONS are
 * NOT: a loop that took `critique → draft` three times took it three times, and collapsing those
 * would hide the one thing a path is drawn to show.
 */
/** How long an interrupted state had been running — the run card's own units (`durationOf`), restated to keep this module free of the view's. */
function spanOf(ms: number): string {
  if (ms < 1000) return `${Math.max(0, ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)} m ${seconds % 60} s`;
}

export function notesOf(turns: readonly ConversationTurn[], root?: InstanceNode): BandNote[] {
  const byInstance = instancesById(root);
  /** With no tree to ask, nothing is claimed by a panel — see the note above. */
  const hasPanel = (turn: ConversationTurn): boolean => byInstance.size > 0 && ranAnOperation(turn, byInstance);
  const seen = new Set<string>();
  const out: BandNote[] = [];
  /**
   * A person's move stepped past it (decision 0005 §4) — interrupted by a Skip, or never entered.
   *
   * Never entered is journaled as an entry and a `skipped` end back to back, because a skipped
   * occurrence is still an occurrence. Drawn as "entered X", then "skipped X", that reads as a state
   * that ran; so the pair is ONE row that says it never did. An interrupted state keeps its entry
   * and says how long it had been running when it was cut.
   */
  const enteredAt = new Map<string, { seq: number; at: number }>();
  const neverEntered = new Set<string>();
  for (const turn of turns) {
    if (turn.instanceId === undefined) continue;
    if (turn.kind === "entered") enteredAt.set(turn.instanceId, { seq: turn.seq, at: turn.at });
    else if (turn.kind === "terminated" && turn.text === "skipped" && enteredAt.get(turn.instanceId)?.seq === turn.seq - 1) neverEntered.add(turn.instanceId);
  }
  for (const turn of turns) {
    const named = {
      ...(turn.stateId !== undefined ? { stateId: turn.stateId } : {}),
      ...(turn.instanceId !== undefined ? { instanceId: turn.instanceId } : {}),
    };
    // An absent mount falls back to the state id. Journals written before `instance.blocked` carried
    // its parent and key have no mount to show — and reading that absence as the ROOT would both
    // print every historical block against the module itself and, because the de-duplication key is
    // the path, silently collapse two blocks that happened to fail for the same reason into one.
    const path = turn.path ?? turn.stateId ?? "";
    // A state being walked into — its own kind since the projection stopped folding three events
    // onto one. Drawn for every state, whether or not it has a panel: the grey is where the run's
    // PATH is read, and a path with the states that spoke missing from it is not a path.
    if (turn.kind === "entered") {
      // The ROOT entering itself is not a step. Everything in the run is inside it, so "entered
      // feature" on a page about `feature` says only that the page is about `feature`.
      if (path === "") continue;
      if (turn.instanceId !== undefined && neverEntered.has(turn.instanceId)) continue;
      out.push({ seq: turn.seq, at: turn.at, kind: "entered", ...named, path, text: "" });
      continue;
    }
    if (turn.kind === "terminated" && turn.text === "skipped") {
      if (path === "") continue;
      const began = turn.instanceId !== undefined ? enteredAt.get(turn.instanceId) : undefined;
      const text = turn.instanceId !== undefined && neverEntered.has(turn.instanceId) ? "never entered" : began !== undefined ? `interrupted at ${spanOf(turn.at - began.at)}` : "interrupted";
      out.push({ seq: turn.seq, at: turn.at, kind: "skipped", ...named, path, text });
      continue;
    }
    // An element that became a TASK (decision 0003): the machine made something, and the line says
    // what and links to it. Never a panel — the work is in the task — and never a lane.
    if (turn.kind === "made" && turn.made !== undefined) {
      out.push({ seq: turn.seq, at: turn.at, kind: "made", ...named, path, text: "", made: turn.made });
      continue;
    }
    // What the conversation's own workflow tool did (`jaira.moved`, decision 0005 §3). At the ROOT —
    // the conversation is the root — and never a lane: nothing was entered by saying so.
    if (turn.kind === "moved") {
      if (turn.moved !== undefined) {
        out.push({ seq: turn.seq, at: turn.at, kind: "moved", path: "", text: "", moved: turn.moved, ...(turn.toolCallId !== undefined ? { toolCallId: turn.toolCallId } : {}) });
      }
      continue;
    }
    if (turn.kind === "transition") {
      // `text` is the TARGET the rule went to (see `conversationView`) — a child key, or one of the
      // `terminate.*` pseudo-states. A transition GOES somewhere, so the row is addressed by where it
      // arrives: the taking state's path with the target as one more step.
      const to = (turn.text ?? "").trim();
      if (to.length === 0) continue;
      const arrivedAt = path === "" ? to : `${path}/${to}`;
      out.push({ seq: turn.seq, at: turn.at, kind: "transition", ...named, path: arrivedAt, text: to });
      continue;
    }
    const blocked = turn.kind === "blocked";
    // `failure` is an operation erroring; a `terminated` turn with `ok: false` is an instance ending
    // badly. Both are failures; only the ones whose instance has no sheet are drawn here.
    if (!blocked && turn.kind !== "failure" && !(turn.kind === "terminated" && turn.ok === false)) continue;
    if (!blocked && hasPanel(turn)) continue;
    const text = reasonOf(turn);
    if (text.length === 0) continue;
    const key = `${path} ${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ seq: turn.seq, at: turn.at, kind: blocked ? "blocked" : "failure", ...named, path, text });
  }
  return groupNeverEntered(out.sort((a, b) => a.at - b.at || a.seq - b.seq));
}

/** The mount a path sits in: `feature/ui` → `feature`, `ui` → the root. */
function parentOf(path: string): string {
  const at = path.lastIndexOf("/");
  return at < 0 ? "" : path.slice(0, at);
}

/**
 * One row for the states a Skip stepped over without entering (decision 0005 §4, the mockup's
 * "skipped · never entered · ui, engineering").
 *
 * A run of never-entered notes that follow each other with nothing between and sit in the same mount
 * is one gesture's work, so it is one row: the first note, carrying every key in `keys`. The state that
 * was INTERRUPTED is not folded in — it ran, and how long it had run is its own sentence — and neither
 * is a never-entered state in a different mount, whose path the row could not say in one breath.
 */
export function groupNeverEntered(notes: readonly BandNote[]): BandNote[] {
  const out: BandNote[] = [];
  const keyOf = (note: BandNote): string => note.path.slice(note.path.lastIndexOf("/") + 1);
  for (const note of notes) {
    const last = out[out.length - 1];
    const never = note.kind === "skipped" && note.text === "never entered";
    if (never && last !== undefined && last.kind === "skipped" && last.text === "never entered" && parentOf(last.path) === parentOf(note.path)) {
      out[out.length - 1] = { ...last, keys: [...(last.keys ?? [keyOf(last)]), keyOf(note)] };
      continue;
    }
    out.push(note);
  }
  return out;
}

/**
 * Split a conversation's band where a `moved` note falls inside it, so the note is a row AT the point
 * it happened — the mockup's "adopted into Feature workflow …" right after the `move_task` call that
 * did it, with the conversation's reply carrying on underneath.
 *
 * Needed because consecutive turns of one conversation are one band (see the module comment), and a
 * note is placed between bands; unsplit, every tool note of a long conversation would pile up after
 * its last turn. A note that names its CALL (`toolCallId`) cuts the turn that made the call in two —
 * the transcript through the call, and the rest of it ({@link PiecePart}) — and the band after the
 * cut starts at the note's own instant, so {@link placeNotes} puts the row between the halves. A note
 * whose runtime did not say which call made it cuts at turn granularity instead: after the turn it
 * fell in, before the next.
 *
 * Only a band holding ONE conversation splits: across several, the turns overlap by definition, and
 * there is no "between" to put the row in. Nothing about the conversation changes: no pause or resume
 * mark is drawn at a cut, because nothing else ran in the gap. The halves keep the marks the band had
 * at its two ends.
 */
export function splitAtNotes(bands: readonly SessionBand[], notes: readonly BandNote[]): SessionBand[] {
  const moved = notes.filter((note) => note.kind === "moved");
  if (moved.length === 0) return [...bands];
  const inside = (piece: SessionPiece, at: number): boolean => piece.startedAt <= at && (piece.endedAt === undefined || at <= piece.endedAt);
  const out: SessionBand[] = [];
  for (const band of bands) {
    const only = band.segments.length === 1 ? band.segments[0]! : undefined;
    if (only === undefined) {
      out.push(band);
      continue;
    }
    // A note names a call it can be cut at only when it fell inside one of this band's turns.
    const atCall = moved.filter((note) => note.toolCallId !== undefined && only.pieces.some((piece) => inside(piece, note.at)));
    const atTurn = moved.filter((note) => !atCall.includes(note)).map((note) => note.at);
    const halves: Array<{ pieces: SessionPiece[]; startedAt?: number }> = [];
    let current: SessionPiece[] = [];
    let startedAt: number | undefined;
    const cut = (next?: number): void => {
      if (current.length > 0) halves.push({ pieces: current, ...(startedAt !== undefined ? { startedAt } : {}) });
      current = [];
      startedAt = next;
    };
    only.pieces.forEach((piece, k) => {
      const calls = atCall.filter((note) => inside(piece, note.at)).sort((a, b) => a.at - b.at || a.seq - b.seq);
      let after: string | undefined;
      for (const note of calls) {
        current.push({ ...piece, part: { ...(after !== undefined ? { after } : {}), through: note.toolCallId! } });
        cut(note.at);
        after = note.toolCallId;
      }
      current.push(after === undefined ? piece : { ...piece, part: { after } });
      const next = only.pieces[k + 1];
      if (next !== undefined && atTurn.some((at) => piece.startedAt <= at && at < next.startedAt)) cut();
    });
    cut();
    if (halves.length === 1) {
      out.push(band);
      continue;
    }
    halves.forEach((half, i) => {
      out.push({
        startedAt: half.startedAt ?? half.pieces[0]!.startedAt,
        segments: [{ ...only, pieces: half.pieces, resumed: i === 0 && only.resumed, paused: i === halves.length - 1 && only.paused }],
      });
    });
  }
  return out;
}

/**
 * Which notes sit above each band, and which are left over at the end.
 *
 * `bands.length + 1` buckets, because the interesting one is usually the last: a run fails on its way
 * OUT of the states that spoke, so the sentence explaining why is after everything on the page.
 *
 * A note is placed by the band it precedes rather than by the band it falls inside. Bands are spans
 * and notes are instants, and an instant inside a band belongs to a conversation that was already
 * being had — so it is drawn after that band rather than in the middle of it.
 *
 * A band that starts at the note's OWN instant has not "already started": the comparison is strictly
 * `<`. That is not a rounding nicety, it is the common case. A band begins at the `operation.started`
 * of its first call, and the state ENTERING is the event immediately before it in the journal — the
 * one that caused it. The two land in the same millisecond routinely, and on `<=` the tie read as
 * "the conversation was already under way", which drew `entered product → context` UNDERNEATH the
 * context conversation it opened.
 */
export function placeNotes(notes: readonly BandNote[], bands: readonly SessionBand[]): BandNote[][] {
  const buckets: BandNote[][] = bands.map(() => []);
  buckets.push([]);
  let i = 0;
  for (const note of notes) {
    while (i < bands.length && bands[i]!.startedAt < note.at) i += 1;
    buckets[i]!.push(note);
  }
  return buckets;
}
