/**
 * The gallery's fixtures, held to the contracts they claim to demonstrate.
 *
 * A gallery is only worth having if what it shows is what a run shows, and the way that goes wrong
 * is silent: a sample config that no longer parses renders an authoring error instead of a
 * component, and nobody notices because the card still draws. So every sample goes through
 * `parseComponentConfig` — the call main makes on a live gate — and through the schema its card
 * validates against, which is the same ajv path the JSON editor uses.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject } from "@jaira/persistence";
import {
  COMPONENT_NAMES,
  GALLERY_CHANGESET,
  GALLERY_SURFACES,
  changesetInputOf,
  componentConfigSchemaId,
  isComponentName,
  listSchemas,
  parseComponentConfig,
  schemaById,
  validateComponentResult,
  type ComponentName,
} from "@jaira/shared";
import { AppService } from "../src/main/service";

let dir: string;
let service: AppService;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "jaira-gallery-"));
  initProject(dir);
  service = new AppService({ watchWorkflows: false });
  await service.open(dir);
});

afterEach(async () => {
  await service.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Violations for a document, as the card's editor would list them. */
const check = (schemaId: string, doc: unknown): string[] =>
  service
    .validateSchema({ schemaId, text: JSON.stringify(doc) })
    .violations.map((v) => `${v.path}: ${v.message}`);

describe("what the gallery covers", () => {
  it("has a card for every built-in component", () => {
    const shown = GALLERY_SURFACES.filter((s) => s.kind === "interaction").map((s) => s.component);
    for (const name of COMPONENT_NAMES) expect(shown, `${name} is missing a card`).toContain(name);
  });

  it("shows the two dialogs JaiRA raises on its own, and the fallback", () => {
    expect(GALLERY_SURFACES.map((s) => s.kind)).toContain("approval");
    expect(GALLERY_SURFACES.map((s) => s.kind)).toContain("question");
    // The fallback's whole point: a function that is NOT a component, so the raw-JSON box renders.
    const unknown = GALLERY_SURFACES.find((s) => s.id === "unknown-function");
    expect(unknown?.component).toBeDefined();
    expect(isComponentName(unknown!.component!)).toBe(false);
  });
});

describe("the sample configs", () => {
  it("parse the way a live gate's config parses", () => {
    for (const surface of GALLERY_SURFACES) {
      if (surface.kind !== "interaction") continue;
      if (!isComponentName(surface.component ?? "")) continue;
      const config = parseComponentConfig(surface.component as ComponentName, surface.sample);
      expect(config.component, surface.id).toBe(surface.component);
      expect(config.prompt.length, `${surface.id} prompt`).toBeGreaterThan(0);
    }
  });

  it("satisfy the schema their card validates against", () => {
    for (const surface of GALLERY_SURFACES) {
      if (surface.schemaId === null) continue;
      expect(schemaById(surface.schemaId), `${surface.id} names an unregistered schema`).toBeDefined();
      expect(check(surface.schemaId, surface.sample), surface.id).toEqual([]);
    }
  });

  it("catches the two errors an author actually makes", () => {
    const id = componentConfigSchemaId("choose_option");
    // A misspelled key — `additionalProperties: false` is what makes this reportable.
    expect(check(id, { prompt: "hi", optoins: ["a"] }).join(" ")).toMatch(/optoins/);
    // A scalar where a list belongs.
    expect(check(id, { prompt: "hi", options: "approve" }).join(" ")).toMatch(/array/);
  });

  it("declares an input for every component that reads one", () => {
    for (const surface of GALLERY_SURFACES) {
      if (surface.kind !== "interaction") continue;
      if (!isComponentName(surface.component ?? "")) continue;
      const config = parseComponentConfig(surface.component as ComponentName, surface.sample);
      // A card whose component displays or seeds from an input has to supply that input, or it
      // renders an empty box and demonstrates nothing.
      if (config.component === "review_artifact") {
        expect(surface.inputs?.[config.artifact], surface.id).toBeTypeOf("string");
      }
      if (config.component === "edit_artifact" && config.source !== undefined) {
        expect(surface.inputs?.[config.source], surface.id).toBeTypeOf("string");
      }
    }
  });
});

describe("the changeset fixture", () => {
  it("is found by shape, the way the gate finds its changeset", () => {
    const surface = GALLERY_SURFACES.find((s) => s.component === "review_artifacts")!;
    const found = changesetInputOf(surface.inputs as Record<string, unknown>);
    expect(found.error).toBeUndefined();
    expect(found.changeset?.changes.map((c) => c.action)).toEqual(["update", "create", "delete", "update"]);
  });

  it("accepts a complete review and refuses a partial one", () => {
    const surface = GALLERY_SURFACES.find((s) => s.component === "review_artifacts")!;
    const config = parseComponentConfig("review_artifacts", surface.sample);
    const inputs = surface.inputs as Record<string, unknown>;
    const decisions = GALLERY_CHANGESET.changes.map((c) => ({ id: c.id, decision: "merged" as const }));
    expect(validateComponentResult(config, { decisions }, inputs).ok).toBe(true);
    // The contract is "every change you were shown, decided" — so one short is not a review.
    expect(validateComponentResult(config, { decisions: decisions.slice(1) }, inputs).ok).toBe(false);
  });
});

describe("where the gallery's schemas live", () => {
  it("registers them for validation without putting them in the file picker", () => {
    const picker = listSchemas().map((s) => s.id);
    for (const surface of GALLERY_SURFACES) {
      if (surface.schemaId === null) continue;
      expect(schemaById(surface.schemaId), surface.id).toBeDefined();
      // A component config is a fragment of a state file, never a file — so it must never be an
      // answer to "what schema is this `.json`".
      expect(picker, surface.id).not.toContain(surface.schemaId);
    }
    expect(picker).toEqual(["state", "state-prompt", "prompt-operation"]);
  });
});
