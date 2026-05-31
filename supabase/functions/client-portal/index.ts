// supabase/functions/client-portal/index.ts
// CLIENT PORTAL — anonymous phone-only access for end-users.
// ============================================================================
// Lets a client (patient, customer) look up every appointment ever booked
// against their phone number across all Nova-AI businesses, and cancel or
// reschedule any future one.
//
// SECURITY model: phone number is the "key". This is the demo posture chosen
// by the project owner. For production, layer SMS OTP on top of this function.
//
// Body:
//   { action: "list", phone: "+212..." }
//   { action: "cancel", phone, appointment_id }
//   { action: "reschedule", phone, appointment_id, date: "YYYY-MM-DD", time: "HH:MM" }
//
// Responses are JSON. CORS is wide-open since this is meant for the public
// landing-page client portal.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function normalisePhone(raw: string): string {
  if (!raw) return "";
  const t = raw.trim().replace(/[\s()-]/g, "");
  if (t.startsWith("+")) return t;
  if (t.startsWith("00")) return "+" + t.slice(2);
  return t;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }

  const action = String(body.action || "").toLowerCase();
  const phone = normalisePhone(String(body.phone || ""));
  if (!phone) return json({ error: "Phone number required" }, 400);

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);

  // --------- LIST ---------------------------------------------------------
  if (action === "list") {
    // Find every client row across all businesses that matches this phone.
    const { data: clientRows, error: clientErr } = await sb
      .from("clients")
      .select("id, business_id, name, phone, language")
      .eq("phone", phone);
    if (clientErr) return json({ error: clientErr.message }, 500);
    if (!clientRows || clientRows.length === 0) {
      return json({ phone, name: null, businesses: [], appointments: [] });
    }
    const clientIds = clientRows.map((c) => c.id);
    const bizIds = Array.from(new Set(clientRows.map((c) => c.business_id)));

    const [{ data: appts, error: aErr }, { data: bizs, error: bErr }] = await Promise.all([
      sb.from("appointments")
        .select("id, business_id, client_id, doctor_id, service_id, date, time, status, source, notes, created_at, users:doctor_id(name), services(name, duration_min, price)")
        .in("client_id", clientIds)
        .order("date", { ascending: false })
        .order("time", { ascending: false }),
      sb.from("businesses")
        .select("id, name, type, phone, address, currency")
        .in("id", bizIds),
    ]);
    if (aErr) return json({ error: aErr.message }, 500);
    if (bErr) return json({ error: bErr.message }, 500);

    // The client's "display name" — pick the most recent one
    const name = clientRows[0]?.name || null;
    return json({
      phone,
      name,
      businesses: bizs || [],
      appointments: (appts || []).map((a: any) => ({
        id: a.id,
        business_id: a.business_id,
        date: a.date,
        time: a.time,
        status: a.status,
        source: a.source,
        notes: a.notes,
        doctor_name: a.users?.name || null,
        service_name: a.services?.name || null,
        service_price: a.services?.price ?? null,
        service_duration: a.services?.duration_min ?? null,
        created_at: a.created_at,
      })),
    });
  }

  // --------- CANCEL -------------------------------------------------------
  if (action === "cancel") {
    const appointmentId = String(body.appointment_id || "");
    if (!appointmentId) return json({ error: "appointment_id required" }, 400);

    const { data: appt, error: aErr } = await sb
      .from("appointments")
      .select("id, status, date, time, business_id, client_id, clients(phone)")
      .eq("id", appointmentId)
      .single();
    if (aErr || !appt) return json({ error: "Appointment not found" }, 404);
    if ((appt as any).clients?.phone !== phone) return json({ error: "Phone does not match this appointment" }, 403);
    if (appt.status === "cancelled") return json({ ok: true, already: true });

    const { error: uErr } = await sb
      .from("appointments")
      .update({ status: "cancelled", cancelled_at: new Date().toISOString(), cancellation_reason: "client_self_service" })
      .eq("id", appointmentId);
    if (uErr) return json({ error: uErr.message }, 500);
    return json({ ok: true });
  }

  // --------- RESCHEDULE ---------------------------------------------------
  if (action === "reschedule") {
    const appointmentId = String(body.appointment_id || "");
    const newDate = String(body.date || "");
    const newTime = String(body.time || "");
    if (!appointmentId || !newDate || !newTime) {
      return json({ error: "appointment_id, date and time are required" }, 400);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(newDate) || !/^\d{2}:\d{2}(:\d{2})?$/.test(newTime)) {
      return json({ error: "date must be YYYY-MM-DD and time must be HH:MM" }, 400);
    }

    const { data: appt, error: aErr } = await sb
      .from("appointments")
      .select("id, status, business_id, client_id, clients(phone)")
      .eq("id", appointmentId)
      .single();
    if (aErr || !appt) return json({ error: "Appointment not found" }, 404);
    if ((appt as any).clients?.phone !== phone) return json({ error: "Phone does not match this appointment" }, 403);

    // Soft conflict check: don't overlap with another booked slot at the same time on the same doctor.
    const { data: conflict } = await sb
      .from("appointments")
      .select("id")
      .eq("business_id", appt.business_id)
      .eq("date", newDate)
      .eq("time", newTime.length === 5 ? newTime + ":00" : newTime)
      .neq("id", appointmentId)
      .neq("status", "cancelled")
      .maybeSingle();
    if (conflict) return json({ error: "That slot is already taken — pick another time." }, 409);

    const { error: uErr } = await sb
      .from("appointments")
      .update({
        date: newDate,
        time: newTime.length === 5 ? newTime + ":00" : newTime,
        status: "confirmed",
        rescheduled_at: new Date().toISOString(),
      })
      .eq("id", appointmentId);
    if (uErr) return json({ error: uErr.message }, 500);
    return json({ ok: true });
  }

  return json({ error: `Unknown action: ${action}` }, 400);
});
