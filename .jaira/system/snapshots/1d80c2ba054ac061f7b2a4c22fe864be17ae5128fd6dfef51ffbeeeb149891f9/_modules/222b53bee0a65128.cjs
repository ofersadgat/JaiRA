"use strict";
/**
 * How far a phase can be trusted to proceed without a person (feature.md §0.6).
 *
 * One file, eight readers — every `feature/<phase>/confidence` state calls into it — which is what
 * makes §0.6's recalibration a single edit. It replaced three `{"expr": …}` documents
 * (`confidence_score`, `confidence_reasons`, `confidence_must_ask`) that said the same things in the
 * closed expression language of SPEC §6.
 *
 * ## What changed by moving to TypeScript
 *
 * The score was always fine as an expression; it is arithmetic. The other two were not. `reasons`
 * and `mustAsk` build LISTS, and the expression language has no array literal — so each was a tower
 * of `concat(concat(concat(…)))` over ternaries, and every phase had to declare a slot called
 * `empty`, defaulted to `[]`, purely so the empty list could arrive as data. That slot is gone from
 * all eight states, and with it the four-deep nesting: the code below is a push into an array.
 *
 * ## What did not change
 *
 * The weights, the thresholds, and every reason string are the same values the expression documents
 * carried. This is a translation, not a recalibration — the numbers are worth arguing about, and
 * that argument belongs in its own change where a diff would show it.
 *
 * Nothing reaches these functions but their parameters (SPEC §7.5.6): no run context, no session, no
 * ambient anything. A phase passes what it knows and reads back a number and two lists.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.confidence = void 0;
/** The severity scale, as ranks. `blocker` = 3 … `note` = 0. */
const MAX_SEVERITY_RANK = 3;
exports.confidence = {
    /**
     * 0..1. Computed, never claimed.
     *
     * Four penalties against a perfect score, each capped by its own weight so no single signal can
     * drive the answer to zero on its own:
     *
     *  - how bad the worst surviving finding is, against the scale's top;
     *  - how many rounds it took, against the ceiling — converging on pass 3 is not converging;
     *  - how close the exploration's winner was to the runner-up — a near-tie says the scoring itself
     *    found the choice arbitrary;
     *  - how close it was to the do-nothing candidate — barely beating it is the case where building
     *    was probably wrong.
     *
     * @param maxSeverityRank blocker=3 … note=0. 0 where the phase has no critique state.
     * @param iteration Which refine pass this is.
     * @param maxIterations The phase's ceiling, from `limits.max_iterations`.
     * @param runnerUpMargin Winner minus runner-up. 1 — no margin pressure — where no exploration ran.
     * @param mandatoryMargin Winner minus the do-nothing / reuse candidate.
     */
    score(maxSeverityRank, iteration, maxIterations, runnerUpMargin = 1, mandatoryMargin = 1) {
        const severity = 0.35 * (maxSeverityRank / MAX_SEVERITY_RANK);
        const rounds = 0.25 * (maxIterations === 0 ? 0 : iteration / maxIterations);
        const runnerUp = 0.2 * (1 - Math.min(1, runnerUpMargin));
        const mandatory = 0.2 * (1 - Math.min(1, mandatoryMargin));
        return Math.max(0, 1 - severity - rounds - runnerUp - mandatory);
    },
    /**
     * What moved the score, in words, worst first and capped at three.
     *
     * The gate shows these; it never shows the bare number, because 0.62 tells a person nothing. The
     * cap is not tidiness — a list of seven reasons is one nobody reads, and the fourth-most-important
     * reason has never been the one that changed a mind.
     *
     * @param maxSeverityRank blocker=3 … note=0.
     * @param thresholdRank What counts as substantial for this phase.
     * @param iteration Which refine pass this is.
     * @param runnerUpMargin Winner minus runner-up.
     * @param mandatoryMargin Winner minus the do-nothing candidate.
     */
    reasons(maxSeverityRank, thresholdRank, iteration, runnerUpMargin = 1, mandatoryMargin = 1) {
        const out = [];
        if (maxSeverityRank >= thresholdRank)
            out.push("the critique exited at or above the severity threshold");
        if (iteration > 1)
            out.push("it took more than one pass to converge");
        if (runnerUpMargin < 0.1) {
            out.push("the exploration was a near-tie, so the scoring itself says the choice was arbitrary");
        }
        if (mandatoryMargin < 0.1) {
            out.push("the winner barely beat the do-nothing candidate, which is the case where building was probably wrong");
        }
        return out.slice(0, 3);
    },
    /**
     * Reasons a person is asked whatever the score says.
     *
     * Non-empty OVERRIDES the threshold. These are the four things no confidence number should be
     * allowed to wave through: something that cannot be undone, a claim that a standing document is
     * wrong, a finding this phase is not the one that can fix, and a loop that ran out of rounds
     * without settling.
     *
     * @param hasIrreversible A migration that has run, deleted data, or a published contract.
     * @param hasAmendment This phase says a standing doc is wrong (§0.4).
     * @param target Where the critique pointed — `upstream` means an earlier phase is wrong.
     * @param iteration Which refine pass this is.
     * @param maxIterations The phase's ceiling.
     */
    mustAsk(hasIrreversible, hasAmendment, target, iteration, maxIterations) {
        const out = [];
        if (hasIrreversible) {
            out.push("an irreversible change — a migration that has run, deleted data, or a published contract");
        }
        if (hasAmendment)
            out.push("an amendment to a standing doc, or a claimed exception to one");
        if (target === "upstream") {
            out.push("the critique says an earlier phase is wrong, which this phase cannot fix");
        }
        if (iteration >= maxIterations)
            out.push("three rounds that did not converge — never silently proceed");
        return out;
    },
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY29uZmlkZW5jZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImNvbmZpZGVuY2UudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7R0F3Qkc7OztBQUVILGdFQUFnRTtBQUNoRSxNQUFNLGlCQUFpQixHQUFHLENBQUMsQ0FBQztBQUVmLFFBQUEsVUFBVSxHQUFHO0lBQ3hCOzs7Ozs7Ozs7Ozs7Ozs7Ozs7T0FrQkc7SUFDSCxLQUFLLENBQ0gsZUFBdUIsRUFDdkIsU0FBaUIsRUFDakIsYUFBcUIsRUFDckIsY0FBYyxHQUFHLENBQUMsRUFDbEIsZUFBZSxHQUFHLENBQUM7UUFFbkIsTUFBTSxRQUFRLEdBQUcsSUFBSSxHQUFHLENBQUMsZUFBZSxHQUFHLGlCQUFpQixDQUFDLENBQUM7UUFDOUQsTUFBTSxNQUFNLEdBQUcsSUFBSSxHQUFHLENBQUMsYUFBYSxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxTQUFTLEdBQUcsYUFBYSxDQUFDLENBQUM7UUFDNUUsTUFBTSxRQUFRLEdBQUcsR0FBRyxHQUFHLENBQUMsQ0FBQyxHQUFHLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQyxFQUFFLGNBQWMsQ0FBQyxDQUFDLENBQUM7UUFDekQsTUFBTSxTQUFTLEdBQUcsR0FBRyxHQUFHLENBQUMsQ0FBQyxHQUFHLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQyxFQUFFLGVBQWUsQ0FBQyxDQUFDLENBQUM7UUFDM0QsT0FBTyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUMsRUFBRSxDQUFDLEdBQUcsUUFBUSxHQUFHLE1BQU0sR0FBRyxRQUFRLEdBQUcsU0FBUyxDQUFDLENBQUM7SUFDbkUsQ0FBQztJQUVEOzs7Ozs7Ozs7Ozs7T0FZRztJQUNILE9BQU8sQ0FDTCxlQUF1QixFQUN2QixhQUFxQixFQUNyQixTQUFpQixFQUNqQixjQUFjLEdBQUcsQ0FBQyxFQUNsQixlQUFlLEdBQUcsQ0FBQztRQUVuQixNQUFNLEdBQUcsR0FBYSxFQUFFLENBQUM7UUFDekIsSUFBSSxlQUFlLElBQUksYUFBYTtZQUFFLEdBQUcsQ0FBQyxJQUFJLENBQUMsd0RBQXdELENBQUMsQ0FBQztRQUN6RyxJQUFJLFNBQVMsR0FBRyxDQUFDO1lBQUUsR0FBRyxDQUFDLElBQUksQ0FBQyx3Q0FBd0MsQ0FBQyxDQUFDO1FBQ3RFLElBQUksY0FBYyxHQUFHLEdBQUcsRUFBRSxDQUFDO1lBQ3pCLEdBQUcsQ0FBQyxJQUFJLENBQUMscUZBQXFGLENBQUMsQ0FBQztRQUNsRyxDQUFDO1FBQ0QsSUFBSSxlQUFlLEdBQUcsR0FBRyxFQUFFLENBQUM7WUFDMUIsR0FBRyxDQUFDLElBQUksQ0FBQyxzR0FBc0csQ0FBQyxDQUFDO1FBQ25ILENBQUM7UUFDRCxPQUFPLEdBQUcsQ0FBQyxLQUFLLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDO0lBQ3pCLENBQUM7SUFFRDs7Ozs7Ozs7Ozs7OztPQWFHO0lBQ0gsT0FBTyxDQUNMLGVBQXdCLEVBQ3hCLFlBQXFCLEVBQ3JCLE1BQWMsRUFDZCxTQUFpQixFQUNqQixhQUFxQjtRQUVyQixNQUFNLEdBQUcsR0FBYSxFQUFFLENBQUM7UUFDekIsSUFBSSxlQUFlLEVBQUUsQ0FBQztZQUNwQixHQUFHLENBQUMsSUFBSSxDQUFDLDBGQUEwRixDQUFDLENBQUM7UUFDdkcsQ0FBQztRQUNELElBQUksWUFBWTtZQUFFLEdBQUcsQ0FBQyxJQUFJLENBQUMsK0RBQStELENBQUMsQ0FBQztRQUM1RixJQUFJLE1BQU0sS0FBSyxVQUFVLEVBQUUsQ0FBQztZQUMxQixHQUFHLENBQUMsSUFBSSxDQUFDLDBFQUEwRSxDQUFDLENBQUM7UUFDdkYsQ0FBQztRQUNELElBQUksU0FBUyxJQUFJLGFBQWE7WUFBRSxHQUFHLENBQUMsSUFBSSxDQUFDLDZEQUE2RCxDQUFDLENBQUM7UUFDeEcsT0FBTyxHQUFHLENBQUM7SUFDYixDQUFDO0NBQ0YsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogSG93IGZhciBhIHBoYXNlIGNhbiBiZSB0cnVzdGVkIHRvIHByb2NlZWQgd2l0aG91dCBhIHBlcnNvbiAoZmVhdHVyZS5tZCDCpzAuNikuXG4gKlxuICogT25lIGZpbGUsIGVpZ2h0IHJlYWRlcnMg4oCUIGV2ZXJ5IGBmZWF0dXJlLzxwaGFzZT4vY29uZmlkZW5jZWAgc3RhdGUgY2FsbHMgaW50byBpdCDigJQgd2hpY2ggaXMgd2hhdFxuICogbWFrZXMgwqcwLjYncyByZWNhbGlicmF0aW9uIGEgc2luZ2xlIGVkaXQuIEl0IHJlcGxhY2VkIHRocmVlIGB7XCJleHByXCI6IOKApn1gIGRvY3VtZW50c1xuICogKGBjb25maWRlbmNlX3Njb3JlYCwgYGNvbmZpZGVuY2VfcmVhc29uc2AsIGBjb25maWRlbmNlX211c3RfYXNrYCkgdGhhdCBzYWlkIHRoZSBzYW1lIHRoaW5ncyBpbiB0aGVcbiAqIGNsb3NlZCBleHByZXNzaW9uIGxhbmd1YWdlIG9mIFNQRUMgwqc2LlxuICpcbiAqICMjIFdoYXQgY2hhbmdlZCBieSBtb3ZpbmcgdG8gVHlwZVNjcmlwdFxuICpcbiAqIFRoZSBzY29yZSB3YXMgYWx3YXlzIGZpbmUgYXMgYW4gZXhwcmVzc2lvbjsgaXQgaXMgYXJpdGhtZXRpYy4gVGhlIG90aGVyIHR3byB3ZXJlIG5vdC4gYHJlYXNvbnNgXG4gKiBhbmQgYG11c3RBc2tgIGJ1aWxkIExJU1RTLCBhbmQgdGhlIGV4cHJlc3Npb24gbGFuZ3VhZ2UgaGFzIG5vIGFycmF5IGxpdGVyYWwg4oCUIHNvIGVhY2ggd2FzIGEgdG93ZXJcbiAqIG9mIGBjb25jYXQoY29uY2F0KGNvbmNhdCjigKYpKSlgIG92ZXIgdGVybmFyaWVzLCBhbmQgZXZlcnkgcGhhc2UgaGFkIHRvIGRlY2xhcmUgYSBzbG90IGNhbGxlZFxuICogYGVtcHR5YCwgZGVmYXVsdGVkIHRvIGBbXWAsIHB1cmVseSBzbyB0aGUgZW1wdHkgbGlzdCBjb3VsZCBhcnJpdmUgYXMgZGF0YS4gVGhhdCBzbG90IGlzIGdvbmUgZnJvbVxuICogYWxsIGVpZ2h0IHN0YXRlcywgYW5kIHdpdGggaXQgdGhlIGZvdXItZGVlcCBuZXN0aW5nOiB0aGUgY29kZSBiZWxvdyBpcyBhIHB1c2ggaW50byBhbiBhcnJheS5cbiAqXG4gKiAjIyBXaGF0IGRpZCBub3QgY2hhbmdlXG4gKlxuICogVGhlIHdlaWdodHMsIHRoZSB0aHJlc2hvbGRzLCBhbmQgZXZlcnkgcmVhc29uIHN0cmluZyBhcmUgdGhlIHNhbWUgdmFsdWVzIHRoZSBleHByZXNzaW9uIGRvY3VtZW50c1xuICogY2FycmllZC4gVGhpcyBpcyBhIHRyYW5zbGF0aW9uLCBub3QgYSByZWNhbGlicmF0aW9uIOKAlCB0aGUgbnVtYmVycyBhcmUgd29ydGggYXJndWluZyBhYm91dCwgYW5kXG4gKiB0aGF0IGFyZ3VtZW50IGJlbG9uZ3MgaW4gaXRzIG93biBjaGFuZ2Ugd2hlcmUgYSBkaWZmIHdvdWxkIHNob3cgaXQuXG4gKlxuICogTm90aGluZyByZWFjaGVzIHRoZXNlIGZ1bmN0aW9ucyBidXQgdGhlaXIgcGFyYW1ldGVycyAoU1BFQyDCpzcuNS42KTogbm8gcnVuIGNvbnRleHQsIG5vIHNlc3Npb24sIG5vXG4gKiBhbWJpZW50IGFueXRoaW5nLiBBIHBoYXNlIHBhc3NlcyB3aGF0IGl0IGtub3dzIGFuZCByZWFkcyBiYWNrIGEgbnVtYmVyIGFuZCB0d28gbGlzdHMuXG4gKi9cblxuLyoqIFRoZSBzZXZlcml0eSBzY2FsZSwgYXMgcmFua3MuIGBibG9ja2VyYCA9IDMg4oCmIGBub3RlYCA9IDAuICovXG5jb25zdCBNQVhfU0VWRVJJVFlfUkFOSyA9IDM7XG5cbmV4cG9ydCBjb25zdCBjb25maWRlbmNlID0ge1xuICAvKipcbiAgICogMC4uMS4gQ29tcHV0ZWQsIG5ldmVyIGNsYWltZWQuXG4gICAqXG4gICAqIEZvdXIgcGVuYWx0aWVzIGFnYWluc3QgYSBwZXJmZWN0IHNjb3JlLCBlYWNoIGNhcHBlZCBieSBpdHMgb3duIHdlaWdodCBzbyBubyBzaW5nbGUgc2lnbmFsIGNhblxuICAgKiBkcml2ZSB0aGUgYW5zd2VyIHRvIHplcm8gb24gaXRzIG93bjpcbiAgICpcbiAgICogIC0gaG93IGJhZCB0aGUgd29yc3Qgc3Vydml2aW5nIGZpbmRpbmcgaXMsIGFnYWluc3QgdGhlIHNjYWxlJ3MgdG9wO1xuICAgKiAgLSBob3cgbWFueSByb3VuZHMgaXQgdG9vaywgYWdhaW5zdCB0aGUgY2VpbGluZyDigJQgY29udmVyZ2luZyBvbiBwYXNzIDMgaXMgbm90IGNvbnZlcmdpbmc7XG4gICAqICAtIGhvdyBjbG9zZSB0aGUgZXhwbG9yYXRpb24ncyB3aW5uZXIgd2FzIHRvIHRoZSBydW5uZXItdXAg4oCUIGEgbmVhci10aWUgc2F5cyB0aGUgc2NvcmluZyBpdHNlbGZcbiAgICogICAgZm91bmQgdGhlIGNob2ljZSBhcmJpdHJhcnk7XG4gICAqICAtIGhvdyBjbG9zZSBpdCB3YXMgdG8gdGhlIGRvLW5vdGhpbmcgY2FuZGlkYXRlIOKAlCBiYXJlbHkgYmVhdGluZyBpdCBpcyB0aGUgY2FzZSB3aGVyZSBidWlsZGluZ1xuICAgKiAgICB3YXMgcHJvYmFibHkgd3JvbmcuXG4gICAqXG4gICAqIEBwYXJhbSBtYXhTZXZlcml0eVJhbmsgYmxvY2tlcj0zIOKApiBub3RlPTAuIDAgd2hlcmUgdGhlIHBoYXNlIGhhcyBubyBjcml0aXF1ZSBzdGF0ZS5cbiAgICogQHBhcmFtIGl0ZXJhdGlvbiBXaGljaCByZWZpbmUgcGFzcyB0aGlzIGlzLlxuICAgKiBAcGFyYW0gbWF4SXRlcmF0aW9ucyBUaGUgcGhhc2UncyBjZWlsaW5nLCBmcm9tIGBsaW1pdHMubWF4X2l0ZXJhdGlvbnNgLlxuICAgKiBAcGFyYW0gcnVubmVyVXBNYXJnaW4gV2lubmVyIG1pbnVzIHJ1bm5lci11cC4gMSDigJQgbm8gbWFyZ2luIHByZXNzdXJlIOKAlCB3aGVyZSBubyBleHBsb3JhdGlvbiByYW4uXG4gICAqIEBwYXJhbSBtYW5kYXRvcnlNYXJnaW4gV2lubmVyIG1pbnVzIHRoZSBkby1ub3RoaW5nIC8gcmV1c2UgY2FuZGlkYXRlLlxuICAgKi9cbiAgc2NvcmUoXG4gICAgbWF4U2V2ZXJpdHlSYW5rOiBudW1iZXIsXG4gICAgaXRlcmF0aW9uOiBudW1iZXIsXG4gICAgbWF4SXRlcmF0aW9uczogbnVtYmVyLFxuICAgIHJ1bm5lclVwTWFyZ2luID0gMSxcbiAgICBtYW5kYXRvcnlNYXJnaW4gPSAxLFxuICApOiBudW1iZXIge1xuICAgIGNvbnN0IHNldmVyaXR5ID0gMC4zNSAqIChtYXhTZXZlcml0eVJhbmsgLyBNQVhfU0VWRVJJVFlfUkFOSyk7XG4gICAgY29uc3Qgcm91bmRzID0gMC4yNSAqIChtYXhJdGVyYXRpb25zID09PSAwID8gMCA6IGl0ZXJhdGlvbiAvIG1heEl0ZXJhdGlvbnMpO1xuICAgIGNvbnN0IHJ1bm5lclVwID0gMC4yICogKDEgLSBNYXRoLm1pbigxLCBydW5uZXJVcE1hcmdpbikpO1xuICAgIGNvbnN0IG1hbmRhdG9yeSA9IDAuMiAqICgxIC0gTWF0aC5taW4oMSwgbWFuZGF0b3J5TWFyZ2luKSk7XG4gICAgcmV0dXJuIE1hdGgubWF4KDAsIDEgLSBzZXZlcml0eSAtIHJvdW5kcyAtIHJ1bm5lclVwIC0gbWFuZGF0b3J5KTtcbiAgfSxcblxuICAvKipcbiAgICogV2hhdCBtb3ZlZCB0aGUgc2NvcmUsIGluIHdvcmRzLCB3b3JzdCBmaXJzdCBhbmQgY2FwcGVkIGF0IHRocmVlLlxuICAgKlxuICAgKiBUaGUgZ2F0ZSBzaG93cyB0aGVzZTsgaXQgbmV2ZXIgc2hvd3MgdGhlIGJhcmUgbnVtYmVyLCBiZWNhdXNlIDAuNjIgdGVsbHMgYSBwZXJzb24gbm90aGluZy4gVGhlXG4gICAqIGNhcCBpcyBub3QgdGlkaW5lc3Mg4oCUIGEgbGlzdCBvZiBzZXZlbiByZWFzb25zIGlzIG9uZSBub2JvZHkgcmVhZHMsIGFuZCB0aGUgZm91cnRoLW1vc3QtaW1wb3J0YW50XG4gICAqIHJlYXNvbiBoYXMgbmV2ZXIgYmVlbiB0aGUgb25lIHRoYXQgY2hhbmdlZCBhIG1pbmQuXG4gICAqXG4gICAqIEBwYXJhbSBtYXhTZXZlcml0eVJhbmsgYmxvY2tlcj0zIOKApiBub3RlPTAuXG4gICAqIEBwYXJhbSB0aHJlc2hvbGRSYW5rIFdoYXQgY291bnRzIGFzIHN1YnN0YW50aWFsIGZvciB0aGlzIHBoYXNlLlxuICAgKiBAcGFyYW0gaXRlcmF0aW9uIFdoaWNoIHJlZmluZSBwYXNzIHRoaXMgaXMuXG4gICAqIEBwYXJhbSBydW5uZXJVcE1hcmdpbiBXaW5uZXIgbWludXMgcnVubmVyLXVwLlxuICAgKiBAcGFyYW0gbWFuZGF0b3J5TWFyZ2luIFdpbm5lciBtaW51cyB0aGUgZG8tbm90aGluZyBjYW5kaWRhdGUuXG4gICAqL1xuICByZWFzb25zKFxuICAgIG1heFNldmVyaXR5UmFuazogbnVtYmVyLFxuICAgIHRocmVzaG9sZFJhbms6IG51bWJlcixcbiAgICBpdGVyYXRpb246IG51bWJlcixcbiAgICBydW5uZXJVcE1hcmdpbiA9IDEsXG4gICAgbWFuZGF0b3J5TWFyZ2luID0gMSxcbiAgKTogc3RyaW5nW10ge1xuICAgIGNvbnN0IG91dDogc3RyaW5nW10gPSBbXTtcbiAgICBpZiAobWF4U2V2ZXJpdHlSYW5rID49IHRocmVzaG9sZFJhbmspIG91dC5wdXNoKFwidGhlIGNyaXRpcXVlIGV4aXRlZCBhdCBvciBhYm92ZSB0aGUgc2V2ZXJpdHkgdGhyZXNob2xkXCIpO1xuICAgIGlmIChpdGVyYXRpb24gPiAxKSBvdXQucHVzaChcIml0IHRvb2sgbW9yZSB0aGFuIG9uZSBwYXNzIHRvIGNvbnZlcmdlXCIpO1xuICAgIGlmIChydW5uZXJVcE1hcmdpbiA8IDAuMSkge1xuICAgICAgb3V0LnB1c2goXCJ0aGUgZXhwbG9yYXRpb24gd2FzIGEgbmVhci10aWUsIHNvIHRoZSBzY29yaW5nIGl0c2VsZiBzYXlzIHRoZSBjaG9pY2Ugd2FzIGFyYml0cmFyeVwiKTtcbiAgICB9XG4gICAgaWYgKG1hbmRhdG9yeU1hcmdpbiA8IDAuMSkge1xuICAgICAgb3V0LnB1c2goXCJ0aGUgd2lubmVyIGJhcmVseSBiZWF0IHRoZSBkby1ub3RoaW5nIGNhbmRpZGF0ZSwgd2hpY2ggaXMgdGhlIGNhc2Ugd2hlcmUgYnVpbGRpbmcgd2FzIHByb2JhYmx5IHdyb25nXCIpO1xuICAgIH1cbiAgICByZXR1cm4gb3V0LnNsaWNlKDAsIDMpO1xuICB9LFxuXG4gIC8qKlxuICAgKiBSZWFzb25zIGEgcGVyc29uIGlzIGFza2VkIHdoYXRldmVyIHRoZSBzY29yZSBzYXlzLlxuICAgKlxuICAgKiBOb24tZW1wdHkgT1ZFUlJJREVTIHRoZSB0aHJlc2hvbGQuIFRoZXNlIGFyZSB0aGUgZm91ciB0aGluZ3Mgbm8gY29uZmlkZW5jZSBudW1iZXIgc2hvdWxkIGJlXG4gICAqIGFsbG93ZWQgdG8gd2F2ZSB0aHJvdWdoOiBzb21ldGhpbmcgdGhhdCBjYW5ub3QgYmUgdW5kb25lLCBhIGNsYWltIHRoYXQgYSBzdGFuZGluZyBkb2N1bWVudCBpc1xuICAgKiB3cm9uZywgYSBmaW5kaW5nIHRoaXMgcGhhc2UgaXMgbm90IHRoZSBvbmUgdGhhdCBjYW4gZml4LCBhbmQgYSBsb29wIHRoYXQgcmFuIG91dCBvZiByb3VuZHNcbiAgICogd2l0aG91dCBzZXR0bGluZy5cbiAgICpcbiAgICogQHBhcmFtIGhhc0lycmV2ZXJzaWJsZSBBIG1pZ3JhdGlvbiB0aGF0IGhhcyBydW4sIGRlbGV0ZWQgZGF0YSwgb3IgYSBwdWJsaXNoZWQgY29udHJhY3QuXG4gICAqIEBwYXJhbSBoYXNBbWVuZG1lbnQgVGhpcyBwaGFzZSBzYXlzIGEgc3RhbmRpbmcgZG9jIGlzIHdyb25nICjCpzAuNCkuXG4gICAqIEBwYXJhbSB0YXJnZXQgV2hlcmUgdGhlIGNyaXRpcXVlIHBvaW50ZWQg4oCUIGB1cHN0cmVhbWAgbWVhbnMgYW4gZWFybGllciBwaGFzZSBpcyB3cm9uZy5cbiAgICogQHBhcmFtIGl0ZXJhdGlvbiBXaGljaCByZWZpbmUgcGFzcyB0aGlzIGlzLlxuICAgKiBAcGFyYW0gbWF4SXRlcmF0aW9ucyBUaGUgcGhhc2UncyBjZWlsaW5nLlxuICAgKi9cbiAgbXVzdEFzayhcbiAgICBoYXNJcnJldmVyc2libGU6IGJvb2xlYW4sXG4gICAgaGFzQW1lbmRtZW50OiBib29sZWFuLFxuICAgIHRhcmdldDogc3RyaW5nLFxuICAgIGl0ZXJhdGlvbjogbnVtYmVyLFxuICAgIG1heEl0ZXJhdGlvbnM6IG51bWJlcixcbiAgKTogc3RyaW5nW10ge1xuICAgIGNvbnN0IG91dDogc3RyaW5nW10gPSBbXTtcbiAgICBpZiAoaGFzSXJyZXZlcnNpYmxlKSB7XG4gICAgICBvdXQucHVzaChcImFuIGlycmV2ZXJzaWJsZSBjaGFuZ2Ug4oCUIGEgbWlncmF0aW9uIHRoYXQgaGFzIHJ1biwgZGVsZXRlZCBkYXRhLCBvciBhIHB1Ymxpc2hlZCBjb250cmFjdFwiKTtcbiAgICB9XG4gICAgaWYgKGhhc0FtZW5kbWVudCkgb3V0LnB1c2goXCJhbiBhbWVuZG1lbnQgdG8gYSBzdGFuZGluZyBkb2MsIG9yIGEgY2xhaW1lZCBleGNlcHRpb24gdG8gb25lXCIpO1xuICAgIGlmICh0YXJnZXQgPT09IFwidXBzdHJlYW1cIikge1xuICAgICAgb3V0LnB1c2goXCJ0aGUgY3JpdGlxdWUgc2F5cyBhbiBlYXJsaWVyIHBoYXNlIGlzIHdyb25nLCB3aGljaCB0aGlzIHBoYXNlIGNhbm5vdCBmaXhcIik7XG4gICAgfVxuICAgIGlmIChpdGVyYXRpb24gPj0gbWF4SXRlcmF0aW9ucykgb3V0LnB1c2goXCJ0aHJlZSByb3VuZHMgdGhhdCBkaWQgbm90IGNvbnZlcmdlIOKAlCBuZXZlciBzaWxlbnRseSBwcm9jZWVkXCIpO1xuICAgIHJldHVybiBvdXQ7XG4gIH0sXG59O1xuIl19