import { Component, useEffect, useState, type ErrorInfo, type JSX, type ReactNode } from "react";
import { ScrollView, useWindowDimensions } from "react-native";
import { View, isWeb } from "@tamagui/core";
import { onLooseError, reportLooseError, textOf, type LooseError } from "@jaira/ui/crashReport";
import { copyText } from "../../clipboard";
import { Txt, scrollbarProps, viewScrollbarProps } from "../../primitives";
import { useTokens } from "../../tokens";
import { Button } from "../settings/Button";

/**
 * The two nets under an interface that stops working, which would otherwise be a blank window with no
 * message: {@link CrashBoundary} draws a throw during render in place of the tree, and
 * {@link LooseErrorBanner} says, over a tree that still works, that something with no render to belong
 * to failed. What they say, and the sink the banner listens on, are `crashReport.ts`'s; a phone feeds
 * that sink from its global handler (`installNativeErrorReporting`). How they look:
 *
 *   the screen       fixed over the window, the card centred both ways, padding 32, --bg, --text, scrolls
 *   the card         min(860px, 100%) wide, --panel, 1px --line, radius 10, padding 24, column, gap 12
 *   its heading      20px, bold, on the body's 1.5
 *   the words under  --dim, app 11/12.5, 1em above and below (added to the card's gap)
 *   the stack        at most 46vh, scrolls, padding 12, --panel-2, 1px --line, radius 8, --font-data
 *                    at 12px whatever the size preference, pre-wrap, words broken
 *   the actions      row, gap 8: Reload the window (`primary`), Copy the error
 *   the banner       fixed, z --z-crash (1000), 16 above the window's foot, centred, at most
 *                    min(720px, 100vw − 32px); row, centred, gap 8, padding 8 12, --panel, --text, 1px
 *                    --bad 45% into --line, radius 8, 0 6 24 black at 18%; the words (the body's font,
 *                    one line, taking the room), then Copy and Dismiss
 *
 * `staged` places either in its box rather than the window's (the specimens).
 */
interface CrashState {
  error: unknown;
  /** React's own component stack — which panel, not which function, and usually the useful half. */
  where?: string | undefined;
}

/**
 * The boundary. Not a retry loop, which works by luck or spins and hides the failure either way: the
 * reader gets the error and a reload. On a phone there is no window to reload, so Reload draws the tree
 * afresh from the store, which holds what is recorded — the same promise the words make.
 */
export class CrashBoundary extends Component<{ children: ReactNode }, CrashState> {
  override state: CrashState = { error: undefined };

  static getDerivedStateFromError(error: unknown): Partial<CrashState> {
    return { error };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    this.setState({ where: info.componentStack ?? undefined });
    console.error("[jaira] the interface threw while rendering:", textOf(error, info.componentStack ?? undefined));
  }

  override render(): ReactNode {
    if (this.state.error === undefined) return this.props.children;
    const reload = (): void => (isWeb ? window.location.reload() : this.setState({ error: undefined, where: undefined }));
    return <CrashScreen error={this.state.error} {...(this.state.where !== undefined ? { where: this.state.where } : {})} onReload={reload} />;
  }
}

export function CrashScreen({ error, where, onReload, staged = false }: { error: unknown; where?: string; onReload: () => void; staged?: boolean }): JSX.Element {
  const t = useTokens();
  const screen = useWindowDimensions();
  const text = textOf(error, where);
  const stack = (
    <Txt spec={{ voice: "data", scale: 1 }} fontSize={12} lineHeight={18} whiteSpace="pre-wrap" style={{ overflowWrap: "break-word", wordBreak: "break-word" }}>
      {text}
    </Txt>
  );
  const well = { padding: 12, backgroundColor: t.v("panel-2"), borderWidth: 1, borderStyle: "solid", borderColor: t.v("line"), borderRadius: 8 } as const;
  return (
    <View
      position={(isWeb && !staged ? "fixed" : "absolute") as never}
      top={0}
      left={0}
      right={0}
      bottom={0}
      flexDirection="row"
      alignItems="center"
      justifyContent="center"
      padding={32}
      backgroundColor={t.v("bg") as never}
      {...((isWeb ? { overflow: "auto" } : {}) as object)}
    >
      <View width={isWeb ? "min(860px, 100%)" : "100%"} maxWidth={860} flexDirection="column" gap={12} padding={24} borderRadius={10} borderWidth={1} borderStyle="solid" borderColor={t.v("line") as never} backgroundColor={t.v("panel") as never}>
        <Txt spec={{ voice: "app", scale: 1, weight: 700 }} fontSize={20} lineHeight={30} role="heading">
          The interface stopped drawing.
        </Txt>
        <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }} marginVertical={t.scaled("size-app", 11 / 12.5) as never}>
          Nothing that was running has been lost — this is the window, not the work. Reloading rebuilds the view from what is already recorded.
        </Txt>
        {isWeb ? (
          <View {...(well as object)} maxHeight="46vh" {...({ overflow: "auto" } as object)} {...(viewScrollbarProps(t) as object)}>
            {stack}
          </View>
        ) : (
          <ScrollView style={{ ...(well as object), maxHeight: screen.height * 0.46 }} nestedScrollEnabled>
            {stack}
          </ScrollView>
        )}
        <View flexDirection="row" gap={8}>
          <Button kind="primary" onPress={onReload}>
            Reload the window
          </Button>
          <Button onPress={() => void copyText(text)}>Copy the error</Button>
        </View>
      </View>
    </View>
  );
}

/** The banner, over the app rather than instead of it: the tree still renders. */
export function LooseErrorBanner({ staged = false }: { staged?: boolean }): JSX.Element | null {
  const t = useTokens();
  const [latest, setLatest] = useState<LooseError | null>(null);
  useEffect(() => onLooseError(setLatest), []);
  if (latest === null) return null;
  const box = (
    <View
      role="alert"
      flexDirection="row"
      alignItems="center"
      gap={8}
      paddingVertical={8}
      paddingHorizontal={12}
      borderRadius={8}
      borderWidth={1}
      borderStyle="solid"
      borderColor={t.mix(t.v("bad"), 45, t.v("line")) as never}
      backgroundColor={t.v("panel") as never}
      {...({ boxShadow: "0 6px 24px rgba(0, 0, 0, 0.18)" } as object)}
      {...(isWeb
        ? // Centred by its own width: placed at 50% and translated back by half of it.
          { position: staged ? "absolute" : "fixed", left: "50%", bottom: 16, zIndex: 1000, maxWidth: "min(720px, calc(100vw - 32px))", transform: [{ translateX: "-50%" }] }
        : { maxWidth: 720 })}
    >
      <Txt spec={{ voice: "app", scale: 13 / 12.5 }} ellip flex={1} minWidth={0} {...((isWeb ? { title: latest.text } : {}) as object)}>
        {"Something failed in the interface: "}
        {latest.text.split("\n")[0]}
      </Txt>
      <Button onPress={() => void copyText(latest.text)}>Copy</Button>
      <Button onPress={() => setLatest(null)}>Dismiss</Button>
    </View>
  );
  if (isWeb) return box;
  // On a phone a layer across the frame, 16 in from each side, centres it.
  return (
    <View position="absolute" left={0} right={0} bottom={16} paddingHorizontal={16} zIndex={1000} alignItems="center" pointerEvents="box-none">
      {box}
    </View>
  );
}

/**
 * A phone's net for what escapes everything else (`crashReport.ts`'s `installGlobalErrorReporting` is the
 * window's): React Native's global handler, chained — the report goes to the banner and the log, and
 * the handler that was there still runs, so a fatal error is still fatal. Once, from the entry point.
 */
export function installNativeErrorReporting(): void {
  const utils = (globalThis as { ErrorUtils?: { getGlobalHandler: () => (error: unknown, fatal?: boolean) => void; setGlobalHandler: (handler: (error: unknown, fatal?: boolean) => void) => void } }).ErrorUtils;
  if (utils === undefined) return;
  const before = utils.getGlobalHandler();
  utils.setGlobalHandler((error, fatal) => {
    const text = textOf(error);
    console.error("[jaira] uncaught in the interface:", text);
    reportLooseError({ at: Date.now(), text });
    before(error, fatal);
  });
}
