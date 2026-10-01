import { createContext, useContext } from "react";
import type { useApp } from "@jaira/ui/store";

/** The one store the shell runs on — `useApp()`, called once by `UniversalApp`. */
export type AppModel = ReturnType<typeof useApp>;
export const AppContext = createContext<AppModel | null>(null);

/** The store, for any component inside `UniversalApp`. */
export function useShell(): AppModel {
  const model = useContext(AppContext);
  if (model === null) throw new Error("useShell() outside <UniversalApp>");
  return model;
}
