-- meshscript Supabase schema
-- STORAGE ONLY, NO AUTH. Rows are scoped by an anonymous device_id.
--
-- SECURITY TRADE-OFF (documented intentionally):
--   There is no user authentication. Access is via the anon key + permissive
--   RLS. Anyone holding the anon key could read/write rows. This is acceptable
--   for a private 2-3 user personal tool. Do NOT expose the anon key publicly.

create extension if not exists pgcrypto;

create table if not exists public.sessions (
  id uuid primary key default gen_random_uuid(),
  device_id text not null,
  subject text,
  task_text text,
  created_at timestamptz not null default now()
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  device_id text not null,
  role text not null check (role in ('user','assistant','system')),
  content text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_sessions_device on public.sessions(device_id);
create index if not exists idx_messages_session on public.messages(session_id);
create index if not exists idx_sessions_created on public.sessions(created_at);

-- Row Level Security: enable, then allow anon full access (device scoping is
-- enforced client-side via the device_id filter; see security trade-off above).
alter table public.sessions enable row level security;
alter table public.messages enable row level security;

drop policy if exists anon_all_sessions on public.sessions;
create policy anon_all_sessions on public.sessions
  for all to anon using (true) with check (true);

drop policy if exists anon_all_messages on public.messages;
create policy anon_all_messages on public.messages
  for all to anon using (true) with check (true);

-- 7-DAY TTL via pg_cron.
create extension if not exists pg_cron;

create or replace function public.purge_old_meshscript_data()
returns void language sql as $$
  delete from public.messages where created_at < now() - interval '7 days';
  delete from public.sessions where created_at < now() - interval '7 days';
$$;

-- Run daily at 03:00 UTC. (Re-running schedule with same name errors; unschedule first if needed.)
select cron.schedule('meshscript_purge', '0 3 * * *', $$select public.purge_old_meshscript_data();$$);
