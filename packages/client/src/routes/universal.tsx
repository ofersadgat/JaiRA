import { NativeApp } from "../native/NativeApp";

/** `/universal` on native is the app itself; `universal.web.tsx` is the fidelity gate's page. */
export default function Universal() {
  return <NativeApp />;
}
