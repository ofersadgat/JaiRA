import type { ComponentType } from "react";
import type { CardProps } from "@jaira/ui/slots";

/**
 * The DOM card a copy falls back on for a case it does not cover yet — on NATIVE, none: there is no
 * DOM to draw it in, so the copy draws what it can. `domFallback.web.tsx` is the web half, and the only
 * file that imports `board.tsx` (and through it `react-dom`).
 */
export const CardDom: ComponentType<CardProps> | null = null;
