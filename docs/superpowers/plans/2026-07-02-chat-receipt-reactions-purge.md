# Implementation Plan — Chat Receipts, Reactions, Scheduled Purge

Spec: `docs/superpowers/specs/2026-07-02-chat-receipt-reactions-purge-design.md`

## Task 1 — Supabase artifacts (new `supabase/` dir in admin repo)
1. `supabase/migrations/20260702_chat_reactions_revenue_log.sql`
   - `open_play_message_reactions` (bigint PK, message_id bigint FK cascade, reactor_token, reactor_name, is_organizer, emoji CHECK in 6, created_at; UNIQUE(message_id, reactor_token); index on message_id; RLS permissive anon+authenticated; add to realtime publication)
   - `open_play_revenue_log` (session_id uuid UNIQUE, date text, players int, price_per_player numeric, total numeric, purged_at; RLS select for authenticated + anon select none; service role writes)
2. `supabase/functions/purge-ended-open-play/index.ts` — Deno Edge Function, service role:
   - compute now in Asia/Manila; select all sessions; filter ended (end_time <= start_time → +1 day; null end → next-day midnight)
   - per session: upsert revenue log → collect message image_urls → storage.remove parsed `openplay-receipts` paths (errors logged, non-fatal) → delete messages, join_requests, queue, session
   - returns {checked, purged, errors[]}
3. `supabase/DEPLOY.md` — exact owner steps (SQL editor, functions deploy, Cron schedule hourly + SQL fallback).

## Task 2 — Admin panel (`src/main.js`, `src/style.css`)
1. Receipt viewer: add `#receipt-modal` HTML to renderApp(); wire close (✕/backdrop/Escape); reuse existing `openReceiptModal`/`closeReceiptModal` (un-orphan them).
2. Chat images clickable: `org-chat-img` class + delegated click on `#org-chat-scroll` → openReceiptModal.
3. Reactions:
   - const `REACTION_EMOJIS = ['👍','❤️','😆','😮','😢','😡']`
   - API: `fetchReactionsFor(messageIds)` (one `in.()` query), `upsertReaction(messageId, emoji)` (POST with `Prefer: resolution=merge-duplicates` on conflict target), `deleteMyReaction(messageId)` (`reactor_token=eq.organizer`)
   - renderOrganizerChat: fetch reactions with messages each poll; chips row under bubble (own chip highlighted); `🙂+` opens picker; picker tap = upsert/toggle-delete; delegated events on scroll container
   - style.css: chip, picker, affordance styles
4. Revenue log: `fetchOpenPlayRevenueData` also pulls `open_play_revenue_log` (catch → []); `openPlayRevenue` adds log rows matching prefix.
5. Cleanup (#6): fix "never deleted" comment; remove dead `deleteCourtLock`, `getRelativeDay` (receipt modal fns now used).

## Task 3 — Booking app (`../Pickleball booking system/index.html`)
1. Lightbox: clickable chat images (`op-chat-img`) → fullscreen overlay, tap to close.
2. Reactions: same emoji const; chips + picker in `opRenderChat`; upsert via `db.from('open_play_message_reactions').upsert(..., {onConflict:'message_id,reactor_token'})`; toggle-off via delete; identity = `opPlayerToken()` / opName.
3. Realtime: subscribe to reactions table changes for the open session's messages → re-render; also refresh on existing message events.

## Task 4 — Verify
- Admin: `npm run build` clean; manual smoke via dev server if asked.
- Booking app: `npm run build` (repo has vite) clean.
- Sanity: reactions REST calls against live DB (read-only where possible).

Order: 1 → 2 → 3 → 4. Git: user commits.
