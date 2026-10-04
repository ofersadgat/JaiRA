import { useEffect, useState, type JSX } from "react";
import { Linking, View, useWindowDimensions } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { DesktopFrame } from "./DesktopFrame";
import { IslandsTab } from "./IslandsTab";
import { TamaguiProvider } from "@tamagui/core";
import { Replayed, TokenRoot, UniversalApp, config, installNativeErrorReporting } from "@jaira/universal";
import { isPhoneWidth } from "@jaira/ui/phoneModel";
import { Remote, linkOf, type PairLink } from "../Remote";
import { holdStill } from "./still";
import { StrictLayout } from "./StrictLayout";

/**
 * The phone (decision 0015). Ruling 1: "the exact same ui on mobile as there is on desktop", as a
 * migration step — and not in a WebView (the person, 2026-09-27: "the goal is to replicate the desktop
 * ui, but not in a webview"). Pair and connect (`Remote`), then the universal shell (`UniversalApp`):
 * the desktop's frame drawn natively, region by region, on a machine's engine over its own transport
 * (decision 0013, amended 2026-09-30). On a phone's width the shell lays itself out for the phone
 * (`UniversalApp phone`: decision 0015, amended 2026-10-04, the mobile pass); wider — a tablet, a phone on
 * its side — it is the desktop's, fitted in `DesktopFrame`.
 *
 * `&screen=islands` on the link opens the island harness instead (`IslandsTab`), which the emulator
 * test (`shots/android.mts`) measures; `&still=1` holds the clocks and spinners so that test can read
 * the screen at all (`still.ts`).
 */

// Before the first render, as the desktop installs its own: what escapes everything else reaches the
// shell's banner (`LooseErrorBanner`), and React Native's own handler still runs after it.
installNativeErrorReporting();
type Screen = "app" | "islands";
type Link = Partial<PairLink> & { screen: Screen };

/**
 * `jaira:///?address=…&code=…` pairs and connects straight away — what a QR code on the machine's
 * Settings → Machines would carry, and how the emulator test drives it. The address alone fills the
 * form. In a browser (the `/native` preview) the page's own query is read the same way.
 */
function readLink(url: string | null | undefined): Link | undefined {
  const { query, ...link } = linkOf(url);
  if (query["still"] === "1") holdStill();
  if (link.address === undefined && link.code === undefined && query["screen"] === undefined) return undefined;
  return { ...link, screen: query["screen"] === "islands" ? "islands" : "app" };
}
const initial = typeof location !== "undefined" && typeof location.href === "string" ? readLink(location.href) : undefined;

export function NativeApp(): JSX.Element {
  const [link, setLink] = useState<Link | undefined>(initial);
  const window = useWindowDimensions();

  useEffect(() => {
    if (initial !== undefined) return undefined;
    const take = (url: string | null): void => {
      const next = readLink(url);
      if (next !== undefined) setLink(next);
    };
    void Linking.getInitialURL().then(take);
    const sub = Linking.addEventListener("url", (e) => take(e.url));
    return () => sub.remove();
  }, []);

  return (
    <SafeAreaProvider>
      <TamaguiProvider config={config} defaultTheme="light">
        {/* `Replayed`: in a browser (the `/native` preview) the tokens are the replayed cascade, as on the
            phone, where it is the only kind there is — there is no stylesheet on the page to resolve them. */}
        <Replayed>
        {/* The window's height, not flex alone: in a browser (the `/native` preview) nothing above sizes it.
            react-native-safe-area-context's SafeAreaView, not React Native's, which pads only on iOS: on
            Android the app sat under the status bar. */}
        <SafeAreaView style={{ height: window.height }}>
          <StrictLayout>
          <Remote
            // The shell is drawn at once, empty until a machine answers (decision 0015, amended 2026-10-04).
            shell
            {...(link !== undefined ? { link } : {})}
            frame={(screen) => (
              <TokenRoot palette="ink" scheme="light">
                {screen}
              </TokenRoot>
            )}
          >
            {link?.screen === "islands" ? (
              <TokenRoot palette="ink" scheme="light">
                <IslandsTab />
              </TokenRoot>
            ) : (
              isPhoneWidth(window.width) ? (
                // The whole height by size, not flex: in a browser the safe area's box is a block, where
                // `flex: 1` below it means nothing.
                <View style={{ height: "100%", width: "100%" }}>
                  <UniversalApp phone />
                </View>
              ) : (
                <DesktopFrame>
                  <UniversalApp />
                </DesktopFrame>
              )
            )}
          </Remote>
          </StrictLayout>
        </SafeAreaView>
        </Replayed>
      </TamaguiProvider>
    </SafeAreaProvider>
  );
}
