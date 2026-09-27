import type { Slots } from "@jaira/ui/slots";
import { Pill } from "./components/Pill";
import { TaskCard } from "./components/TaskCard";

export { config } from "./tamagui.config";
export { TokenRoot, TokenScope, useLook, useTokens, type Look, type Tokens } from "./tokens";

/** Every universal copy there is, by the slot it fills. `/universal` and native draw all of them. */
export const COPIES: Partial<Slots> = { Pill, TaskCard };

/**
 * The copies the DESKTOP draws (decision 0013, S4): each passed the fidelity gate against its DOM
 * original, and then the S1 gate with the desktop switched to it.
 */
export const SHARED: Partial<Slots> = { Pill, TaskCard };
