import type { MirrorStore } from "@jaira/ui/syncMirror";

/**
 * Where this device keeps its mirror of its machines (decision 0018 §7) — a phone does
 * (`mirrorStore.native.ts`); a browser keeps none, and reads its machines afresh each time it opens.
 */
export const mirrorStore: MirrorStore | undefined = undefined;
