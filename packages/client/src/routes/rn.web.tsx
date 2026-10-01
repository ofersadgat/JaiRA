import { StrictMode, useState } from "react";
import { TamaguiProvider } from "@tamagui/core";
import { Replayed, TokenRoot, UniversalApp, config } from "@jaira/universal";
import { installGlobalErrorReporting } from "@jaira/ui/crashReport";
import "../rn/fonts.css";
import { Remote, pageLink } from "../Remote";

// Before the first render, as `Shell.tsx` does it: the shell's banner reports what this catches. Guarded
// because `one build` imports every page in Node, where there is no window.
if (typeof window !== "undefined") installGlobalErrorReporting();

/**
 * `/rn`: the phone's app, in a browser (decision 0015). The universal shell drawn by react-native-web,
 * on the NATIVE token path (`Replayed`), with no `styles.css` on the page — so every colour, size and
 * rule on it comes from the copies, as on a phone. The fidelity gate diffs it against `/`, the desktop's
 * own page, in the same window and the same state; the Android emulator is the final check after it.
 *
 * In Electron it reads the window's own bridge. Anywhere else it is a device, as the phone is: `Remote`
 * pairs it with a machine by its code (`?address=…&code=…` does so at once, as a phone's link does) and
 * connects it over the engine's transport. The shell says so itself when the machine goes away
 * (`floats/Disconnected.tsx`).
 */
export default function Rn() {
  // Once, at mount: `Remote` takes the code out of the address bar when it has paired with it.
  const [link] = useState(pageLink);
  return (
    <Remote
      link={link}
      frame={(screen) => (
        <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
          <TamaguiProvider config={config} defaultTheme="light">
            <Replayed>
              <TokenRoot palette="ink" scheme="light">
                {screen}
              </TokenRoot>
            </Replayed>
          </TamaguiProvider>
        </div>
      )}
    >
      <div id="root">
        <StrictMode>
          <TamaguiProvider config={config} defaultTheme="light">
            <Replayed>
              <UniversalApp />
            </Replayed>
          </TamaguiProvider>
        </StrictMode>
      </div>
    </Remote>
  );
}
