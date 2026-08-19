/**
 * What the state form can offer to complete, computed from the file tree the app already holds.
 *
 * Every suggestion here is a name the author would otherwise type from memory and get subtly wrong —
 * a child key that does not match the file beside it, a `function` naming an executor that is turned
 * off. The tree is already loaded for the Files view, so none of this costs a read.
 *
 * ## How a child state is detected
 *
 * A state OWNS THE NAMESPACE UNDER ITS OWN ID (`@declarative-ai/hw`'s `ref.ts`): `feature/plan.json`
 * lives in `feature/`, but its children live in `feature/plan/`, and `./goals` from it resolves to
 * `feature/plan/goals` rather than `feature/goals`. So a child is any state exactly ONE path segment
 * below this one — nothing about the filename needs inspecting, and there is no `index` convention
 * to look for.
 *
 * That is deliberately the same rule the loader uses when `children` is absent (WORKFLOWS.md §6:
 * "every state one path segment below this one, keyed by basename, in alphabetical order"). So the
 * suggestions are exactly the children the engine would infer for free — which makes the dropdown a
 * readout of what the directory already says rather than a second, competing opinion.
 */
import {
  COMPONENT_NAMES,
  refForPath,
  type ExecutorInfo,
  type FileNode,
  type FileTree,
  type StateSlots,
  type WorkflowLayer,
} from "@jaira/shared/browser";

/** Every state id in both layers, deduplicated and sorted. A shadowed base copy has the id its
 *  project override has, so the two collapse to the one name an author would write. */
export function allStateIds(tree: FileTree | null): string[] {
  if (tree === null) return [];
  const ids = new Set<string>();
  const walk = (nodes: FileNode[]): void => {
    for (const node of nodes) {
      if (node.stateId !== undefined && node.kind === "workflow") ids.add(node.stateId);
      if (node.children) walk(node.children);
    }
  };
  for (const root of tree.roots) walk(root.nodes);
  return [...ids].sort();
}

/** The state ids exactly one segment below `stateId` — this state's children, as the tree has them. */
export function childStateIds(tree: FileTree | null, stateId: string): string[] {
  if (stateId.length === 0) return [];
  const prefix = `${stateId}/`;
  return allStateIds(tree).filter((id) => id.startsWith(prefix) && !id.slice(prefix.length).includes("/"));
}

/**
 * Keys to offer for a child: the basename of every state below this one.
 *
 * A key is free text and stays free text — a child may be keyed anything, and `state` then says what
 * it runs. But keying it after the file is the case the tree convention is built around, since a
 * child with no `state` means `./<key>`, so the name that makes that work is worth offering first.
 */
export function childKeyOptions(tree: FileTree | null, stateId: string): string[] {
  return childStateIds(tree, stateId).map((id) => id.slice(stateId.length + 1));
}

/**
 * References to offer for a child's `state`, nearest first.
 *
 * Descendants are offered in their `./` spelling because that is what they mean here and what the
 * field's own placeholder suggests; everything else is offered bare, which is how a cross-tree mount
 * is written. The validator only WARNS on a non-descendant child, so those are legitimate and belong
 * in the list — just not at the top of it.
 */
export function childStateOptions(tree: FileTree | null, stateId: string): string[] {
  const own = new Set(childStateIds(tree, stateId));
  return [
    ...[...own].map((id) => `./${id.slice(stateId.length + 1)}`),
    ...allStateIds(tree).filter((id) => !own.has(id) && id !== stateId),
  ];
}

/**
 * The state a child row actually mounts, canonically — the inverse of {@link childStateOptions}.
 *
 * Three spellings collapse to one id (WORKFLOWS.md §6): no `state` at all runs `./<key>`, a `./`
 * reference hangs off the PARENT's id rather than its directory, and anything else is already
 * canonical. Getting this wrong is invisible in the form and wrong in the engine, so it is written
 * once here and used by everything that has to ask what a child runs.
 *
 * `""` when there is nothing to resolve yet — no key and no state, or a spelling that walks above
 * the root. The caller treats that as "no answer", not as an id.
 */
export function childStateIdOf(parentId: string, key: string, state: string): string {
  const named = state.trim().length > 0 ? state.trim() : `./${key.trim()}`;
  if (!named.startsWith("./") && !named.startsWith("../")) return named;
  const segments = parentId.length > 0 ? parentId.split("/") : [];
  for (const segment of named.split("/")) {
    if (segment === "." || segment === "") continue;
    if (segment === "..") {
      if (segments.length === 0) return "";
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  // A trailing empty segment means the row is still `./` — a reference to the parent itself is not
  // an answer, it is an unfinished one.
  return segments.join("/") === parentId ? "" : segments.join("/");
}

/**
 * Every file in the tree, spelled as a reference a link control can offer.
 *
 * Both layers, deduplicated: `$/prompts/x.md` names whichever layer supplies it, so the project copy
 * and the base copy are ONE suggestion. Which is the point of the bare-`$` spelling — the reference
 * follows the search path instead of pinning a layer.
 *
 * Directories are excluded, because a reference names a file. Nothing else is: a fragment lives
 * outside `workflows/` by convention, but transcluding a block out of a sibling state is legal and a
 * suggestion list that hid it would be quietly claiming otherwise.
 *
 * The extension question is the one that matters here and {@link refForPath} owns it — only
 * `.json`/`.yaml`/`.yml` may be dropped, so a `.md` prompt is offered with its suffix. Offering
 * `$/prompts/goals` for `goals.md` would suggest a reference that resolves to nothing.
 */
export function linkTargets(tree: FileTree | null): string[] {
  if (tree === null) return [];
  const refs = new Set<string>();
  const walk = (nodes: FileNode[]): void => {
    for (const node of nodes) {
      if (node.kind === "directory") {
        if (node.children) walk(node.children);
        continue;
      }
      refs.add(refForPath(node.path));
    }
  };
  for (const root of tree.roots) walk(root.nodes);
  return [...refs].sort();
}

/**
 * The file a reference names, if this window can see one.
 *
 * The inverse of {@link linkTargets}, and it is the same rule read backwards: a node's path becomes
 * a reference through `refForPath`, so a reference is that node's when the two spellings agree. The
 * PROJECT layer is tried first because a bare `$/…` is searched along the layer path and a project
 * copy overrides the shared one — the same order the loader would resolve it in.
 *
 * Everything after the file name is a property path into the document (§2.2), so the name is given
 * back one dotted component at a time, longest first — `$/lib/review.operation` is `review.json`
 * with `.operation` taken out of it, and what this answers is the FILE.
 */
export function resolveRef(tree: FileTree | null, ref: string): { layer: WorkflowLayer; path: string } | null {
  const trimmed = ref.trim();
  if (tree === null || !trimmed.startsWith("$/")) return null;
  const cut = trimmed.lastIndexOf("/");
  const dir = trimmed.slice(0, cut + 1);
  const parts = trimmed.slice(cut + 1).split(".");
  const found = new Map<string, { layer: WorkflowLayer; path: string }>();
  const walk = (layer: WorkflowLayer, nodes: FileNode[]): void => {
    for (const node of nodes) {
      if (node.kind === "directory") {
        if (node.children) walk(layer, node.children);
        continue;
      }
      const spelling = refForPath(node.path);
      // First writer wins per spelling, and the roots are walked project-first below.
      if (!found.has(spelling)) found.set(spelling, { layer, path: node.path });
    }
  };
  const roots = [...tree.roots].sort((a, b) => (a.layer === b.layer ? 0 : a.layer === "project" ? -1 : 1));
  for (const root of roots) walk(root.layer, root.nodes);
  for (let take = parts.length; take >= 1; take--) {
    const at = found.get(`${dir}${parts.slice(0, take).join(".")}`);
    if (at !== undefined) return at;
  }
  return null;
}

/**
 * Whether a typed reference plausibly names something — the link control's "this will not resolve"
 * hint, and deliberately only a hint.
 *
 * The real answer is the linter's: hw decides by probing the filesystem along a search path this
 * side of the process cannot see, and a reference is written whether this likes it or not. What this
 * catches is the mistake worth catching while the box still has focus — a path with no file behind
 * it — early enough to fix without a round trip.
 *
 * The trailing-segment loop is what makes `$/lib/review.operation` pass: everything after the file
 * name is a PROPERTY PATH into it (§2.2), so a match is looked for by giving back one dotted
 * component at a time, longest first, the way the loader's own `splitAtFile` does.
 *
 * Anything not anchored at `$` is left alone. A `./` or bare reference resolves against roots this
 * list does not model, so judging one would produce a warning that is simply wrong.
 */
export function isKnownRef(ref: string, targets: readonly string[]): boolean {
  const trimmed = ref.trim();
  if (!trimmed.startsWith("$/")) return true;
  const known = new Set(targets);
  const cut = trimmed.lastIndexOf("/");
  const dir = trimmed.slice(0, cut + 1);
  const parts = trimmed.slice(cut + 1).split(".");
  for (let take = parts.length; take >= 1; take--) {
    if (known.has(`${dir}${parts.slice(0, take).join(".")}`)) return true;
  }
  return false;
}

/**
 * Every runtime path a binding in this state could name (WORKFLOWS.md §8).
 *
 * A binding is where a value COMES FROM, and until now it was a bare text box with a placeholder —
 * so the two most common bindings in the format, `.inputs.<slot>` and
 * `.children.<key>.outputs.<slot>`, were things you typed from memory. A slot name misremembered by
 * one character is not a syntax error; it is a binding that resolves to nothing, and it is caught by
 * the linter rather than by the box you typed it into.
 *
 * Order is nearest-first in the sense that matters while authoring: this state's own inputs, then
 * each child's outputs in run order. A child whose state has not been read contributes nothing
 * rather than a guess — see {@link StateSlots}.
 *
 * `.outputs.*` is deliberately absent. A state's own outputs are what it PRODUCES, so binding one to
 * another is either a loop or a rename, and neither belongs in a suggestion list.
 */
export function bindingTargets(
  children: ReadonlyArray<{ key: string; stateId: string }>,
  declared: Record<string, StateSlots>,
  ownInputs: readonly string[],
  ownProducedOutputs: readonly string[] = [],
  /** Names the operation returns — see {@link operationOutputNames}. */
  operationOutputs: readonly string[] = [],
): string[] {
  const out: string[] = ownInputs.filter((name) => name.length > 0).map((name) => `.inputs.${name}`);
  // THE OPERATION'S RESULT, by both routes. `.operation.output.<name>` reads what the call returned
  // directly — the engine gained that namespace for bindings, so an output can rename or transform
  // the result instead of only receiving it. `.outputs.<name>` reads a slot the operation has
  // already filled, which is how a second output derives from a first.
  // The bare path first: `.operation.output` IS the returned value, which for an operation returning
  // a LIST or a scalar is the only way to name it — there are no property names to offer.
  if (operationOutputs.length > 0) out.push(".operation.output");
  out.push(...operationOutputs.filter((name) => name.length > 0).map((name) => `.operation.output.${name}`));
  out.push(...ownProducedOutputs.filter((name) => name.length > 0).map((name) => `.outputs.${name}`));
  for (const child of children) {
    const key = child.key.trim();
    if (key.length === 0) continue;
    for (const slot of declared[child.stateId]?.outputs ?? []) {
      out.push(`.children.${key}.outputs.${slot.name}`);
    }
    // How the CHILD terminated, which is a different thing from any output it declares — and the
    // usual way a parent turns "the review said block" into a transition or a derived output.
    out.push(`.children.${key}.outcome`);
  }
  return [...new Set(out)];
}

/**
 * What the state's operation kind is, as far as the `.operation.*` namespace is concerned.
 *
 * `""` covers both "no operation" and "the form cannot tell" — a pure composite has no `.operation`
 * node at all, and a transcluded or inherited block has one whose kind this file has not resolved.
 */
export type OperationNamespace = "" | "prompt" | "function" | "unknown";

/**
 * The paths a GUARD may name, on top of everything a binding may (WORKFLOWS.md §8).
 *
 * `.operation.output.*` is NOT here — it is a binding target now, and lives in {@link
 * bindingTargets} with the rest of the dataflow. What remains is the call's METADATA and the
 * control-flow scalars: things a guard branches on and a slot has no business receiving.
 *
 * Two engine rules this mirrors, or the list would suggest lint errors of its own:
 *
 *  - **A state with no operation has no `.operation` node.** Not an object of unknowns — the schema
 *    is `undefined`, so `.operation.cost` there is an unresolved reference.
 */
export function guardTargets(kind: OperationNamespace): string[] {
  return [
    ...(kind === ""
      ? []
      : [
          ".operation.outcome",
          ".operation.cost",
          ".operation.model",
          ".operation.usage",
        ]),
    // Guard-only control-flow scalars (§8) — never a reference binding.
    ".run.iteration",
    ".run.cursor",
    ".run.position",
    ".limits.max_iterations",
    ".limits.timeout",
  ];
}

/**
 * Function names a `function` operation can name: the built-in UI components, then the executors.
 *
 * A DISABLED executor is offered too, and that is the useful part. It is not registered, so naming
 * one is an authoring error — but it is an error the author is far more likely to make by typing the
 * name from memory than by picking it from a list that tells them its state.
 */
export function functionOptions(executors: ExecutorInfo[]): Array<{ name: string; note: string }> {
  return [
    ...COMPONENT_NAMES.map((name) => ({ name, note: "built-in human gate" })),
    ...executors.map((executor) => ({
      name: executor.name,
      note: executor.enabled ? executor.kind : `${executor.kind} — turned off, so it is not registered`,
    })),
  ];
}

/**
 * The names an operation puts in `.operation.output.*`.
 *
 * `session` on a prompt op — the position the call ended at is one of a prompt operation's outputs,
 * not a separate envelope beside them — plus whatever the state's outputs say the call returns.
 *
 * The returned names are taken from the outputs that have no binding of their own: those are the
 * slots the operation fills, so they are exactly the contract it is held to. An output that binds
 * from somewhere else says nothing about what the call returns.
 */
export function operationOutputNames(kind: OperationNamespace, producedOutputs: readonly string[]): string[] {
  if (kind === "") return [];
  const names = producedOutputs.filter((name) => name.length > 0);
  // A prompt op always has at least `session`, so the bare `.operation.output` is offered even when
  // the call returns something with no names of its own — a list, a string.
  if (kind !== "prompt" && names.length === 0) return [];
  // The author's own `session` wins, exactly as it does in the engine: they named it, and preferring
  // the engine's would leave theirs unreadable.
  return kind === "prompt" && !names.includes("session") ? [...names, "session"] : names;
}
