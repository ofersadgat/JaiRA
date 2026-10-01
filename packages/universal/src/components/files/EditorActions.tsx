import { createContext, useContext, type JSX, type ReactNode } from "react";
import { View, isWeb } from "@tamagui/core";
import { Txt } from "../../primitives";
import { useTokens } from "../../tokens";
import { Button } from "../settings/Button";

/**
 * `editorChrome.tsx`'s `EditorActions`: Save and Revert, pinned under the editor. The rules
 * (`cascade.mts '.pane-actions.pinned'`):
 *
 *   .pane-actions.pinned   row, centred, wrapping, gap 6; 8 above, a --line over it, --panel; pushed to
 *                          the foot (margin-top auto); sticky at the foot of what scrolls it, z-index 2 —
 *                          which is also what draws it over the Components room's own sticky bar (equal
 *                          z-index, later in the page) when a card's Save scrolls under it
 *   button.primary/.ghost  `Button`'s; disabled at half opacity
 *   .reason                --bad, app 11/12.5 (why saving is refused)
 *   .sub                   --dim, app 11/12.5
 */
export function EditorActions({
  dirty,
  busy,
  blocked,
  onSave,
  onRevert,
  children,
}: {
  dirty?: boolean | undefined;
  busy?: boolean;
  blocked?: string | undefined;
  onSave: () => void;
  onRevert?: (() => void) | undefined;
  children?: ReactNode;
}): JSX.Element {
  return (
    <EditorActionsRow>
      <Button kind="primary" onPress={onSave} disabled={busy === true || dirty === false || blocked !== undefined}>
        Save
      </Button>
      {onRevert !== undefined ? (
        <Button kind="ghost" onPress={onRevert} disabled={dirty === false}>
          Revert
        </Button>
      ) : null}
      {blocked !== undefined ? <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "bad" }}>{blocked}</Txt> : null}
      {dirty === true && blocked === undefined ? <Sub>unsaved changes</Sub> : null}
      {children}
    </EditorActionsRow>
  );
}

/** `.sub`: --dim, app 11/12.5. */
export function Sub({ children, ...rest }: { children: ReactNode } & Record<string, unknown>): JSX.Element {
  return (
    <Txt spec={{ voice: "app", scale: 11 / 12.5, color: "dim" }} {...rest}>
      {children}
    </Txt>
  );
}

/** `ReadingNote`: the row a Save button would have been in, saying why there is none. */
export function ReadingNote(): JSX.Element {
  return (
    <EditorActionsRow>
      <Sub>The reading of this type — not a place to type. Appearance › File types.</Sub>
    </EditorActionsRow>
  );
}

/**
 * Inside the File types preview the row is not drawn (`.ft-preview-body .pane-actions { display: none }`):
 * the sample's text is thrown away, so a Save there would be a button that does nothing.
 */
const Hidden = createContext(false);
export function HideEditorActions({ children }: { children: ReactNode }): JSX.Element {
  return <Hidden.Provider value={true}>{children}</Hidden.Provider>;
}

/** `.pane-actions.pinned`, holding whatever the surface puts in it. */
export function EditorActionsRow({ children }: { children: ReactNode }): JSX.Element | null {
  const t = useTokens();
  if (useContext(Hidden)) return null;
  return (
    <View {...((isWeb ? { position: "sticky", bottom: 0, zIndex: 2 } : {}) as object)} flexDirection="row" flexWrap="wrap" alignItems="center" gap={6} flexShrink={0} marginTop="auto" paddingTop={8} backgroundColor={t.v("panel") as never} borderTopWidth={1} borderRightWidth={0} borderBottomWidth={0} borderLeftWidth={0} borderStyle="solid" borderColor={t.v("line") as never}>
      {children}
    </View>
  );
}

/** `.file-edit`: a column, gap 8, taking the half it was given (flex 1 1 auto, may shrink to nothing). */
export function FileEdit({ children }: { children: ReactNode }): JSX.Element {
  return (
    <View flexDirection="column" flexGrow={1} flexShrink={1} flexBasis="auto" gap={8} minHeight={0}>
      {children}
    </View>
  );
}
