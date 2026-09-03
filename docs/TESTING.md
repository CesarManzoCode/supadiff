# Testing

## What actually exists

| Layer        | Package            | Test files | Tests   |
| ------------ | ------------------ | ---------- | ------- |
| L1 spec      | `@supadiff/spec`   | 5          | 35      |
| L2-L5 engine | `@supadiff/engine` | 6          | 44      |
| L5 CLI       | `supadiff` (cli)   | 4          | 21      |
| **Total**    |                    | **15**     | **100** |

All numbers above are reproducible by running the commands below; they are
not claimed from memory.

## Exact acceptance commands

```bash
corepack pnpm install --frozen-lockfile
pnpm check                                              # boundary + lint + typecheck + format + test

pnpm --filter @supadiff/spec test                        # L1
pnpm --filter @supadiff/engine test -- execution          # L2
pnpm test:observations                                    # L3 (packages/engine/test/observation)
pnpm test:secret-corpus                                   # L3 (packages/engine/test/secret-corpus)
pnpm test:comparison-honesty                               # L4 (packages/engine/test/comparison-honesty)

pnpm --filter @supadiff/spec build && \
pnpm --filter @supadiff/engine build && \
pnpm --filter supadiff build && \
node packages/cli/dist/bin.js run test/fixtures/basic.json \
  --target test/fixtures/fake-reference.json \
  --target test/fixtures/fake-match.json \
  --policy test/fixtures/basic-policy.json \
  --output json                                           # L5
```

## What each suite actually proves

- **L1** (`packages/spec/test`): a corpus of valid and invalid scenarios,
  comparison policies, target specs, and known-divergence entries; RFC 8785
  canonicalization characterization; builder-vs-hand-JSON digest equality.
- **L2** (`packages/engine/test/execution`): exact event ordering across two
  targets in lockstep, capture resolution, secret capture to vault,
  capability unsupported-before-mutation, runtime capability downgrade,
  identity-mismatch, timeout, target death, comparable-prefix preservation,
  retry legality (valid idempotent retry vs. rejected illegal retry),
  cleanup after every failure class, and recovery-journal tombstoning.
- **L3** (`packages/engine/test/observation`, `.../secret-corpus`):
  projector purity/determinism, token relationship without token equality,
  null-vs-missing preservation, unaccounted-field fail-closed behavior, and
  the secret corpus described in `docs/SECURITY.md`.
- **L4** (`packages/engine/test/comparison-honesty`): one mutation per
  contractual field must produce `new-divergence`; benign differences (key
  order, unordered rows) must not; known-divergence expiry and overlap
  behavior; ambiguous rule selection throws rather than picking a winner.
- **L5** (`packages/engine/test/artifact`, `packages/cli/test`): byte-
  identical bundle assembly, artifactId changes on payload change, blocked
  artifact on an unexplained secret leak, checksums covering every payload
  plus manifest excluding itself, malicious-path rejection (`../`,
  absolute, nested traversal), checksum-corruption detection via `inspect
artifact`, exact exit codes (0/10/20/30) under different `--fail-on`
  configurations, JSON-stdout purity (exactly one document), NDJSON event
  ordering, human stdout/stderr separation, and offline `compare` producing
  the same outcome as a live two-target `run` on identical fixtures.

## Honesty gates actually enforced

- Boundary checker (`scripts/boundary-check.mjs`) fails the build on any
  forbidden cross-package import — verified by a self-test in this session
  (a deliberately introduced violation was caught, then reverted).
- `pnpm check` runs boundary check, lint, typecheck, format check, and every
  package's tests in one command; it is the acceptance gate for this
  delivery and passes cleanly as committed.
- No test in this repository claims conformance with real Supabase or
  Supalite. `FakeTargetDriver` is explicitly test infrastructure (§15.2)
  and every doc in `docs/` that mentions it says so.

## Explicitly not built in this delivery

- Dogfood fault lab (§15.5's six deliberately incompatible service
  variants) — depends on L7 (a real peer target) per the Implementation DAG;
  not attempted.
- Driver contract test suite (§15.1 item 5) — no concrete driver exists.
- Property-based/generated test corpora — `fast-check` is deliberately not a
  dependency yet (§10.1, C-001).
