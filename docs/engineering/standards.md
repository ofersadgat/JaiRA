---
id: engineering/standards
type: standing
status: proposed
updated: 2026-08-04
---

# Code standards

The concrete rules a reviewer can cite by name. Phase 5 of
[WORKFLOW.md](../../WORKFLOW.md) reads this while writing the code; phase 8
checks the build against it. A rule discovered while writing code is the most
credible kind — amend this file when you find one.

Each rule should be citable ("this breaks *Errors name the fix*") and checkable
by someone who did not write the code. A rule that needs a paragraph of context
to apply is a [principle](principles.md), not a standard.

> **Mostly unwritten.** The rules below are the ones already enforced in
> practice, taken from [README.md](../../README.md) and the existing root docs.
> The rest of this file is section headings on purpose: filling them in with
> guesses would make the file worse than empty, because a reviewer would start
> citing rules nobody agreed to. Add each one the first time it matters.

## Configuration and inputs

- **Model ids are route-prefixed.** `anthropic/claude-sonnet-5`. A bare id is a
  fail-fast error, not a defaulted route.
- **Secrets come from the environment.** Never a committed file, never a
  default.
- **Derived state is gitignored.** `jaira.db*` and `snapshots/` are derived;
  `.jaira/workflows/` is authored and committed.

## Errors

- **Errors name the fix.** A missing ABI build says which command builds it. A
  failed run prints operation-level `causes`, not only the parent's summary.
- (To write: error types vs. thrown strings; when a failure is logged versus
  surfaced; what a user-facing error may assume the reader knows.)

## Naming

_To write._ Package-level conventions, file naming, what a `*.test.ts` sits next
to, when a name is allowed to be long.

## Module structure and dependencies

- **Depend downward only**, along the layers in
  [architecture.md](architecture.md).
- (To write: barrel files, circular-import policy, what belongs in `@jaira/shared`
  versus a package's own types.)

## Tests

- Tests run under vitest: `npm test`, `npm run typecheck` beside it.
- Live-agent tests are opt-in behind an env flag
  (`JAIRA_LIVE_AGENT=1`) and never run in the default suite.
- (To write: where a test file lives relative to its subject; what may be faked;
  when an integration test is required rather than allowed.)

## Logging and observability

_To write._ What is journalled versus logged, what a log line owes the operator
at 3am, what must never appear in output (keys, prompt bodies, user content).

## Comments and documentation in code

_To write._ When a comment is required, what a doc comment owes a caller, and
which of these facts belong in [the docs tree](../index.md) instead of beside
the code.

## Amendments

| Date | What changed | What forced it |
| --- | --- | --- |
| 2026-08-04 | Created with the rules already enforced; the rest left as headings | The docs tree was created |
