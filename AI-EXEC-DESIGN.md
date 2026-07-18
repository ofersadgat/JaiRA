# ai-exec: Shared AI Execution Library — MOVED

**The canonical design document now lives with the implementation:**
`C:\UbuntuCode\ai-exec\DESIGN.md` (repo `C:\UbuntuCode\ai-exec`).

This file was the working draft used to design the extraction; it has been
superseded in full. As of 2026-07-17 the library is implemented and tested:

- `@ai-exec/core` — execution contract, error classification, hashing/memo keys
- `@ai-exec/services` — validation, retry, rate limiting, deadline
- `@ai-exec/llm` — the `llm-call` executor (extracted from findmyprompt)
- `@ai-exec/hw` — the hierarchical-workflow engine + executor (SPEC §3–§10)

For how JaiRA consumes the library, see [DESIGN.md](DESIGN.md) §1a (status
update), §2.1 (layout), §8 (executor contract), and §14 (revised phases).
The formalism specification lives at `C:\UbuntuCode\ai-exec\SPEC.md`.
