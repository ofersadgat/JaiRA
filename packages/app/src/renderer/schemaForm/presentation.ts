/**
 * UI presentation: `(declaring $type, member) → { label, tooltip }`. Ported from findmyprompt.
 *
 * Presentation lives in the UI, NOT the schema. The renderer resolves a member against its IMMEDIATE
 * container's `$type`, and a member defined on a base type is keyed under that base so every subtype
 * reuses it — define-once. Last resort: the prettified property key.
 *
 * JaiRA's schemas carry `title` and `description` themselves (they are authored in `@jaira/shared`
 * rather than generated from a server's type system), so this map is mostly EMPTY and the resolver
 * falls through to them. It exists anyway, and is not dead weight: it is where a label goes when the
 * schema's own wording is right for a parser's error message and wrong for a form — which is the
 * exact case that put presentation outside the schema in the first place.
 */
export interface MemberPresentation {
  label: string;
  tooltip?: string;
}

const PRESENTATION: Record<string, Record<string, MemberPresentation>> = {
  retry: {
    // The schema calls it `transient` because that is the failure CLASS it counts; a form reads
    // better saying what it does.
    transient: {
      label: "attempts after a retriable failure",
      tooltip:
        "A 429, a dropped connection, a 5xx. Not a refusal or a bad request — those do not get better " +
        "by being sent again, and retrying them just spends money twice.",
    },
  },
  rateLimit: {
    increaseEvery: { label: "raise concurrency after" },
  },
};

/** camelCase / kebab → spaced lowercase words (the fallback label). */
export function prettify(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]/g, " ")
    .toLowerCase();
}

/**
 * The label and tooltip for one member.
 *
 * Resolved FIELD BY FIELD, not entry by entry: the map wins for whatever it states, and the schema
 * fills in whatever it does not. An entry that overrode a label would otherwise silently drop the
 * schema's description with it — which is a worse form than the one before the override, and is
 * exactly what an all-or-nothing lookup did here (`rateLimit.increaseEvery` renamed itself and lost
 * its hint).
 *
 * Precedence per field: the presentation map, then the schema's own `title`/`description`, then the
 * prettified key. The map leads because it is the only wording written for a reader of the form; the
 * schema beats the key because it is authored beside the parser that enforces it.
 */
export function presentationFor(
  containerType: string | undefined,
  member: string,
  schema?: Record<string, unknown>,
): MemberPresentation {
  const hit = containerType ? PRESENTATION[containerType]?.[member] : undefined;
  const title = typeof schema?.["title"] === "string" ? (schema["title"] as string) : undefined;
  const description = typeof schema?.["description"] === "string" ? (schema["description"] as string) : undefined;
  const tooltip = hit?.tooltip ?? description;
  return {
    label: hit?.label ?? title ?? prettify(member),
    ...(tooltip !== undefined ? { tooltip } : {}),
  };
}
