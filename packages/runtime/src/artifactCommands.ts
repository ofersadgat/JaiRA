/**
 * The commands a person types into a conversation that Claude Code would expand — `/design <brief>`
 * (decision 0020 §2).
 *
 * Claude Code turns `/design` into a prompt telling the model to start a canvas from the Design type and
 * follow its instructions; JaiRA sends the model that same prompt, kept word for word in
 * `$SYSTEM/artifact-types/design/command.md`, with the person's brief where the run had theirs. Anything
 * that is not one of these commands is sent as typed.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultBuiltInDir } from "@jaira/shared";

/** `/design`, alone or followed by a brief, at the very start of the message. */
const DESIGN = /^\/design(?:\s+([\s\S]*))?$/;

export function expandArtifactCommand(message: string, builtInDir: string = defaultBuiltInDir()): string {
  const match = DESIGN.exec(message.trim());
  if (match === null) return message;
  let template: string;
  try {
    template = readFileSync(join(builtInDir, "artifact-types", "design", "command.md"), "utf8");
  } catch {
    // Without the type's files the command means nothing to the model; send what was typed.
    return message;
  }
  return template.replace("{{brief}}", (match[1] ?? "").trim());
}
