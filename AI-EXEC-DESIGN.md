# Shared execution library design — MOVED

This was the working draft used to design extracting a shared execution library
out of JaiRA. It is superseded in full.

**The canonical documents live with the implementation, in the sibling
[declarative-ai](https://github.com/ofersadgat/declarative-ai) repo** (formerly
`ai-exec`):

- `declarative-ai/DESIGN.md` — architecture, the declarative model, the execution
  contract, the runtime/tool/permission model, consumer migration plans
- `declarative-ai/API.md` — API reference, package by package
- `declarative-ai/SPEC.md` — the hierarchical-workflow formalism (normative for
  `@declarative-ai/hw`)

For how JaiRA consumes it, see [DESIGN.md](DESIGN.md) §1c (current status, and the
migration off the old `@ai-exec/*` API), §2.1 (layout), and §14 (phases).
