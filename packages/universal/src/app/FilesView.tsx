import type { JSX } from "react";
import { Uncopied } from "./Uncopied";

/** The Files room (`.files-view`: `FilePanel`, the viewer over the editor, and the side panel beside it), as `App.tsx` draws it in `.viewport` (decision 0015). */
export function FilesView(): JSX.Element {
  return <Uncopied name="FilesView" flex={1} />;
}
