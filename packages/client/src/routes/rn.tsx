import { NativeApp } from "../native/NativeApp";

/** `/rn` on native is the app itself; `rn.web.tsx` is the browser page that tests the native path. */
export default function Rn() {
  return <NativeApp />;
}
