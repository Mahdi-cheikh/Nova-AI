// supabase/functions/google-calendar-create/index.ts
// Reads an appointment + the business's stored Google refresh_token,
// exchanges for a fresh access token, then POSTs the event to the
// doctor's primary calendar. Stores the resulting event ID back on
// the appointment so we can delete/update it later.
//
// Deploy:   supabase functions deploy google-calendar-create
// Secrets:  supabase secrets set GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=...

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL  = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY   = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const G_CLIENT_ID   = Deno.env.get("GOOGLE_CLIENT_ID")!;
const G_CLIENT_SECR = Deno.env.get("GOOGLE_CLIENT_SECRET")!;

serve(async (req) => {
  try {
    const { appointment_id } = await req.json();
    const sb = createClient(SUPABASE_URL, SERVICE_KEY);

    const { data: apt } = await sb.from("appointments")
      .select("*, businesses(*), clients(*), users:doctor_id(*), services(*)")
      .eq("id", appointment_id).single();
    if (!apt?.businesses?.google_oauth_refresh_token || !apt.businesses?.google_calendar_connected) {
      return new Response(JSON.stringify({ skipped: "calendar not connected" }), { status: 200 });
    }

    // Refresh the token
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: G_CLIENT_ID, client_secret: G_CLIENT_SECR,
        refresh_token: apt.businesses.google_oauth_refresh_token, grant_type: "refresh_token",
      }),
    });
    const tokenJson = await tokenRes.json();
    const accessToken: string = tokenJson.access_token;
    if (!accessToken) return new Response(JSON.stringify({ error: "Token refresh failed", detail: tokenJson }), { status: 500 });

    const startISO = `${apt.date}T${apt.time}:00`;
    const durationMin = apt.services?.duration_min ?? 30;
    const endISO = isoPlusMin(startISO, durationMin);

    const event = {
      summary: `Nova AI · ${apt.services?.name ?? "Appointment"} · ${apt.clients?.name ?? ""}`.trim(),
      description: `Booked via Nova AI. Phone: ${apt.clients?.phone ?? "—"}.`,
      start: { dateTime: startISO },
      end: { dateTime: endISO },
    };

    const calId = apt.users?.google_calendar_id ?? apt.businesses.google_calendar_id ?? "primary";
    const calRes = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(event),
    });
    const calJson = await calRes.json();
    if (calJson.id) {
      await sb.from("appointments").update({ google_calendar_event_id: calJson.id }).eq("id", appointment_id);
    }
    return new Response(JSON.stringify({ ok: true, event_id: calJson.id }), { status: 200 });
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
});

function isoPlusMin(iso: string, mins: number) {
  const d = new Date(iso); d.setMinutes(d.getMinutes() + mins); return d.toISOString().slice(0, 19);
}
