# Reproducibility

## Canonicalization

RFC 8785 JSON Canonicalization Scheme via the `canonicalize` package
(`@supadiff/spec`'s `canonical.ts`), characterized by tests in
`packages/spec/test/canonicalization.test.ts`: key sorting, array order
preservation, shortest round-trippable numbers, null/empty distinctness, and
explicit non-normalization of Unicode (NFC vs NFD strings hash differently —
by design, RFC 8785 is not a Unicode normalizer).

Digests are `sha256:<hex>` of the canonical form
(`sha256OfCanonicalJson`). `computeScenarioDigest` covers the full canonical
scenario, including declared resource hashes.

## Toolchain

- Node.js `>=22.0.0 <23.0.0` (enforced in every `package.json`'s `engines`).
- pnpm workspace, `pnpm-lock.yaml` committed.
- TypeScript strict mode (`tsconfig.base.json`).
- Vitest for tests.

## Determinism inside a run

- **Scheduling**: serial lockstep by logical step, target order fixed by the
  plan (§5.2) — `packages/engine/src/execution/run.ts`. Proven by
  `lockstep-and-events.test.ts`.
- **Clock**: `runScenario` accepts an injectable `clock: () => IsoDateTime`;
  the default is a deterministic synthetic counter, not wall time, so event
  ordering tests never depend on real elapsed time.
- **Secret handles**: `InMemorySecretVault` accepts an optional `seed`
  (`${scenario.seed}-${targetSlot}` in `runScenario`); handle IDs are then a
  keyed hash of a monotonic counter, not `crypto.randomBytes`, so two
  executions of the same plan against the same fixture data produce
  identical handle strings. Handle opacity (§2.6) means "not derivable from
  the secret value," not "cryptographically unpredictable" — determinism
  here does not weaken the security property.
- **Comparison result IDs**: derived from `(stepId, observablePath)`, not a
  process-lifetime counter, so results are stable regardless of how many
  comparisons ran earlier in the same process.

## Artifact determinism

`buildBundle` (`@supadiff/engine`) is a pure function of its input: same
`BuildBundleInput` → byte-identical `files` map, proven directly (buffer
equality per path) in `packages/engine/test/artifact/bundle.test.ts` and, at
the CLI level, across two independent `supadiff run` invocations of the same
scenario/targets in `packages/cli/test/run-command.test.ts` (excluding
`manifest.json`, `checksums.sha256`, and `provenance/secret-scan.json`,
whose `scannedAt`/timestamps are legitimate wall-clock provenance metadata,
not scenario-derived payload).

`artifactId` is the SHA-256 of the canonical JSON of the sorted
`(path, sha256)` payload inventory — a simplified stand-in for a full
Merkle tree, sufficient to detect any payload change deterministically.
See `docs/adr/0002-artifact-directory-format.md` for why artifacts are
directory trees rather than ZIP files in this delivery, and
`docs/TESTING.md` for the exact reproducibility test list.

## What is not yet reproducible

- No real target (Supalite/Supabase) exists yet, so nothing about real
  backend timing, container startup, or network behavior is characterized.
- Generation/reduction (`fast-check`-based scenario generation, dependency-
  safe reduction) are not implemented (L10, L12) — nothing here claims
  reduced-repro reproducibility beyond the deterministic artifact property
  above.
