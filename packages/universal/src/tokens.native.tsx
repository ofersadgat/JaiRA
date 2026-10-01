import type { JSX, ReactNode } from "react";
import { ReplayRoot, ReplayScope, useReplayLook, useReplayTokens } from "./tokensReplay";

/**
 * Tokens on NATIVE (decision 0015): `styles.css`'s cascade replayed for where the component stands
 * (`tokensReplay.tsx`). The same API as `tokens.tsx`, the web's, which reads the same replay under
 * `Replayed`.
 */
export type { Look, Tokens } from "./tokens";

export const TokenRoot = ReplayRoot;
export const TokenScope = ReplayScope;
export const useLook = useReplayLook;
export const useTokens = useReplayTokens;

/** Native is always replayed; this is here so the two files export the same names. */
export function Replayed({ children }: { children: ReactNode }): JSX.Element {
  return <>{children}</>;
}
