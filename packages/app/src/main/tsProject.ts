/**
 * The real TypeScript program, kept alive so the editor can ask it questions.
 *
 * ## Why this exists at all
 *
 * Monaco already had a TypeScript service. It runs in a web worker inside the renderer, and it is
 * what drew the red underlines in the Files view. It also could not possibly be right: a web worker
 * has no disk, so its program held exactly ONE file — whatever was on screen — and every import in
 * it resolved to nothing. `export * from "./main/service"` came back as "Cannot find module
 * './main/service'. Did you mean to set the 'moduleResolution' option to 'nodenext'…", advice about
 * a file that compiles cleanly. Every semantic complaint it made rested on that empty program: an
 * unknown `React`, an `any` that is really a typed import, a member that "does not exist" on a type
 * the worker never read. The squiggles were not noise around a signal — there was no signal.
 *
 * So the check happens where the project is. `tsconfig.json` is found the way `tsc` finds it, the
 * program is the one that config describes — its `paths` aliases, its `lib`, its `jsx`, the
 * checkout's `node_modules` — and what comes back are the errors a build reports.
 *
 * ## Syntax as well as meaning, and why it is not shared
 *
 * A parse needs no project, so Monaco could have gone on reporting missing braces from its own
 * in-browser copy of TypeScript while this answered about types. That split was tried and is wrong,
 * for a reason that has nothing to do with the diagnostics: Monaco re-validates every open model
 * whenever its language defaults change, and its validator asks the worker about a model that may
 * already be gone — an unhandled "Could not find source file: 'inmemory://model/1'" that surfaces in
 * the app's own crash reporter and is nobody's bug to fix.
 *
 * So Monaco's TypeScript validation is off entirely (see `monacoDiff.tsx`) and this answers both
 * halves. Which also makes the rule simpler to state: every red underline under TypeScript in this
 * app came from a real compiler reading a real disk.
 *
 * A file no project covers still gets its syntax — {@link syntaxOnly} parses it by itself, which is
 * exactly what a parse can do without a program. What such a file does not get is types, and
 * `checked: false` is how it says so.
 *
 * ## Living with a project that changes underneath
 *
 * A `LanguageService` is incremental, which is the whole reason one is HELD rather than a program
 * built per keystroke: the first question about a package costs seconds and every one after it costs
 * milliseconds. Incremental means it re-reads a file when its version string changes, so the version
 * has to say something true about the file. Ours is the buffer's own counter for the file being
 * edited and the mtime for everything else — which is what makes an agent's edit in another file,
 * or a `git checkout` under the window, show up here without anything having to be invalidated.
 *
 * `node_modules` is the exception, and deliberately: it is thousands of files that do not change
 * while an editor is open, and statting all of them on every keystroke is the difference between a
 * check that feels instant and one that does not.
 */
import { dirname, resolve as resolvePath } from "node:path";
import { statSync } from "node:fs";
import type * as TS from "typescript";
import {
  REFERENCE_FILE_LIMIT,
  type FileCheck,
  type FileDefinitions,
  type FileDiagnostic,
  type FileHover,
  type FileLocation,
  type FileReferences,
  type FileSpan,
} from "@jaira/shared";

/**
 * What {@link AppService} needs from a type checker, and the seam a test replaces.
 *
 * {@link TsCheckers} is the reference implementation and runs in-process; `tsCheck.ts` has the one
 * that puts the same thing behind a worker thread. Declared here, beside the implementation, so
 * neither module has to import the other.
 */
export interface TypeCheckPort {
  check(file: string, text?: string, baseline?: readonly BaselineOverlay[]): Promise<FileCheck>;
  definitions(file: string, at: Caret, text?: string, baseline?: readonly BaselineOverlay[]): Promise<FileDefinitions>;
  references(file: string, at: Caret, text?: string, baseline?: readonly BaselineOverlay[]): Promise<FileReferences>;
  sourceOf(from: string, target: string, baseline?: readonly BaselineOverlay[]): Promise<string | undefined>;
  hover(file: string, at: Caret, text?: string, baseline?: readonly BaselineOverlay[]): Promise<FileHover>;
  release(file: string): Promise<void>;
  close(): Promise<void>;
}

/** A place in a file, 1-based — the way an editor counts and the way a diagnostic reports. */
export interface Caret {
  line: number;
  column: number;
}

/** One file put back the way it was, absolutely addressed — `null` meaning it did not exist. */
export interface BaselineOverlay {
  file: string;
  text: string | null;
}

/**
 * The compiler, loaded once and lazily.
 *
 * A dynamic import for the reason `hw` uses one: `typescript` is CommonJS, this file is bundled into
 * a CJS worker AND run as ESM source under vitest, and the interop only lines up in both when the
 * default export is unwrapped by hand. It is also megabytes, and a window that never opens a `.ts`
 * file should not pay for it.
 */
let compiler: Promise<typeof TS> | undefined;
function typescript(): Promise<typeof TS> {
  compiler ??= import("typescript").then(
    (m) => (m as unknown as { default?: typeof TS }).default ?? (m as unknown as typeof TS),
  );
  return compiler;
}

/**
 * A file this program is told about, and how many times it has changed.
 *
 * `text: null` means the file is NOT THERE — the program should behave as though the disk had
 * nothing at this path, whatever the disk actually has. It exists for the baseline
 * ({@link TsCheckers}): a file the changeset created did not exist at the base revision, and a
 * baseline that let the real one through would be checking the future against the past. An empty
 * string would not do — an empty module resolves and exports nothing, a missing one does not resolve
 * — and the difference is exactly the kind of invented error this whole file exists to stop.
 */
interface OpenFile {
  text: string | null;
  version: number;
}

/**
 * One `tsconfig.json`, and the service that answers for it.
 *
 * Keyed by config file rather than by directory, because that is the unit TypeScript itself works
 * in: two packages in this monorepo are two programs with two sets of options, and a file belongs to
 * whichever config's search found it.
 */
interface Project {
  config: string;
  service: TS.LanguageService;
  /**
   * The config's own file list, by {@link keyOf} key — added to when a file it does not include is
   * asked about. A map rather than a set because the key is not the spelling the compiler wants.
   */
  roots: Map<string, string>;
  options: TS.CompilerOptions;
  /** The mtime of the config when it was read, so an edited `tsconfig.json` rebuilds. */
  configAt: number;
}

/**
 * Every project this process has been asked about, plus the buffers the editor is holding.
 *
 * One instance per process. It is a cache with no eviction on purpose: the number of `tsconfig.json`
 * files a person opens files under in one session is small, and dropping one means paying the
 * seconds-long first build again the next time they click the file they just closed.
 */
export class TsProjects {
  private readonly projects = new Map<string, Project>();
  /** Buffers, by {@link keyOf} key — the spelling that survives a platform's casing rules. */
  private readonly open = new Map<string, OpenFile>();
  /** Config lookups already done, including the misses — `findConfigFile` walks the disk. */
  private readonly configOf = new Map<string, string | undefined>();

  /**
   * What the compiler says about one file, given the text the editor is holding.
   *
   * `text` is the buffer, so the answer follows typing rather than the last save. Everything else in
   * the program still comes off disk, which is the point: this is the file as it would be compiled
   * IN its project, not on its own.
   */
  async check(file: string, text?: string): Promise<FileCheck> {
    const ts = await typescript();
    const path = pathOf(file);
    const key = keyOf(ts, file);
    if (text !== undefined) this.hold(key, text);
    else this.open.delete(key);

    const project = this.projectFor(ts, path);
    if (project === undefined) {
      // No program, so nothing can be said about types — but a parse needs no program, and a missing
      // brace is worth reporting in a file nobody has put in a `tsconfig.json` yet.
      return {
        checked: false,
        reason: `no tsconfig.json covers ${file}`,
        diagnostics: syntaxOnly(ts, path, this.open.get(key)?.text ?? ts.sys.readFile(path)),
      };
    }
    // Asked about a file this program has been told is not there. Nothing is wrong with a file that
    // does not exist, and adding it as a root would make the compiler invent one.
    if (this.open.get(key)?.text === null) {
      return { checked: true, config: project.config, diagnostics: [] };
    }
    // A file the config's own `include` misses — a scratch file beside the sources, or one under a
    // path the project excludes — is still worth checking, and adding it as a root is how TypeScript
    // is told to. Done here rather than at build time so it survives a rebuild of the project. By
    // KEY, so a file the config already listed is not added a second time under another casing.
    if (!project.roots.has(key)) project.roots.set(key, path);

    let raw: readonly TS.Diagnostic[];
    try {
      // Syntax first, because that is the order they are worth reading in: a file that does not parse
      // produces type errors that are artefacts of the parse rather than facts about the code.
      raw = [...project.service.getSyntacticDiagnostics(path), ...project.service.getSemanticDiagnostics(path)];
    } catch (e) {
      // A language service can throw on a program it cannot build — a circular project reference, a
      // config that names a missing `extends`. That is a fact about the project, not a crash: report
      // it as "nothing checked this" rather than taking the call down.
      return { checked: false, reason: messageOf(e), config: project.config, diagnostics: [] };
    }
    return {
      checked: true,
      config: project.config,
      diagnostics: raw.map((d) => toDiagnostic(ts, d, key)),
    };
  }

  /**
   * Where the symbol at `at` is defined.
   *
   * The other half of what a program is for. The buffer is held first for the same reason a check
   * holds it — the caret is in text that may not be saved, and a position means nothing against a
   * different revision of the file.
   *
   * A definition in ANOTHER file is the ordinary case and the whole point: the answer's spans are
   * converted against that file's own source, which the program already has because resolving the
   * import is what put it there.
   */
  async definitions(file: string, at: Caret, text?: string): Promise<FileDefinitions> {
    return this.atCaret<FileDefinitions>(file, at, text, { checked: false, definitions: [] }, (ts, project, program, path, offset) => ({
      checked: true,
      definitions: (project.service.getDefinitionAtPosition(path, offset) ?? []).flatMap((d) =>
        locationOf(ts, program, d.fileName, d.textSpan, d.name),
      ),
    }));
  }

  /**
   * Everywhere the symbol at `at` is used.
   *
   * Bounded by FILES rather than by hits, because the renderer has to hold a text model for each
   * file it is going to preview — see `REFERENCE_FILE_LIMIT`. The truncation is reported rather than
   * hidden: an answer that quietly stops is worse than one that says where it stopped.
   *
   * Ordered as TypeScript gives them, which groups by file, so the cut falls on whole files.
   */
  async references(file: string, at: Caret, text?: string): Promise<FileReferences> {
    return this.atCaret<FileReferences>(file, at, text, { checked: false, references: [] }, (ts, project, program, path, offset) => {
      const found = project.service.getReferencesAtPosition(path, offset) ?? [];
      const references: FileLocation[] = [];
      const files = new Set<string>();
      let truncated = false;
      for (const r of found) {
        const where = keyOf(ts, r.fileName);
        if (!files.has(where)) {
          if (files.size >= REFERENCE_FILE_LIMIT) {
            truncated = true;
            continue;
          }
          files.add(where);
        }
        references.push(...locationOf(ts, program, r.fileName, r.textSpan));
      }
      return { checked: true, references, ...(truncated ? { truncated } : {}) };
    });
  }

  /**
   * What the symbol at `at` IS — the hover.
   *
   * `displayParts` rather than the type printed by hand: it is what TypeScript itself shows, tags
   * and overloads included, and re-deriving it would be a second, worse renderer for a thing the
   * compiler already renders.
   */
  async hover(file: string, at: Caret, text?: string): Promise<FileHover> {
    return this.atCaret<FileHover>(file, at, text, { checked: false }, (ts, project, _program, path, offset) => {
      const info = project.service.getQuickInfoAtPosition(path, offset);
      if (info === undefined) return { checked: true };
      const documentation = ts.displayPartsToString(info.documentation);
      return {
        checked: true,
        info: {
          ...spanOf(ts, project.service.getProgram()?.getSourceFile(path), info.textSpan.start, info.textSpan.length),
          signature: ts.displayPartsToString(info.displayParts),
          ...(documentation.length > 0 ? { documentation } : {}),
        },
      };
    });
  }

  /**
   * The shape every question about a POSITION has, asked once.
   *
   * All three — where is this defined, where is it used, what is it — need the same four things
   * before they can be asked: the compiler, the buffer held so the position means something, a
   * program that covers the file, and a character offset for a line and column. Written out three
   * times, they would have drifted three ways; the interesting part of each is the one line that
   * differs, and that is all `ask` is.
   *
   * `absent` is what to answer when there is no program. It is per-question because "nothing" has a
   * different shape for each, and because `checked: false` has to be said in whichever shape the
   * caller is expecting.
   */
  private async atCaret<T>(
    file: string,
    at: Caret,
    text: string | undefined,
    absent: T,
    ask: (ts: typeof TS, project: Project, program: TS.Program, path: string, offset: number) => T,
  ): Promise<T> {
    const ts = await typescript();
    const path = pathOf(file);
    const key = keyOf(ts, file);
    if (text !== undefined) this.hold(key, text);
    else this.open.delete(key);

    const project = this.projectFor(ts, path);
    // No program, no answer. A parse can find a syntax error by itself; it cannot say where an
    // imported name comes from or what it is, and guessing would send somebody to the wrong file.
    if (project === undefined || this.open.get(key)?.text === null) return absent;
    if (!project.roots.has(key)) project.roots.set(key, path);

    try {
      const program = project.service.getProgram();
      const source = program?.getSourceFile(path);
      if (program === undefined || source === undefined) return absent;
      return ask(ts, project, program, path, ts.getPositionOfLineAndCharacter(source, at.line - 1, at.column - 1));
    } catch {
      // A program that cannot be built is a fact about the project, not a crash.
      return absent;
    }
  }

  /**
   * The text of a file this file's PROGRAM holds — see `SourceFileRequest`.
   *
   * `from` is the file whose program to ask, because a program is what makes the answer safe: a
   * target the compiler never resolved is not there, so a path cannot be fished for. It also makes
   * it free — the text is already in memory, put there by the resolution that produced the
   * definition — so this reads nothing from disk and cannot disagree with what was answered.
   */
  async sourceOf(from: string, target: string): Promise<string | undefined> {
    const ts = await typescript();
    const project = this.projectFor(ts, pathOf(from));
    if (project === undefined) return undefined;
    try {
      return project.service.getProgram()?.getSourceFile(pathOf(target))?.getFullText();
    } catch {
      return undefined;
    }
  }

  /**
   * Drop every program and every buffer.
   *
   * A language service holds a whole program — every source file it resolved, and their ASTs — so a
   * process that is shutting down, or a test that is finishing, should not leave one behind. Safe to
   * call twice, and safe to use again afterwards: the next check simply builds what it needs.
   */
  async close(): Promise<void> {
    for (const project of this.projects.values()) project.service.dispose();
    this.projects.clear();
    this.configOf.clear();
    this.open.clear();
  }

  /** Forget a buffer — the editor closed it, so the file on disk is the truth again. */
  async release(file: string): Promise<void> {
    // Nothing can be held before the compiler has loaded, and loading it to forget something would
    // be the one path that pays megabytes for no answer.
    if (compiler === undefined) return;
    const ts = await typescript();
    this.open.delete(keyOf(ts, file));
  }

  private hold(path: string, text: string | null): void {
    const existing = this.open.get(path);
    if (existing !== undefined && existing.text === text) return;
    this.open.set(path, { text, version: (existing?.version ?? 0) + 1 });
  }

  /**
   * Replace the WHOLE overlay — what makes this program a version of the tree rather than the tree.
   *
   * Every path named is held at the text given (or as an absence, for `null`); every path held
   * before and not named now goes back to whatever is on disk. Both halves matter: a baseline
   * re-seeded for a second changeset must stop pretending about the first one's files.
   *
   * Idempotent, and that is what makes it cheap to call on every check. {@link hold} only moves a
   * version when the text actually moves, so re-seeding the same overlay changes nothing the
   * language service can see — and an incremental service that sees no change does no work.
   */
  async seed(files: readonly { file: string; text: string | null }[]): Promise<void> {
    const ts = await typescript();
    const wanted = new Map(files.map((f) => [keyOf(ts, f.file), f.text] as const));
    for (const key of [...this.open.keys()]) if (!wanted.has(key)) this.open.delete(key);
    for (const [key, text] of wanted) this.hold(key, text);
  }

  /**
   * The project a file belongs to, built on first sight and reused after.
   *
   * The config search is cached per DIRECTORY rather than per file: every file in a package finds
   * the same config, and `findConfigFile` is a walk up the disk that would otherwise run once per
   * keystroke.
   */
  private projectFor(ts: typeof TS, path: string): Project | undefined {
    const dir = dirname(path);
    const at = keyOf(ts, dir);
    let config = this.configOf.get(at);
    if (!this.configOf.has(at)) {
      config = ts.findConfigFile(dir, (f) => ts.sys.fileExists(f));
      this.configOf.set(at, config);
    }
    if (config === undefined) return undefined;
    const key = keyOf(ts, config);
    const held = this.projects.get(key);
    // An edited `tsconfig.json` is a different project: rebuild rather than answer from options the
    // person has just changed. Cheap to detect, and the alternative is a stale `paths` map that makes
    // every alias look unresolvable.
    if (held !== undefined && held.configAt === mtimeOf(config)) return held;
    held?.service.dispose();
    const built = this.build(ts, config);
    this.projects.set(key, built);
    return built;
  }

  private build(ts: typeof TS, config: string): Project {
    const host: TS.ParseConfigFileHost = {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: () => {
        // A config too broken to parse leaves `parsed` undefined, and the fallback below is a
        // program with default options — which is a worse answer than nothing but still an answer.
        // Throwing here would make one malformed `tsconfig.json` break the editor for every file.
      },
      getCurrentDirectory: () => dirname(config),
    };
    const parsed = ts.getParsedCommandLineOfConfigFile(config, {}, host);
    const options: TS.CompilerOptions = {
      ...(parsed?.options ?? {}),
      // The editor never emits, and an emit-shaped complaint ("cannot write file … because it would
      // overwrite an input") is not something a person editing a file should be told about.
      noEmit: true,
      // A composite project answers `getSemanticDiagnostics` out of its own build bookkeeping — a
      // `.tsbuildinfo` that may be stale or missing — instead of from the sources on screen.
      composite: false,
      declaration: false,
      incremental: false,
    };
    const roots = new Map((parsed?.fileNames ?? []).map((f) => [keyOf(ts, f), pathOf(f)] as const));
    return {
      config,
      service: ts.createLanguageService(this.hostFor(ts, config, options, roots), ts.createDocumentRegistry()),
      roots,
      options,
      configAt: mtimeOf(config),
    };
  }

  /**
   * The host: where the service gets its files.
   *
   * Everything except `getScriptVersion` and `getScriptSnapshot` is `ts.sys` verbatim, and that is
   * the whole trick — module resolution, `paths`, `node_modules`, `@types` and the default lib are
   * all TypeScript's own, reading the real disk, so the program is the one `tsc` would build. The
   * two overridden methods are the only place buffers enter.
   */
  private hostFor(
    ts: typeof TS,
    config: string,
    options: TS.CompilerOptions,
    roots: Map<string, string>,
  ): TS.LanguageServiceHost {
    const base = dirname(config);
    return {
      // Minus whatever the overlay says is not there: a root the program cannot read is a root it
      // reports as missing, which is a diagnostic about the fixture rather than about the code.
      getScriptFileNames: () => [...roots].flatMap(([key, path]) => (this.open.get(key)?.text === null ? [] : [path])),
      getScriptVersion: (file) => {
        const held = this.open.get(keyOf(ts, file));
        return held === undefined ? `d${stamp(file)}` : `b${held.version}`;
      },
      getScriptSnapshot: (file) => {
        const held = this.open.get(keyOf(ts, file));
        if (held !== undefined) return held.text === null ? undefined : ts.ScriptSnapshot.fromString(held.text);
        const text = ts.sys.readFile(file);
        return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
      },
      getCurrentDirectory: () => base,
      getCompilationSettings: () => options,
      getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
      // An overlay OVERRIDES the disk in both directions: a file held as text exists even where the
      // disk has none (a deletion, seen from the baseline), and a file held as an absence does not
      // exist even where the disk has one (a creation, seen from the baseline). Falling through to
      // `ts.sys` in the second case is what would let a created file resolve at a revision that
      // never had it.
      fileExists: (f) => {
        const held = this.open.get(keyOf(ts, f));
        return held === undefined ? ts.sys.fileExists(f) : held.text !== null;
      },
      readFile: (f, encoding) => {
        const held = this.open.get(keyOf(ts, f));
        if (held !== undefined) return held.text ?? undefined;
        return ts.sys.readFile(f, encoding);
      },
      readDirectory: (d, extensions, exclude, include, depth) =>
        ts.sys.readDirectory(d, extensions, exclude, include, depth),
      directoryExists: (d) => ts.sys.directoryExists(d),
      getDirectories: (d) => ts.sys.getDirectories(d),
      realpath: ts.sys.realpath?.bind(ts.sys),
      useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    };
  }
}

/**
 * A file's version stamp.
 *
 * The mtime for a project's own sources, so an edit made outside this window — an agent's, a branch
 * switch — is picked up on the next check with nothing to invalidate. A CONSTANT for anything under
 * `node_modules`, because a program this size resolves thousands of declaration files and statting
 * all of them on every keystroke costs more than the check itself. Installing a package while the
 * editor is open is the case that misses, and reopening the window is its fix.
 */
function stamp(file: string): number {
  if (file.includes("node_modules")) return 0;
  return mtimeOf(file);
}

function mtimeOf(file: string): number {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return -1;
  }
}

/**
 * The path itself, in the spelling TypeScript uses: absolute, forward slashes, casing UNTOUCHED.
 *
 * The casing is the part that had to be learned. Lower-casing a path on Windows looks harmless and
 * is not: TypeScript compares file names for identity, so handing it `…/renderer/editorlook.ts`
 * while its own directory walk found `…/renderer/editorLook.ts` makes it believe there are two
 * files, and it says so — "File name … differs from already included file name … only in casing",
 * four times, about a file with nothing wrong with it. The whole point here is to stop inventing
 * errors, so the path given to the compiler is the path.
 */
function pathOf(file: string): string {
  return resolvePath(file).split("\\").join("/");
}

/**
 * The same path as a MAP KEY — where case-insensitivity belongs, and nowhere else.
 *
 * The renderer sends `C:\…` and the compiler hands back `c:/…` for the same file, so a buffer filed
 * under one would never be found under the other; that shows up as the editor checking the file on
 * disk while somebody types. TypeScript's own rule for the platform, so the keys agree with it.
 */
function keyOf(ts: typeof TS, file: string): string {
  const path = pathOf(file);
  return ts.sys.useCaseSensitiveFileNames ? path : path.toLowerCase();
}

/**
 * What a file says about itself, with no project behind it.
 *
 * A parse resolves nothing and needs nothing: `noResolve` and `noLib` mean this program is the one
 * file, so it costs a parse and reports exactly the errors a parse can find. It is what a `.ts` file
 * outside every `tsconfig.json` gets — a workflow's function file in `~/.jaira`, a scratch file
 * beside a repository — instead of the nothing it would get from a program that does not exist.
 *
 * The SCRIPT KIND comes from the extension, which is what makes a `.tsx` file parse as one; getting
 * that wrong would report every JSX tag in it as a syntax error, which is one of the two bugs this
 * whole file exists to stop.
 */
function syntaxOnly(ts: typeof TS, file: string, text: string | undefined): FileDiagnostic[] {
  if (text === undefined) return [];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, scriptKindOf(ts, file));
  const host: TS.CompilerHost = {
    getSourceFile: (name) => (name === file ? source : undefined),
    writeFile: () => {},
    getDefaultLibFileName: () => "lib.d.ts",
    getCurrentDirectory: () => dirname(file),
    getCanonicalFileName: (name) => (ts.sys.useCaseSensitiveFileNames ? name : name.toLowerCase()),
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    getNewLine: () => "\n",
    fileExists: (name) => name === file,
    readFile: (name) => (name === file ? text : undefined),
  };
  const program = ts.createProgram([file], { noResolve: true, noLib: true, allowJs: true }, host);
  const found = program.getSourceFile(file);
  if (found === undefined) return [];
  return program.getSyntacticDiagnostics(found).map((d) => toDiagnostic(ts, d, keyOf(ts, file)));
}

/** TypeScript's own rule, by extension — the thing a `.tsx` file needs and a language id cannot say. */
function scriptKindOf(ts: typeof TS, file: string): TS.ScriptKind {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (file.endsWith(".js") || file.endsWith(".mjs") || file.endsWith(".cjs")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/**
 * One of TypeScript's spans, as a place the renderer can go to.
 *
 * A span is measured against the file it is IN, which is why the program is needed rather than just
 * the name: a definition three files away has line and column numbers that only mean anything
 * against that file's own text. A file the program does not hold is dropped rather than measured
 * against the wrong one — it should not happen, since resolving an import is what puts a file in a
 * program, and a wrong line number is worse than a missing entry.
 */
function locationOf(
  ts: typeof TS,
  program: TS.Program,
  fileName: string,
  span: TS.TextSpan,
  name?: string,
): FileLocation[] {
  const target = program.getSourceFile(fileName);
  if (target === undefined) return [];
  return [
    {
      ...spanOf(ts, target, span.start, span.length),
      file: pathOf(fileName),
      ...(name !== undefined && name.length > 0 ? { name } : {}),
    },
  ];
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** TypeScript's diagnostic, in the 1-based line/column an editor counts in. */
function toDiagnostic(ts: typeof TS, d: TS.Diagnostic, subject: string): FileDiagnostic {
  const related = (d.relatedInformation ?? []).flatMap((r) =>
    r.file === undefined
      ? []
      : [
          {
            ...spanOf(ts, r.file, r.start, r.length),
            file: r.file.fileName,
            message: ts.flattenDiagnosticMessageText(r.messageText, "\n"),
          },
        ],
  );
  const where = d.file === undefined ? undefined : keyOf(ts, d.file.fileName);
  return {
    ...spanOf(ts, d.file, d.start, d.length),
    severity: severityOf(ts, d.category),
    code: d.code,
    message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
    // Only when it is somewhere ELSE: the common case is the file that was asked about, and saying
    // so on every diagnostic would make the renderer decide something it does not need to.
    ...(d.file !== undefined && where !== subject ? { file: d.file.fileName } : {}),
    ...(related.length > 0 ? { related } : {}),
  };
}

function spanOf(ts: typeof TS, file: TS.SourceFile | undefined, start?: number, length?: number): FileSpan {
  // A diagnostic with no position is about the PROGRAM rather than a place in it — a bad option, a
  // missing lib. Anchored at the first character so it is still visible, rather than dropped.
  if (file === undefined || start === undefined) return { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 };
  const from = ts.getLineAndCharacterOfPosition(file, start);
  const to = ts.getLineAndCharacterOfPosition(file, start + (length ?? 0));
  return {
    startLine: from.line + 1,
    startColumn: from.character + 1,
    endLine: to.line + 1,
    endColumn: to.character + 1,
  };
}

function severityOf(ts: typeof TS, category: TS.DiagnosticCategory): FileDiagnostic["severity"] {
  switch (category) {
    case ts.DiagnosticCategory.Error:
      return "error";
    case ts.DiagnosticCategory.Warning:
      return "warning";
    default:
      return "info";
  }
}

/**
 * The two programs a review needs, and the rule for which question goes to which.
 *
 * A diff has two sides and they are compiled in two different trees. The right-hand side is on a
 * disk — a worktree holds every changed file at its proposed content — so it is the ordinary case
 * and goes to {@link live}, which is also what the Files editor uses. The left-hand side is a git
 * revision, and nothing holds a tree at that revision.
 *
 * It does not need one, and that is the whole trick: a base revision differs from the worktree in
 * exactly the files the changeset touches, so a second program with those files PUT BACK is the base
 * revision, for every purpose a type-checker has. Everything else is read off the same disk.
 *
 * ## Why two instances rather than one
 *
 * Because a program holds one text per file, and these two need different texts for the same file at
 * the same time — the before on the left, the after on the right. One instance would have to re-seed
 * and re-check on every switch, which is the incremental service's worst case (every dependent file
 * invalidated, twice per glance) and would also make the two sides' answers depend on which was
 * asked for last.
 *
 * The baseline is built on first sight of a `baseline` argument and there is only ever one. A window
 * reviews one changeset at a time, and re-seeding it for the next one is cheaper than rebuilding: the
 * files that did not change between the two changesets keep their place in the program.
 */
export class TsCheckers implements TypeCheckPort {
  private readonly live = new TsProjects();
  private past: TsProjects | undefined;

  async check(file: string, text?: string, baseline?: readonly BaselineOverlay[]): Promise<FileCheck> {
    const check = await (await this.programFor(baseline)).check(file, text);
    return baseline === undefined ? check : { ...check, baseline: true };
  }

  /**
   * Where a symbol is defined, in whichever of the two trees the question was asked about.
   *
   * The base side gets its own program for the same reason its diagnostics do: a name in the
   * before-text may have come from a file the changeset has since deleted, and following it into the
   * worktree would land on whatever is at that path now.
   */
  async definitions(
    file: string,
    at: Caret,
    text?: string,
    baseline?: readonly BaselineOverlay[],
  ): Promise<FileDefinitions> {
    return (await this.programFor(baseline)).definitions(file, at, text);
  }

  /** Everywhere a symbol is used, in whichever of the two trees was asked about. */
  async references(
    file: string,
    at: Caret,
    text?: string,
    baseline?: readonly BaselineOverlay[],
  ): Promise<FileReferences> {
    return (await this.programFor(baseline)).references(file, at, text);
  }

  /** What a symbol is, in whichever of the two trees was asked about. */
  async hover(file: string, at: Caret, text?: string, baseline?: readonly BaselineOverlay[]): Promise<FileHover> {
    return (await this.programFor(baseline)).hover(file, at, text);
  }

  /** The live program, or the baseline seeded with these files — see the note on the class. */
  private async programFor(baseline?: readonly BaselineOverlay[]): Promise<TsProjects> {
    if (baseline === undefined) return this.live;
    this.past ??= new TsProjects();
    await this.past.seed(baseline);
    return this.past;
  }

  /** A resolved file's text, out of whichever of the two programs was asked about. */
  async sourceOf(from: string, target: string, baseline?: readonly BaselineOverlay[]): Promise<string | undefined> {
    return (await this.programFor(baseline)).sourceOf(from, target);
  }

  /** Only the live program holds an editor's buffer; the baseline's overlay is the changeset's. */
  release(file: string): Promise<void> {
    return this.live.release(file);
  }

  async close(): Promise<void> {
    await this.live.close();
    await this.past?.close();
    this.past = undefined;
  }
}
