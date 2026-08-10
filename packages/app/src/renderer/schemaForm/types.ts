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
  /** True when the layer being edited states this value itself, rather than inheriting it. */
  isSet?: (path: string) => boolean;
  disabled?: boolean;
}

export interface WidgetProps {
  schema: Schema;
  value: unknown;
  onChange: (value: unknown) => void;
  ctx: SchemaFormContext;
}

export type Widget = ComponentType<WidgetProps>;
