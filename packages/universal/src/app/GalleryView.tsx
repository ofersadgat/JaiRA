import type { JSX } from "react";
import { GalleryPane } from "../components/gallery/GalleryPane";
import { useShell } from "./shell";

/** The Components room (`GalleryPane`), with the store's schema check. */
export function GalleryView(): JSX.Element {
  const { actions } = useShell();
  return <GalleryPane validateSchema={actions.validateSchema} />;
}
