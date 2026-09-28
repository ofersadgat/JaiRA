import type { JSX } from "react";
import { GalleryPane } from "../components/gallery/GalleryPane";

/** The Components room (`GalleryPane`), as `App.tsx` draws it in `.viewport` (decision 0015). */
export function GalleryView(): JSX.Element {
  return <GalleryPane />;
}
