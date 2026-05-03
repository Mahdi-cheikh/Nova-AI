// supabase/functions/google-calendar-delete/index.ts
// Deletes the Google Calendar event tied to an appointment.

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

    const { data: apt } = await sb.from("appointments").select("*, businesses(*), users:doctor_id(*)").eq("id", appointment_id).single();
    if (!apt?.google_calendar_event_id || !apt.businesses?.google_oauth_refresh_token) {
      return new Response(JSON.stringify({ skipped: true }), { status: 200 });
    }

    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: G_CLIENT_ID, client_secret: G_CLIENT_SECR,
        refresh_token: apt.businesses.google_oauth_refresh_token, grant_type: "refresh_token",
      }),
    });
    const { access_token } = await tokenRes.json();
    if (!access_token) return new Response(JSON.stringify({ error: "token refresh failed" }), { status: 500 });

    const calId = apt.users?.google_calendar_id ?? apt.businesses.google_calendar_id ?? "primary";
    await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events/${apt.google_calendar_event_id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${access_token}` },
    });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
});
