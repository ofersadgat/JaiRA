import { createContext, useContext } from "react";

/**
 * Whether the shell is laid out for a phone (decision 0015, amended 2026-10-04: the mobile pass). The
 * host says so (`NativeApp`, for a window narrower than `phoneModel.ts`' `PHONE_WIDTH`), and the shell
 * lays itself out by it: the sidebar a drawer, the context panel a sheet, the inbox a room of its own
 * (`PhoneFrame.tsx`). Off, everything is the desktop's, unchanged.
 */
export const PhoneContext = createContext(false);

export function usePhone(): boolean {
  return useContext(PhoneContext);
}
