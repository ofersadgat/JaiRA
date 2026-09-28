import { createContext, useContext, type JSX } from "react";
import { Text, View } from "@tamagui/core";
import { useApp } from "@jaira/ui/store";
import { TokenRoot, useTokens } from "../tokens";

/**
 * The desktop's shell, universal (decision 0015): `App.tsx`'s frame drawn from copies, on a phone and in
 * the `/rn` page that tests the phone's path in a browser. The same store drives it — `useApp()`, once,
 * here, as `App.tsx` calls it once — so this is a second VIEW of the one state, not a second app.
 *
 * What is not copied yet is drawn as {@link Uncopied}: a labelled box where the region stands, so what is
 * left is visible on the screen and in every gate picture, rather than silently missing.
 */
export type AppModel = ReturnType<typeof useApp>;
const AppContext = createContext<AppModel | null>(null);

/** The store, for any copy inside {@link UniversalApp}. */
export function useShell(): AppModel {
  const model = useContext(AppContext);
  if (model === null) throw new Error("useShell() outside <UniversalApp>");
  return model;
}

export function UniversalApp(): JSX.Element {
  const model = useApp();
  return (
    <AppContext.Provider value={model}>
      <TokenRoot {...model.appearance}>
        <Frame />
      </TokenRoot>
    </AppContext.Provider>
  );
}

/**
 * `.app`: the sidebar, its splitter, and the body — a row the height of the window. The body is the
 * address bar over the viewport, and the inbox strip under both.
 */
function Frame(): JSX.Element {
  const t = useTokens();
  return (
    <View flex={1} flexDirection="row" overflow="hidden" backgroundColor={t.v("bg") as never}>
      <Uncopied name="Sidebar" width={300} />
      <View flex={1} minWidth={0} minHeight={0} flexDirection="column">
        <View flexDirection="row" alignItems="stretch" flexShrink={0} minHeight={34} backgroundColor={t.v("panel") as never} borderBottomWidth={1} borderColor={t.v("line") as never} borderStyle="solid">
          <Uncopied name="TaskAddressBar" flex={1} />
        </View>
        <View flex={1} minHeight={0} flexDirection="row">
          <Uncopied name="Board" flex={1} />
        </View>
        <Uncopied name="InboxStrip" height={48} />
      </View>
    </View>
  );
}

/** A region with no copy yet: its name, where it stands. */
export function Uncopied({ name, ...box }: { name: string; width?: number; height?: number; flex?: number }): JSX.Element {
  const t = useTokens();
  return (
    <View {...box} testID={`uncopied-${name}`} borderWidth={1} borderStyle="dashed" borderColor={t.v("dim") as never} alignItems="center" justifyContent="center" padding={8}>
      <Text fontSize={12} color={t.v("dim") as never}>
        {name} (not copied yet)
      </Text>
    </View>
  );
}
