import { NativeApp } from "../native/NativeApp";

/** `/` on native: the phone (`NativeApp`). `index.web.tsx` is the same shell in a browser, and the desktop's page. */
export default function Index() {
  return <NativeApp />;
}
