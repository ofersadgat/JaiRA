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
  type RunView,
  type SessionRef,
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
  // Run and instance, for the same reason the join uses both: `#i2` names a different state in every
  // run, and two runs' session-less pieces sharing a key would be drawn as one panel.
  const run = piece.node.runId;
  return piece.sessionId ?? (run === undefined ? `#${piece.node.instanceId}` : `#${run}:${piece.node.instanceId}`);
}

/**
 * Every operation under one run, oldest first — the whole subtree, at every depth.
 *
 * Flattened rather than nested because the sessions are: a grandchild continuing its grandparent's
 * conversation belongs in that conversation's panel, and a view that nested by state would put it
 * two boxes away from the turns it is answering.
 *
 * `runId` is NOT a filter. It is the run a single-run projection belongs to, for a tree whose nodes
 * carry no `runId` of their own — a folded tree stamps every node and needs no such fallback. The
 * conversation being the TASK's rather than the newest run's is the whole point: a resumed run
 * dispatches only what it did not replay, so reading one run alone shows a conversation with holes
 * where the replayed states are, and each of those holes used to be drawn as a panel reading "this
 * state ran no model call" about a state that had one.
 *
 * A state is a piece when it RAN something. A composite that only orchestrates contributes nothing —
 * it has no session, and the panel it used to get was filled by whichever conversation happened to be
 * last in the task, which is the bug this rewrite exists to fix. A leaf is always a piece even with
 * no session row, because "this state ran no model call" is an answer and dropping it would lose a
 * run from the picture entirely.
 */
export function piecesOf(
  root: InstanceNode | undefined,
  history: readonly SessionRef[],
  runId?: number,
): SessionPiece[] {
  if (root === undefined) return [];
  /**
   * Keyed by RUN and instance, never by instance alone.
   *
   * Instance ids are minted per run, so `#i2` names a different state in each one — an unscoped join
   * matched this run's second instance against every older run's, and the way that failed was silent:
   * a panel drawn with another run's transcript in it. The tree is folded across runs (`foldRuns`),
   * so every node carries the run it came from and the pair is the only key that means anything.
   */
  const byInstance = new Map<string, SessionRef[]>();
  const at = (run: number | undefined, instance: number): string => `${run ?? runId ?? ""}:${instance}`;
  for (const ref of history) {
    const key = at(ref.runId, ref.instanceId);
    const list = byInstance.get(key);
    if (list === undefined) byInstance.set(key, [ref]);
    else list.push(ref);
  }

  const out: SessionPiece[] = [];
  const visit = (node: InstanceNode): void => {
    const refs = [...(byInstance.get(at(node.runId, node.instanceId)) ?? [])].sort((a, b) => a.seq - b.seq);
    for (const ref of refs) {
      out.push({
        node,
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
   * Operations the FOLDED TREE has no node for — an earlier run's work that a later run overwrote.
   *
   * `mergeNodes` merges by position and the later run wins, so a state that ran in run 1 and again in
   * run 2 leaves one node, run 2's. The earlier call is still in the history, still cost money and
   * still said things, and without this it is on screen nowhere: the fork mark would name a side that
   * has no panels, which is the same disappearance the mark exists to stop.
   *
   * Synthesised from the ref, which carries everything a panel needs — the state, the run, the span.
   * A node built here is never walked into: it has no children by construction, because a composite
   * writes no session ref.
   */
  const drawn = new Set(out.map((piece) => `${piece.node.runId ?? runId ?? ""}:${piece.node.instanceId}:${piece.seq ?? ""}`));
  for (const ref of history) {
    if (drawn.has(`${ref.runId}:${ref.instanceId}:${ref.seq}`)) continue;
    out.push({
      node: {
        instanceId: ref.instanceId,
        stateId: ref.stateId,
        status: ref.status === "error" ? "failed" : ref.status === "interrupted" ? "canceled" : "completed",
        iteration: 0,
        superseded: false,
        startedAt: ref.startedAt ?? ref.at,
        endedAt: ref.at,
        runId: ref.runId,
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

  out.sort((a, b) => a.startedAt - b.startedAt || (a.seq ?? 0) - (b.seq ?? 0) || a.node.instanceId - b.node.instanceId);
  return out;
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
export function bandsOf(pieces: readonly SessionPiece[]): SessionBand[] {
  const clusters: SessionPiece[][] = [];
  let end = -Infinity;
  for (const piece of pieces) {
    const stop = piece.endedAt ?? Infinity;
    const last = clusters[clusters.length - 1];
    if (last === undefined || piece.startedAt >= end) {
      clusters.push([piece]);
      end = stop;
      continue;
    }
    last.push(piece);
    end = Math.max(end, stop);
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

/**
 * One run-scale divergence: where the task divided, and the runs whose own work begins there.
 *
 * A run forks at the first operation it DISPATCHED rather than replayed — `RunView.forkedAt`, written
 * on the row when the resume plan was made. Everything before it that run took from the record, so it
 * is shared with whichever earlier runs produced it; everything from there is the run's own. Runs
 * that begin at the same place are the sides of one mark.
 *
 * Grouped by the address SERIALIZED, which is a map key and nothing more — the address itself is
 * compared structurally, and is never encoded to be stored or sent.
 *
 * A place with one side is not a fork: the first run of a task diverges from nothing, and so does
 * every run of a task nobody has resumed.
 */
export interface RunFork {
  /** Where the sides diverge — the address every side ran for itself. */
  at: InstanceAddress;
  /** The runs that ran it, oldest first. */
  sides: Array<{ runId: number; piece: SessionPiece }>;
}

/**
 * Every place the TASK divided: an address more than one run did its own work at.
 *
 * The same shape as {@link forksOf} one scale up, and for the same reason. A session forks when two
 * calls claim one position; a task forks when two RUNS dispatch one address — and the second is what
 * a restart, a retry and a resume-into-a-failed-state all produce. Everything above such a place the
 * later run replayed, which is to say it is shared; everything from there is that run's own.
 *
 * Derived from the pieces rather than from `RunView.forkedAt`, and that is deliberate: a side of a
 * mark has to be a side you can READ, and a piece is exactly the evidence that a run has panels here
 * to show. `forkedAt` answers the other question — where a run's own work begins, which is what says
 * a run REPLAYED an address rather than never reaching it — and a run that replayed this address is
 * correctly not a side of it: it produced nothing here to choose.
 *
 * One side is not a fork. Most addresses in most tasks were run exactly once.
 */
export function runForksOf(pieces: readonly SessionPiece[]): RunFork[] {
  const at = new Map<string, RunFork>();
  for (const piece of pieces) {
    const { address, runId } = piece.node;
    if (address === undefined || runId === undefined) continue;
    const key = JSON.stringify(address);
    const held = at.get(key);
    if (held === undefined) at.set(key, { at: address, sides: [{ runId, piece }] });
    else if (!held.sides.some((side) => side.runId === runId)) held.sides.push({ runId, piece });
  }
  for (const fork of at.values()) fork.sides.sort((a, c) => a.piece.startedAt - c.piece.startedAt);
  return [...at.values()].filter((fork) => fork.sides.length > 1);
}

/** Whether two addresses name the same place. Structural, because an address is not a string. */
export function sameAddress(a: InstanceAddress | undefined, c: InstanceAddress | undefined): boolean {
  if (a === undefined || c === undefined) return a === c;
  return a.length === c.length && a.every((step, i) => step.childKey === c[i]?.childKey && step.occurrence === c[i]?.occurrence);
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
export function instancesOf(bands: readonly SessionBand[]): Array<{ runId?: number; instanceId: number }> {
  const seen = new Map<string, { runId?: number; instanceId: number }>();
  for (const band of bands) {
    for (const segment of band.segments) {
      for (const piece of segment.pieces) {
        // The RUN as well as the instance: ids are minted per run, and a transcript fetched by the id
        // alone comes back from whichever run wrote it last — someone else's words, silently.
        const { runId, instanceId } = piece.node;
        seen.set(`${runId ?? ""}:${instanceId}`, { instanceId, ...(runId !== undefined ? { runId } : {}) });
      }
    }
  }
  return [...seen.values()];
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
  kind: "failure" | "blocked" | "entered" | "transition";
  /** The state DEFINITION the note is about, when the journal named one — what the title shows. */
  stateId?: string;
  /**
   * The instance the note is about, when it became one.
   *
   * The rail's lane identity — see `rail.ts`. It has to be the instance and not the state, because
   * `explore` running twice is two lanes with one colour, and a rail keyed on the name would draw the
   * second pass as a continuation of the first. Absent on a `blocked` note by construction: a child
   * that could not be entered never became an instance, which is what blocked means.
   */
  instanceId?: number;
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
function ranAnOperation(turn: ConversationTurn, byInstance: Map<number, InstanceNode>): boolean {
  if (turn.instanceId === undefined) return false;
  return byInstance.get(turn.instanceId)?.operation !== undefined;
}

/** Every instance in a run, by id — the index the rule above is a lookup into. */
function instancesById(root: InstanceNode | undefined): Map<number, InstanceNode> {
  const out = new Map<number, InstanceNode>();
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
export function mountPathOf(instances: readonly InstanceNode[], instanceId: number): string {
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
export function notesOf(turns: readonly ConversationTurn[], root?: InstanceNode): BandNote[] {
  const byInstance = instancesById(root);
  /** With no tree to ask, nothing is claimed by a panel — see the note above. */
  const hasPanel = (turn: ConversationTurn): boolean => byInstance.size > 0 && ranAnOperation(turn, byInstance);
  const seen = new Set<string>();
  const out: BandNote[] = [];
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
      out.push({ seq: turn.seq, at: turn.at, kind: "entered", ...named, path, text: "" });
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
  return out.sort((a, b) => a.at - b.at || a.seq - b.seq);
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
/**
 * Which run-scale marks go above which band — one bucket per gap, as {@link placeNotes} does.
 *
 * A mark belongs immediately above the first panel of the side it opens: the fork's address is where
 * a run's own work BEGINS, so the panel at that address is that side's first, and the divergence is
 * the gap in front of it. The root fork — runs that share nothing — goes above everything.
 *
 * A mark whose address matches no panel is dropped rather than floated to the end. It names a place
 * this view is not showing (a walk into a child, a state whose record was pruned), and a fork drawn
 * away from the work it divides is pointing at the wrong thing.
 */
export function placeRunForks(forks: readonly RunFork[], bands: readonly SessionBand[]): RunFork[][] {
  const buckets: RunFork[][] = bands.map(() => []);
  buckets.push([]);
  for (const fork of forks) {
    const first = fork.sides[0]?.piece;
    if (first === undefined) continue;
    const where = bands.findIndex((band) => band.segments.some((segment) => segment.pieces.includes(first)));
    if (where < 0) continue;
    // Only a fork that OPENS a panel belongs in the gap above it. One that divides a panel part-way
    // down is drawn inside it, between the two cards — see {@link runForkAt}. Otherwise the mark
    // would sit above work that is shared, and the one thing it claims is that everything above it
    // is common to both sides.
    if (bands[where]!.segments.some((segment) => segment.pieces[0] === first)) buckets[where]!.push(fork);
  }
  return buckets;
}

/**
 * Forks by the piece they open, for a panel that has to draw one BETWEEN two of its cards.
 *
 * A panel holds every operation of one conversation, so a workflow that puts several states on one
 * thread (`environment.session`) has the shared work and the divided work as cards in the same
 * sheet. The gap above the sheet is then the wrong place: it puts a shared operation below the line.
 *
 * Identity, not a key: these are the very piece objects the bands were built from, so a `Map` on
 * them needs no serialisation and cannot collide.
 */
export function runForkAt(forks: readonly RunFork[]): Map<SessionPiece, RunFork> {
  const at = new Map<SessionPiece, RunFork>();
  for (const fork of forks) {
    const first = fork.sides[0]?.piece;
    if (first !== undefined) at.set(first, fork);
  }
  return at;
}

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
