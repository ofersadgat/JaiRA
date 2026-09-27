/**
 * JaiRA's engine as a service (decision 0012 §1): `AppService` and what it is made of, with no Electron
 * in it. The desktop app's main process constructs it today and hands it the few things only Electron
 * has (`publish` to the window, the keychain, `reveal`, `openExternal`, a directory dialog); a local
 * server and the CLI are the next hosts. A module's internals are reached as `@jaira/service/<module>`.
 */
export * from "./service";
export { stackDetail } from "./diagnostics";
export * from "./handlers";
