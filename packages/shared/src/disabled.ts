/**
 * Disabled workflows (decision 0021).
 *
 * `"disabled": true` in a state file switches off that state and every state under its id: no new
 * run starts there, whoever starts it, and a running workflow that would enter one fails at the
 * entry. It is a property of the workflow's FILE, not a setting — the person's ruling, 2026-10-26:
 * "this isnt an application setting, its a workflow configuration. the state should live with the
 * workflow". Hiding a board column is the view's business and lives elsewhere (`uiState.shut`).
 *
 * The set of disabled ids is read from the winning file of each state on the workflow path, a file
 * that follows another (`{ "$ref": …, "disabled": true }`) included; these are the rules over it.
 */
import { applyEdits, modify, parse as parseJsonc } from "jsonc-parser";

/**
 * The state that switches `stateId` off — itself, or the NEAREST state above it whose file says
 * `"disabled": true` — or `undefined` when nothing does. A variant id (`feature/plan#1`, one state
 * mounted twice) is read as the state it is a variant of.
 */
export function disabledBy(disabled: Iterable<string> | undefined, stateId: string): string | undefined {
  if (disabled === undefined) return undefined;
  const off = disabled instanceof Set ? (disabled as ReadonlySet<string>) : new Set(disabled);
  if (off.size === 0) return undefined;
  const at = stateId.lastIndexOf("#");
  const id = at > 0 ? stateId.slice(0, at) : stateId;
  for (let cut = id.length; cut > 0; cut = id.lastIndexOf("/", cut - 1)) {
    const prefix = id.slice(0, cut);
    if (off.has(prefix)) return prefix;
  }
  return undefined;
}

/**
 * What a refusal says about a disabled state — the words a start, an entry and a move share, so a
 * person reads one sentence for one cause wherever it stopped them.
 */
export function disabledWords(stateId: string, by: string): string {
  return by === stateId ? `'${stateId}' is disabled` : `'${stateId}' is under '${by}', which is disabled`;
}

// --- writing the switch -------------------------------------------------------------------------
//
// Text in, text out: the service reads and writes the file. Pure so the rules are testable without a
// file system, and free of Node so the renderer may import the module for `disabledBy`.

/** The fields the switch is written after, first found wins — where a person reading the file looks. */
const DISABLED_AFTER = ["description", "label", "$ref"];

/**
 * A state file's text with `"disabled"` set to `value`, or taken out when `value` is `undefined` — a
 * format-preserving edit: indentation, line endings and every other key stay as they were.
 */
export function withDisabledText(text: string, value: boolean | undefined): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const indent = /\n([ \t]+)"/.exec(text)?.[1] ?? "  ";
  const tabs = indent.includes("\t");
  const edits = modify(text, ["disabled"], value, {
    formattingOptions: { insertSpaces: !tabs, tabSize: tabs ? 1 : indent.length, eol },
    getInsertionIndex: (properties) => {
      for (const after of DISABLED_AFTER) {
        const at = properties.indexOf(after);
        if (at >= 0) return at + 1;
      }
      return 0;
    },
  });
  return applyEdits(text, edits);
}

/**
 * Whether a state file says nothing but whose file it follows (`{ "$ref": … }`) — what Enable leaves
 * of a file Disable wrote, and so a file with nothing left to keep.
 */
export function followsOnly(text: string): boolean {
  const value = parseJsonc(text, [], { allowTrailingComma: true }) as unknown;
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 1 && typeof (value as { $ref?: unknown }).$ref === "string";
}

/**
 * A new state file that follows `follows` — `$SYSTEM/workflows/chat/session`, a root written out so
 * a bare `$` cannot find the file itself — and sets the switch. How a workflow a layer only inherits
 * is switched off (or back on) there without a copy that would stop hearing about the original.
 */
export function followFileText(follows: string, disabled: boolean): string {
  return `${JSON.stringify({ $ref: follows, disabled }, null, 2)}\n`;
}
