-- Locad WFM — Supabase (Postgres) schema
-- Run this once against a fresh Supabase project (SQL editor, or `psql $DATABASE_URL -f sql/schema.sql`).
--
-- Design doctrine carried over from the project's agreed-operating-process.md:
--   * Standards (medians/percentiles) are computed OUTSIDE Postgres (by DuckDB at
--     ingestion, from the frozen, versioned benchmark files) and stored as plain
--     numbers here. Never recompute a median in SQL against filter context —
--     that was the exact DAX-median trap the project already hit once.
--   * curated_packing is line grain (one row per SKU line), matching the
--     project's data dictionary, and rebuilt from raw on every ingestion run
--     (upsert keyed on (order_code, event_time, sku, line_seq)) — never appended.
--   * Aggregation (SUM/COUNT/AVG of already-frozen numbers) is safe in SQL and
--     lives in the views at the bottom of this file — that is the only kind of
--     "computation" this database is allowed to do.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- 1. Reference / lookup tables (small, replaced wholesale on each upload)
-- ---------------------------------------------------------------------------

create table if not exists name_wms_mapping (
  employee_id text primary key,
  employee_name text not null,
  agency text,                         -- kept for reference only; NOT the
                                        -- canonical agency source (see decision:
                                        -- Employer Agency is sourced from attendance)
  transaction_user_login text unique,
  match_status text,                   -- 'matched' | 'UNMATCHED' — surfaced in UI,
                                        -- never silently dropped
  mixed_security_signal boolean default false,
  updated_at timestamptz not null default now()
);

create table if not exists sku_product_mapping (
  product_sku text not null,
  client text not null,
  product_name text not null,
  updated_at timestamptz not null default now(),
  primary key (product_sku, client)
);

-- One row per (client, signature), frozen and versioned per quarter.
-- 'usable' + 'spread_flag' decide whether a curated line can use this tier
-- or must fall back to brand_fallback.
create table if not exists benchmark_signature (
  client text not null,
  signature text not null,
  version text not null,               -- e.g. 'Q2 2026'
  lines_per_order int not null default 1,
  n_orders int not null default 0,
  p25 numeric,
  p50 numeric,
  p75 numeric,
  trimmed_mean numeric,
  spread_flag text,
  usable boolean not null default false,
  primary key (client, signature, version)
);

-- Brand-wide fallback standard, used when a signature has too few orders to
-- be usable on its own (decision: intentional, not a shortcut — some orders
-- only occur once).
create table if not exists brand_fallback (
  client text not null,
  version text not null,
  p25 numeric,
  p50 numeric,
  p75 numeric,
  trimmed_mean numeric,
  primary key (client, version)
);

-- ---------------------------------------------------------------------------
-- 2. Attendance — canonical source of Employer/Agency (decision, this round)
-- ---------------------------------------------------------------------------

create table if not exists attendance (
  employee_id text not null,
  work_date date not null,             -- the shift's calendar date, as exported
  employer text,                       -- canonical "Employer Agency" for View 2
  shift_name text,
  sign_in_time timestamptz,
  sign_out_time timestamptz,
  shift_start_time timestamptz,
  shift_end_time timestamptz,
  delay_mins numeric,
  normal_hours numeric,
  overtime_hours numeric,
  primary key (employee_id, work_date, shift_name)
);

create index if not exists idx_attendance_employee_date
  on attendance (employee_id, work_date);

-- ---------------------------------------------------------------------------
-- 3. curated_packing — line grain, rebuilt from raw every ingestion run
-- ---------------------------------------------------------------------------

create table if not exists curated_packing (
  order_code text not null,
  event_time timestamptz not null,
  sku text not null,
  line_seq int not null default 1,
  packer_login text not null,
  client text not null,
  work_date date not null,
  hour_of_day int not null,
  signature text not null,             -- identifier only, never a chart dimension
  n_lines int not null default 1,
  pack_qty numeric,
  uom_qty numeric,
  order_duration_min numeric,          -- null unless duration_flag = 'ok'
  line_duration_min numeric,
  raw_gap_min numeric,                 -- kept even when rejected — the audit trail
  duration_flag text not null,         -- 'ok' | 'no_next_action' | 'exceeds_max_gap'
  next_action_type text,               -- for task-switch overhead detection
  target_location text,                -- "Packing Station #" — Packing-type rows only,
                                        -- diagnostic tag, never a benchmark key
  order_type text not null default 'B2C',
  -- Benchmark resolved once at ingestion (frozen), never recomputed in SQL:
  bench_tier text not null,            -- 'signature' | 'brand_fallback'
  bench_p25 numeric,
  bench_p50 numeric,
  bench_p75 numeric,
  bench_trimmed numeric,
  primary key (order_code, event_time, sku, line_seq)
);

create index if not exists idx_curated_client_date on curated_packing (client, work_date);
create index if not exists idx_curated_packer_date on curated_packing (packer_login, work_date);
create index if not exists idx_curated_hour on curated_packing (work_date, hour_of_day);

-- ---------------------------------------------------------------------------
-- 4. Station hardware status — single current value per station, no history
--    (decision: worker↔station is already derivable from target_location on
--    every order; this table is ONLY the manual hardware-condition dropdown)
-- ---------------------------------------------------------------------------

create table if not exists station_status (
  target_location text primary key,
  bench_status text not null default 'active',   -- 'active' | 'idle' | 'maintenance'
  hardware_health text not null default 'ok',     -- 'ok' | 'lagging' | 'printer_jam' | 'offline'
  updated_at timestamptz not null default now(),
  updated_by text
);

-- ---------------------------------------------------------------------------
-- 5. View 1 — Per Brand Execution, aggregated per (client, work_date)
--    Order-level dedupe happens here: order_duration_min repeats across a
--    multi-line order's SKU lines, so distinct-order stats must select
--    order-grain rows first, matching the project's "grain trap" rule.
-- ---------------------------------------------------------------------------

create or replace view brand_daily_agg as
with order_grain as (
  select distinct on (order_code, packer_login, event_time)
    client, work_date, order_code, order_type, duration_flag,
    order_duration_min, raw_gap_min, bench_tier, bench_p25, bench_p50, bench_p75, bench_trimmed
  from curated_packing
  order by order_code, packer_login, event_time
)
select
  client,
  work_date,
  order_type,
  count(*) as total_orders,
  count(*) filter (where bench_tier = 'signature') as orders_on_signature_tier,
  count(*) filter (where bench_tier = 'brand_fallback') as orders_on_fallback_tier,
  sum(order_duration_min) filter (where duration_flag = 'ok') as actual_minutes,
  sum(bench_p50) filter (where duration_flag = 'ok') as std_minutes_p50,
  sum(bench_p25) filter (where duration_flag = 'ok') as std_minutes_p25,
  sum(bench_p75) filter (where duration_flag = 'ok') as std_minutes_p75,
  sum(bench_trimmed) filter (where duration_flag = 'ok') as std_minutes_trimmed,
  -- Unattributed idle: gaps rejected by max_plausible_duration_min — "we don't
  -- know", never charged to a person. Feeds OLE's Availability term.
  sum(raw_gap_min) filter (where duration_flag = 'exceeds_max_gap') as unattributed_min,
  count(*) filter (
    where duration_flag = 'ok' and order_duration_min > bench_p50
  ) as flagged_slow_orders
from order_grain
group by client, work_date, order_type;

-- ---------------------------------------------------------------------------
-- 6. View 2 — Packer Overview, aggregated per (packer_login, work_date)
-- ---------------------------------------------------------------------------

create or replace view packer_daily_agg as
with order_grain as (
  select distinct on (order_code, packer_login, event_time)
    packer_login, client, work_date, hour_of_day, order_type, duration_flag,
    order_duration_min, raw_gap_min, bench_p50
  from curated_packing
  order by order_code, packer_login, event_time
)
select
  packer_login,
  work_date,
  order_type,
  count(*) as total_orders,
  sum(order_duration_min) filter (where duration_flag = 'ok') as actual_minutes,
  sum(bench_p50) filter (where duration_flag = 'ok') as std_minutes_p50,
  sum(raw_gap_min) filter (where duration_flag = 'exceeds_max_gap') as unattributed_min,
  count(*) filter (
    where duration_flag = 'ok' and order_duration_min > bench_p50
  ) as flagged_slow_orders
from order_grain
group by packer_login, work_date, order_type;

create or replace view packer_hourly_agg as
select
  packer_login,
  work_date,
  hour_of_day,
  order_type,
  count(distinct order_code) as orders_packed
from curated_packing
group by packer_login, work_date, hour_of_day, order_type;
