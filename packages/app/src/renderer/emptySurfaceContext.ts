import type { FileSurfaceContext } from "./fileTypes";

/**
 * The context fields no configuration surface reads.
 *
 * Spelled out rather than cast, so that adding a field to {@link FileSurfaceContext} makes this
 * fail to compile instead of quietly passing `undefined` into a surface that expects it.
 *
 * EXPORTED for the surfaces that mount one at a time with no shell behind them — the file-types
 * preview is the one in the tree — because they need exactly this: every channel present and inert.
 * A second hand-written copy would be a second thing to keep in step with the interface, and it
 * would rot the first time somebody added a field.
 */
export const EMPTY_CONTEXT: FileSurfaceContext = {
  // No shell behind this, so there is nowhere for a definition to be opened.
  onOpenDefinition: undefined,
  revealAt: null,
  state: null,
  config: null,
  tree: null,
  executors: [],
  records: {},
  selected: null,
  conversation: null,
  detail: null,
  sessions: {},
  onLoadSession: () => undefined,
  onLoadSessions: () => undefined,
  shutStates: new Set<string>(),
  onToggleShutState: () => undefined,
  onSetShutStates: () => undefined,
  userEvents: [],
  onDeliverUserEvent: () => undefined,
  sessionHistory: [],
  session: null,
  sessionInstance: null,
  liveTurn: null,
  onShowSession: () => undefined,
  onSelectTask: () => undefined,
  onDrill: () => undefined,
  onSaveConfig: () => undefined,
  // The config surfaces validate through `config:write`, not through a schema — see ConfigEdit.
  validateSchema: async () => null,
  stateSlots: async () => null,
  schemaChoice: {},
  onSchemaChoice: () => undefined,
  detectSchema: async () => null,
  wrapJson: false,
  onWrapJson: () => undefined,
};

