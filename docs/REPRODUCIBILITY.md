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

## Generation determinism (L12)

`@supadiff/generators` hashes the scenario seed into `fast-check@4.9.0`'s
numeric seed (`hashSeedToUint32`, FNV-1a) and indexes its deterministic
sample sequence by ordinal position (`generation.path`, a plain array
index — not `fast-check`'s internal shrink-path notation, since nothing is
shrunk during generation). Two independent generator runs with the same
`{seed, count}` produce byte-identical `ScenarioSpec`s, proven directly via
`computeScenarioDigest` equality in `packages/generators/test/
generation.test.ts`. `provenance.createdAt` is pinned to the Unix epoch
rather than wall-clock time specifically because `computeScenarioDigest`
hashes the whole canonical scenario, `provenance` included.

## Reduction determinism (L10)

`@supadiff/reducer`'s acceptance oracle compares reproduction signatures
using a digest that explicitly excludes `scenarioDigest` itself (§9.3's
own wording: "scenario digest OR reduced scenario digest"), since a
reduction pass necessarily changes the scenario's steps and therefore its
digest — the property being preserved is the _divergence signature_, not
byte-identity with the original scenario. A 3x flake-check gates every
reduction attempt before any step is removed.

## What is not yet reproducible

- The real `supabase-hosted` target (L13) runs against a live hosted
  project over the public internet; nothing about its wall-clock timing or
  network behavior is characterized or asserted as deterministic (its
  scenario _outcome_ — Data / Auth / RLS behavior, cleanup completeness — is
  what the acceptance gate checks). Real Supalite (L6/L11), real
  `supabase-local` (L7/L8/L11, a pinned `supabase` CLI over Docker Compose)
  and real `supabase-hosted` (L13) process-spawn, container-startup and HTTP
  timing all happen for real — but this document makes no timing-determinism
  claim about them;
  only the properties above (canonicalization, artifact bytes, generation,
  reduction) are asserted as deterministic.
