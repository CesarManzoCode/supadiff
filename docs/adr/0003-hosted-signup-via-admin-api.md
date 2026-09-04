# ADR-0003: `supabase-hosted` implements `auth.signUp` via the real GoTrue admin API

## Context

L13's real acceptance gate runs the canonical Data + Auth + owner-scoped RLS
scenario (`scn.peer-data-auth-rls-smoke`) against a real hosted Supabase
project — the dedicated throwaway project `supadiff-v1-smoke`. That scenario
begins with an `auth.signUp` step whose returned session authorizes every
subsequent RLS-gated data operation.

Two facts about the dedicated project block the public `POST /auth/v1/signup`
mailer flow:

1. **No SMTP is configured.** With email confirmation on (the platform
   default) and no mailer, `/signup` returns without a session and, on
   repeat, `over_email_send_rate_limit` (2/hour).
2. **The supplied Management API token is project-scoped.** It can call
   `GET /v1/projects/{ref}`, `GET .../api-keys`, and `POST .../database/query`,
   but `PATCH /v1/projects/{ref}/config/auth` returns `403` — so the driver
   cannot toggle `mailer_autoconfirm` to make `/signup` return a session.

## Decision

The `supabase-hosted` driver intercepts `auth.signUp` (the same way it
intercepts `schema.apply`) and implements it as:

1. `supabase.auth.admin.createUser({ email, password, email_confirm: true })`
   through a **real** service-role GoTrue admin client, then
2. `supabase.auth.signInWithPassword({ email, password })` through a **real**
   anon GoTrue client to obtain the session,

and binds the resulting real access/refresh tokens to the actor exactly as
the shared REST dispatch does for the Supalite / `supabase-local` path.

Every byte of authentication is performed by the hosted project's real
GoTrue service. Nothing is mocked, stubbed, or faked. The only difference
from the other drivers is _which_ real GoTrue endpoint creates the confirmed
user — `admin/users` instead of the mailer-gated `signup`.

## Alternatives considered

1. **A dedicated hosted scenario using `auth.signInWithPassword` against a
   SQL-seeded `auth.users` row.** Works, but requires hand-maintaining a
   GoTrue-compatible bcrypt/`auth.identities` seed and diverges the hosted
   acceptance scenario from the shared canonical one for no behavioral gain.
2. **Requiring the operator to pre-configure SMTP + autoconfirm on the
   project.** Pushes non-reproducible manual setup onto every hosted run and
   still needs a fallback.
3. **Skipping Auth on hosted.** Rejected — RLS is the most valuable thing to
   prove against a real hosted project.

## Evidence

- `packages/targets/src/supabase-hosted/session.ts` — `#handleHostedSignUp`.
- `SUPADIFF_HOSTED=1 pnpm test:integration:hosted-smoke` — the RLS assertions
  (owner sees the owned row, anon sees nothing) run on the session this path
  produces, against real hosted PostgREST.
- Recorded as an explicit unproven/accommodated surface in
  `release-evidence/v1.0.0.json` and `docs/LIMITATIONS.md`.

## Consequences

- The hosted driver's `auth.signUp` observable shape (`/status`,
  `/user/email`, `/user/id`, `/session`) matches the other drivers', so the
  canonical scenario runs unmodified.
- `auth.signUp` failure modes that are specific to the public mailer flow
  (confirmation-token handling, rate limiting) are not exercised on hosted.
- If a future hosted project is provisioned with SMTP + autoconfigured
  confirmation, this interception can be removed without touching the
  scenario.
