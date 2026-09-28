import type { ComponentType, JSX, ReactNode } from "react";
import { View } from "@tamagui/core";
import { GALLERY_SURFACES, type GallerySurface } from "@jaira/shared/browser";
import { Stage as DomStage } from "@jaira/ui/componentGallery";
import { initialState, parsedDoc } from "@jaira/ui/galleryModel";
import { GalleryStage as Stage, useTokens } from "@jaira/universal";

/**
 * The floats and dialogs `App.tsx` owns, and the gates and dialogs the Components room stages, as
 * specimens (decision 0015): each DOM original against its universal copy, from the same fixture.
 *
 *  - `gallery-<row>-<variant>` — every card's stage in the Components room: the gallery's own `Stage`
 *    (`componentGallery.tsx`) in `.gallery-stage`, against `GalleryPane.tsx`'s in the same dashed box,
 *    each from the variant's own config. The room itself scrolls them into view a fraction of a pixel
 *    apart (the rows above it are laid out by two engines); here each is drawn at the top of its box.
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
