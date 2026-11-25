/**
 * The types a workflow script is handed (`builtin/types/chat.ts`) are generated from `@jaira/shared`
 * (the person, 2026-11-24: "shouldnt the Settings type be imported from somewhere instead of
 * duplicated?"). This fails when a type they come from changed and the file was not written again —
 * run `node packages/shared/scripts/scriptTypes.mjs`.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error — a plain .mjs build script, with no declarations.
import { OUT, generate } from "../scripts/scriptTypes.mjs";

describe("the types a workflow script is handed", () => {
  it("are what @jaira/shared declares now", () => {
    expect(readFileSync(OUT as string, "utf8")).toBe((generate as () => string)());
  }, 60_000);
});
