# Locad WFM Dashboard — View 1 & View 2

Next.js (App Router) app: authenticated shell with a role-gated nav (View 1, View 2, Upload),
reading from Supabase Postgres. Curation and benchmarking happen outside the request path, in
`ingest-core/run.ts` (DuckDB) — run manually via `scripts/ingest.ts` or automatically by
`worker/server.ts` when a file is uploaded in-app — never as a live query. See `sql/schema.sql`'s
header comment for why.

## Architecture in one paragraph

A signed-in admin/supervisor/manager uploads files on `/upload`. The app stores them in Supabase
Storage and inserts an `ingestion_jobs` row; a Supabase Database Webhook fires on that insert and
calls the standalone worker (`worker/`), which re-runs the full DuckDB pipeline and writes results
into Postgres. View 1 and View 2 (`app/(app)/view1`, `app/(app)/view2`) only ever do cheap reads
against the pre-aggregated tables/views that pipeline produces — no live recomputation, no
per-request medians. Auth and the nav/role gate live in `middleware.ts`, `lib/auth.ts`, and
`components/Sidebar.tsx` — see "Auth & the shared shell" below.

## Environment variables

### Next.js app (set in the Vercel project dashboard, never in chat)

| Variable | Used by | Notes |
|---|---|---|
| `SUPABASE_URL` | Server-side dashboard reads (`lib/supabase/server.ts`) | Project Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-side dashboard reads | Service role, not anon — View 1/2 read pre-aggregated views not meant for direct browser access |
| `NEXT_PUBLIC_SUPABASE_URL` | Browser + middleware auth clients | Project Settings → API — same value as `SUPABASE_URL`, just exposed as a public var since the browser needs it for sign-in |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Browser + middleware auth clients | Project Settings → API — anon key, RLS applies; this is the one that's safe to ship to the browser |

### Ingestion (CLI script and/or worker — never on Vercel)

| Variable | Used by | Notes |
|---|---|---|
| `DATABASE_URL` | `scripts/ingest.ts`, `worker/server.ts` | Project Settings → Database → Connection string (session pooler) |
| `MAX_PLAUSIBLE_DURATION_MIN` | Both (optional) | Defaults to 60 — still an open parameter per the project's canon doc, not empirically finalized |
| `WEBHOOK_SECRET`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `PORT` | `worker/server.ts` only | See `worker/README.md` |

## First-time setup

1. Create the schema: run `sql/schema.sql` then `sql/auth_and_jobs.sql` once against a fresh
   Supabase project (SQL editor, or `psql`).
2. In Supabase Auth, create the first admin account by hand and add a matching row to
   `user_roles` (`role = 'admin'`) — everyone after that can be invited and assigned a role from
   inside that account's own tooling, or by an admin inserting more `user_roles` rows directly for
   now (no in-app user-management screen yet, see below).
3. Deploy the worker (`worker/`) somewhere that stays running — see `worker/README.md` for hosting
   options — and configure the Supabase Database Webhook to call it (also in `worker/README.md`).
4. Deploy the Next.js app (this repo) to Vercel with the app env vars above set.
5. Sign in at `/login` and upload data at `/upload`. Processing starts automatically; the page
   polls and shows status.

Ingestion can also be run by hand instead of/alongside the webhook, e.g. for a first bulk backfill:
```
npm install
npm run ingest -- \
  --tx ./data/transactions \
  --attendance ./data/attendance \
  --benchmark ./data/signal1_line_benchmark__Q2.csv \
  --fallback ./data/brandlevel_fallback__Q2.csv \
  --skumap ./data/sku_product_name_mapping.csv \
  --namemap ./data/name_wms_mapping.csv
```
`--tx` and `--attendance` are directories — drop in as many `.csv`/`.xlsx` files as you have (any
mix of formats); every file in the directory is picked up automatically.

## Auth & the shared shell

Per 'Cis's correction to the original CLI-only design ("shouldn't the app request for data? ...
the views mean that they exist in one area, just different barrier"): View 1, View 2, and Upload
are one app with one nav (`components/Sidebar.tsx`), not separate tools. `middleware.ts` blocks
`/view1`, `/view2`, `/upload` for anyone not signed in via Supabase Auth (fresh email/password or
magic link — not Locad SSO, per 'Cis's choice to start simple). `app/(app)/layout.tsx` additionally
handles a signed-in account with no role yet (shows "Access pending" rather than a broken nav).
Role currently only controls what's *shown* in the nav (`lib/nav.ts`'s `NAV_ITEMS`) — the real
access control for who can insert an `ingestion_jobs` row or write to `raw-uploads` is Postgres
RLS in `sql/auth_and_jobs.sql`, so a role check in the UI is a convenience, not the security
boundary.

## Why ingestion doesn't run on Vercel

At real volume (6.5M+ raw rows across Feb–Aug per the project's own historical pull) this takes
minutes, not the ~10–60s a Vercel serverless function gets. It runs on the standalone worker
(`worker/`, always-on, triggered by a Supabase webhook) or by hand via `scripts/ingest.ts` — both
call the same shared pipeline in `ingest-core/run.ts`, so a rule fixed once is fixed for both
paths. The deployed Next.js app only ever does cheap, indexed reads against the tables/views that
pipeline produces.

## What's implemented in this pass

- Auth (Supabase Auth, password + magic link), role-gated shared shell/nav, and an in-app upload
  flow (`/upload`) that triggers automatic processing — replacing the earlier CLI-only ingestion
  path.
- Standalone worker service (`worker/`) that the Supabase Database Webhook calls; shares its
  pipeline with the CLI script via `ingest-core/run.ts` so the two never diverge.
- Attendance is now actually pushed to Postgres during ingestion (`pg.attendance`) — the original
  CLI script staged it in DuckDB but never wrote it out; fixed using the real April.csv column
  schema (`Employee ID`, `Employer`, `Shift Name`, `Sign In/Out Time`, `Shift Start/End Time`,
  `Delay (mins)`, `Normal Hours`, `Overtime Hours`).
- View 1 (Per Brand Execution): OLE gauge with score-based color, hero cards, brand table
  including a Bench Tier column (signature vs. brand-fallback %, so a brand running mostly on
  fallback is visible, not silent).
- View 2 (Packer Overview): leaderboard with the weekly confidence floor actually gating who's
  ranked (excluded <10 orders, flagged 10–24), a 24-hour scrollable hourly heatmap (fixes the
  6am–10pm window that was blind to night-shift hours), "Net SvA Balance" (total hours) vs.
  "Net SvA Performance" (per-order rate) as two distinct labeled metrics, and green station-badge
  pills sourced from `curated_packing.target_location` (no separate assignment state needed).

## Deliberately not done this pass

- In-app user/role management (assigning roles is currently a direct `user_roles` insert, not a
  UI) — flagged as a loose end, not a decision to skip it permanently.
- Top 5 / Bottom 5 leaderboard compression (full list renders for now — data correctness came
  first; the compression toggle is a follow-up UI pass, not a data change).
- Drawers (A–E), Exceptions log, SKU affinity, Capacity Planner, Team Allocation, station hardware
  status editor — out of scope for this build (View 1 + View 2 only, per 'Cis's sequencing call).
- Automatic retry of a failed ingestion job — re-uploading the file creates a fresh job; see
  `worker/README.md`.
