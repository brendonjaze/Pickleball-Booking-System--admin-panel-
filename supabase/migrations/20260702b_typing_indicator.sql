-- ─── Open Play chat typing indicator ────────────────────────────────────────
-- Run in the Supabase SQL editor. Safe to re-run (idempotent).
--
-- One row per (session, person), refreshed while they type. A client shows
-- "typing…" when the other party's row was updated in the last ~4 seconds.
-- Rows are tiny and get deleted by the purge function with the session.

create table if not exists public.open_play_typing (
  session_id   uuid not null,              -- no FK: session may be purged first
  actor_token  text not null,              -- player device UUID, or 'organizer'
  actor_name   text,
  is_organizer boolean not null default false,
  updated_at   timestamptz not null default now(),
  primary key (session_id, actor_token)
);

alter table public.open_play_typing enable row level security;

-- Same trust level as open_play_messages (booking app runs on the anon key).
drop policy if exists "opt_select" on public.open_play_typing;
create policy "opt_select" on public.open_play_typing
  for select to anon, authenticated using (true);

drop policy if exists "opt_insert" on public.open_play_typing;
create policy "opt_insert" on public.open_play_typing
  for insert to anon, authenticated with check (true);

drop policy if exists "opt_update" on public.open_play_typing;
create policy "opt_update" on public.open_play_typing
  for update to anon, authenticated using (true) with check (true);

drop policy if exists "opt_delete" on public.open_play_typing;
create policy "opt_delete" on public.open_play_typing
  for delete to anon, authenticated using (true);

-- Booking app receives organizer-typing signals live.
do $$
begin
  alter publication supabase_realtime add table public.open_play_typing;
exception
  when duplicate_object then null;
end $$;
