/**
 * The promise the type table makes, checked against the thing that has to keep it.
 *
 * `shared/mime.ts` names a type for an extension, and naming one is a claim: this file has a
 * grammar, so it will open coloured. Nothing enforces that claim at runtime — a type with no entry
 * in `monacoLanguageOf` resolves to `plaintext` and the file opens grey, which looks like a styling
 * problem rather than a missing table row and so goes unreported indefinitely. That is exactly how
 * `.ps1`, `.bat` and `.graphql` came to be classified as text by one function and as non-text by
 * another for as long as they were.
 *
 * So the two tables are cross-checked here, and the exceptions are written down rather than
 * discovered. The exception list IS the list of formats this app names and cannot colour — if it
 * grows, that should be a decision somebody made on purpose.
 */
import { describe, expect, it } from "vitest";
import {
  CONFIG_JSON,
  WORKFLOW_JSON,
  WORKFLOW_YAML,
  codeMirrorGrammarOf,
  codeMirrorGrammars,
  isCodeMime,
  isTextMime,
  mimeOfFenceLang,
  mimeOfPath,
  monacoGrammarOf,
  registeredTextMimes,
} from "@jaira/shared/browser";

/**
 * Types this app names on purpose and cannot hand to a colourer.
 *
 * Each is a deliberate answer rather than a gap:
 *  - `text/plain` has no grammar, which is what being plain means.
 *  - `text/csv` and `text/tab-separated-values` have a better reading than colour — the table — and
 *    Monaco ships no grammar for either.
 *  - `text/x-diff` has no Monaco grammar either, and no longer needs one: a patch is read as the
 *    change it describes (`unifiedDiff.ts`), and the `code` view under that reading is the fallback
 *    rather than the answer.
 *  - `application/toml` is the one genuine hole left. Monaco ships no `toml` grammar, so a
 *    `Cargo.toml` opens uncoloured. It is nearly INI and could borrow that grammar, and deliberately
 *    does not: `monacoLanguage.ts` states the rule that an unknown type shows plain rather than
 *    wearing a grammar that is only mostly right, and a rule is not worth having if it bends for the
 *    first convenient case.
 */
const UNCOLOURED = new Set([
  "text/plain",
  "text/csv",
  "text/tab-separated-values",
  "text/x-diff",
  "application/toml",
]);

describe("every named type reaches a colourer", () => {
  for (const mime of registeredTextMimes()) {
    it(`colours ${mime}`, () => {
      const language = monacoGrammarOf(mime);
      if (UNCOLOURED.has(mime)) {
        expect(language).toBe("plaintext");
        return;
      }
      expect(language).not.toBe("plaintext");
    });
  }
});

describe("every named type is readable at all", () => {
  it("agrees with itself about what counts as text", () => {
    // The bug this exists for: `isTextMime` held a hand-written second copy of the table's values,
    // so three types were named by `mimeOfPath` and denied by the function that decides whether a
    // file can be opened — greyed out in the tree and refused by `file:read`.
    for (const mime of registeredTextMimes()) {
      expect(isTextMime(mime), mime).toBe(true);
    }
  });

  it("keeps the three that were actually broken honest", () => {
    for (const ext of ["ps1", "bat", "graphql"]) {
      const mime = mimeOfPath(`a.${ext}`);
      expect(isTextMime(mime), mime).toBe(true);
      expect(monacoGrammarOf(mime), mime).not.toBe("plaintext");
    }
  });
});

describe("a fence and a file agree", () => {
  it("resolves the same type from a language name as from an extension", () => {
    // `jsx` was the case that gave this away: ```jsx coloured as JavaScript and `Component.jsx`
    // opened as plain text, which is one vocabulary disagreeing with the other about one file.
    for (const [lang, ext] of [
      ["jsx", "jsx"],
      ["typescript", "ts"],
      ["python", "py"],
      ["powershell", "ps1"],
      ["rust", "rs"],
      ["diff", "diff"],
      ["yaml", "yaml"],
    ] as const) {
      expect(mimeOfFenceLang(lang), lang).toBe(mimeOfPath(`a.${ext}`));
    }
  });
});

describe("one route, two engines", () => {
  it("resolves a fence name the same way a file path is resolved — through the MIME type", async () => {
    const { fenceLanguage } = await import("../src/renderer/markdownEditor");
    // Every spelling of YAML lands on one grammar, because the aliases are resolved by
    // `mimeOfFenceLang` before this table is consulted rather than by a second list beside it.
    for (const name of ["yaml", "yml", "YAML"]) {
      expect(fenceLanguage(name)?.name, name).toBe("yaml");
    }
    expect(fenceLanguage("ts")?.name).toBe("typescript");
    expect(fenceLanguage("typescript")?.name).toBe("typescript");
    expect(fenceLanguage("js")?.name).toBe("javascript");
    expect(fenceLanguage("jsonc")?.name).toBe("json");
    // The info string may carry more than a language — `js title=foo` is one fence.
    expect(fenceLanguage("yaml title=workflow.yaml")?.name).toBe("yaml");
  });

  it("declines rather than guessing where only the other engine has a grammar", async () => {
    const { fenceLanguage } = await import("../src/renderer/markdownEditor");
    // Monaco can colour Python; CodeMirror here cannot. The honest answer is an uncoloured fence,
    // never a grammar that is merely nearby — the rule `languages.ts` states for both columns.
    expect(monacoGrammarOf(mimeOfPath("a.py"))).toBe("python");
    expect(fenceLanguage("python")).toBeNull();
    expect(fenceLanguage("")).toBeNull();
    expect(fenceLanguage("nothing-is-called-this")).toBeNull();
  });

  it("has a parser behind every CodeMirror grammar it names", async () => {
    // The promise this table makes, checked the same way the Monaco column's is: a name with no
    // loader behind it would leave the fence silently uncoloured.
    const { fenceLanguage } = await import("../src/renderer/markdownEditor");
    for (const grammar of codeMirrorGrammars()) {
      const named = ["yaml", "json", "javascript", "typescript", "html", "css"].includes(grammar);
      expect(named, `${grammar} has no loader`).toBe(true);
    }
    // …and the loaders actually resolve, which is the part a name cannot promise on its own.
    for (const name of ["yaml", "json", "ts"]) {
      const description = fenceLanguage(name);
      expect(description, name).not.toBeNull();
      await expect(description!.load()).resolves.toBeDefined();
    }
  });
});

describe("vendor types inherit their syntax", () => {
  it("colours a workflow file as the syntax it is written in", () => {
    // Three hand-written `endsWith("+json")`-style checks used to do this for three suffixes and
    // nothing else. `mimeFallbacks` is the mechanism the rest of the app already resolves with —
    // `typeNames.ts` for the label, `fileTypes.ts` for the surface, `structuredFormatOf` for the
    // parse — so a new vendor type now needs no entry anywhere to be coloured.
    expect(monacoGrammarOf(WORKFLOW_YAML)).toBe("yaml");
    expect(monacoGrammarOf(WORKFLOW_JSON)).toBe("json");
    expect(monacoGrammarOf(CONFIG_JSON)).toBe("json");
    expect(monacoGrammarOf("text/vnd.jaira.workflow-description+markdown")).toBe("markdown");
    expect(codeMirrorGrammarOf(WORKFLOW_YAML)).toBe("yaml");
  });

  it("reads a type that carries parameters", () => {
    expect(monacoGrammarOf("application/json; charset=utf-8")).toBe("json");
  });

  it("still answers plaintext for a type nothing knows", () => {
    expect(monacoGrammarOf("application/x-invented")).toBe("plaintext");
    expect(codeMirrorGrammarOf("application/x-invented")).toBeNull();
  });
});

describe("the view list and the grammar table are one answer", () => {
  it("offers a code view exactly where a grammar exists to produce one", () => {
    // The invariant the table moved into `shared` to make checkable. It used to be two independent
    // answers — a heuristic in `isCodeMime`, a lookup in the grammar table — and they disagreed
    // about four types, each of which drew a Code button that produced text identical to Source.
    for (const mime of registeredTextMimes()) {
      // Markdown is the one stated exception: it HAS a grammar (the diff editor colours a `.md`
      // file with it) and still must not offer `code`, because the rendering beats the source.
      if (mime === "text/markdown") {
        expect(monacoGrammarOf(mime)).not.toBe("plaintext");
        expect(isCodeMime(mime)).toBe(false);
        continue;
      }
      expect(isCodeMime(mime), mime).toBe(monacoGrammarOf(mime) !== "plaintext");
    }
  });

  it("no longer offers the four readings that could not be produced", () => {
    for (const mime of ["application/toml", "text/csv", "text/tab-separated-values", "text/x-diff"]) {
      expect(monacoGrammarOf(mime), mime).toBe("plaintext");
      expect(isCodeMime(mime), mime).toBe(false);
    }
  });

  it("answers the same for a bare subtype a slot declares as for the registered type", () => {
    // `{contentMediaType: "yaml"}` is what a workflow actually writes — see `grammarOf`'s BARE map.
    expect(monacoGrammarOf("yaml")).toBe("yaml");
    expect(isCodeMime("yaml")).toBe(true);
    expect(isCodeMime("markdown")).toBe(false);
  });
});
