/**
 * What a transcript's work rows say: the reading `WorkRows`
 * (`packages/universal/src/components/panel/WorkRows.tsx`) draws its rows from.
 */
import { artifactOf, mimeOfPath, toolDisplayOf, workflowToolOf, type AgentQuestion, type SettledByView } from "@jaira/shared/browser";
import type { JsonValue } from "@declarative-ai/json";
import { answersOfAnsweredText } from "./choicesModel";
import { approvalAboutOf, approvalAnswerOf, approvalWordsOf, isApprovalCall } from "./workSummary";
import { shellLineOf, type ToolEntry, type WorkEntry } from "./transcript";

/**
 * The type a tool call's OWN arguments say its payload is.
 *
 * A `Read` of `main.cpp` produces a string, and nothing downstream knew what kind of string — so
 * `viewsFor` sniffed, and sniffing is weakest exactly on source code. The call already carries the
 * answer: a path, in an argument the tool itself named. Reading it turns a guess into a
 * declaration, and a declaration beats the sniffer everywhere in `viewsFor`.
 *
 * Absolute paths are what a tool is given, so the vendor rules in {@link mimeOfPath} — which key
 * off a position under a layer root — simply do not fire, and the extension answers. `text/plain`
 * comes back as `undefined` for the same reason it does in `mimeOfFenceLang`: it is not a
 * statement worth making, and making it would silence sniffing on a value nobody classified.
 */
export function pathMimeOf(args: JsonValue | undefined): string | undefined {
  if (args === null || args === undefined || typeof args !== "object" || Array.isArray(args)) return undefined;
  const at = args as Record<string, JsonValue | undefined>;
  for (const key of ["file_path", "filePath", "notebook_path", "path"]) {
    const named = at[key];
    if (typeof named === "string" && named !== "") {
      const mime = mimeOfPath(named.replace(/\\/g, "/"));
      return mime === "text/plain" ? undefined : mime;
    }
  }
  return undefined;
}

/**
 * The page a call PRODUCED, when it produced one — `show_artifact`'s half of the artifact story.
 *
 * Read off the result rather than off the tool's NAME, deliberately. `show_artifact` reaches an
 * agent under several names (bare, and MCP-prefixed per transport), and it is not the only producer
 * an artifact envelope can come out of; what makes a result showable is that it says what its bytes
 * are, which is exactly what {@link artifactOf} asks. A name test would have to be kept in step with
 * every transport, and would answer wrongly the first time it was not.
 *
 * `content` decides. The envelope carries the bytes inline whenever they are small enough
 * (`inlineMaxBytes`), which is the common case and the cheap one — there is nothing to fetch and
 * nothing to serve. Above that the envelope is metadata and a `uri`, and the page stays where the
 * artifacts panel can open it: an artifact too large to inline is also too large to unfold into the
 * middle of a conversation unasked.
 */
export function producedArtifact(result: JsonValue | undefined): JsonValue | undefined {
  if (result === undefined) return undefined;
  const artifact = artifactOf(result);
  return artifact?.content !== undefined ? result : undefined;
}

/**
 * An agent's question to the person, out of the call that asked it — `AskUserQuestion`.
 *
 * The questions are the call's arguments. The answers are what came back, read from the richest
 * record there is: the agent's own `toolUseResult` keeps them as a map, and the wire result the
 * model saw spells them out as text, which is parsed when the map was not captured. A call still in
 * flight, or a dismissal, answers nothing and is drawn unanswered.
 *
 * A call that FAILED is not a question. The binary refuses the tool's input on its own rules — five
 * questions where it takes four — before any person is asked, and the agent goes on as if answered.
 * Drawn as a question, that read as one nobody could answer: options a reader could not pick and a
 * run that did not wait. It is the failed tool call it was, with the refusal behind the row.
 */
export function askedOf(entry: ToolEntry): { questions: AgentQuestion[]; answers: Record<string, JsonValue> | undefined } | undefined {
  if (entry.name !== "AskUserQuestion" && !entry.name.endsWith("__AskUserQuestion")) return undefined;
  if (entry.ok === false) return undefined;
  const args = entry.args;
  if (args === null || typeof args !== "object" || Array.isArray(args)) return undefined;
  const questions = (args as Record<string, JsonValue>)["questions"];
  if (!Array.isArray(questions)) return undefined;
  const sound = questions.filter(
    (q): q is JsonValue & Record<string, JsonValue> =>
      q !== null && typeof q === "object" && !Array.isArray(q) && typeof (q as Record<string, JsonValue>)["question"] === "string",
  );
  if (sound.length === 0) return undefined;
  const asked = sound.map(
    (q): AgentQuestion => ({
      question: q["question"] as string,
      ...(typeof q["header"] === "string" ? { header: q["header"] } : {}),
      ...(q["multiSelect"] === true ? { multiSelect: true } : {}),
      options: Array.isArray(q["options"])
        ? q["options"]
            .filter((o): o is JsonValue & Record<string, JsonValue> => o !== null && typeof o === "object" && !Array.isArray(o))
            .map((o) => ({
              label: String(o["label"] ?? ""),
              ...(typeof o["description"] === "string" ? { description: o["description"] } : {}),
            }))
        : [],
    }),
  );
  const detail = entry.detail;
  const kept =
    detail !== undefined && detail !== null && typeof detail === "object" && !Array.isArray(detail)
      ? (detail as Record<string, JsonValue>)["answers"]
      : undefined;
  if (kept !== undefined && kept !== null && typeof kept === "object" && !Array.isArray(kept)) {
    return { questions: asked, answers: kept as Record<string, JsonValue> };
  }
  const text = resultTextOf(entry.result);
  const parsed =
    text === undefined
      ? undefined
      : answersOfAnsweredText(
          text,
          asked.map((q) => q.question),
        );
  return { questions: asked, answers: parsed };
}

/** The text of a tool's result, out of whichever envelope the transport left it in. */
function resultTextOf(result: JsonValue | undefined): string | undefined {
  if (typeof result === "string") return result;
  if (Array.isArray(result)) {
    const texts = result
      .map((block) =>
        block !== null && typeof block === "object" && !Array.isArray(block) && typeof (block as Record<string, JsonValue>)["text"] === "string"
          ? ((block as Record<string, JsonValue>)["text"] as string)
          : typeof block === "string"
            ? block
            : "",
      )
      .filter((t) => t.length > 0);
    return texts.length > 0 ? texts.join("\n") : undefined;
  }
  return undefined;
}

/**
 * What a surface lends the CALL rows of its transcript — the placement decisions a transcript cannot
 * make for itself (a component has no opinion about its place).
 */
export interface CallSurface {
  /**
   * Where a workflow tool's note goes. `inline` (the default) draws it under the call — right for a
   * one-column conversation. `rail`: the host draws it as a row beside the panel, from the journal
   * (`jaira.moved`), so the call's row says nothing more.
   */
  outcomes?: "inline" | "rail";
  /** Take back an answer the conversation gave — the rewind "Answer it yourself" is. Absent ⇒ no button. */
  onAnswerYourself?: ((by: SettledByView) => void) | undefined;
}

/**
 * The rows no summary may hide — drawn under it, whatever it says.
 *
 * The same argument the old fold made for its exemptions, and for the same rows: a page the model
 * drew, the call that delivered the operation's output, a question the agent put to the person (half
 * of which the person wrote), what a workflow tool did and a subagent's conversation are not steps
 * towards the answer, they are pieces of it. A summary that counted them into "3 commands · 2 edited" would be saying, of work done
 * on request, that it was bookkeeping.
 */
export function keptUnderSummary(entry: WorkEntry, calls?: CallSurface): boolean {
  if (entry.kind !== "tool") return false;
  // A subagent's call: its conversation is a child of this one, not a step of it.
  if (entry.sidechain !== undefined) return true;
  if (entry.output !== undefined || producedArtifact(entry.result) !== undefined || askedOf(entry) !== undefined) return true;
  return workflowToolOf(entry.name) !== undefined && entry.result !== undefined && entry.ok !== false && calls?.outcomes !== "rail";
}

/** How a row's glyph and name are coloured. Not the same axis as the mark at the end. */
export type RowTone = "plain" | "muted" | "warn" | "bad";
/** The verdict at the end of a row, when there is one to give. */
export type RowMark = "ok" | "bad" | "waiting" | "cut";

/** What goes under a call's line without being asked for (`Tool`'s `shown`), by kind. */
export type ToolShown = "sidechain" | "outcome" | "asked" | "produced" | "output" | undefined;

/**
 * One tool call's line — what `Tool` hands its `Row`: the name, what it was called as, the server, the
 * preview (a shell line in its parts' colours where it is one), the tone and the mark, and what is drawn
 * under it unasked. `open` is whether the call's stretch is the last thing in a record still being
 * written; `hasSidechain` whether the host can show or walk into a subagent's conversation.
 */
export function toolLineOf(
  entry: ToolEntry,
  open: boolean,
  hasSidechain: boolean,
  calls?: CallSurface,
): {
  name: string;
  called: string;
  server?: string;
  preview: string;
  command: string | undefined;
  prose: boolean;
  tone: RowTone;
  mark?: RowMark;
  shown: ToolShown;
  /** No answer recorded — still running (the call's stretch is open) or never answered. */
  unanswered: boolean;
  running: boolean;
  /** The subagent crumb's name: the Task's short description, or the tool's own title. */
  chainName: string;
  pathMime: string | undefined;
} {
  // No answer recorded is one of two different facts: the call is still running (the record is still
  // being written, and this is its last stretch), or it never answered (the record went on, or ended,
  // without one). Only the first may be called running.
  const unanswered = entry.ok === undefined && entry.result === undefined;
  const running = unanswered && open;
  const display = toolDisplayOf(entry.name);
  const chainName = `⑂ ${entry.summary.length > 0 ? entry.summary : display.title}`;
  const pathMime = pathMimeOf(entry.args);
  // The approval prompt, a tool the tool called: its verdict is its name, and who, how far and after
  // how long are the rest of the line (the person, 2026-09-26).
  if (isApprovalCall(entry)) {
    const words = approvalWordsOf(entry, unanswered && open);
    return {
      name: words.name,
      called: entry.name,
      preview: words.preview,
      command: approvalAnswerOf(entry) === undefined ? approvalAboutOf(entry).command : undefined,
      prose: approvalAnswerOf(entry) !== undefined,
      tone: words.tone,
      ...(words.mark !== undefined ? { mark: words.mark } : {}),
      shown: undefined,
      unanswered,
      running,
      chainName,
      pathMime,
    };
  }
  const shown: ToolShown =
    entry.sidechain !== undefined && hasSidechain
      ? "sidechain"
      : workflowToolOf(entry.name) !== undefined && entry.result !== undefined && entry.ok !== false
        ? calls?.outcomes === "rail"
          ? undefined
          : "outcome"
        : askedOf(entry) !== undefined
          ? "asked"
          : producedArtifact(entry.result) !== undefined
            ? "produced"
            : entry.output !== undefined
              ? "output"
              : undefined;
  return {
    name: display.title,
    called: entry.name,
    ...(display.server !== undefined ? { server: display.server } : {}),
    preview: entry.sidechain !== undefined ? `⑂ ${entry.summary}` : entry.summary,
    command: entry.sidechain === undefined ? shellLineOf(entry) : undefined,
    prose: false,
    tone: entry.ok === false ? "bad" : "plain",
    mark: entry.ok === undefined ? (running || !unanswered ? "waiting" : "cut") : entry.ok ? "ok" : "bad",
    shown,
    unanswered,
    running,
    chainName,
    pathMime,
  };
}
