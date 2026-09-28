import { setStringAsync } from "expo-clipboard";

/** Put text on the phone's clipboard (`expo-clipboard`) — see `clipboard.ts`. */
export function copyText(text: string): Promise<boolean> {
  return setStringAsync(text).then(
    (done) => done,
    () => false,
  );
}
