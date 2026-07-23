# Open Play Chat: Clickable Receipts, Emoji Reactions, Scheduled Purge — Design

**Date:** 2026-07-02
**Repos affected:**
- Admin panel (this repo) — `src/main.js`, `src/style.css`
- Booking app (`C:\Users\brendon.lambago\Pickleball booking system\index.html`)
- Supabase (SQL migration + Edge Function, deployed by the owner)

## Goals

1. **Clickable receipt images** in the Open Play session chat (admin and player side) — tap to view full-size.
2. **Messenger-style emoji reactions** on chat messages — 👍 ❤️ 😆 😮 😢 😡 — usable by **both** the organizer (admin) and players.
3. **Scheduled server-side purge** after a session ends: delete its chat messages, receipt image files (Supabase Storage `openplay-receipts` bucket), registrations (`open_play_queue`), join requests (`open_play_join_requests`), and the session row itself.
4. **Revenue preservation:** Open Play revenue now shows in the admin Revenue tab (players × `price_per_player`). Because the purge deletes registrations, the purge must first **snapshot each session's revenue** into a permanent `open_play_revenue_log` table, and the admin combines live data + log.

## Non-goals

- No reactions on court bookings, announcements, or anything outside Open Play chat.
- No read receipts, typing indicators, or message editing.
- No admin UI for browsing the revenue log (it only feeds the Revenue tab numbers).

## Data model (Supabase migration)

### `open_play_message_reactions` (new)

| column | type | notes |
|---|---|---|
| `id` | `bigint` identity PK | |
| `message_id` | `bigint` FK → `open_play_messages(id)` `ON DELETE CASCADE` (verified: messages PK is bigint) | |
| `reactor_token` | `text` | player: device UUID from `opPlayerToken()`; organizer: literal `'organizer'` |
| `reactor_name` | `text` | display name snapshot |
| `is_organizer` | `boolean` default false | |
| `emoji` | `text` | one of the six; CHECK constraint |
| `created_at` | `timestamptz` default `now()` | |

- `UNIQUE (message_id, reactor_token)` — one reaction per person per message. Changing your reaction replaces it (upsert with `resolution=merge-duplicates`); tapping the same emoji again deletes it (toggle off).
- Index on `message_id`.
- RLS: permissive `select`/`insert`/`update`/`delete` for `anon` + `authenticated`, mirroring the existing `open_play_messages` trust level (the booking app runs entirely on the anon key; client scopes actions by its own token). This is the same trust model already accepted for chat itself.
- Added to the `supabase_realtime` publication so the booking app updates live.

### `open_play_revenue_log` (new)

| column | type | notes |
|---|---|---|
| `id` | `bigint` identity PK | |
| `session_id` | `uuid` (verified: sessions PK is uuid) | no FK — session row gets deleted |
| `date` | `text` `YYYY-MM-DD` | session date, drives period filtering |
| `players` | `int` | count of `open_play_queue` rows at purge time |
| `price_per_player` | `numeric` | snapshot |
| `total` | `numeric` | `players × price_per_player` |
| `purged_at` | `timestamptz` default `now()` | |

- `UNIQUE (session_id)` — purge is idempotent; re-runs upsert rather than duplicate.
- RLS: `select` for `authenticated` (admin reads it); writes happen only via the service-role Edge Function (bypasses RLS).

## Feature 1 — Clickable receipt image

**Admin (`openOrganizerChat` / `renderOrganizerChat`):**
- Chat `<img>` elements get `class="org-chat-img"` + `data-full="<url>"` and `cursor: zoom-in`.
- One delegated click listener on the chat scroll container opens the existing-but-currently-orphaned receipt viewer: add the missing `#receipt-modal` HTML (image, spinner, error state, "Open in new tab" link, close button) to `renderApp()`, and wire `openReceiptModal(url)` / `closeReceiptModal()` (both already written, currently dead code — they come alive here).
- Modal closes on ✕, backdrop click, or Escape.

**Booking app (`opRenderChat`):**
- Same pattern: clickable chat images open a minimal full-screen lightbox (dark backdrop, centered image, tap anywhere to close). Reuses the player app's existing modal styling conventions.

## Feature 2 — Emoji reactions (two-way)

**Set:** `👍 ❤️ 😆 😮 😢 😡` (fixed constant, same order both apps).

**Interaction (both apps):**
- Each message bubble shows a small "add reaction" affordance (`🙂+`), revealed on hover (desktop) and always visible-but-subtle on touch.
- Tapping it opens a small horizontal emoji picker anchored to the bubble.
- Picking an emoji: upsert `(message_id, reactor_token, emoji)` → replaces any previous reaction by that person (Messenger behavior).
- Tapping the same emoji you already have (in picker or on your chip): delete → toggle off.
- Reactions render as chips under the bubble: distinct emojis with counts (`👍 3 ❤️ 1`), your own reaction's chip highlighted.

**Identity:**
- Booking app: `reactor_token = opPlayerToken()` (existing device UUID), `reactor_name = opName || 'Player'`.
- Admin: `reactor_token = 'organizer'`, `reactor_name = 'Organizer'`, `is_organizer = true`. (Single shared organizer identity — matches how organizer chat messages already work.)

**Data flow:**
- Admin: reactions fetched alongside messages on the existing 4-second chat poll (`message_id=in.(…)` single request). Writes via `sbFetch` (authenticated).
- Booking app: initial fetch + Supabase Realtime subscription on `open_play_message_reactions` (INSERT/UPDATE/DELETE) re-renders chat; existing message subscription pattern reused. Upsert via `db.from(...).upsert(..., { onConflict: 'message_id,reactor_token' })`.

## Feature 3 — Scheduled purge (Edge Function + cron)

**Function:** `purge-ended-open-play` (Deno, service role — bypasses RLS).

**Schedule:** hourly via Supabase Cron invoking the Edge Function.

**"Ended" definition (mirrors admin `isSessionPassed`, evaluated in `Asia/Manila` time):**
- `end_time` present: session ends at `date + end_time`, **+1 day when `end_time <= start_time`** (crosses midnight).
- No `end_time`: ends at `date + 1 day, 00:00`.
- The function computes "now" in Asia/Manila regardless of server TZ.

**Per ended session, in order (idempotent):**
1. **Snapshot revenue:** upsert into `open_play_revenue_log` (`players` = count of queue rows; if the session was already partially purged, the earlier snapshot stands).
2. **Delete receipt files:** collect `image_url` from the session's `open_play_messages`, parse the storage path after `/openplay-receipts/`, `storage.remove(paths)`. Non-receipt or unparsable URLs are skipped; storage errors are logged but don't abort the row deletions (files can be re-orphan-swept later; DB consistency wins).
3. **Delete rows:** `open_play_messages` (reactions cascade) → `open_play_join_requests` → `open_play_queue` → the `open_play_sessions` row (hard delete).

**Failure model:** each session is processed independently; one failure doesn't block others. The function returns a JSON summary (`purged`, `errors`) for the cron log.

**Admin UI interplay:** the existing client-side soft-delete keeps hiding passed sessions instantly; the Edge Function does the real destruction on its next run. The admin's Open Play tab never shows purged sessions (they're gone).

## Feature 4 — Revenue reads live + log

- `fetchOpenPlayRevenueData()` additionally fetches `open_play_revenue_log?select=session_id,date,players,total`.
- `openPlayRevenue(prefix)` sums **live** sessions (players × price) **plus** log rows matching the date prefix. No double counting: a session is either live (not yet purged) or in the log (purged and deleted), never both.
- If the log table doesn't exist yet (migration not run), the fetch degrades gracefully to live-only (catch → empty log).

## Deployment (owner actions, documented in `supabase/DEPLOY.md`)

1. Run `supabase/migrations/20260702_chat_reactions_revenue_log.sql` in the SQL editor.
2. Confirm the reactions table is in the Realtime publication (migration does it; verify in dashboard).
3. Deploy `supabase/functions/purge-ended-open-play/` (`supabase functions deploy purge-ended-open-play`) and schedule it hourly (Dashboard → Integrations → Cron, or provided `cron.schedule` SQL fallback).

## Risks / notes

- **Destructive by design:** once purged, chat, receipts, players, and the session are unrecoverable; only the revenue snapshot survives. Cadence is hourly, so a session's data lives at most ~1 hour past its end.
- **Reactions trust model:** anon-key clients can technically write any token (same as existing chat, where anyone can post as any name). Accepted for this app's scale.
- **Booking-app Realtime quota:** one extra subscription per open chat; negligible.
- The six-emoji CHECK constraint keeps the data clean if a modified client posts junk.
