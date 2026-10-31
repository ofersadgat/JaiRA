/**
 * `/design <brief>` becomes the prompt Claude Code sends for it (decision 0020 §2); nothing else changes.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ARTIFACT_TOOL_NOTE, expandArtifactCommand } from "../src/artifactCommands";

const builtInDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "shared", "builtin");
const command = readFileSync(join(builtInDir, "artifact-types", "design", "command.md"), "utf8");

describe("expandArtifactCommand", () => {
  it("sends the command's prompt, word for word, with the brief where the run had its own", () => {
    const sent = expandArtifactCommand("/design a settings screen\nfor a banking app", builtInDir);
    expect(sent).toBe(`${command.replace("{{brief}}", "a settings screen\nfor a banking app").trimEnd()}\n\n${ARTIFACT_TOOL_NOTE}\n`);
    expect(sent).toMatch(/^`\/design` was invoked/);
  });

  it("takes /design with no brief, and leaves every other message as typed", () => {
    expect(expandArtifactCommand("/design", builtInDir)).toBe(`${command.replace("{{brief}}", "").trimEnd()}\n\n${ARTIFACT_TOOL_NOTE}\n`);
    expect(expandArtifactCommand("please /design this", builtInDir)).toBe("please /design this");
    expect(expandArtifactCommand("/designer", builtInDir)).toBe("/designer");
  });

  it("sends what was typed when the type's files are missing", () => {
    expect(expandArtifactCommand("/design x", join(builtInDir, "nowhere"))).toBe("/design x");
  });
});
