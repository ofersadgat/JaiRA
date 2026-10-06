/**
 * One engine view, held by a component for as long as it is mounted (decision 0018): read from the
 * window's store, kept current from the change log, and redrawn only when this view changes.
 *
 * `still` holds it without re-reading on changes — a transcript while its turn streams, which the live
 * tail is drawing — and it is read as soon as it is held live again.
 */
import { useEffect, useId, useMemo, useSyncExternalStore } from "react";
import { lazyHashes, withLazyFilled, type IpcChannel, type IpcRequest, type IpcResponse } from "@jaira/shared/browser";
import type { JsonValue } from "@declarative-ai/json";
import { syncCache } from "./store";
import { viewKey, type Held } from "./syncCache";

const NOTHING: Held<never> = Object.freeze({ value: undefined, error: undefined, loading: false });

export function useView<C extends IpcChannel>(channel: C, request: IpcRequest<C> | null, still = false): Held<IpcResponse<C>> {
  const store = syncCache();
  const owner = `view:${useId()}`;
  const key = request === null ? null : viewKey(channel, request);
  useEffect(() => {
    if (request === null) return;
    const held: ReadonlyArray<readonly [IpcChannel, unknown]> = [[channel, request]];
    store.hold(owner, still ? [] : held, still ? held : []);
    return () => store.hold(owner, []);
    // The key stands for the request: the same view however the object was made.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, owner, key, still]);
  return useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => (request === null ? NOTHING : store.peek(channel, request)),
    () => (request === null ? NOTHING : store.peek(channel, request)),
  );
}

/** Several views of one channel, held together — a run's open transcripts. Redrawn when any of them changes. */
export function useViews<C extends IpcChannel>(channel: C, requests: ReadonlyArray<IpcRequest<C>>, still = false): Array<Held<IpcResponse<C>>> {
  const store = syncCache();
  const owner = `views:${useId()}`;
  const keys = requests.map((request) => viewKey(channel, request)).join("\u0000");
  useEffect(() => {
    const held: ReadonlyArray<readonly [IpcChannel, unknown]> = requests.map((request) => [channel, request] as const);
    store.hold(owner, still ? [] : held, still ? held : []);
    return () => store.hold(owner, []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, owner, keys, still]);
  const version = useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.version,
    () => store.version,
  );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => requests.map((request) => store.peek(channel, request)), [store, keys, version]);
}

/**
 * A value with its `$lazy` placeholders filled in (decision 0018 §6): each fetched by its hash while
 * this is mounted, the value as it came — placeholders and all — until they arrive. Mount it where
 * the value is DRAWN (an opened payload), not where it is listed, and only what is looked at is fetched.
 */
export function useFilled<T extends JsonValue | undefined>(value: T): T {
  const hashes = useMemo(() => (value === undefined ? [] : [...lazyHashes(value)].sort()), [value]);
  const requests = useMemo(() => hashes.map((hash) => ({ hash })), [hashes.join(",")]);
  const held = useViews("lazy:value", requests);
  return useMemo(() => {
    if (value === undefined || hashes.length === 0) return value;
    const known = new Map<string, string>();
    hashes.forEach((hash, i) => {
      const text = held[i]?.value;
      if (text !== undefined) known.set(hash, text);
    });
    return withLazyFilled(value, known) as T;
  }, [value, hashes, held]);
}
