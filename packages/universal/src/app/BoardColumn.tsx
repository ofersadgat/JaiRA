import type { JSX } from "react";
import { Uncopied } from "./Uncopied";

/**
 * The Tasks room's middle column (`.tasks-view > .col.mid`, `App.tsx`): one board per project group,
 * each after its own address bar but the first, or the run the address has drilled into (`RunView`).
 */
export function BoardColumn(): JSX.Element {
  return <Uncopied name="Board" flex={1} />;
}
