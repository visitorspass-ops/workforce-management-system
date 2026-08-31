# WFM ingestion worker

Always-on Node process that runs the real DuckDB pipeline (`ingest-core/run.ts`)
when a file lands in Supabase Storage. It exists because Vercel serverless
functions have a hard time limit and DuckDB over 6.5M+ rows takes minutes —
so ingestion runs here, on a small process that's simply left running,
never on Vercel.

## How it's wired to the app

1. Someone with the admin/supervisor/manager role uploads files on `/upload`
   in the Next.js app.
2. The app uploads each file to the `raw-uploads` Storage bucket, then
   inserts a row into `ingestion_jobs` (see `sql/auth_and_jobs.sql`).
3. A **Supabase Database Webhook** (configured by hand in the Supabase
   dashboard — not in code, since the worker's URL and shared secret are
   environment-specific) fires on that INSERT and POSTs to this worker's
   `/process` endpoint.
4. This worker downloads the current files, runs `runIngestion()`, and
   updates the job's `status` to `done` or `error`. The upload page polls
   `ingestion_jobs` and shows the result.

## Configuring the webhook (Supabase dashboard)

Database → Webhooks → Create a new webhook:
- Table: `ingestion_jobs`
- Events: `INSERT`
- Type: HTTP Request → `POST` to `https://<your-worker-host>/process`
- Headers: `Authorization: Bearer <WEBHOOK_SECRET>` — same value as this
  worker's `WEBHOOK_SECRET` env var. Generate a long random string for
  this; never reuse another secret.

## Environment variables

Set these wherever the worker runs (never commit them, never paste them
in chat):

| Var | Where to find it |
|---|---|
| `WEBHOOK_SECRET` | Value you invent — must match the webhook's Authorization header |
| `SUPABASE_URL` | Project Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | Project Settings → API (service role, not anon — this worker bypasses RLS to read every uploaded file and write results) |
| `DATABASE_URL` | Project Settings → Database → Connection string (session pooler recommended) |
| `MAX_PLAUSIBLE_DURATION_MIN` | Optional, defaults to 60 — same open parameter as the CLI script |
| `PORT` | Optional, defaults to 8787 |

## Hosting options

This is a plain Node HTTP server — any host that runs a long-lived
container works. No specific host is required; pick whichever is
convenient:

- **Railway** — new project → Deploy from repo → set root/Dockerfile path
  to `worker/Dockerfile`, build context to the repo root → add the env
  vars above → deploy. Railway gives you the public URL to put in the
  webhook config.
- **Fly.io** — `fly launch` pointed at `worker/Dockerfile` with the repo
  root as context (`fly launch --dockerfile worker/Dockerfile`), then
  `fly secrets set WEBHOOK_SECRET=... SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... DATABASE_URL=...`.
- **Render** — New → Web Service → Docker → Dockerfile path
  `worker/Dockerfile`, root directory left at the repo root so the build
  context includes `ingest-core/`.
- **A plain VM** — `docker build -f worker/Dockerfile -t wfm-worker .` from
  the repo root, then `docker run -p 8787:8787 --env-file .env wfm-worker`.

Whichever host is chosen, the important constraints are: it must stay
running (not scale to zero on a schedule that could miss a webhook — a
missed call just means a job stays `pending`, which is recoverable by
re-uploading, but avoid it if possible), and it needs outbound network
access to Supabase Storage and Postgres.

## Local development

```
cd worker
npm install
WEBHOOK_SECRET=dev SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... DATABASE_URL=... npm start
```

Then point the Supabase webhook at a tunnel (e.g. `ngrok http 8787`) while
testing, or just call `POST /process` by hand with a job's real `id`:

```
curl -X POST http://localhost:8787/process \
  -H "Authorization: Bearer dev" \
  -H "Content-Type: application/json" \
  -d '{"record": {"id": "<a real ingestion_jobs.id>"}}'
```

## What this does NOT do

- It does not validate file contents beyond what `ingest-core/run.ts`
  already assumes (real column names/headers per source type) — a
  malformed file fails the job with `error_message` set, it doesn't
  silently skip bad rows.
- It does not retry failed jobs automatically. A failed job is visible in
  `/upload`'s recent-uploads list; re-uploading the same file creates a new
  job and retries.
- It does not deduplicate concurrent webhook deliveries — Supabase
  webhooks are effectively at-least-once. Two jobs racing on overlapping
  work_dates both do a DELETE+INSERT for those dates, so the last one to
  finish wins; this matches the "rebuild from raw" model rather than
  something order-sensitive.
