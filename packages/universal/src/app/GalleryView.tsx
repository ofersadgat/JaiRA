import type { JSX } from "react";
import { GalleryPane } from "../components/gallery/GalleryPane";
import { useShell } from "./shell";

/** The Components room (`GalleryPane`), as `App.tsx` draws it in `.viewport` (decision 0015), with the store's schema check. */
export function GalleryView(): JSX.Element {
  const { actions } = useShell();
  return <GalleryPane validateSchema={actions.validateSchema} />;
}
