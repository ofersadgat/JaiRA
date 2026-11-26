/**
 * An artboard's tweaks as the Tweaks tab draws them: the `data-props` entries that ask for an editor,
 * grouped by their `section` in the order the file first names each, with a colour's `options` read as
 * the swatches to offer (the Design type's format, "`data-props`": `section` groups, `options` on a
 * colour renders swatches, `unit` labels a number).
 */
import { parse } from "@jaira/dc-runtime/source";

export interface TweakLever {
  readonly name: string;
  readonly editor: string;
  readonly value: unknown;
  readonly options?: readonly unknown[];
  /** A colour's offered swatches: its `options` that are colours, as written. */
  readonly swatches?: readonly string[];
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly unit?: string;
}

export interface TweakGroup {
  /** The `section` its levers named; `undefined` for those that named none. */
  readonly section: string | undefined;
  readonly levers: readonly TweakLever[];
}

/** A colour as a swatch can paint it: hex, or a CSS colour function. */
const COLOUR = /^(#[0-9a-f]{3,8}|(rgb|rgba|hsl|hsla|oklch|oklab|lab|lch|color)\(.*\))$/i;

/** The levers of one declaration, grouped; the levers with no section come first. */
export function tweakGroups(declared: Readonly<Record<string, unknown>>): TweakGroup[] {
  const groups = new Map<string | undefined, TweakLever[]>();
  groups.set(undefined, []);
  for (const [name, raw] of Object.entries(declared)) {
    if (name === "$preview" || raw === null || typeof raw !== "object") continue;
    const p = raw as Record<string, unknown>;
    if (typeof p.editor !== "string") continue;
    const options = Array.isArray(p.options) ? (p.options as unknown[]) : undefined;
    const swatches = p.editor === "color" && options !== undefined ? options.filter((o): o is string => typeof o === "string" && COLOUR.test(o.trim())).map((o) => o.trim()) : [];
    const lever: TweakLever = {
      name,
      editor: p.editor,
      value: p.default,
      ...(options !== undefined ? { options } : {}),
      ...(swatches.length > 0 ? { swatches } : {}),
      ...(typeof p.min === "number" ? { min: p.min } : {}),
      ...(typeof p.max === "number" ? { max: p.max } : {}),
      ...(typeof p.step === "number" ? { step: p.step } : {}),
      ...(typeof p.unit === "string" && p.unit.length > 0 ? { unit: p.unit } : {}),
    };
    const section = typeof p.section === "string" && p.section.trim().length > 0 ? p.section.trim() : undefined;
    const into = groups.get(section);
    if (into !== undefined) into.push(lever);
    else groups.set(section, [lever]);
  }
  return [...groups].filter(([, levers]) => levers.length > 0).map(([section, levers]) => ({ section, levers }));
}

/** How many levers the groups hold. */
export const leverCount = (groups: readonly TweakGroup[]): number => groups.reduce((n, g) => n + g.levers.length, 0);

const parsed = new Map<string, TweakGroup[]>();

/** The levers an artboard's source declares, kept per source text: the board asks again on every draw. */
export function tweaksOf(source: string): TweakGroup[] {
  const known = parsed.get(source);
  if (known !== undefined) return known;
  let groups: TweakGroup[];
  try {
    groups = tweakGroups((parse(source).props ?? {}) as Record<string, unknown>);
  } catch {
    groups = [];
  }
  if (parsed.size > 64) parsed.clear();
  parsed.set(source, groups);
  return groups;
}
