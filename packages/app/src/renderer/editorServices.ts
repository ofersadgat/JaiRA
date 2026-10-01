/**
 * What an editing surface asks of the shell — the services a file's editor is handed by whoever hosts
 * it (`fileTypes.ts`'s surface table passes them through). A type only.
 */
import type { ValidateSchemaResult } from "@jaira/shared/browser";
import type { Drafts, SetDraft } from "./drafts";

/**
 * What `edit_artifact` needs from the shell to be the app's editor rather than a textarea.
 *
 * A separate bag from `services` (the changeset gate's §8.2 contract) because these are different
 * capabilities for a different component, and one prop named `services` meaning two unrelated
 * things is how a contract stops being one. Every field optional: a dialog rendered without them
 * still edits, it just keeps its draft locally and offers no schema checking.
 */
export interface EditorServices {
  drafts?: Drafts | undefined;
  onDraft?: SetDraft | undefined;
  /** Check a draft against a registered schema — what turns the JSON editor's picker on. */
  validateSchema?: ((schemaId: string, text: string) => Promise<ValidateSchemaResult | null>) | undefined;
  wrapJson?: boolean | undefined;
  onWrapJson?: ((wrap: boolean) => void) | undefined;
}
