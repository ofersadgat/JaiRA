import { Platform } from "react-native";
import type { DeviceKind } from "@jaira/shared/browser";

/** A phone's name for the machine's Settings → Machines row: its model — see `deviceInfo.ts`. */
export const DEVICE_KIND: DeviceKind = "phone";

export function deviceLabel(): string {
  if (Platform.OS === "android") {
    const { Brand, Model } = Platform.constants as { Brand?: string; Model?: string };
    const model = (Model ?? "").trim();
    if (model === "") return "An Android phone";
    // "Pixel 8" says it all; "SM-S911B" is helped by "samsung".
    const brand = (Brand ?? "").trim();
    return brand !== "" && !model.toLowerCase().includes(brand.toLowerCase()) && brand.toLowerCase() !== "google" ? `${brand} ${model}` : model;
  }
  if (Platform.OS === "ios") return Platform.isPad ? "An iPad" : "An iPhone";
  return "A phone";
}
