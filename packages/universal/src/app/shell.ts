import { createContext, useContext, useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import type { useApp } from "@jaira/ui/store";

/** The one store the shell runs on — `useApp()`, called once by `UniversalApp`. */
export type AppModel = ReturnType<typeof useApp>;
type AppState = AppModel["state"];

/**
 * Where the shell's regions read the store from: the model `UniversalApp` last drew, and who to tell when
 * it moves. Handed down once and never replaced, so a region is drawn again when what IT reads moves, not
 * whenever anything does (2026-11-06: the phone redrew ~1,600 components for every change on its machine,
 * and a tap waited two seconds behind them).
 */
export class ShellHub {
  private current: AppModel;
  private version = 0;
  private told = 0;
  private readonly listeners = new Set<() => void>();

  constructor(model: AppModel) {
    this.current = model;
  }

  model(): AppModel {
    return this.current;
  }

  at(): number {
    return this.version;
  }

  /** The model `UniversalApp` is drawing: set while it draws, so a region drawn with it reads the same. */
  set(model: AppModel): void {
    if (model === this.current) return;
    this.current = model;
    this.version += 1;
  }

  /** After the commit: each region checks whether what it read moved. */
  tell(): void {
    if (this.told === this.version) return;
    this.told = this.version;
    for (const listener of [...this.listeners]) listener();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };
}

export const AppContext = createContext<ShellHub | null>(null);

/** The hub for `UniversalApp`: made once, set to each model it draws, telling the regions after each commit. */
export function useShellHub(model: AppModel): ShellHub {
  const hub = useMemo(() => new ShellHub(model), []); // eslint-disable-line react-hooks/exhaustive-deps
  hub.set(model);
  useLayoutEffect(() => hub.tell());
  return hub;
}

/**
 * One component's reading of the hub: which fields of `state` it read, with what it read, and the model it
 * was last handed. {@link snapshot} is what `useSyncExternalStore` compares — the version it was drawn for
 * until a field it read, the actions or the look move; {@link draw} is what it is handed.
 */
export class ShellReader {
  private version = -1;
  /** Each field of the state read through what this reader handed out, with what it was drawn with. */
  private readonly read = new Map<PropertyKey, unknown>();
  private shown: AppModel | null = null;

  constructor(private readonly hub: ShellHub) {}

  snapshot = (): number => {
    const now = this.hub.at();
    const shown = this.shown;
    if (shown === null || now === this.version) return now;
    const model = this.hub.model();
    if (model.actions !== shown.actions || model.appearance !== shown.appearance) return now;
    const state = model.state as unknown as Record<PropertyKey, unknown>;
    for (const [key, value] of this.read) if (state[key] !== value) return now;
    return this.version;
  };

  /** The model to hand the component drawn at `version`: the one handed before, unless it moved. */
  draw(version: number): AppModel {
    if (this.shown !== null && version === this.version) return this.shown;
    const model = this.hub.model();
    const live = model.state as unknown as Record<PropertyKey, unknown>;
    for (const key of this.read.keys()) this.read.set(key, live[key]);
    this.version = version;
    this.shown = { ...model, state: tracking(this.hub, this.read) };
    return this.shown;
  }
}

/**
 * The store, for any component inside `UniversalApp` — drawn again only when a field of `state` it has
 * read moves (or the actions, or the look). `state` reads the newest model whenever it is read, so a
 * handler run after the draw sees what is true now; every field read is noted against this component,
 * whoever reads it (a child handed `state`, an effect), and the fields it noted are what it watches. A
 * component that read one moved is given a new `state`, so what it hands down or memoizes on is new too.
 */
export function useShell(): AppModel {
  const model = useShellOrNull();
  if (model === null) throw new Error("useShell() outside <UniversalApp>");
  return model;
}

/** {@link useShell}, or `null` outside `UniversalApp` (a specimen drawn alone). */
export function useShellOrNull(): AppModel | null {
  const hub = useContext(AppContext);
  const reader = useMemo(() => (hub === null ? null : new ShellReader(hub)), [hub]);
  const version = useSyncExternalStore(hub?.subscribe ?? noSubscribe, reader?.snapshot ?? nothing, reader?.snapshot ?? nothing);
  return reader === null ? null : reader.draw(version);
}

const noSubscribe = (): (() => void) => () => undefined;
const nothing = (): number => 0;

/** The state, read from the hub's newest model, each field read noted in `read`. */
function tracking(hub: ShellHub, read: Map<PropertyKey, unknown>): AppState {
  const live = (): Record<PropertyKey, unknown> => hub.model().state as unknown as Record<PropertyKey, unknown>;
  // A field already watched keeps what the component was drawn with: only its next draw takes the new
  // value, so a read after a change (an effect, a handler) cannot hide the change from it.
  const note = (key: PropertyKey, value: unknown): void => {
    if (!read.has(key)) read.set(key, value);
  };
  return new Proxy(hub.model().state as unknown as Record<PropertyKey, unknown>, {
    get(_target, key) {
      const value = live()[key];
      note(key, value);
      return value;
    },
    has(_target, key) {
      return key in live();
    },
    ownKeys() {
      const state = live();
      for (const key of Reflect.ownKeys(state)) note(key, state[key]);
      return Reflect.ownKeys(state);
    },
    getOwnPropertyDescriptor(_target, key) {
      const state = live();
      note(key, state[key]);
      const found = Reflect.getOwnPropertyDescriptor(state, key);
      return found === undefined ? undefined : { ...found, configurable: true };
    },
  }) as unknown as AppState;
}
