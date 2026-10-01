import { createElement, type JSX } from "react";
import { forgeName } from "@jaira/ui/remoteStrip";
import { Txt } from "../../primitives";
import { useTokens } from "../../tokens";
import { BrandIcon } from "../settings/bits";

/**
 * The web half of `SourceMark.tsx`: an inline-flex `span` in the author's line, which Chromium places
 * on that line itself (its baseline the mark's foot).
 */
export function SourceMark({ source }: { source: string }): JSX.Element {
  const t = useTokens();
  const label = forgeName(source);
  return createElement(
    "span",
    {
      title: `written on ${label}`,
      style: { display: "inline-flex", alignItems: "center", gap: 4, marginLeft: 6, padding: "1px 6px", borderRadius: 999, border: `1px solid ${String(t.v("line"))}` },
    },
    <BrandIcon name={source} size={10} ink="dim" />,
    <Txt spec={{ voice: "data", scale: 10.5 / 12, weight: 500, color: "dim" }}>{label}</Txt>,
  );
}
