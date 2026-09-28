import { useEffect, type ComponentType, type JSX, type ReactNode } from "react";
import { View } from "@tamagui/core";
import { GALLERY_SURFACES, type GallerySurface, type ModuleApproval, type PendingApproval, type UpdateState } from "@jaira/shared/browser";
import { ApprovalDialog as DomApprovalDialog, ModuleApprovalDialog as DomModuleApprovalDialog } from "@jaira/ui/components";
import { Stage as DomStage } from "@jaira/ui/componentGallery";
import { FolderBrowser as DomFolderBrowser } from "@jaira/ui/folderBrowser";
import { approvalOf, initialState, parsedDoc } from "@jaira/ui/galleryModel";
import { invoke } from "@jaira/ui/store";
import { publishUpdate } from "@jaira/ui/updatesStore";
import { SidebarUpdateRow } from "@jaira/ui/updatesView";
import { ApprovalDialog, FolderBrowser, GalleryStage as Stage, ModuleApprovalDialog, TokenScope, UpdateRow, useLook, useTokens } from "@jaira/universal";

/**
 * The floats and dialogs `App.tsx` owns, and the gates and dialogs the Components room stages, as
 * specimens (decision 0015): each DOM original against its universal copy, from the same fixture.
 *
 *  - `gallery-<row>-<variant>` — every card's stage in the Components room: the gallery's own `Stage`
 *    (`componentGallery.tsx`) in `.gallery-stage`, against `GalleryPane.tsx`'s in the same dashed box,
 *    each from the variant's own config. The room itself scrolls them into view a fraction of a pixel
 *    apart (the rows above it are laid out by two engines); here each is drawn at the top of its box.
 *  - `approval-dialog`, `module-approval`, `folder-browser` — `App.tsx`'s own dialogs, drawn where they
 *    stand as the room's stage draws a dialog (`.gallery-stage` neutralises the backdrop; the copies take
 *    `staged`): a command approval that names no task, a workflow's modules to trust, and the folder
 *    browser (which asks main to list a machine that is not paired, and says why it cannot).
 *  - `update-row-<status>` — the sidebar's Update row in the sidebar's foot, with a newer version on the
 *    feed (published after main's own answer, so the fixture is what it shows).
 */
export interface FloatSpecimen {
  width: number;
  dom: ComponentType;
  rn: ComponentType;
}

/** The stage's width in the room at the studio's window: the card's body less the side column. */
const STAGE = 624;

/** `.gallery-stage`: padding 12, a dashed --line, radius 8, --bg. */
function RnStage({ children }: { children: ReactNode }): JSX.Element {
  const t = useTokens();
  return (
    <View padding={12} borderRadius={8} backgroundColor={t.v("bg") as never} borderWidth={1} borderStyle="dashed" borderColor={t.v("line") as never} minWidth={0}>
      {children}
    </View>
  );
}

const nameOf = (surface: GallerySurface): string => `gallery-${surface.id.replace(/\//g, "-")}`;

export const FLOAT_SPECIMENS: Record<string, FloatSpecimen> = Object.fromEntries(
  GALLERY_SURFACES.map((surface): [string, FloatSpecimen] => [
    nameOf(surface),
    {
      width: STAGE,
      dom: () => {
        const parsed = parsedDoc(initialState(surface).text);
        return (
          <div className="gallery-stage">
            <DomStage surface={surface} doc={parsed.doc} docError={parsed.error} onResult={() => undefined} />
          </div>
        );
      },
      rn: () => (
        <RnStage>
          <Stage surface={surface} text={initialState(surface).text} onResult={() => undefined} />
        </RnStage>
      ),
    },
  ]),
);

/** A command approval that names no task's conversation — the one still drawn as a modal — with its task's id over it. */
const ORPHAN = ((): PendingApproval => {
  const surface = GALLERY_SURFACES.find((s) => s.id === "approval/basic")!;
  return { ...approvalOf(surface, parsedDoc(initialState(surface).text).doc!), taskId: "t-8k2m4q" };
})();

/** Two modules a workflow is about to call: one never approved, one changed since it was. */
const MODULES: ModuleApproval[] = [
  {
    file: "C:/work/checkout/.jaira/workflows/lint/check.ts",
    hash: "a1",
    source: ["export function check(states: string[]): string[] {", "  return states.filter((s) => !s.includes(\"/\"));", "}", ""].join("\n"),
    symbols: ["check"],
  },
  {
    file: "C:/work/checkout/.jaira/workflows/lint/util.ts",
    hash: "b2",
    previousHash: "b1",
    source: ["export const trim = (s: string): string => s.trim();", ""].join("\n"),
  },
];

/** A newer version on the feed, published this morning — what the sidebar's Update row offers. */
const UPDATE = (status: "available" | "downloading" | "downloaded" | "error"): UpdateState => ({
  status,
  version: "0.3.282",
  channel: "stable",
  available: { version: "0.3.290", releaseDate: "2026-09-27T08:00:00Z", url: "https://example.com/releases/0.3.290" },
  ...(status === "downloading" ? { percent: 42 } : {}),
  ...(status === "error" ? { error: "the feed could not be read" } : {}),
} as UpdateState);

/** Publishes the update after main's own answer has landed, so the fixture is what the row shows. */
function WithUpdate({ state, children }: { state: UpdateState; children: ReactNode }): JSX.Element {
  useEffect(() => {
    void invoke("update:state", undefined).finally(() => publishUpdate(state));
  }, [state]);
  return <>{children}</>;
}

/** The sidebar's foot, where the row stands (`.side-foot` in `.sidebar`): its ground, 6 on top under a --line, the sidebar's --line on the right. */
function RnFoot({ children }: { children: ReactNode }): JSX.Element {
  return (
    <TokenScope scope="sidebar">
      <FootBox>{children}</FootBox>
    </TokenScope>
  );
}
function FootBox({ children }: { children: ReactNode }): JSX.Element {
  const t = useTokens();
  const look = useLook();
  return (
    <View flexDirection="column" gap={1} paddingTop={6} paddingHorizontal={6} paddingBottom={6} backgroundColor={t.v(look.palette === "classic" ? "panel-2" : "chrome") as never} borderTopWidth={1} borderRightWidth={1} borderBottomWidth={0} borderLeftWidth={0} borderStyle="solid" borderColor={t.v("line") as never}>
      {children}
    </View>
  );
}

/** The dialogs' stage: `.gallery-stage` round the DOM's (its backdrop static), the dashed box round the copy's. */
const staged = (dom: () => JSX.Element, rn: () => JSX.Element): FloatSpecimen => ({
  width: STAGE,
  dom: () => <div className="gallery-stage">{dom()}</div>,
  rn: () => <RnStage>{rn()}</RnStage>,
});

const NOOP = (): void => undefined;
const MACHINES = [{ id: "m-unpaired", label: "build box" }];

Object.assign(FLOAT_SPECIMENS, {
  "approval-dialog": staged(
    () => <DomApprovalDialog pending={ORPHAN} onDecide={NOOP} />,
    () => <ApprovalDialog staged pending={ORPHAN} onDecide={NOOP} />,
  ),
  "module-approval": staged(
    () => <DomModuleApprovalDialog files={MODULES} onApprove={NOOP} onCancel={NOOP} />,
    () => <ModuleApprovalDialog staged files={MODULES} onApprove={NOOP} onCancel={NOOP} />,
  ),
  "folder-browser": staged(
    () => <DomFolderBrowser machines={MACHINES} initial="m-unpaired" mode="open" onClose={NOOP} onChosen={NOOP} />,
    () => <FolderBrowser staged machines={MACHINES} initial="m-unpaired" mode="open" onClose={NOOP} onChosen={NOOP} />,
  ),
  ...Object.fromEntries(
    (["available", "downloading", "downloaded", "error"] as const).map((status): [string, FloatSpecimen] => [
      `update-row-${status}`,
      {
        width: 250,
        dom: () => (
          <WithUpdate state={UPDATE(status)}>
            <nav className="sidebar" style={{ height: "auto", width: "100%" }}>
              <div className="side-foot">
                <SidebarUpdateRow collapsed={false} onOpenAbout={NOOP} onNotes={NOOP} onRetry={NOOP} />
              </div>
            </nav>
          </WithUpdate>
        ),
        rn: () => (
          <WithUpdate state={UPDATE(status)}>
            <RnFoot>
              <UpdateRow collapsed={false} onOpenAbout={NOOP} onNotes={NOOP} onRetry={NOOP} />
            </RnFoot>
          </WithUpdate>
        ),
      },
    ]),
  ),
});
