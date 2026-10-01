import { Fragment, type JSX } from "react";
import { View, isWeb } from "@tamagui/core";
import type { ConnectPreview, Words } from "@jaira/ui/connectDrag";
import { Txt, faceOf, type FontSpec } from "../primitives";
import { useTokens, type Tokens } from "../tokens";

/**
 * `board.tsx`'s `ConnectPop`, universal (decision 0015): the DROP PREVIEW — what a drop on the column
 * under the pointer will do, drawn in that column under its cards while a card is over it. What it says
 * is `connectDrag.ts`'s `previewOf`; this only draws it. The rules, with the contests settled:
 *
 *   .connect-pop                 a grid, gap 8, padding 12, --panel, 1px --line, radius 10, --lift,
 *                                `--size-app`; never a target (`pointer-events: none`)
 *   .connect-pop-inline          width auto (the column's), 8 above
 *   .connect-kind                data 600 at `--size-app` × 10.5/12.5 on 1.3, .04em, upper, --dim
 *   .connect-say                 the app voice at `--size-app` on 1.45, wrapping anywhere; `b` bolder (700),
 *                                `code` the data voice at `--size-data` (`.connect-say code` beats `code`)
 *   .connect-facts               a list with no marks, gap 3, --dim at `--size-app` × 11.5/12.5; `b` --text
 *                                600; `code` is the page's (`code`: data at `--size-data` × 11/12)
 *   .connect-drop / .connect-no  data 600 at `--size-app` × 11/12.5 on 1.3, --accent / --dim
 *
 * The fonts that are the data face at the APP size (`font: … var(--size-app) … var(--font-data)`) are
 * `Txt`s in the app voice's size given the data face ({@link dataAtApp}).
 */
export function ConnectPop({ preview }: { preview: ConnectPreview | "asking" | undefined }): JSX.Element | null {
  const t = useTokens();
  if (preview === undefined) return null;
  const box = {
    marginTop: 8,
    padding: 12,
    gap: 8,
    flexDirection: "column",
    backgroundColor: t.v("panel"),
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: t.v("line"),
    borderRadius: 10,
    boxShadow: t.v("lift"),
    pointerEvents: "none",
    ...(isWeb ? { role: "status" } : {}),
  };
  if (preview === "asking") {
    return (
      <View {...(box as object)}>
        <Kind t={t}>Working out what a drop does…</Kind>
      </View>
    );
  }
  return (
    <View {...(box as object)}>
      <Kind t={t}>{preview.kind}</Kind>
      <Txt spec={{ voice: "app", scale: 1, lineHeight: 1.45 }} {...({ style: { overflowWrap: "anywhere" } } as object)}>
        <WordsView words={preview.say} base={{ voice: "app", scale: 1, lineHeight: 1.45 }} bold={700} code={{ voice: "data", scale: 1, lineHeight: 1.45 }} />
      </Txt>
      {preview.facts.length > 0 ? (
        <View flexDirection="column" gap={3}>
          {preview.facts.map((fact, i) => (
            <Txt key={i} spec={FACT}>
              <WordsView words={fact} base={FACT} bold={600} boldColor="text" code={{ voice: "data", scale: 11 / 12, color: "dim" }} />
            </Txt>
          ))}
        </View>
      ) : null}
      {preview.drop !== undefined ? <Drop t={t} color="accent">{preview.drop}</Drop> : null}
      {preview.refused !== undefined ? <Drop t={t} color="dim">{preview.refused}</Drop> : null}
    </View>
  );
}

/** `.connect-facts li`: --dim at `--size-app` × 11.5/12.5, on the body's 1.5. */
const FACT: FontSpec = { voice: "app", scale: 11.5 / 12.5, color: "dim" };

/**
 * The data face at a factor of `--size-app`, as `font: … calc(var(--size-app) * k) / lh var(--font-data)`
 * writes it: sized and spaced as the app voice, drawn in the data face.
 */
export function dataAtApp(t: Tokens, spec: FontSpec): Record<string, unknown> {
  return faceOf(t, "data", spec.weight ?? 400, t.scaled("size-app", spec.scale));
}

/** `.connect-kind`. */
export function Kind({ t, children }: { t: Tokens; children: string }): JSX.Element {
  const spec: FontSpec = { voice: "app", scale: 10.5 / 12.5, weight: 600, ls: 0.04, upper: true, color: "dim", lineHeight: 1.3 };
  return (
    <Txt spec={spec} {...(dataAtApp(t, spec) as object)}>
      {children}
    </Txt>
  );
}

/** `.connect-drop`, and `.connect-no` in --dim. */
function Drop({ t, color, children }: { t: Tokens; color: string; children: string }): JSX.Element {
  const spec: FontSpec = { voice: "app", scale: 11 / 12.5, weight: 600, color, lineHeight: 1.3 };
  return (
    <Txt spec={spec} {...(dataAtApp(t, spec) as object)}>
      {children}
    </Txt>
  );
}

/**
 * `WordsView`: a run of words with the parts drawn strong or as code. Each part is its own run, as each
 * is its own element in the DOM (a text node is a shaping boundary).
 */
function WordsView({ words, base, bold, boldColor, code }: { words: Words; base: FontSpec; bold: number; boldColor?: string; code: FontSpec }): JSX.Element {
  return (
    <>
      {words.map((part, i) =>
        typeof part === "string" ? (
          <Fragment key={i}>{part}</Fragment>
        ) : "b" in part ? (
          <Txt key={i} spec={{ ...base, weight: bold, ...(boldColor !== undefined ? { color: boldColor } : {}) }}>
            {part.b}
          </Txt>
        ) : (
          <Txt key={i} spec={{ ...code, ...(code.color === undefined && base.color !== undefined ? { color: base.color } : {}) }}>
            {part.code}
          </Txt>
        ),
      )}
    </>
  );
}
