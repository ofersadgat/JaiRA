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
import { testHome } from "@jaira/testing";
import {
  COMPONENT_NAMES,
  GALLERY_CHANGESET,
  GALLERY_GROUPS,
  GALLERY_SURFACES,
  GALLERY_VARIANT_ORDER,
  changesetInputOf,
  componentConfigSchemaId,
  isComponentName,
  listSchemas,
  parseComponentConfig,
  schemaById,
  surfacesOfGroups,
  validateComponentResult,
  type ComponentName,
} from "@jaira/shared";
import { AppService } from "../src/main/service";

let dir: string;
let service: AppService;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "jaira-gallery-"));
  initProject(dir, testHome());
  service = new AppService({ baseDir: testHome(), watchWorkflows: false });
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
    const unknown = GALLERY_SURFACES.find((s) => s.group === "unknown-function");
    expect(unknown?.component).toBeDefined();
    expect(isComponentName(unknown!.component!)).toBe(false);
  });

  it("is a group per surface with a variation per card, every id unique", () => {
    expect(GALLERY_SURFACES).toEqual(surfacesOfGroups(GALLERY_GROUPS));
    for (const group of GALLERY_GROUPS) expect(group.variants.length, `${group.id} has no variants`).toBeGreaterThan(0);
    const ids = GALLERY_SURFACES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const surface of GALLERY_SURFACES) expect(surface.id).toBe(`${surface.group}/${surface.variant}`);
  });

  it("names its variants from one shared vocabulary, and every row has a basic one", () => {
    // The top bar slides every row to the same variant, which only means something if `comments`
    // on a chooser and `comments` on a review are the same word — so the ids come from one list.
    for (const group of GALLERY_GROUPS) {
      expect(group.variants[0]!.id, `${group.id} does not start with basic`).toBe("basic");
      for (const variant of group.variants) {
        expect(GALLERY_VARIANT_ORDER, `${group.id}/${variant.id} is not a canonical variant`).toContain(variant.id);
      }
    }
    // And every word in the vocabulary is used somewhere — a button that slides no row is noise.
    const used = new Set(GALLERY_SURFACES.map((s) => s.variant));
    for (const id of GALLERY_VARIANT_ORDER) expect(used, `no group has a ${id} variant`).toContain(id);
  });

  it("covers every knob a choose_option and a fill_form can express", () => {
    // Reading a group top to bottom is reading the contract — so the contract's knobs each have a
    // card. A knob with no card is a knob nobody can see before a run reaches it.
    const chooser = GALLERY_GROUPS.find((g) => g.id === "choose_option")!;
    const keys = new Set(chooser.variants.flatMap((v) => Object.keys(v.sample as Record<string, unknown>)));
    for (const knob of ["options", "comments", "multiple", "require_confirm", "custom", "questions", "follow_up", "icon"]) {
      expect(keys, `choose_option has no card showing ${knob}`).toContain(knob);
    }
    const form = GALLERY_GROUPS.find((g) => g.id === "fill_form")!;
    const fieldKeys = new Set(
      form.variants.flatMap((v) => ((v.sample as { fields: Record<string, unknown>[] }).fields).flatMap((f) => Object.keys(f))),
    );
    for (const knob of ["type", "label", "description", "enum", "optional", "multiline", "default", "custom"]) {
      expect(fieldKeys, `fill_form has no card showing ${knob}`).toContain(knob);
    }
  });
});

describe("the multi-part chooser fixture", () => {
  const surface = GALLERY_SURFACES.find((s) => s.id === "choose_option/steps")!;
  const config = parseComponentConfig("choose_option", surface.sample);

  it("asks several questions, each passable and each answerable in your own words", () => {
    expect(config.component === "choose_option" && config.questions?.length).toBeGreaterThan(1);
    if (config.component !== "choose_option" || config.questions === undefined) throw new Error("not multi-part");
    for (const question of config.questions) {
      expect(question.optional, question.name).toBe(true);
      expect(question.custom, question.name).toBe(true);
    }
  });

  it("accepts a complete answer, a pass, and an own answer — and refuses a stray key", () => {
    if (config.component !== "choose_option" || config.questions === undefined) throw new Error("not multi-part");
    const [first, second] = config.questions;
    expect(validateComponentResult(config, { answers: { [first!.name]: first!.options[0]!.value } }).ok).toBe(true);
    expect(validateComponentResult(config, { answers: {} }).ok).toBe(true);
    expect(validateComponentResult(config, { answers: { [second!.name]: "neither — put it in Settings" } }).ok).toBe(true);
    expect(validateComponentResult(config, { answers: { nobody: "asked" } }).ok).toBe(false);
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
