-- Locad WFM — Auth, roles, and upload/ingestion job tracking
-- Run once, after sql/schema.sql, against the same Supabase project.
--
-- Reconciles two things 'Cis flagged: (1) files should be uploaded through
-- the app by a logged-in admin/supervisor/manager, not via a CLI script;
-- (2) processing still takes minutes (DuckDB), so upload and processing are
-- two separate steps, connected by a Database Webhook — the upload lands
-- instantly, a worker (outside Vercel, see worker/README.md) is notified
-- automatically and does the actual DuckDB run.

-- ---------------------------------------------------------------------------
-- 1. Roles — one row per authenticated user
-- ---------------------------------------------------------------------------

create table if not exists user_roles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null check (role in ('admin', 'supervisor', 'manager')),
  display_name text,
  created_at timestamptz not null default now()
);

alter table user_roles enable row level security;

-- Everyone signed in can read the role list (needed to render the nav
-- correctly for other people's names in future admin screens); only an
-- admin can change roles.
create policy "roles readable by any signed-in user"
  on user_roles for select
  using (auth.role() = 'authenticated');

create policy "roles editable by admins only"
  on user_roles for all
  using (exists (select 1 from user_roles r where r.user_id = auth.uid() and r.role = 'admin'))
  with check (exists (select 1 from user_roles r where r.user_id = auth.uid() and r.role = 'admin'));

-- ---------------------------------------------------------------------------
-- 2. Ingestion jobs — one row per uploaded file, the thing the webhook
--    fires on. Status is what the /upload page polls to show progress.
-- ---------------------------------------------------------------------------

create table if not exists ingestion_jobs (
  id uuid primary key default gen_random_uuid(),
  storage_path text not null,          -- path inside the 'raw-uploads' bucket
  kind text not null check (kind in ('transactions', 'attendance', 'benchmark', 'brand_fallback', 'sku_map', 'name_map')),
  status text not null default 'pending' check (status in ('pending', 'processing', 'done', 'error')),
  error_message text,
  uploaded_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz
);

alter table ingestion_jobs enable row level security;

create policy "jobs readable by any signed-in user"
  on ingestion_jobs for select
  using (auth.role() = 'authenticated');

-- Only admin/supervisor/manager can create a job (i.e. upload) — this is
-- the actual access-control point 'Cis asked for, not just a UI hint.
create policy "jobs insertable by admin/supervisor/manager"
  on ingestion_jobs for insert
  with check (
    exists (
      select 1 from user_roles r
      where r.user_id = auth.uid() and r.role in ('admin', 'supervisor', 'manager')
    )
  );

-- The worker updates status using the service role key, which bypasses RLS
-- entirely — no policy needed for that path. No update policy is granted
-- to normal signed-in users; status changes only ever come from the worker.

-- ---------------------------------------------------------------------------
-- 3. Storage bucket for raw uploads
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('raw-uploads', 'raw-uploads', false)
on conflict (id) do nothing;

create policy "raw-uploads insertable by admin/supervisor/manager"
  on storage.objects for insert
  with check (
    bucket_id = 'raw-uploads'
    and exists (
      select 1 from user_roles r
      where r.user_id = auth.uid() and r.role in ('admin', 'supervisor', 'manager')
    )
  );

create policy "raw-uploads readable by any signed-in user"
  on storage.objects for select
  using (bucket_id = 'raw-uploads' and auth.role() = 'authenticated');

-- ---------------------------------------------------------------------------
-- 4. Database Webhook — automatic-on-upload, per 'Cis's choice.
--
-- Supabase Database Webhooks are configured in the dashboard (Database →
-- Webhooks), not purely in SQL, because the target URL is an env-specific
-- secret (the worker's endpoint). Steps for 'Cis:
--
--   1. Deploy the worker (see worker/README.md) and note its public URL,
--      e.g. https://wfm-worker.up.railway.app/process
--   2. Supabase dashboard → Database → Webhooks → Create a new webhook
--        Table: ingestion_jobs
--        Events: INSERT
--        Type: HTTP Request → POST https://<worker-url>/process
--        HTTP Headers: Authorization: Bearer <a shared secret you choose>
--          (the worker checks this header — see worker/server.ts)
--
-- This keeps the worker URL and shared secret out of this SQL file and out
-- of chat, consistent with how SUPABASE_URL/keys are handled.
-- ---------------------------------------------------------------------------
