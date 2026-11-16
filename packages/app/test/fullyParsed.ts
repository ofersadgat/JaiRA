import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState, type EditorStateConfig } from "@codemirror/state";

/**
 * An editor state whose syntax tree covers its whole document, for tests that read `marks` once.
 *
 * `EditorState.create` parses only as far as a time budget and a few thousand characters allow. The
 * editor redraws as the parse grows (`livePreview` in markdownEditor.tsx), but a test that reads the
 * new state once sees only that first slice. Under the full suite's load the budget once ran out after
 * the first line of a two-line task list (2026-11-15: `• ☐ todo\n- [x] done`). Forcing the parse
 * advances the state's parse context, and one transaction later the state reports the whole tree.
 */
export function fullyParsed(config: EditorStateConfig): EditorState {
  const state = EditorState.create(config);
  ensureSyntaxTree(state, state.doc.length, 10_000);
  return state.update({}).state;
}
