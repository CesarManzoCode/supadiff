# ADR-0002: L0-L5 artifacts are written as directory trees, not ZIP files

## Context

§9.1 states: "Artifacts are deterministic directory trees or deterministic
ZIP bundles with the `.supadiff` suffix." Both formats are explicitly
sanctioned by the contract. A ZIP writer that produces byte-stable output
(sorted entries, `/` separators, fixed metadata timestamps) is not difficult
on its own, but a full round-trip story — `compare` and `inspect` reading
artifacts back — additionally needs a ZIP _reader_, which the ecosystem does
not obviously make as simple to get byte-for-byte deterministic and
dependency-light as directory I/O.

## Decision

For L0-L5, `supadiff run`/`compare` write and read bundles as directory
trees under a `.supadiff`-suffixed directory name (e.g.
`run-scn.basic-1.supadiff/`). Every file's bytes are exactly the canonical
bytes computed by `buildBundle` (`@supadiff/engine`), written and read with
plain `fs` calls — no ZIP dependency in this delivery.

## Alternatives considered

1. **ZIP-only via `yazl`+`yauzl`.** Viable, but adds a read/write dependency
   pair and a compression-format determinism surface (timestamps, external
   file attributes, compression method selection) to get exactly right for
   the "byte-identical artifact" property, for a format the contract already
   treats as optional.
2. **Both formats simultaneously.** Deferred as unnecessary scope for this
   delivery; the directory tree alone fully satisfies §9.1's "or" and keeps
   `compare`/`inspect` simple and testable.

## Evidence

§9.1: "Artifacts are deterministic directory trees **or** deterministic ZIP
bundles with the `.supadiff` suffix."

## Consequences

- `writeBundleDirectory` (`@supadiff/cli`) rejects any bundle entry path
  containing `..` or an absolute path before writing anything, standing in
  for the ZIP format's "malicious path" defense (§L5 test list).
- Determinism tests (`packages/engine/test/artifact/bundle.test.ts`,
  `packages/cli/test/run-command.test.ts`) compare raw file bytes directly,
  which is a strictly stronger determinism check than comparing ZIP
  container bytes would be (it is immune to incidental ZIP-library
  metadata differences).
- A ZIP writer/reader can be added later as an additional output mode
  without changing `buildBundle`'s file map, which is format-agnostic.
