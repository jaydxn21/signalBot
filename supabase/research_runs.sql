-- supabase/research_runs.sql
-- Schema for the Auto-Researcher's persisted reports (engine/research/store.js).
-- Run this once in the Supabase SQL editor (or via `psql`) for the project
-- referenced by SUPABASE_URL/SUPABASE_SERVICE_KEY in your .env.
--
-- If these tables are not created, engine/research/store.js automatically
-- falls back to local JSON files under data/ — nothing breaks, you just
-- lose the shared/cloud dashboard view until the tables exist.

create table if not exists research_runs (
  id uuid primary key default gen_random_uuid(),
  cycle_id text not null,
  symbol text not null,
  timeframe_seconds integer not null,
  strategy_id text not null,
  params jsonb,
  candle_count integer,
  is_stats jsonb,
  oos_stats jsonb,
  score numeric,
  grade text,
  verdict text,
  warnings jsonb,
  is_winner boolean default false,
  created_at timestamptz not null default now()
);

create index if not exists research_runs_created_at_idx on research_runs (created_at desc);
create index if not exists research_runs_symbol_strategy_idx on research_runs (symbol, strategy_id);
create index if not exists research_runs_cycle_id_idx on research_runs (cycle_id);

create table if not exists model_versions (
  id uuid primary key default gen_random_uuid(),
  version_tag text not null,
  model_path text,
  trained_on_count integer,
  accuracy numeric,
  feature_importance jsonb,
  created_at timestamptz not null default now()
);

create index if not exists model_versions_created_at_idx on model_versions (created_at desc);

-- Optional: enable Row Level Security + a read-only policy if you expose
-- these tables to an authenticated dashboard client instead of only the
-- service-role key used by the Node researcher.
-- alter table research_runs enable row level security;
-- create policy "Allow read for authenticated users" on research_runs
--   for select using (auth.role() = 'authenticated');
