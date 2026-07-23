-- ─── Open Play chat reactions + revenue log ─────────────────────────────────
-- Run this in the Supabase SQL editor (or `supabase db push`).
-- Safe to re-run: everything is IF NOT EXISTS / idempotent.

-- 1) Emoji reactions on chat messages ----------------------------------------

create table if not exists public.open_play_message_reactions (
  id            bigint generated always as identity primary key,
  message_id    bigint not null references public.open_play_messages(id) on delete cascade,
  reactor_token text   not null,           -- player device UUID, or 'organizer'
  reactor_name  text,
  is_organizer  boolean not null default false,
  emoji         text   not null check (emoji in ('👍','❤️','😆','😮','😢','😡')),
  created_at    timestamptz not null default now(),
  unique (message_id, reactor_token)       -- one reaction per person per message
);

create index if not exists idx_opmr_message_id
  on public.open_play_message_reactions (message_id);

alter table public.open_play_message_reactions enable row level security;

-- Same trust level as open_play_messages: the booking app runs on the anon key.
drop policy if exists "opmr_select" on public.open_play_message_reactions;
create policy "opmr_select" on public.open_play_message_reactions
  for select to anon, authenticated using (true);

drop policy if exists "opmr_insert" on public.open_play_message_reactions;
create policy "opmr_insert" on public.open_play_message_reactions
  for insert to anon, authenticated with check (true);

drop policy if exists "opmr_update" on public.open_play_message_reactions;
create policy "opmr_update" on public.open_play_message_reactions
  for update to anon, authenticated using (true) with check (true);

drop policy if exists "opmr_delete" on public.open_play_message_reactions;
create policy "opmr_delete" on public.open_play_message_reactions
  for delete to anon, authenticated using (true);

-- Live updates in the booking app. REPLICA IDENTITY FULL makes DELETE events
-- carry the full old row (needed so clients know which message lost a reaction).
alter table public.open_play_message_reactions replica identity full;

do $$
begin
  alter publication supabase_realtime add table public.open_play_message_reactions;
exception
  when duplicate_object then null;
end $$;

-- 2) Revenue snapshots taken just before a session is purged -----------------

create table if not exists public.open_play_revenue_log (
  id               bigint generated always as identity primary key,
  session_id       uuid not null unique,   -- no FK: the session row gets deleted
  date             text not null,          -- YYYY-MM-DD (matches open_play_sessions.date)
  players          integer not null default 0,
  price_per_player numeric not null default 0,
  total            numeric not null default 0,
  purged_at        timestamptz not null default now()
);

create index if not exists idx_oprl_date on public.open_play_revenue_log (date);

alter table public.open_play_revenue_log enable row level security;

-- Admin (authenticated) reads it for the Revenue tab; only the service-role
-- Edge Function writes it (service role bypasses RLS, so no write policy).
drop policy if exists "oprl_select" on public.open_play_revenue_log;
create policy "oprl_select" on public.open_play_revenue_log
  for select to authenticated using (true);
