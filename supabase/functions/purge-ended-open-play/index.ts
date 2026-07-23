// purge-ended-open-play
//
// Runs hourly (Supabase Cron). For every Open Play session whose real end
// moment (Asia/Manila) has passed, it:
//   1. snapshots revenue (players × price_per_player) into open_play_revenue_log
//   2. deletes the session's receipt images from the openplay-receipts bucket
//   3. deletes its chat messages (reactions cascade), join requests,
//      registrations, and finally the session row itself.
//
// Idempotent: the revenue log upserts on session_id, and deletes of
// already-deleted rows are no-ops. Each session is processed independently,
// so one failure doesn't block the rest.

import { createClient } from "npm:@supabase/supabase-js@2";

const BUCKET = "openplay-receipts";
const TZ = "Asia/Manila";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// Current date/time in Asia/Manila as { date: 'YYYY-MM-DD', minutes: 0..1439 }.
function nowInManila() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: parseInt(get("hour")) % 24 * 60 + parseInt(get("minute")),
  };
}

function hmToMinutes(t: string | null): number | null {
  if (!t) return null;
  const [h, m] = t.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

// Mirrors the admin panel's isSessionPassed(): a session ends at date+end_time,
// +1 day when end_time <= start_time (crosses midnight); with no end_time it
// ends when the calendar day is over (next day 00:00).
function isEnded(
  s: { date: string | null; start_time: string | null; end_time: string | null },
  now: { date: string; minutes: number },
): boolean {
  if (!s.date) return false;
  const end = hmToMinutes(s.end_time);
  if (end === null) {
    return now.date >= addDays(s.date, 1);
  }
  const start = hmToMinutes(s.start_time);
  const endDate = start !== null && end <= start ? addDays(s.date, 1) : s.date;
  if (now.date > endDate) return true;
  if (now.date < endDate) return false;
  return now.minutes > end;
}

// ".../storage/v1/object/public/openplay-receipts/<token>/<file>" → "<token>/<file>"
function storagePathFromUrl(url: string): string | null {
  const marker = `/${BUCKET}/`;
  const i = url.indexOf(marker);
  if (i === -1) return null;
  const path = url.slice(i + marker.length).split("?")[0];
  return path.length ? decodeURIComponent(path) : null;
}

async function purgeSession(
  s: { id: string; date: string; price_per_player: number | null },
): Promise<void> {
  // 1) Revenue snapshot (before anything is deleted).
  const { count, error: countErr } = await supabase
    .from("open_play_queue")
    .select("id", { count: "exact", head: true })
    .eq("session_id", s.id);
  if (countErr) throw new Error(`count queue: ${countErr.message}`);
  const players = count ?? 0;
  const price = Number(s.price_per_player) || 0;

  const { error: logErr } = await supabase
    .from("open_play_revenue_log")
    .upsert(
      {
        session_id: s.id,
        date: s.date,
        players,
        price_per_player: price,
        total: players * price,
      },
      { onConflict: "session_id", ignoreDuplicates: true }, // first snapshot wins
    );
  if (logErr) throw new Error(`revenue log: ${logErr.message}`);

  // 2) Receipt files referenced by this session's chat messages.
  const { data: msgs, error: msgErr } = await supabase
    .from("open_play_messages")
    .select("image_url")
    .eq("session_id", s.id)
    .not("image_url", "is", null);
  if (msgErr) throw new Error(`fetch messages: ${msgErr.message}`);

  const paths = (msgs ?? [])
    .map((m) => storagePathFromUrl(m.image_url as string))
    .filter((p): p is string => !!p);
  if (paths.length) {
    const { error: rmErr } = await supabase.storage.from(BUCKET).remove(paths);
    // Storage failures are logged but don't abort: DB consistency wins, and
    // orphaned files can be swept on a later run or by hand.
    if (rmErr) console.error(`storage remove (${s.id}):`, rmErr.message);
  }

  // 3) Rows, children first. Reactions cascade from messages.
  for (const table of [
    "open_play_messages",
    "open_play_join_requests",
    "open_play_queue",
  ]) {
    const { error } = await supabase.from(table).delete().eq("session_id", s.id);
    if (error) throw new Error(`delete ${table}: ${error.message}`);
  }
  const { error: sessErr } = await supabase
    .from("open_play_sessions")
    .delete()
    .eq("id", s.id);
  if (sessErr) throw new Error(`delete session: ${sessErr.message}`);
}

Deno.serve(async () => {
  const now = nowInManila();

  const { data: sessions, error } = await supabase
    .from("open_play_sessions")
    .select("id,date,start_time,end_time,price_per_player");
  if (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }

  const ended = (sessions ?? []).filter((s) => isEnded(s, now));
  let purged = 0;
  const errors: string[] = [];

  for (const s of ended) {
    try {
      await purgeSession(s);
      purged++;
    } catch (e) {
      errors.push(`${s.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  console.log(
    `checked=${sessions?.length ?? 0} ended=${ended.length} purged=${purged} errors=${errors.length}`,
  );
  return Response.json({
    ok: errors.length === 0,
    checked: sessions?.length ?? 0,
    ended: ended.length,
    purged,
    errors,
  });
});
