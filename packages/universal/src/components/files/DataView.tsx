import type { JSX } from "react";
import { Text, View, isWeb } from "@tamagui/core";
import { Txt, edge, font } from "../../primitives";
import { useTokens } from "../../tokens";

/**
 * `valueView.tsx`'s `DataView`, universal (decision 0015): the value a structured document denotes, as
 * a tree — a container's size (`{29}`, `[3]`) and its entries nested under a rule; a leaf as its key and
 * its JSON. The rules, from `styles.css` (`cascade.mts .run-half --scene files-json`):
 *
 *   .doc-tree        the data voice at --size-data, line 1.7; 13 in, a --line on the left (none at the root)
 *   .doc-tree li     one line (nowrap)
 *   .doc-key         --dim, then ":" and 5 of space (`::after`)
 *   .sub             the count: 11/12.5 of --size-app, --dim (the family and line height inherited: the
 *                    data voice at 1.7)
 *   code.doc-value   the data voice at 11/12, line 1.7; --accent a string, --text a number or boolean,
 *                    --dim null; wraps anywhere
 */
export function DataView({ value }: { value: unknown }): JSX.Element {
  return (
    <View flexDirection="column">
      <DataNode name={null} value={value} />
    </View>
  );
}

function DataNode({ name, value }: { name: string | null; value: unknown }): JSX.Element {
  const t = useTokens();
  const container = value !== null && typeof value === "object";
  const entries: Array<[string, unknown]> = !container ? [] : Array.isArray(value) ? value.map((entry, i) => [String(i), entry]) : Object.entries(value as Record<string, unknown>);
  const ink = value === null ? "dim" : typeof value === "string" ? "accent" : "text";
  // The `li` is ONE line of inline text, as the DOM's: the key, its ":" and 5 of space (`::after`
  // padding, here as the colon's letter spacing), then the count or the value — nested runs of one
  // Text, so a long value wraps back to the line's start and the line's height and baseline are the
  // li's own font (the data voice at 1.7), whatever smaller text is on it.
  const line = (
    <Txt spec={{ voice: "data", scale: 1, lineHeight: 1.7, color: "dim" }} {...((isWeb ? { whiteSpace: "nowrap" } : {}) as object)}>
      {name === null ? null : (
        <>
          {name}
          <Text letterSpacing={5}>:</Text>
        </>
      )}
      {container ? (
        // `.sub`: an app SIZE, in the data face and line height it inherits.
        <Text fontSize={t.scaled("size-app", 11 / 12.5) as never}>{Array.isArray(value) ? `[${entries.length}]` : `{${entries.length}}`}</Text>
      ) : (
        <Text
          {...(font(t, { voice: "data", scale: 11 / 12, lineHeight: 1.7, color: ink }) as object)}
          {...((isWeb ? { whiteSpace: "pre-wrap", overflowWrap: "anywhere" } : {}) as object)}
        >
          {JSON.stringify(value)}
        </Text>
      )}
    </Txt>
  );
  if (!container) return line;
  return (
    <View flexDirection="column">
      {line}
      {entries.length > 0 ? (
        <View flexDirection="column" paddingLeft={13} {...(edge(t, { left: 1 }) as object)}>
          {entries.map(([key, entry]) => (
            <DataNode key={key} name={key} value={entry} />
          ))}
        </View>
      ) : null}
    </View>
  );
}
