# Crewline prototype

Crewline is a lightweight, mobile-first workforce and volunteer scheduling prototype. It is intentionally usable without a backend for the first walkthrough: seeded data is stored in `localStorage`, so opportunity responses and availability changes persist on the device.

## Run locally

Because this is a buildless static prototype, any static server works:

```bash
python3 -m http.server 4173 --directory dist
```

Then open <http://localhost:4173>. Use **Reset demo** in the top-right to restore seeded data.

## Deploy a static prototype to Cloudflare Pages

With Wrangler authenticated, run:

```bash
npx wrangler pages deploy dist --project-name crewline-prototype
```

This first prototype uses local browser storage so the UI can be exercised immediately. For the production pass, move the state behind the Worker/D1 API described below; do not treat local storage as the source of truth for staffing or pay.

## Product architecture

The intended production shape is a small Cloudflare Worker serving the static frontend, with D1 as the source of truth and R2 only for optional profile photos/documents. Authentication should be passwordless: magic link or verification code, with server-side durable sessions in HttpOnly, SameSite cookies and revocation support. The browser should never hold authentication secrets.

Suggested request flow: `static frontend → Worker API → D1`; email notifications can be queued through a Worker Queue, while `.ics` downloads and a subscribable calendar feed are generated from canonical assignments. Keep the event/assignment record canonical so changes update one calendar entry rather than generating invitation spam.

## MVP routes

- `/schedule` — worker schedule and event detail
- `/opportunities` — open shifts with accept/decline and scheduler approval
- `/people` — searchable directory, role management and CSV import/export
- `/availability` — date and blackout availability
- `/timesheets` — submitted hours, minimum-call calculation and CSV export
- `/admin/events/new` — event and role-requirement creation
- `/admin/events/:id/staff` — fast staffing screen with availability/conflict flags

## D1 schema proposal

Core tables: `organizations`, `users`, `organization_members`, `roles`, `person_roles`, `events`, `event_role_requirements`, `assignments`, `opportunity_responses`, `availability_blocks`, `messages`, `timesheets`, `notifications`, `audit_log`, and `sessions`.

Important design choices:

- `organization_members` makes multi-organization accounts possible while the MVP can default to one organization.
- `person_roles` is many-to-many. `assignments` snapshots `hourly_rate_cents` and `minimum_call_minutes` so historical pay cannot change when defaults change.
- `events` own the canonical date/time and location; `assignments` can coexist on the same date and only flag actual time overlap.
- `event_role_requirements` tracks required and filled counts without duplicating assignments.
- `availability_blocks` stores all-day or partial-day ranges with `available`, `unavailable`, or `tentative` status.
- `timesheets` store scheduled/actual times, break minutes, adjusted/approved hours, and audit notes. Overtime stays configurable through organization settings rather than hard-coding labor law.

## Security and privacy notes

Use invite-scoped magic-link tokens with short expiry, hash tokens at rest, rate-limit requests, and revoke sessions server-side. Enforce organization membership on every query. Phone/email directory visibility must be an organization policy. Audit changes to assignments, times, pay rates, timesheets, cancellations, and overrides. Never trust client-submitted pay calculations.

## Feature sizing

Easy: roles, multi-role people, events, schedule, opportunity response, estimated pay, minimum-call calculation, ICS output, CSV export.

Moderate: passwordless auth and trusted-device sessions, CSV preview/mapping/duplicate detection, conflict-aware staffing, availability ranges, event messaging, audit log.

Harder: production email delivery/retries, calendar subscription semantics, payroll adapters, two-way Google Calendar sync, multi-org permission edge cases.

## Cloudflare direction

The first backend pass is now included in `src/index.js` and `migrations/`. The Worker exposes `/api/health`, `/api/bootstrap`, `POST /api/opportunities/:id/respond`, `POST /api/availability`, and `POST /api/timesheets`. The UI hydrates from `/api/bootstrap` when the API is available and keeps the local demo fallback for offline walkthroughs.

The D1 database is `crewline-prod`, configured as binding `DB`. Apply future migrations with:

```bash
npx wrangler d1 migrations apply crewline-prod --remote
npx wrangler deploy
```

The current Worker deployment is `crewline-prototype`. Authentication and organization-level authorization are intentionally the next backend layer; the current seeded API is for the prototype workspace only and must not be treated as a secure multi-tenant production app yet.

Authentication foundation is now present in migration `0003_auth.sql` and `src/index.js`: users, organization memberships, hashed one-time codes, 90-day server-side sessions, logout, and `/api/auth/me`. Set `AUTH_DEV_MODE=true` only in a local environment to receive a test code in the API response. Production email delivery is intentionally not enabled yet; the next step is connecting Cloudflare Email Service or another transactional email provider, then gating data mutations on the authenticated session and organization role.
