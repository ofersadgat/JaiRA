/**
 * The signature-driven form — shared types. Ported from findmyprompt's `schemaForm/types.ts`.
 *
 * The idea it carries: a schema declares its type identity with a `$type` tag, the UI keys a widget
 * registry off that tag, and the schema itself stays UI-agnostic. Labels and tooltips live in the
 * PRESENTATION map, never in the schema — so the same declaration can be read by a parser, a form,
 * and documentation without any of them owning the others' vocabulary.
 *
 * The one honest difference from findmyprompt: there the schema arrives from a `/signature` endpoint
 * that the search engine also implements, so the form follows the engine automatically. JaiRA's
 * executor stack is a fixed set of upstream wrappers, so its schemas are authored in
 * `@jaira/shared`'s `executorStack.ts` — still ONE declaration, read by the config parser, this form,
 * and the composition.
 */
import type { ComponentType } from "react";
import type { FieldError } from "./model";

/** A JSON Schema node. Self-contained: nothing here resolves a `$ref`. */
export type Schema = Record<string, unknown>;

/**
 * What a widget may need beyond its own value.
 *
 * findmyprompt's carries a problem/dataset id; JaiRA's carries what a form here needs to describe
 * where a value is going — the config path, for the key tag beside a label, and whether this layer
 * states it.
 */
export interface SchemaFormContext {
  /** The dotted config path of the node being rendered, for the `param` tag. */
  path: string;
  /**
   * The DOCUMENT this schema came out of, for following a local `$ref`.
   *
   * On the context rather than as a prop because every recursion already spreads the context, so a
   * document threads itself down to the leaf that needs it without a single call site changing.
   * Absent at the top, where the schema being rendered IS the document — see `SchemaForm`, which
   * fills it in on the way down.
   */
  root?: Schema;
  /**
   * The `$ref` pointers already expanded on the way to this node — how a self-referential schema
   * stops.
   *
   * A JSON Schema that describes JSON Schema is the case, and it is not exotic: a slot's `schema`
   * member is one, so it appears in every state file this app opens. Its `items` member refers to
   * itself, so a renderer that follows references and draws every declared property will follow that
   * one for ever. It did, the first time references were resolved here, and the window stopped
   * responding — a hang rather than a crash, because the recursion is React rendering rather than a
   * loop with an end.
   *
   * Depth alone would not do: nesting is legitimately deep in these documents, and any cap large
   * enough to draw them is large enough to be slow before it fires. What is not legitimate is
   * expanding the SAME pointer twice on one path, which is exactly what a cycle is.
   */
  refs?: readonly string[];
  /**
   * This form is a READING of a document rather than a place to fill one in.
   *
   * It draws only the members the value actually states. That is the difference between the two jobs
   * the same component does: a settings form has to show a field nobody has set, because setting it
   * is the point, while a form that READS a document and shows it twenty-six empty controls has
   * buried the four things the document says.
   *
   * Not folded into `disabled`, though every reading is also disabled. A locked settings pane — a
   * project layer you may look at but not edit — is disabled and still has to show the whole shape,
   * or "what could be set here" becomes unanswerable the moment a layer is read-only.
   */
  reading?: boolean;
  /**
   * True when the layer being edited states this value itself, rather than inheriting it.
   *
   * Its presence is what makes a form LAYERED: every member is optional there (a layer requires
   * nothing — the merge does), and a member's on/off switch reads this rather than whether the merged
   * value happens to hold something.
   */
  isSet?: (path: string) => boolean;
  /**
   * Write ONE member at its dotted path, instead of rebuilding its parent and handing that up.
   *
   * For a form drawn over a MERGED document but saved into one layer of it. Rebuilding the parent
   * spreads every inherited sibling into the object that gets written, so editing one field would
   * pin all the others into the layer. Not passed down into list items: a path with `[2]` in it is
   * not somewhere a dotted-path writer can reach, so a list is written whole.
   */
  setAt?: (path: string, value: unknown) => void;
  /**
   * How a member names itself. `presentation` (the default) is a label for a reader of settings;
   * `keys` is the member's own name in data voice — a state's input slots, whose names are what the
   * prompt and the wiring call them.
   */
  labels?: "presentation" | "keys";
  /**
   * Leave out the dotted path beside each label. It names where a SETTING is written, which a person
   * answering a gate has no file to connect it to — there it reads as a stray word after the hint.
   */
  hidePaths?: boolean;
  /** Complaints placed on the form by path — see `model.fieldErrorsOf`. */
  errors?: readonly FieldError[];
  /**
   * Whether a field has been edited. An untouched field keeps its complaint to itself (the host says
   * it beside the button instead); absent, every field shows its own.
   */
  touched?: (path: string) => boolean;
  /** Called with a field's path whenever someone changes it. */
  touch?: (path: string) => void;
  /**
   * What a switched-off member says where its control would be. The default names the declared
   * `default` for an ordinary form and the inherited value for a layered one.
   */
  unsetNote?: (path: string, schema: Schema, value: unknown) => string;
  disabled?: boolean;
}

export interface WidgetProps {
  schema: Schema;
  value: unknown;
  onChange: (value: unknown) => void;
  ctx: SchemaFormContext;
}

export type Widget = ComponentType<WidgetProps>;
