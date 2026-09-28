import type { ComponentType } from "react";
import { CardDom as DomCard } from "@jaira/ui/board";
import type { CardProps } from "@jaira/ui/slots";

/** On web, the DOM card itself (see `domFallback.tsx`). */
export const CardDom: ComponentType<CardProps> | null = DomCard;
