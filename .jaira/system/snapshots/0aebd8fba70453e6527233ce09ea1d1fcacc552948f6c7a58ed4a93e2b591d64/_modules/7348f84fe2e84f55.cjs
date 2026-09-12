"use strict";
/**
 * Render a prompt template against the values a CALL SITE hands it.
 *
 * The engine has its own `{{…}}` renderer (`hw`'s `engine.ts`, `renderTemplate`) and this is
 * deliberately not a second copy of it. Two differences, and both are the reason this exists:
 *
 *  - **The scope is what you pass, and nothing else.** The engine builds a template's scope from the
 *    whole instance — `.inputs.*` shadowed by the operation's inputs, plus `.children.*`, `.run.*`,
 *    `.artifacts.*`. That silently welds every prompt file to the shape of the one state that owns
 *    it. Here the scope is the second argument, so a template is reusable by anything willing to
 *    supply its holes, and what it needs is written at every call site rather than inferred.
 *  - **A hole nobody supplies is an ERROR.** The engine's renderer is total: `{{.inputs.typo}}` is a
 *    well-formed path that resolves to nothing and renders as `""`. Nothing in the loader, the
 *    validator or JaiRA's lint surface looks at a `{{…}}` hole, so a prompt could lose a whole
 *    section — the findings it was supposed to act on — and the run would report success. That is
 *    the failure this function exists to convert into a stopped run.
 *
 * ## How it reaches a workflow
 *
 * `export default` means the symbol is the FILENAME STEM (`moduleExports.ts`: "export default
 * function () {} → symbol <filename>"), so the call is `renderTemplate(…)` with no prefix:
 *
 * ```jsonc
 * { "when": ".children.gate.output.decision === 'revise'", "to": "draft",
 *   "inputs": {
 *     "prompt": "renderTemplate($/prompts/feature/product/turns/override.md, { comments: .children.gate.output.comments })"
 *   } }
 * ```
 *
 * The first argument is a `.md` REFERENCE, not a path string: a bare name is a document and "a `.md`
 * is text", so the file is resolved and inlined while the workflow LOADS. Three things follow from
 * that and each is worth having — a renamed or missing prompt is a reference error before the run
 * starts rather than an empty prompt during it; the text is copied into the task's snapshot, so
 * editing a prompt cannot change what an already-started task is running; and this function never
 * touches the filesystem, which is what keeps it pure.
 *
 * The cost is that it does not know the file's name, so a diagnostic quotes the template's opening
 * line instead. In practice that identifies it — a turn file starts with its heading.
 *
 * ## Why the holes are still spelled `{{.inputs.x}}`
 *
 * A template's holes ARE its parameters, and the 29 prompt files already in `$/prompts` are written
 * that way. Keeping the spelling means a file moves under this renderer by gaining a call site, not
 * by being edited. `{{.children.…}}` and `{{.run.…}}` are refused rather than rendered empty: under
 * a scope that is only what was passed, they cannot mean anything, and quietly rendering nothing is
 * the exact failure mode this replaces.
 *
 * Nothing reaches this but its parameters (SPEC §7.5.6) — no run context, no session, no ambient
 * anything. It is pure, and total except where it is deliberately not: it throws, and the registry
 * entry classifies the throw as an error VALUE, so the consuming slot's declared type decides
 * whether the run stops. A `prompt` slot typed as a string refuses an error, which is precisely the
 * "stop rather than send a prompt with a section missing" behaviour.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = renderTemplate;
/**
 * The hole grammar, character-for-character the engine's `TEMPLATE_REF`.
 *
 * Copied rather than approximated on purpose: two renderers that disagree about what a hole IS would
 * disagree about which files are affected by a change to either, and the whole point of this
 * function is to be the strict reading of the SAME language.
 */
const TEMPLATE_REF = /\{\{\s*(\.?[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*)\s*\}\}/g;
/** The one root a rendered template can read. Everything else is out of scope by construction. */
const ROOT = ".inputs.";
/** Enough of the template to identify it in a diagnostic, since the file's name did not survive. */
function opening(template) {
    const line = template.split("\n").find((l) => l.trim().length > 0)?.trim() ?? "";
    return line.length > 72 ? `${line.slice(0, 69)}...` : line;
}
/** Every hole in the template, in source order, deduplicated. */
function holesOf(template) {
    const seen = new Set();
    for (const match of template.matchAll(TEMPLATE_REF))
        seen.add(match[1]);
    return [...seen];
}
/**
 * Walk a dotted path into a value. Stops at the first step that is not an object.
 *
 * The TOP-LEVEL key is checked by the caller and is an error when absent — that is the wiring
 * mistake. A deeper step that misses is ordinary optional data inside a structure the call site did
 * supply, so it renders empty rather than stopping the run.
 */
function walk(value, path) {
    let current = value;
    for (const step of path) {
        if (current === null || current === undefined || typeof current !== "object")
            return undefined;
        current = current[step];
    }
    return current;
}
/**
 * How a value becomes text — the engine's own rules, so a template reads the same under both.
 *
 * Absent renders as empty, which is what makes an OPTIONAL hole work: a call site that supplies
 * `framing` as nothing (the catalog answered the framing question, so the exploration never ran)
 * gets a blank section rather than a stopped run. The key still has to be supplied; it is the value
 * that may be missing.
 */
function render(value) {
    if (value === undefined || value === null)
        return "";
    if (typeof value === "object")
        return JSON.stringify(value);
    return String(value);
}
/**
 * Render `template`, filling each `{{.inputs.x}}` from `values`.
 *
 * @param template The template text. In a workflow this is a `.md` reference, inlined at load.
 * @param values The scope, as an object literal at the call site. Its keys are the template's
 *   parameters: every hole must name one, and every one must be named by a hole.
 * @returns The rendered text, ready to be appended to a conversation as one turn.
 * @throws When a hole names no supplied key, when a supplied key is read by no hole, or when a hole
 *   is spelled in a way a hermetic scope cannot answer.
 */
function renderTemplate(template, values = {}) {
    if (typeof template !== "string") {
        throw new TypeError("renderTemplate: the first argument must be template TEXT. A bare `$/prompts/....md` reference " +
            "resolves to its text; a quoted string resolves to itself and is almost never what was meant.");
    }
    const where = `renderTemplate("${opening(template)}")`;
    const supplied = new Set(Object.keys(values));
    const read = new Set();
    for (const hole of holesOf(template)) {
        // The missing-dot trap, called out by name because it is the one that renders as literal text
        // rather than as nothing: `{{inputs.x}}` is not a runtime reference, so the engine leaves the
        // braces in the prompt and a model is asked to interpret them.
        if (!hole.startsWith(".")) {
            throw new Error(`${where}: the hole {{${hole}}} has no leading dot, so it names a DOCUMENT rather than data. ` +
                `Write {{.${hole}}}.`);
        }
        if (!hole.startsWith(ROOT)) {
            throw new Error(`${where}: the hole {{${hole}}} reads outside the values it was handed. A rendered template ` +
                `sees only its own parameters — pass what it needs at the call site, e.g. ` +
                `{ iteration: .run.iteration }, and read it as {{.inputs.iteration}}.`);
        }
        const path = hole.slice(ROOT.length).split(".");
        const key = path[0];
        if (!supplied.has(key)) {
            const offered = supplied.size === 0 ? "nothing" : [...supplied].sort().join(", ");
            throw new Error(`${where}: the hole {{${hole}}} names \`${key}\`, which this call does not supply. Supplied: ${offered}.`);
        }
        read.add(key);
    }
    // The other direction. A key nothing reads is wiring that computes a value and throws it away —
    // usually a template edited out from under its call sites, or a renamed hole. It costs whatever
    // produced the value, and it is silent, so it is an error rather than a warning.
    const unread = [...supplied].filter((key) => !read.has(key)).sort();
    if (unread.length > 0) {
        throw new Error(`${where}: supplied ${unread.length === 1 ? "a value" : "values"} no hole reads — ` +
            `${unread.join(", ")}. Either the template lost the hole or the call site named it wrongly.`);
    }
    return template.replace(TEMPLATE_REF, (_match, hole) => render(walk(values, hole.slice(ROOT.length).split("."))));
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicmVuZGVyVGVtcGxhdGUuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJyZW5kZXJUZW1wbGF0ZS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiO0FBQUE7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7R0FvREc7O0FBbUVILGlDQXFEQztBQXRIRDs7Ozs7O0dBTUc7QUFDSCxNQUFNLFlBQVksR0FBRyw2RUFBNkUsQ0FBQztBQUVuRyxrR0FBa0c7QUFDbEcsTUFBTSxJQUFJLEdBQUcsVUFBVSxDQUFDO0FBRXhCLG9HQUFvRztBQUNwRyxTQUFTLE9BQU8sQ0FBQyxRQUFnQjtJQUMvQixNQUFNLElBQUksR0FBRyxRQUFRLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsRUFBRSxFQUFFLENBQUMsQ0FBQyxDQUFDLElBQUksRUFBRSxDQUFDLE1BQU0sR0FBRyxDQUFDLENBQUMsRUFBRSxJQUFJLEVBQUUsSUFBSSxFQUFFLENBQUM7SUFDakYsT0FBTyxJQUFJLENBQUMsTUFBTSxHQUFHLEVBQUUsQ0FBQyxDQUFDLENBQUMsR0FBRyxJQUFJLENBQUMsS0FBSyxDQUFDLENBQUMsRUFBRSxFQUFFLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUM7QUFDN0QsQ0FBQztBQUVELGlFQUFpRTtBQUNqRSxTQUFTLE9BQU8sQ0FBQyxRQUFnQjtJQUMvQixNQUFNLElBQUksR0FBRyxJQUFJLEdBQUcsRUFBVSxDQUFDO0lBQy9CLEtBQUssTUFBTSxLQUFLLElBQUksUUFBUSxDQUFDLFFBQVEsQ0FBQyxZQUFZLENBQUM7UUFBRSxJQUFJLENBQUMsR0FBRyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQVcsQ0FBQyxDQUFDO0lBQ2xGLE9BQU8sQ0FBQyxHQUFHLElBQUksQ0FBQyxDQUFDO0FBQ25CLENBQUM7QUFFRDs7Ozs7O0dBTUc7QUFDSCxTQUFTLElBQUksQ0FBQyxLQUFj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Q0FBQyxDQUFDLE1BQU0sQ0FBQyxDQUFDLEdBQUcsRUFBRSxFQUFFLENBQUMsQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsSUFBSSxFQUFFLENBQUM7SUFDcEUsSUFBSSxNQUFNLENBQUMsTUFBTSxHQUFHLENBQUMsRUFBRSxDQUFDO1FBQ3RCLE1BQU0sSUFBSSxLQUFLLENBQ2IsR0FBRyxLQUFLLGNBQWMsTUFBTSxDQUFDLE1BQU0sS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLFNBQVMsQ0FBQyxDQUFDLENBQUMsUUFBUSxtQkFBbUI7WUFDakYsR0FBRyxNQUFNLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyx3RUFBd0UsQ0FDL0YsQ0FBQztJQUNKLENBQUM7SUFFRCxPQUFPLFFBQVEsQ0FBQyxPQUFPLENBQUMsWUFBWSxFQUFFLENBQUMsTUFBTSxFQUFFLElBQVksRUFBRSxFQUFFLENBQzdELE1BQU0sQ0FBQyxJQUFJLENBQUMsTUFBTSxFQUFFLElBQUksQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQ3pELENBQUM7QUFDSixDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBSZW5kZXIgYSBwcm9tcHQgdGVtcGxhdGUgYWdhaW5zdCB0aGUgdmFsdWVzIGEgQ0FMTCBTSVRFIGhhbmRzIGl0LlxuICpcbiAqIFRoZSBlbmdpbmUgaGFzIGl0cyBvd24gYHt74oCmfX1gIHJlbmRlcmVyIChgaHdgJ3MgYGVuZ2luZS50c2AsIGByZW5kZXJUZW1wbGF0ZWApIGFuZCB0aGlzIGlzXG4gKiBkZWxpYmVyYXRlbHkgbm90IGEgc2Vjb25kIGNvcHkgb2YgaXQuIFR3byBkaWZmZXJlbmNlcywgYW5kIGJvdGggYXJlIHRoZSByZWFzb24gdGhpcyBleGlzdHM6XG4gKlxuICogIC0gKipUaGUgc2NvcGUgaXMgd2hhdCB5b3UgcGFzcywgYW5kIG5vdGhpbmcgZWxzZS4qKiBUaGUgZW5naW5lIGJ1aWxkcyBhIHRlbXBsYXRlJ3Mgc2NvcGUgZnJvbSB0aGVcbiAqICAgIHdob2xlIGluc3RhbmNlIOKAlCBgLmlucHV0cy4qYCBzaGFkb3dlZCBieSB0aGUgb3BlcmF0aW9uJ3MgaW5wdXRzLCBwbHVzIGAuY2hpbGRyZW4uKmAsIGAucnVuLipgLFxuICogICAgYC5hcnRpZmFjdHMuKmAuIFRoYXQgc2lsZW50bHkgd2VsZHMgZXZlcnkgcHJvbXB0IGZpbGUgdG8gdGhlIHNoYXBlIG9mIHRoZSBvbmUgc3RhdGUgdGhhdCBvd25zXG4gKiAgICBpdC4gSGVyZSB0aGUgc2NvcGUgaXMgdGhlIHNlY29uZCBhcmd1bWVudCwgc28gYSB0ZW1wbGF0ZSBpcyByZXVzYWJsZSBieSBhbnl0aGluZyB3aWxsaW5nIHRvXG4gKiAgICBzdXBwbHkgaXRzIGhvbGVzLCBhbmQgd2hhdCBpdCBuZWVkcyBpcyB3cml0dGVuIGF0IGV2ZXJ5IGNhbGwgc2l0ZSByYXRoZXIgdGhhbiBpbmZlcnJlZC5cbiAqICAtICoqQSBob2xlIG5vYm9keSBzdXBwbGllcyBpcyBhbiBFUlJPUi4qKiBUaGUgZW5naW5lJ3MgcmVuZGVyZXIgaXMgdG90YWw6IGB7ey5pbnB1dHMudHlwb319YCBpcyBhXG4gKiAgICB3ZWxsLWZvcm1lZCBwYXRoIHRoYXQgcmVzb2x2ZXMgdG8gbm90aGluZyBhbmQgcmVuZGVycyBhcyBgXCJcImAuIE5vdGhpbmcgaW4gdGhlIGxvYWRlciwgdGhlXG4gKiAgICB2YWxpZGF0b3Igb3IgSmFpUkEncyBsaW50IHN1cmZhY2UgbG9va3MgYXQgYSBge3vigKZ9fWAgaG9sZSwgc28gYSBwcm9tcHQgY291bGQgbG9zZSBhIHdob2xlXG4gKiAgICBzZWN0aW9uIOKAlCB0aGUgZmluZGluZ3MgaXQgd2FzIHN1cHBvc2VkIHRvIGFjdCBvbiDigJQgYW5kIHRoZSBydW4gd291bGQgcmVwb3J0IHN1Y2Nlc3MuIFRoYXQgaXNcbiAqICAgIHRoZSBmYWlsdXJlIHRoaXMgZnVuY3Rpb24gZXhpc3RzIHRvIGNvbnZlcnQgaW50byBhIHN0b3BwZWQgcnVuLlxuICpcbiAqICMjIEhvdyBpdCByZWFjaGVzIGEgd29ya2Zsb3dcbiAqXG4gKiBgZXhwb3J0IGRlZmF1bHRgIG1lYW5zIHRoZSBzeW1ib2wgaXMgdGhlIEZJTEVOQU1FIFNURU0gKGBtb2R1bGVFeHBvcnRzLnRzYDogXCJleHBvcnQgZGVmYXVsdFxuICogZnVuY3Rpb24gKCkge30g4oaSIHN5bWJvbCA8ZmlsZW5hbWU+XCIpLCBzbyB0aGUgY2FsbCBpcyBgcmVuZGVyVGVtcGxhdGUo4oCmKWAgd2l0aCBubyBwcmVmaXg6XG4gKlxuICogYGBganNvbmNcbiAqIHsgXCJ3aGVuXCI6IFwiLmNoaWxkcmVuLmdhdGUub3V0cHV0LmRlY2lzaW9uID09PSAncmV2aXNlJ1wiLCBcInRvXCI6IFwiZHJhZnRcIixcbiAqICAgXCJpbnB1dHNcIjoge1xuICogICAgIFwicHJvbXB0XCI6IFwicmVuZGVyVGVtcGxhdGUoJC9wcm9tcHRzL2ZlYXR1cmUvcHJvZHVjdC90dXJucy9vdmVycmlkZS5tZCwgeyBjb21tZW50czogLmNoaWxkcmVuLmdhdGUub3V0cHV0LmNvbW1lbnRzIH0pXCJcbiAqICAgfSB9XG4gKiBgYGBcbiAqXG4gKiBUaGUgZmlyc3QgYXJndW1lbnQgaXMgYSBgLm1kYCBSRUZFUkVOQ0UsIG5vdCBhIHBhdGggc3RyaW5nOiBhIGJhcmUgbmFtZSBpcyBhIGRvY3VtZW50IGFuZCBcImEgYC5tZGBcbiAqIGlzIHRleHRcIiwgc28gdGhlIGZpbGUgaXMgcmVzb2x2ZWQgYW5kIGlubGluZWQgd2hpbGUgdGhlIHdvcmtmbG93IExPQURTLiBUaHJlZSB0aGluZ3MgZm9sbG93IGZyb21cbiAqIHRoYXQgYW5kIGVhY2ggaXMgd29ydGggaGF2aW5nIOKAlCBhIHJlbmFtZWQgb3IgbWlzc2luZyBwcm9tcHQgaXMgYSByZWZlcmVuY2UgZXJyb3IgYmVmb3JlIHRoZSBydW5cbiAqIHN0YXJ0cyByYXRoZXIgdGhhbiBhbiBlbXB0eSBwcm9tcHQgZHVyaW5nIGl0OyB0aGUgdGV4dCBpcyBjb3BpZWQgaW50byB0aGUgdGFzaydzIHNuYXBzaG90LCBzb1xuICogZWRpdGluZyBhIHByb21wdCBjYW5ub3QgY2hhbmdlIHdoYXQgYW4gYWxyZWFkeS1zdGFydGVkIHRhc2sgaXMgcnVubmluZzsgYW5kIHRoaXMgZnVuY3Rpb24gbmV2ZXJcbiAqIHRvdWNoZXMgdGhlIGZpbGVzeXN0ZW0sIHdoaWNoIGlzIHdoYXQga2VlcHMgaXQgcHVyZS5cbiAqXG4gKiBUaGUgY29zdCBpcyB0aGF0IGl0IGRvZXMgbm90IGtub3cgdGhlIGZpbGUncyBuYW1lLCBzbyBhIGRpYWdub3N0aWMgcXVvdGVzIHRoZSB0ZW1wbGF0ZSdzIG9wZW5pbmdcbiAqIGxpbmUgaW5zdGVhZC4gSW4gcHJhY3RpY2UgdGhhdCBpZGVudGlmaWVzIGl0IOKAlCBhIHR1cm4gZmlsZSBzdGFydHMgd2l0aCBpdHMgaGVhZGluZy5cbiAqXG4gKiAjIyBXaHkgdGhlIGhvbGVzIGFyZSBzdGlsbCBzcGVsbGVkIGB7ey5pbnB1dHMueH19YFxuICpcbiAqIEEgdGVtcGxhdGUncyBob2xlcyBBUkUgaXRzIHBhcmFtZXRlcnMsIGFuZCB0aGUgMjkgcHJvbXB0IGZpbGVzIGFscmVhZHkgaW4gYCQvcHJvbXB0c2AgYXJlIHdyaXR0ZW5cbiAqIHRoYXQgd2F5LiBLZWVwaW5nIHRoZSBzcGVsbGluZyBtZWFucyBhIGZpbGUgbW92ZXMgdW5kZXIgdGhpcyByZW5kZXJlciBieSBnYWluaW5nIGEgY2FsbCBzaXRlLCBub3RcbiAqIGJ5IGJlaW5nIGVkaXRlZC4gYHt7LmNoaWxkcmVuLuKApn19YCBhbmQgYHt7LnJ1bi7igKZ9fWAgYXJlIHJlZnVzZWQgcmF0aGVyIHRoYW4gcmVuZGVyZWQgZW1wdHk6IHVuZGVyXG4gKiBhIHNjb3BlIHRoYXQgaXMgb25seSB3aGF0IHdhcyBwYXNzZWQsIHRoZXkgY2Fubm90IG1lYW4gYW55dGhpbmcsIGFuZCBxdWlldGx5IHJlbmRlcmluZyBub3RoaW5nIGlzXG4gKiB0aGUgZXhhY3QgZmFpbHVyZSBtb2RlIHRoaXMgcmVwbGFjZXMuXG4gKlxuICogTm90aGluZyByZWFjaGVzIHRoaXMgYnV0IGl0cyBwYXJhbWV0ZXJzIChTUEVDIMKnNy41LjYpIOKAlCBubyBydW4gY29udGV4dCwgbm8gc2Vzc2lvbiwgbm8gYW1iaWVudFxuICogYW55dGhpbmcuIEl0IGlzIHB1cmUsIGFuZCB0b3RhbCBleGNlcHQgd2hlcmUgaXQgaXMgZGVsaWJlcmF0ZWx5IG5vdDogaXQgdGhyb3dzLCBhbmQgdGhlIHJlZ2lzdHJ5XG4gKiBlbnRyeSBjbGFzc2lmaWVzIHRoZSB0aHJvdyBhcyBhbiBlcnJvciBWQUxVRSwgc28gdGhlIGNvbnN1bWluZyBzbG90J3MgZGVjbGFyZWQgdHlwZSBkZWNpZGVzXG4gKiB3aGV0aGVyIHRoZSBydW4gc3RvcHMuIEEgYHByb21wdGAgc2xvdCB0eXBlZCBhcyBhIHN0cmluZyByZWZ1c2VzIGFuIGVycm9yLCB3aGljaCBpcyBwcmVjaXNlbHkgdGhlXG4gKiBcInN0b3AgcmF0aGVyIHRoYW4gc2VuZCBhIHByb21wdCB3aXRoIGEgc2VjdGlvbiBtaXNzaW5nXCIgYmVoYXZpb3VyLlxuICovXG5cbi8qKlxuICogVGhlIGhvbGUgZ3JhbW1hciwgY2hhcmFjdGVyLWZvci1jaGFyYWN0ZXIgdGhlIGVuZ2luZSdzIGBURU1QTEFURV9SRUZgLlxuICpcbiAqIENvcGllZCByYXRoZXIgdGhhbiBhcHByb3hpbWF0ZWQgb24gcHVycG9zZTogdHdvIHJlbmRlcmVycyB0aGF0IGRpc2FncmVlIGFib3V0IHdoYXQgYSBob2xlIElTIHdvdWxkXG4gKiBkaXNhZ3JlZSBhYm91dCB3aGljaCBmaWxlcyBhcmUgYWZmZWN0ZWQgYnkgYSBjaGFuZ2UgdG8gZWl0aGVyLCBhbmQgdGhlIHdob2xlIHBvaW50IG9mIHRoaXNcbiAqIGZ1bmN0aW9uIGlzIHRvIGJlIHRoZSBzdHJpY3QgcmVhZGluZyBvZiB0aGUgU0FNRSBsYW5ndWFnZS5cbiAqL1xuY29uc3QgVEVNUExBVEVfUkVGID0gL1xce1xce1xccyooXFwuP1tBLVphLXpfJF1bQS1aYS16MC05XyRdKig/OlxcLltBLVphLXpfJF1bQS1aYS16MC05XyRdKikqKVxccypcXH1cXH0vZztcblxuLyoqIFRoZSBvbmUgcm9vdCBhIHJlbmRlcmVkIHRlbXBsYXRlIGNhbiByZWFkLiBFdmVyeXRoaW5nIGVsc2UgaXMgb3V0IG9mIHNjb3BlIGJ5IGNvbnN0cnVjdGlvbi4gKi9cbmNvbnN0IFJPT1QgPSBcIi5pbnB1dHMuXCI7XG5cbi8qKiBFbm91Z2ggb2YgdGhlIHRlbXBsYXRlIHRvIGlkZW50aWZ5IGl0IGluIGEgZGlhZ25vc3RpYywgc2luY2UgdGhlIGZpbGUncyBuYW1lIGRpZCBub3Qgc3Vydml2ZS4gKi9cbmZ1bmN0aW9uIG9wZW5pbmcodGVtcGxhdGU6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IGxpbmUgPSB0ZW1wbGF0ZS5zcGxpdChcIlxcblwiKS5maW5kKChsKSA9PiBsLnRyaW0oKS5sZW5ndGggPiAwKT8udHJpbSgpID8/IFwiXCI7XG4gIHJldHVybiBsaW5lLmxlbmd0aCA+IDcyID8gYCR7bGluZS5zbGljZSgwLCA2OSl9Li4uYCA6IGxpbmU7XG59XG5cbi8qKiBFdmVyeSBob2xlIGluIHRoZSB0ZW1wbGF0ZSwgaW4gc291cmNlIG9yZGVyLCBkZWR1cGxpY2F0ZWQuICovXG5mdW5jdGlvbiBob2xlc09mKHRlbXBsYXRlOiBzdHJpbmcpOiBzdHJpbmdbXSB7XG4gIGNvbnN0IHNlZW4gPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgZm9yIChjb25zdCBtYXRjaCBvZiB0ZW1wbGF0ZS5tYXRjaEFsbChURU1QTEFURV9SRUYpKSBzZWVuLmFkZChtYXRjaFsxXSBhcyBzdHJpbmcpO1xuICByZXR1cm4gWy4uLnNlZW5dO1xufVxuXG4vKipcbiAqIFdhbGsgYSBkb3R0ZWQgcGF0aCBpbnRvIGEgdmFsdWUuIFN0b3BzIGF0IHRoZSBmaXJzdCBzdGVwIHRoYXQgaXMgbm90IGFuIG9iamVjdC5cbiAqXG4gKiBUaGUgVE9QLUxFVkVMIGtleSBpcyBjaGVja2VkIGJ5IHRoZSBjYWxsZXIgYW5kIGlzIGFuIGVycm9yIHdoZW4gYWJzZW50IOKAlCB0aGF0IGlzIHRoZSB3aXJpbmdcbiAqIG1pc3Rha2UuIEEgZGVlcGVyIHN0ZXAgdGhhdCBtaXNzZXMgaXMgb3JkaW5hcnkgb3B0aW9uYWwgZGF0YSBpbnNpZGUgYSBzdHJ1Y3R1cmUgdGhlIGNhbGwgc2l0ZSBkaWRcbiAqIHN1cHBseSwgc28gaXQgcmVuZGVycyBlbXB0eSByYXRoZXIgdGhhbiBzdG9wcGluZyB0aGUgcnVuLlxuICovXG5mdW5jdGlvbiB3YWxrKHZhbHVlOiB1bmtub3duLCBwYXRoOiByZWFkb25seSBzdHJpbmdbXSk6IHVua25vd24ge1xuICBsZXQgY3VycmVudDogdW5rbm93biA9IHZhbHVlO1xuICBmb3IgKGNvbnN0IHN0ZXAgb2YgcGF0aCkge1xuICAgIGlmIChjdXJyZW50ID09PSBudWxsIHx8IGN1cnJlbnQgPT09IHVuZGVmaW5lZCB8fCB0eXBlb2YgY3VycmVudCAhPT0gXCJvYmplY3RcIikgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICBjdXJyZW50ID0gKGN1cnJlbnQgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pW3N0ZXBdO1xuICB9XG4gIHJldHVybiBjdXJyZW50O1xufVxuXG4vKipcbiAqIEhvdyBhIHZhbHVlIGJlY29tZXMgdGV4dCDigJQgdGhlIGVuZ2luZSdzIG93biBydWxlcywgc28gYSB0ZW1wbGF0ZSByZWFkcyB0aGUgc2FtZSB1bmRlciBib3RoLlxuICpcbiAqIEFic2VudCByZW5kZXJzIGFzIGVtcHR5LCB3aGljaCBpcyB3aGF0IG1ha2VzIGFuIE9QVElPTkFMIGhvbGUgd29yazogYSBjYWxsIHNpdGUgdGhhdCBzdXBwbGllc1xuICogYGZyYW1pbmdgIGFzIG5vdGhpbmcgKHRoZSBjYXRhbG9nIGFuc3dlcmVkIHRoZSBmcmFtaW5nIHF1ZXN0aW9uLCBzbyB0aGUgZXhwbG9yYXRpb24gbmV2ZXIgcmFuKVxuICogZ2V0cyBhIGJsYW5rIHNlY3Rpb24gcmF0aGVyIHRoYW4gYSBzdG9wcGVkIHJ1bi4gVGhlIGtleSBzdGlsbCBoYXMgdG8gYmUgc3VwcGxpZWQ7IGl0IGlzIHRoZSB2YWx1ZVxuICogdGhhdCBtYXkgYmUgbWlzc2luZy5cbiAqL1xuZnVuY3Rpb24gcmVuZGVyKHZhbHVlOiB1bmtub3duKTogc3RyaW5nIHtcbiAgaWYgKHZhbHVlID09PSB1bmRlZmluZWQgfHwgdmFsdWUgPT09IG51bGwpIHJldHVybiBcIlwiO1xuICBpZiAodHlwZW9mIHZhbHVlID09PSBcIm9iamVjdFwiKSByZXR1cm4gSlNPTi5zdHJpbmdpZnkodmFsdWUpO1xuICByZXR1cm4gU3RyaW5nKHZhbHVlKTtcbn1cblxuLyoqXG4gKiBSZW5kZXIgYHRlbXBsYXRlYCwgZmlsbGluZyBlYWNoIGB7ey5pbnB1dHMueH19YCBmcm9tIGB2YWx1ZXNgLlxuICpcbiAqIEBwYXJhbSB0ZW1wbGF0ZSBUaGUgdGVtcGxhdGUgdGV4dC4gSW4gYSB3b3JrZmxvdyB0aGlzIGlzIGEgYC5tZGAgcmVmZXJlbmNlLCBpbmxpbmVkIGF0IGxvYWQuXG4gKiBAcGFyYW0gdmFsdWVzIFRoZSBzY29wZSwgYXMgYW4gb2JqZWN0IGxpdGVyYWwgYXQgdGhlIGNhbGwgc2l0ZS4gSXRzIGtleXMgYXJlIHRoZSB0ZW1wbGF0ZSdzXG4gKiAgIHBhcmFtZXRlcnM6IGV2ZXJ5IGhvbGUgbXVzdCBuYW1lIG9uZSwgYW5kIGV2ZXJ5IG9uZSBtdXN0IGJlIG5hbWVkIGJ5IGEgaG9sZS5cbiAqIEByZXR1cm5zIFRoZSByZW5kZXJlZCB0ZXh0LCByZWFkeSB0byBiZSBhcHBlbmRlZCB0byBhIGNvbnZlcnNhdGlvbiBhcyBvbmUgdHVybi5cbiAqIEB0aHJvd3MgV2hlbiBhIGhvbGUgbmFtZXMgbm8gc3VwcGxpZWQga2V5LCB3aGVuIGEgc3VwcGxpZWQga2V5IGlzIHJlYWQgYnkgbm8gaG9sZSwgb3Igd2hlbiBhIGhvbGVcbiAqICAgaXMgc3BlbGxlZCBpbiBhIHdheSBhIGhlcm1ldGljIHNjb3BlIGNhbm5vdCBhbnN3ZXIuXG4gKi9cbmV4cG9ydCBkZWZhdWx0IGZ1bmN0aW9uIHJlbmRlclRlbXBsYXRlKHRlbXBsYXRlOiBzdHJpbmcsIHZhbHVlczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7fSk6IHN0cmluZyB7XG4gIGlmICh0eXBlb2YgdGVtcGxhdGUgIT09IFwic3RyaW5nXCIpIHtcbiAgICB0aHJvdyBuZXcgVHlwZUVycm9yKFxuICAgICAgXCJyZW5kZXJUZW1wbGF0ZTogdGhlIGZpcnN0IGFyZ3VtZW50IG11c3QgYmUgdGVtcGxhdGUgVEVYVC4gQSBiYXJlIGAkL3Byb21wdHMvLi4uLm1kYCByZWZlcmVuY2UgXCIgK1xuICAgICAgICBcInJlc29sdmVzIHRvIGl0cyB0ZXh0OyBhIHF1b3RlZCBzdHJpbmcgcmVzb2x2ZXMgdG8gaXRzZWxmIGFuZCBpcyBhbG1vc3QgbmV2ZXIgd2hhdCB3YXMgbWVhbnQuXCIsXG4gICAgKTtcbiAgfVxuICBjb25zdCB3aGVyZSA9IGByZW5kZXJUZW1wbGF0ZShcIiR7b3BlbmluZyh0ZW1wbGF0ZSl9XCIpYDtcbiAgY29uc3Qgc3VwcGxpZWQgPSBuZXcgU2V0KE9iamVjdC5rZXlzKHZhbHVlcykpO1xuICBjb25zdCByZWFkID0gbmV3IFNldDxzdHJpbmc+KCk7XG5cbiAgZm9yIChjb25zdCBob2xlIG9mIGhvbGVzT2YodGVtcGxhdGUpKSB7XG4gICAgLy8gVGhlIG1pc3NpbmctZG90IHRyYXAsIGNhbGxlZCBvdXQgYnkgbmFtZSBiZWNhdXNlIGl0IGlzIHRoZSBvbmUgdGhhdCByZW5kZXJzIGFzIGxpdGVyYWwgdGV4dFxuICAgIC8vIHJhdGhlciB0aGFuIGFzIG5vdGhpbmc6IGB7e2lucHV0cy54fX1gIGlzIG5vdCBhIHJ1bnRpbWUgcmVmZXJlbmNlLCBzbyB0aGUgZW5naW5lIGxlYXZlcyB0aGVcbiAgICAvLyBicmFjZXMgaW4gdGhlIHByb21wdCBhbmQgYSBtb2RlbCBpcyBhc2tlZCB0byBpbnRlcnByZXQgdGhlbS5cbiAgICBpZiAoIWhvbGUuc3RhcnRzV2l0aChcIi5cIikpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYCR7d2hlcmV9OiB0aGUgaG9sZSB7eyR7aG9sZX19fSBoYXMgbm8gbGVhZGluZyBkb3QsIHNvIGl0IG5hbWVzIGEgRE9DVU1FTlQgcmF0aGVyIHRoYW4gZGF0YS4gYCArXG4gICAgICAgICAgYFdyaXRlIHt7LiR7aG9sZX19fS5gLFxuICAgICAgKTtcbiAgICB9XG4gICAgaWYgKCFob2xlLnN0YXJ0c1dpdGgoUk9PVCkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYCR7d2hlcmV9OiB0aGUgaG9sZSB7eyR7aG9sZX19fSByZWFkcyBvdXRzaWRlIHRoZSB2YWx1ZXMgaXQgd2FzIGhhbmRlZC4gQSByZW5kZXJlZCB0ZW1wbGF0ZSBgICtcbiAgICAgICAgICBgc2VlcyBvbmx5IGl0cyBvd24gcGFyYW1ldGVycyDigJQgcGFzcyB3aGF0IGl0IG5lZWRzIGF0IHRoZSBjYWxsIHNpdGUsIGUuZy4gYCArXG4gICAgICAgICAgYHsgaXRlcmF0aW9uOiAucnVuLml0ZXJhdGlvbiB9LCBhbmQgcmVhZCBpdCBhcyB7ey5pbnB1dHMuaXRlcmF0aW9ufX0uYCxcbiAgICAgICk7XG4gICAgfVxuICAgIGNvbnN0IHBhdGggPSBob2xlLnNsaWNlKFJPT1QubGVuZ3RoKS5zcGxpdChcIi5cIik7XG4gICAgY29uc3Qga2V5ID0gcGF0aFswXSBhcyBzdHJpbmc7XG4gICAgaWYgKCFzdXBwbGllZC5oYXMoa2V5KSkge1xuICAgICAgY29uc3Qgb2ZmZXJlZCA9IHN1cHBsaWVkLnNpemUgPT09IDAgPyBcIm5vdGhpbmdcIiA6IFsuLi5zdXBwbGllZF0uc29ydCgpLmpvaW4oXCIsIFwiKTtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYCR7d2hlcmV9OiB0aGUgaG9sZSB7eyR7aG9sZX19fSBuYW1lcyBcXGAke2tleX1cXGAsIHdoaWNoIHRoaXMgY2FsbCBkb2VzIG5vdCBzdXBwbHkuIFN1cHBsaWVkOiAke29mZmVyZWR9LmAsXG4gICAgICApO1xuICAgIH1cbiAgICByZWFkLmFkZChrZXkpO1xuICB9XG5cbiAgLy8gVGhlIG90aGVyIGRpcmVjdGlvbi4gQSBrZXkgbm90aGluZyByZWFkcyBpcyB3aXJpbmcgdGhhdCBjb21wdXRlcyBhIHZhbHVlIGFuZCB0aHJvd3MgaXQgYXdheSDigJRcbiAgLy8gdXN1YWxseSBhIHRlbXBsYXRlIGVkaXRlZCBvdXQgZnJvbSB1bmRlciBpdHMgY2FsbCBzaXRlcywgb3IgYSByZW5hbWVkIGhvbGUuIEl0IGNvc3RzIHdoYXRldmVyXG4gIC8vIHByb2R1Y2VkIHRoZSB2YWx1ZSwgYW5kIGl0IGlzIHNpbGVudCwgc28gaXQgaXMgYW4gZXJyb3IgcmF0aGVyIHRoYW4gYSB3YXJuaW5nLlxuICBjb25zdCB1bnJlYWQgPSBbLi4uc3VwcGxpZWRdLmZpbHRlcigoa2V5KSA9PiAhcmVhZC5oYXMoa2V5KSkuc29ydCgpO1xuICBpZiAodW5yZWFkLmxlbmd0aCA+IDApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgJHt3aGVyZX06IHN1cHBsaWVkICR7dW5yZWFkLmxlbmd0aCA9PT0gMSA/IFwiYSB2YWx1ZVwiIDogXCJ2YWx1ZXNcIn0gbm8gaG9sZSByZWFkcyDigJQgYCArXG4gICAgICAgIGAke3VucmVhZC5qb2luKFwiLCBcIil9LiBFaXRoZXIgdGhlIHRlbXBsYXRlIGxvc3QgdGhlIGhvbGUgb3IgdGhlIGNhbGwgc2l0ZSBuYW1lZCBpdCB3cm9uZ2x5LmAsXG4gICAgKTtcbiAgfVxuXG4gIHJldHVybiB0ZW1wbGF0ZS5yZXBsYWNlKFRFTVBMQVRFX1JFRiwgKF9tYXRjaCwgaG9sZTogc3RyaW5nKSA9PlxuICAgIHJlbmRlcih3YWxrKHZhbHVlcywgaG9sZS5zbGljZShST09ULmxlbmd0aCkuc3BsaXQoXCIuXCIpKSksXG4gICk7XG59XG4iXX0=