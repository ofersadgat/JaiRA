---
id: product/run-history-travels-with-the-repository
type: product-feature
status: shipped
updated: 2026-09-13
story: "As an operator, I can choose to keep a project's run history as plain files that live in the repository instead of in a local database, in the line formats other agent tools already read, so that history can be committed, merged and read by tools the product did not write."
importance: 0.2
audience: operator
metrics:
  - "Projects whose run history is kept in the repository: rises"
  - "Conflicts when merging committed run history: falls"
requires: [product/complete-record-of-every-run]
related: [product/share-processes-across-projects, product/keep-history-within-bounds]
verified_by: []
---

# A project's run history can live in the repository as plain files other tools can read

> As an operator, I can choose to keep a project's run history as plain files that live in the repository instead of in a local database, in the line formats other agent tools already read, so that history can be committed, merged and read by tools the product did not write.

## Without this, run history is locked in a local database that cannot be shared or merged

The person decides how a project keeps its records. History kept only in a local
database stays on one machine. It cannot be committed usefully, two copies of it
cannot be merged, and tools the product did not write cannot read it.

## Each kind of record can be kept in the database, as plain files in the project, or both

A project keeps four kinds of record: how work went step by step, conversations,
the pieces of work themselves, and what work produced. For each, the person
chooses the database, plain files in the project, or both. Everything is kept in
the database unless the person chooses otherwise.

Conversations kept as files are written in the line format Claude Code or Codex
already uses, as the person chooses, so those tools can read them. Files in
either format read correctly whatever a project has chosen, so history from two
people who chose differently still reads.

What only makes sense on one machine never goes into the repository: the local
database, the app's own log, the output of commands a run started, anything that
records which code this machine agreed to run, and local credentials.

Trimming history removes its files from the project too. Taking them out of
version control is the person's own commit.

## Plain files make run history part of the project

When run history is plain files in a known format, it is committed, reviewed and
merged with the code it produced. Anyone who checks out the project has the
history too, and other agent tools can read the conversations without the
product in between.

## Success shows as more projects sharing history through version control without conflicts

| Metric | Read from | Success |
| --- | --- | --- |
| Projects whose run history is kept in the repository | The record of each project's choice of where its records are kept | Rises |
| Conflicts when merging committed run history | The record of merges that touched run history and which of them conflicted | Falls |
