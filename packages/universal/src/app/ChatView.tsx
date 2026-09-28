import type { JSX } from "react";
import { Uncopied } from "./Uncopied";

/** The Chat room (`.chat-view`: `ChatView`, the conversation and its composer), as `App.tsx` draws it in `.viewport` (decision 0015). */
export function ChatView(): JSX.Element {
  return <Uncopied name="ChatView" flex={1} />;
}
