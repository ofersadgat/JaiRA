/**
 * The types JaiRA hands a workflow SCRIPT (decision 0029 §2), generated from `@jaira/shared` so a script
 * imports them rather than keeping a copy (the person, 2026-11-24: "shouldnt the Settings type be imported
 * from somewhere instead of duplicated?").
 *
 *   node packages/shared/scripts/scriptTypes.mjs            write packages/shared/builtin/types/chat.ts
 *   node packages/shared/scripts/scriptTypes.mjs --check    fail if it is stale (typecheck runs this)
 *
 * A script cannot import JaiRA's packages — its imports resolve inside the workflow layers — so the
 * types are written into what ships, where `$SYSTEM/types/chat` reaches them:
 *
 *   import type { ChatSettings } from "$SYSTEM/types/chat";
 *
 * Each root below is followed through every type it names in `packages/shared/src`, and each one found
 * is written with its doc comment, as declared. A type alias that reads a VALUE (`typeof X[number]`) is
 * written as the type it comes to, since the value does not travel. A name that resolves anywhere else
 * than `packages/shared/src` or TypeScript's own library is refused, rather than left dangling.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const SHARED = fileURLToPath(new URL("..", import.meta.url));
const SRC = resolve(SHARED, "src").replace(/\\/g, "/");
export const OUT = resolve(SHARED, "builtin", "types", "chat.ts");

/** What a script is handed, and the file that declares each. */
const ROOTS = [{ name: "ChatSettings", file: "operationVocabulary.ts" }];

const HEADER = `/**
 * The settings a person chose for a conversation's message — what the Chat view's composer sends, and
 * what a program conversation's \`settings\` input and \`input()\`'s message carry.
 *
 * GENERATED from \`@jaira/shared\` by \`packages/shared/scripts/scriptTypes.mjs\` — do not edit; change
 * the types there. Import it in a workflow script with
 *
 *   import type { ChatSettings } from "$SYSTEM/types/chat";
 */
`;

/** The file's text, as it should be now. */
export function generate() {
  const config = ts.getParsedCommandLineOfConfigFile(resolve(SHARED, "tsconfig.json"), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined });
  if (config === undefined) throw new Error("packages/shared/tsconfig.json could not be read");
  const program = ts.createProgram(ROOTS.map((root) => resolve(SRC, root.file)), config.options);
  const checker = program.getTypeChecker();

  const inShared = (node) => node.getSourceFile().fileName.replace(/\\/g, "/").startsWith(`${SRC}/`);
  const isLib = (node) => program.isSourceFileDefaultLibrary(node.getSourceFile()) || node.getSourceFile().fileName.includes("/node_modules/typescript/");

  /** Declarations to write, by name, in the order they were found. */
  const found = new Map();
  const queue = [];
  const take = (declaration) => {
    const name = declaration.name.text;
    const seen = found.get(name);
    if (seen !== undefined) {
      if (seen !== declaration) throw new Error(`two types called '${name}' are reachable from the roots`);
      return;
    }
    found.set(name, declaration);
    queue.push(declaration);
  };

  for (const root of ROOTS) {
    const source = program.getSourceFile(resolve(SRC, root.file));
    const declaration = source?.statements.find((s) => (ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s)) && s.name.text === root.name);
    if (declaration === undefined) throw new Error(`'${root.name}' is not declared in ${root.file}`);
    take(declaration);
  }

  /** Every named type a declaration's own text refers to. */
  const follow = (node) => {
    if (ts.isTypeReferenceNode(node) || ts.isExpressionWithTypeArguments(node)) {
      const at = ts.isTypeReferenceNode(node) ? node.typeName : node.expression;
      let symbol = checker.getSymbolAtLocation(at);
      if (symbol !== undefined && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
      const declaration = symbol?.declarations?.[0];
      if (declaration === undefined) throw new Error(`'${at.getText()}' does not resolve`);
      if (ts.isTypeParameterDeclaration(declaration) || isLib(declaration)) {
        // A generic's own parameter, or `Record`/`ReadonlyArray`: nothing to write.
      } else if (inShared(declaration) && (ts.isInterfaceDeclaration(declaration) || ts.isTypeAliasDeclaration(declaration))) {
        take(declaration);
      } else {
        throw new Error(`'${at.getText()}' is declared outside packages/shared/src, or is not a type — a script could not be handed it`);
      }
    }
    ts.forEachChild(node, follow);
  };

  const written = [];
  while (queue.length > 0) {
    const declaration = queue.shift();
    const doc = declaration.jsDoc?.at(-1)?.getText();
    const reads = (node) => ts.isTypeQueryNode(node) || ts.forEachChild(node, reads) === true;
    let body;
    if (ts.isTypeAliasDeclaration(declaration) && reads(declaration.type)) {
      // `typeof VALUES[number]`: the value stays behind, so the alias is written as what it comes to.
      const type = checker.getTypeAtLocation(declaration.name);
      body = `export type ${declaration.name.text} = ${checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.InTypeAlias)};`;
    } else {
      follow(declaration);
      const text = declaration.getText();
      body = /^export\s/.test(text) ? text : `export ${text}`;
    }
    written.push(`${doc !== undefined ? `${doc}\n` : ""}${body}`);
  }
  return `${HEADER}\n${written.join("\n\n")}\n`;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const text = generate();
  if (process.argv.includes("--check")) {
    let now = "";
    try {
      now = readFileSync(OUT, "utf8");
    } catch {
      // missing: stale
    }
    if (now !== text) {
      console.error(`${OUT} is stale — run: node packages/shared/scripts/scriptTypes.mjs`);
      process.exit(1);
    }
  } else {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, text, "utf8");
    console.log(`wrote ${OUT}`);
  }
}
