# Supabase Deployment — Chat Reactions + Scheduled Purge

Three one-time steps, in order. Everything is idempotent (safe to re-run).

## 1. Run the migration

Supabase Dashboard → **SQL Editor** → paste the contents of
`supabase/migrations/20260702_chat_reactions_revenue_log.sql` → **Run**.

This creates:
- `open_play_message_reactions` (emoji reactions, RLS + Realtime enabled)
- `open_play_revenue_log` (revenue snapshots that survive the purge)

Verify: **Database → Replication → supabase_realtime** should list
`open_play_message_reactions`.

## 2. Deploy the Edge Function

With the [Supabase CLI](https://supabase.com/docs/guides/cli) logged in and the
project linked (`supabase link --project-ref qzjaegutlsgtlaworbuy`):

```sh
supabase functions deploy purge-ended-open-play --no-verify-jwt
```

`--no-verify-jwt` lets the cron scheduler call it without a user token. The
function itself uses the service-role key, which Supabase injects
automatically — no secrets to configure.

Test it once manually (Dashboard → Edge Functions → purge-ended-open-play →
**Invoke**, or):

```sh
curl -X POST "https://qzjaegutlsgtlaworbuy.supabase.co/functions/v1/purge-ended-open-play" \
  -H "Authorization: Bearer <ANON_KEY>"
```

Expected response: `{"ok":true,"checked":N,"ended":N,"purged":N,"errors":[]}`.

## 3. Schedule it hourly

**Preferred (Dashboard):** Integrations → **Cron** → Create job →
- Name: `purge-ended-open-play`
- Schedule: `0 * * * *` (every hour, on the hour)
- Type: **Edge Function** → pick `purge-ended-open-play`, method POST.

**Fallback (SQL editor)** if the Cron integration isn't available — uses
`pg_cron` + `pg_net` (enable both under Database → Extensions first):

```sql
select cron.schedule(
  'purge-ended-open-play',
  '0 * * * *',
  $$
  select net.http_post(
    url     := 'https://qzjaegutlsgtlaworbuy.supabase.co/functions/v1/purge-ended-open-play',
    headers := '{"Content-Type":"application/json"}'::jsonb
  );
  $$
);
```

## What the purge does (recap)

Every hour, for each Open Play session whose end time (Asia/Manila) has passed:
1. Writes players × price into `open_play_revenue_log` (so the admin Revenue
   tab keeps counting it forever).
2. Deletes the session's receipt images from the `openplay-receipts` bucket.
3. Deletes its chat messages (reactions cascade), join requests,
   registrations, and the session row.

⚠️ **Destructive and unrecoverable** — only the revenue snapshot survives.

## Monitoring

Dashboard → Edge Functions → purge-ended-open-play → **Logs** shows one line
per run: `checked=… ended=… purged=… errors=…`.
