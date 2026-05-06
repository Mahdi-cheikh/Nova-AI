// supabase/functions/whatsapp-webhook/index.ts
// Public endpoint that Meta WhatsApp posts incoming messages to.
// Routes them to classify-message for the right business (looked up
// by the destination phone number).
//
// Deploy: supabase functions deploy whatsapp-webhook --no-verify-jwt
// Secrets: supabase secrets set WA_VERIFY_TOKEN=your-shared-secret

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VERIFY_TOKEN = Deno.env.get("WA_VERIFY_TOKEN")!;
const WA_ACCESS_TOKEN = Deno.env.get("WA_ACCESS_TOKEN") || "";
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") || "";


// Send a plain WhatsApp text reply (used by demand-fill / waitlist confirmations)
async function sendText(toPhone: string, body: string): Promise<boolean> {
 const phoneId = Deno.env.get("WA_PHONE_ID");
 const token = Deno.env.get("WA_ACCESS_TOKEN");
 if (!phoneId || !token || !toPhone) return false;
 const to = String(toPhone).replace(/^\+/, "");
 try {
   const res = await fetch(`https://graph.facebook.com/v20.0/${phoneId}/messages`, {
     method: "POST",
     headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
     body: JSON.stringify({
       messaging_product: "whatsapp",
       recipient_type: "individual",
       to,
       type: "text",
       text: { body: String(body || "").slice(0, 4096) },
     }),
   });
   return res.ok;
 } catch { return false; }
}

// Download a WhatsApp media object and transcribe via OpenAI Whisper.
// Returns the transcript string, or empty string on failure.
async function transcribeVoice(mediaId: string): Promise<string> {
 if (!WA_ACCESS_TOKEN || !OPENAI_API_KEY) {
 console.error("transcribeVoice: missing WA_ACCESS_TOKEN or OPENAI_API_KEY");
 return "";
 }
 try {
 // 1. Resolve the media URL from Meta
 const metaRes = await fetch(`https://graph.facebook.com/v20.0/${mediaId}`, {
 headers: { Authorization: `Bearer ${WA_ACCESS_TOKEN}` },
 });
 const metaJson = await metaRes.json();
 const audioUrl = metaJson.url as string;
 if (!audioUrl) { console.error("No audio URL from Meta:", metaJson); return ""; }

 // 2. Download the audio bytes (auth required)
 const audioRes = await fetch(audioUrl, {
 headers: { Authorization: `Bearer ${WA_ACCESS_TOKEN}` },
 });
 const audioBuf = new Uint8Array(await audioRes.arrayBuffer());

 // 3. Send to Whisper (multipart/form-data)
 const form = new FormData();
 form.append("file", new Blob([audioBuf], { type: "audio/ogg" }), "voice.ogg");
 form.append("model", "whisper-1");
 // No `language` field — Whisper auto-detects (handles AR/FR/EN + dialects)

 const whRes = await fetch("https://api.openai.com/v1/audio/transcriptions", {
 method: "POST",
 headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
 body: form,
 });
 const whJson = await whRes.json();
 const text = (whJson.text || "").toString().trim();
 console.log("Whisper transcribed:", text);
 return text;
 } catch (e) {
 console.error("transcribeVoice error:", (e as Error).message);
 return "";
 }
}

serve(async (req) => {
 const url = new URL(req.url);

 // Meta verification handshake (GET)
 if (req.method === "GET") {
 const mode = url.searchParams.get("hub.mode");
 const token = url.searchParams.get("hub.verify_token");
 const challenge = url.searchParams.get("hub.challenge");
 if (mode === "subscribe" && token === VERIFY_TOKEN) return new Response(challenge ?? "", { status: 200 });
 return new Response("forbidden", { status: 403 });
 }

 if (req.method !== "POST") return new Response("method", { status: 405 });

 try {
 const body = await req.json();
 const sb = createClient(SUPABASE_URL, SERVICE_KEY);

 // Walk Meta's payload shape
 for (const entry of body.entry ?? []) {
 for (const change of entry.changes ?? []) {
 const value = change.value;
 const recipientPhone = value?.metadata?.display_phone_number;
 if (!recipientPhone) continue;

 // Find the business that owns this phone number
 const { data: biz } = await sb.from("businesses").select("id, ai_receptionist_enabled, name, type").eq("phone", "+" + recipientPhone).maybeSingle();
 if (!biz) continue;

 for (const msg of value.messages ?? []) {
 let text = msg.text?.body ?? "";
 let actualChannel = "whatsapp";
 const from = "+" + msg.from;

 // VOICE NOTE: download from Meta, transcribe via Whisper, treat as text from here on
 if (!text && msg.type === "audio" && msg.audio?.id) {
 text = await transcribeVoice(msg.audio.id);
 actualChannel = "whatsapp_voice";
 }

 // Diagnostic — see exactly what's coming in so we can tell why the image
 // handler short-circuits when it shouldn't.
 console.log("[MSG-DEBUG] type=", msg.type, "has-text=", !!text, "has-image-id=", !!msg.image?.id, "biz.type=", JSON.stringify(biz.type), "biz-type-len=", (biz.type||"").length);

 // PRESCRIPTION IMAGE: download from Meta, store in 'prescriptions' bucket,
 // run Claude Sonnet Vision OCR with the lab's catalog as vocabulary so
 // handwriting maps cleanly to known test codes. Then ack the patient
 // with what we extracted, so they can correct any OCR errors before
 // the booking flow proceeds.
 if (!text && (msg.type === "image" || msg.type === "document") && (msg.image?.id || msg.document?.id) && (biz.type||"").trim() === "laboratoire") {
 const mediaId = msg.image?.id || msg.document?.id;
 console.log("[IMAGE-HANDLER] entering with media id=", mediaId, "type=", msg.type);
 // Send an immediate ack so the patient knows we received the image
 // (Sonnet OCR can take 5-15 seconds — we don't want them thinking we ignored them).
 await fetch(`https://graph.facebook.com/v20.0/${Deno.env.get("WA_PHONE_ID")}/messages`, {
 method: "POST",
 headers: { Authorization: `Bearer ${WA_ACCESS_TOKEN}`, "Content-Type": "application/json" },
 body: JSON.stringify({
 messaging_product: "whatsapp", recipient_type: "individual",
 to: from.replace(/^\+/, ""), type: "text",
 text: { body: " Got your prescription, reading it now — one moment..." },
 }),
 }).catch(() => {});
 try {
 const metaRes = await fetch(`https://graph.facebook.com/v20.0/${mediaId}`, {
 headers: { Authorization: `Bearer ${WA_ACCESS_TOKEN}` },
 });
 const metaJson = await metaRes.json();
 console.log("Meta media metadata:", JSON.stringify(metaJson));
 if (metaJson.url) {
 const imgRes = await fetch(metaJson.url, { headers: { Authorization: `Bearer ${WA_ACCESS_TOKEN}` } });
 const imgBuf = new Uint8Array(await imgRes.arrayBuffer());
 const path = `${biz.id}/${Date.now()}_${msg.image.id}.jpg`;
 await sb.storage.from("prescriptions").upload(path, imgBuf, { contentType: "image/jpeg", upsert: false });

 // Pull this lab's test catalog so Claude has a vocabulary to disambiguate handwriting
 const { data: catalog = [] } = await sb.from("lab_tests")
 .select("code, name, name_fr, name_ar")
 .eq("business_id", biz.id).eq("active", true);
 const vocabBlock = (catalog as any[])
 .map((t: any) => `- ${t.code || ""}: ${t.name}${t.name_fr ? ` / ${t.name_fr}` : ""}${t.name_ar ? ` / ${t.name_ar}` : ""}`)
 .join("\n");

 // Encode image for Claude Vision (chunked to avoid stack-blow on big payloads)
 let bin = "";
 const view = imgBuf.slice(0, 5_000_000);
 for (let i = 0; i < view.length; i += 0x8000) {
 bin += String.fromCharCode(...view.subarray(i, i + 0x8000));
 }
 const b64 = btoa(bin);

 const sysPrompt = `You are an expert at reading medical lab prescriptions, INCLUDING messy handwriting in French, Arabic, and English. Doctors in Tunisia / Maghreb commonly use abbreviations like NFS, BHCG, TSH, GLY, BIL, etc.

The lab the patient is sending this to offers ONLY these tests — when in doubt, prefer matching to one of these (use the exact 'name' field):

${vocabBlock || "(no catalog provided)"}

Read the image carefully. Tolerant rules:
- Abbreviations: 'Glycémie' = Fasting Glucose, 'NFS' / 'FNS' = Complete Blood Count, 'Bilan lipidique' = Lipid Panel, 'TSH' / 'T4' / 'T3' = thyroid panel, 'CRP' / 'VS' = inflammation markers, '25-OH-D' / 'Vit D' = Vitamin D, 'B12' = Vitamin B12, 'Fer' = Iron, 'Ferritine' = Ferritin, 'Créat' = Creatinine, 'Urée' = Urea, 'ALAT/ASAT' = liver enzymes, 'BHCG' = Beta-HCG, 'Calcémie' = Calcium, 'PSA' = PSA.
- If a token is illegible, omit it rather than guessing.
- Date format on prescriptions is often DD/MM/YYYY in French — convert to YYYY-MM-DD.

Reply with valid JSON ONLY (no prose, no code fences):
{
 "prescriber_name": "",
 "prescription_date": "",
 "tests": ["<exact name from the catalog when possible, otherwise patient-friendly name>"],
 "confidence": "high" | "medium" | "low",
 "notes": "<short observation about handwriting quality or anything ambiguous, in the patient's language>"
}`;

 const ocrRes = await fetch("https://api.anthropic.com/v1/messages", {
 method: "POST",
 headers: {
 "x-api-key": Deno.env.get("ANTHROPIC_API_KEY") || "",
 "anthropic-version": "2023-06-01",
 "content-type": "application/json",
 },
 body: JSON.stringify({
 model: "claude-sonnet-4-6",
 max_tokens: 800,
 system: sysPrompt,
 messages: [{ role: "user", content: [
 { type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } },
 { type: "text", text: "Extract the prescription details now." },
 ] }],
 }),
 });
 const ocrJson = await ocrRes.json();
 console.log("Vision OCR raw response:", JSON.stringify(ocrJson).slice(0, 500));
 if (ocrJson?.error) {
 console.error("Vision OCR API error:", ocrJson.error);
 await fetch(`https://graph.facebook.com/v20.0/${Deno.env.get("WA_PHONE_ID")}/messages`, {
 method: "POST",
 headers: { Authorization: `Bearer ${WA_ACCESS_TOKEN}`, "Content-Type": "application/json" },
 body: JSON.stringify({
 messaging_product: "whatsapp", recipient_type: "individual",
 to: from.replace(/^\+/, ""), type: "text",
 text: { body: "I had trouble processing that image. Could you type the tests you need? E.g. \"Lipid panel, TSH, Vitamin D\"." },
 }),
 }).catch(() => {});
 continue;
 }
 const ocrText = ocrJson?.content?.[0]?.text || "{}";
 let parsed: any = {};
 try { parsed = JSON.parse((ocrText.match(/\{[\s\S]*\}/) || ["{}"])[0]); }
 catch (pe) { console.error("OCR JSON parse failed:", ocrText.slice(0,300)); }
 const tests = Array.isArray(parsed.tests) ? parsed.tests : [];
 const conf = parsed.confidence || "medium";

 // Upsert client + insert prescription_uploads row
 const { data: existing } = await sb.from("clients").select("id").eq("business_id", biz.id).eq("phone", from).maybeSingle();
 const cId = existing?.id ?? (await sb.from("clients").insert({ business_id: biz.id, phone: from, name: from }).select("id").single()).data?.id;
 await sb.from("prescription_uploads").insert({
 business_id: biz.id, client_id: cId,
 storage_path: path, ocr_text: ocrText,
 parsed_tests: tests,
 prescriber_name: parsed.prescriber_name || null,
 prescription_date: parsed.prescription_date || null,
 status: "parsed",
 });

 // Acknowledge to the patient FIRST so they can correct any OCR misread
 if (tests.length > 0) {
 const list = tests.map((n: string) => `• ${n}`).join("\n");
 const confWarn = conf === "low"
 ? "\n\n The handwriting was difficult to read. If anything is missing or wrong, send the corrected list as a text message instead."
 : conf === "medium"
 ? "\n\nIf any test is missing or wrong, just type the correct list."
 : "";
 const ackBody = ` I read this from your prescription:\n${list}${confWarn}\n\nLet's book these now.`;
 await fetch(`https://graph.facebook.com/v20.0/${Deno.env.get("WA_PHONE_ID")}/messages`, {
 method: "POST",
 headers: { Authorization: `Bearer ${WA_ACCESS_TOKEN}`, "Content-Type": "application/json" },
 body: JSON.stringify({
 messaging_product: "whatsapp", recipient_type: "individual",
 to: from.replace(/^\+/, ""), type: "text", text: { body: ackBody },
 }),
 }).catch(() => {});
 // Forward to classify-message as if the patient typed the cleaned-up test list
 text = "I want to book: " + tests.join(", ");
 } else {
 // OCR returned nothing usable — ask the patient to type their tests
 await fetch(`https://graph.facebook.com/v20.0/${Deno.env.get("WA_PHONE_ID")}/messages`, {
 method: "POST",
 headers: { Authorization: `Bearer ${WA_ACCESS_TOKEN}`, "Content-Type": "application/json" },
 body: JSON.stringify({
 messaging_product: "whatsapp", recipient_type: "individual",
 to: from.replace(/^\+/, ""), type: "text",
 text: { body: "I couldn't read your prescription clearly. Could you type the tests you need? E.g. \"Lipid panel, TSH, Vitamin D\"." },
 }),
 }).catch(() => {});
 continue;
 }
 console.log("Prescription parsed (confidence=" + conf + "):", text);
 }
 } catch (e) {
 console.error("Prescription OCR failed:", (e as Error).message);
 }
 }

 // === GARAGE: image of a car, damage, dashboard, document => attach to vehicle file ===
 // Garage messages are NOT short-circuited — we tag the photo, then let the
 // text (if any) continue through classify-message so Nova can still answer.
 if ((msg.type === "image" || msg.type === "document") && (msg.image?.id || msg.document?.id) && (biz.type||"").trim() === "garage") {
   try {
     const mediaId = msg.image?.id || msg.document?.id;
     const metaRes2 = await fetch(`https://graph.facebook.com/v20.0/${mediaId}`, {
       headers: { Authorization: `Bearer ${WA_ACCESS_TOKEN}` },
     });
     const metaJson2 = await metaRes2.json();
     if (metaJson2.url) {
       const imgRes2 = await fetch(metaJson2.url, { headers: { Authorization: `Bearer ${WA_ACCESS_TOKEN}` } });
       const imgBuf2 = new Uint8Array(await imgRes2.arrayBuffer());
       const path2 = `${biz.id}/${Date.now()}_${mediaId}.jpg`;
       // Storage bucket "vehicle-photos" should exist (idempotent: ignore "already exists" errors)
       const up = await sb.storage.from("vehicle-photos").upload(path2, imgBuf2, { contentType: "image/jpeg", upsert: false });
       const { data: urlData } = sb.storage.from("vehicle-photos").getPublicUrl(up.data?.path || path2);
       const photoUrl = urlData?.publicUrl || "";

       // Find a vehicle for this client. RPC tries plate / VIN / fallback to most-recent.
       let vehicleId: string | null = null;
       let matchType = "";
       const { data: vmatch } = await sb.rpc("find_vehicle_for_message", {
         p_business_id: biz.id, p_client_id: clientId, p_text: text || msg.image?.caption || msg.document?.caption || null,
       });
       if (vmatch && (vmatch as any[]).length) {
         vehicleId = (vmatch as any[])[0].vehicle_id;
         matchType = (vmatch as any[])[0].match_type;
       }

       // Heuristic: damage if the message mentions specific keywords
       const lc = (text || "").toLowerCase();
       let kind = "general";
       if (/(damage|d[ée]g[aâ]t|cog|broken|cass[ée]|accident|scratch|dent|rayure|bosse|noise|bruit|leak|fuite)/i.test(lc)) kind = "damage";
       else if (/(dashboard|tableau|warning|voyant|temoin|t[eé]moin)/i.test(lc)) kind = "dashboard";
       else if (/(document|carte\s*gris|insurance|assurance|registration)/i.test(lc)) kind = "document";

       if (vehicleId && photoUrl) {
         await sb.from("vehicle_photos").insert({
           business_id: biz.id, vehicle_id: vehicleId, url: photoUrl,
           caption: text || null, kind,
         });
         await sb.from("notifications").insert({
           business_id: biz.id, type: "info",
           title: "Vehicle photo attached",
           message: `${matchType === "plate" ? "Plate-matched" : matchType === "vin" ? "VIN-matched" : "Best-guess"} photo (${kind}) added to a vehicle file.`,
           urgent: kind === "damage",
         });
       } else if (photoUrl) {
         // No vehicle yet — drop a notification asking the owner to register one
         await sb.from("notifications").insert({
           business_id: biz.id, type: "info",
           title: "Vehicle photo received — no matching car",
           message: `${from} sent a photo but isn't linked to a registered vehicle. Add the car in Vehicles to start a service file.`,
         });
       }
     }
   } catch (e) {
     console.error("Garage photo handler failed:", (e as Error).message);
   }
   // Note: we DO NOT `continue;` here — let the text flow through classify-message
   // so Nova can answer "my Clio is making a noise" and offer a diagnosis booking.
 }

 // INTERACTIVE LIST: patient tapped a list option — we receive the row id
 // (e.g. doctor UUID) and the title. Forward the id as the "text" so the
 // multi-turn handler can validate it directly without ambiguity.
 if (!text && msg.type === "interactive") {
 const inter = msg.interactive || {};
 if (inter.list_reply?.id) {
 text = inter.list_reply.id;
 console.log("Interactive list_reply received:", text, "title:", inter.list_reply.title);
 } else if (inter.button_reply?.id) {
 text = inter.button_reply.id;
 console.log("Interactive button_reply received:", text);
 }
 }

 if (!text) continue;

 // === SHORT-CIRCUIT button replies that don't need Claude ===
 // Reminder buttons: confirm:<apt-id> | cancel:<apt-id>
 // Waitlist: wl_yes:<wl-id>:<date>:<time>:<doc>:<svc> | wl_no:<wl-id>
 // Review: rev:<rating>:<apt-id>
 // Reactivation: reactivate:<client-id> -> falls through to classify-message as a fresh booking
 if (text.startsWith("confirm:") || text.startsWith("cancel:")) {
 const [kind, aptId] = text.split(":");
 const newStatus = kind === "confirm" ? "confirmed" : "cancelled";
 const upd: any = { status: newStatus };
 if (kind === "confirm") upd.confirmed_by_patient = true;
 const { data: apt } = await sb.from("appointments").update(upd).eq("id", aptId).select().maybeSingle();
 if (apt) {
 await sb.from("notifications").insert({
 business_id: biz.id, type: kind === "confirm" ? "info" : "cancel",
 title: kind === "confirm" ? "Appointment confirmed by patient" : "Patient cancelled",
 message: `${from} ${kind === "confirm" ? "confirmed" : "cancelled"} their ${apt.date} ${String(apt.time).slice(0,5)} appointment.`,
 urgent: kind === "cancel",
 });
 if (kind === "cancel") {
 // Fire-and-forget waitlist runner so any waiting patient gets pinged
 fetch(`${SUPABASE_URL}/functions/v1/waitlist-runner`, {
 method: "POST",
 headers: { Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
 body: JSON.stringify({ business_id: biz.id, date: apt.date, time: String(apt.time).slice(0,5), doctor_id: apt.doctor_id, service_id: apt.service_id }),
 }).catch(() => {});
 }
 }
 continue;
 }

 if (text.startsWith("rev:")) {
 const [, rating, aptId] = text.split(":");
 const r = parseInt(rating || "0", 10);
 if (r >= 1 && r <= 5 && aptId) {
 await sb.from("appointment_reviews").update({
 rating: r,
 responded_at: new Date().toISOString(),
 }).eq("appointment_id", aptId);
 await sb.from("notifications").insert({
 business_id: biz.id, type: "info",
 title: r >= 4 ? "Great review received" : "Review received",
 message: `${from} rated their visit ${r} stars.`,
 urgent: r <= 2,
 });
 }
 continue;
 }

 // === DEMAND-FILL: patient replied to "We have open slots" ping ===
 if (text.startsWith("df_yes:")) {
   const [, campaignId] = text.split(":");
   const { data: campaign } = await sb.from("demand_fill_campaigns")
     .select("*, services(name), users:doctor_id(name)")
     .eq("id", campaignId).maybeSingle();
   if (!campaign) { continue; }
   if (campaign.status === "filled" || (campaign.slot_times || []).length === 0) {
     // No slots left — politely tell patient
     await sendText(from, "Sorry — those slots just got booked. We'll keep you posted on the next opening.");
     continue;
   }
   // Find or create the client by phone
   let { data: client } = await sb.from("clients")
     .select("*").eq("business_id", biz.id).eq("phone", from).maybeSingle();
   if (!client) {
     const { data: newClient } = await sb.from("clients")
       .insert({ business_id: biz.id, phone: from, name: from }).select().single();
     client = newClient;
   }
   const claimedTime = campaign.slot_times[0];
   // Atomically book: insert appointment + remove slot from campaign
   const { data: apt, error: aptErr } = await sb.from("appointments").insert({
     business_id: biz.id,
     client_id: client.id,
     doctor_id: campaign.doctor_id,
     service_id: campaign.service_id,
     date: campaign.date,
     time: claimedTime,
     status: "confirmed",
     source: "whatsapp_ai",
     notes: "Booked via demand-fill campaign",
   }).select().single();
   if (aptErr) {
     console.error("df_yes booking failed:", aptErr);
     await sendText(from, "Sorry — could not book that slot. Please try again.");
     continue;
   }
   // Update campaign: pop the claimed slot, increment filled_count
   const remaining = (campaign.slot_times || []).filter((t: string) => t !== claimedTime);
   await sb.from("demand_fill_campaigns").update({
     slot_times: remaining,
     filled_count: (campaign.filled_count || 0) + 1,
     status: remaining.length === 0 ? "filled" : campaign.status,
   }).eq("id", campaignId);
   // Update target status
   await sb.from("demand_fill_targets").update({
     status: "filled",
     responded_at: new Date().toISOString(),
   }).eq("campaign_id", campaignId).eq("client_id", client.id);
   // Notify owner
   await sb.from("notifications").insert({
     business_id: biz.id, type: "booking",
     title: "Demand-fill slot claimed",
     message: `${client.name || from} grabbed the ${campaign.date} ${claimedTime} slot with ${campaign.users?.name || "your provider"}.`,
   });
   // Confirm to patient
   const lang = client?.profile?.language || "en";
   const conf = lang === "fr"
     ? `Confirmé ! Vous avez ${campaign.date} à ${claimedTime}${campaign.users?.name ? " avec " + campaign.users.name : ""}. À bientôt !`
     : lang === "ar"
     ? `تم التأكيد! موعدك يوم ${campaign.date} على الساعة ${claimedTime}.`
     : `Confirmed! You're booked for ${campaign.date} at ${claimedTime}${campaign.users?.name ? " with " + campaign.users.name : ""}. See you then.`;
   await sendText(from, conf);
   continue;
 }
 if (text.startsWith("df_no:")) {
   const [, campaignId] = text.split(":");
   const { data: client } = await sb.from("clients")
     .select("id").eq("business_id", biz.id).eq("phone", from).maybeSingle();
   if (client) {
     await sb.from("demand_fill_targets").update({
       status: "declined",
       responded_at: new Date().toISOString(),
     }).eq("campaign_id", campaignId).eq("client_id", client.id);
   }
   const lang = "en";
   await sendText(from, "No problem — we'll let you know about the next opening.");
   continue;
 }

 if (text.startsWith("wl_no:")) {
 const [, wlId] = text.split(":");
 await sb.from("waitlist").update({ status: "cancelled" }).eq("id", wlId);
 continue;
 }
 if (text.startsWith("wl_yes:")) {
 const parts = text.split(":"); // [wl_yes, wlId, date, time, docId, svcId]
 const [, wlId, date, time, docId, svcId] = parts;
 const { data: wl } = await sb.from("waitlist").select("client_id").eq("id", wlId).maybeSingle();
 if (wl?.client_id) {
 await sb.from("appointments").insert({
 business_id: biz.id, client_id: wl.client_id,
 doctor_id: docId || null, service_id: svcId || null,
 date, time: time || "10:00", status: "confirmed",
 source: "whatsapp_ai",
 });
 await sb.from("waitlist").update({ status: "booked" }).eq("id", wlId);
 await sb.from("notifications").insert({
 business_id: biz.id, doctor_id: docId || null, type: "booking",
 title: "Waitlist booking confirmed",
 message: `Patient claimed ${date} ${time || ""} from the waitlist.`,
 });
 }
 continue;
 }

 if (text.startsWith("reactivate:")) {
 // Treat as a fresh booking intent so classify-message kicks off the booking flow
 text = "I want to book an appointment";
 }
 // === END short-circuit ===

 // Owner has flipped the AI off — store the message and notify, but don't auto-reply.
 if (biz.ai_receptionist_enabled === false) {
 // Upsert client so it shows up under Clients
 const { data: existing } = await sb.from("clients").select("id").eq("business_id", biz.id).eq("phone", from).maybeSingle();
 const clientId = existing?.id ?? (await sb.from("clients").insert({ business_id: biz.id, phone: from, name: from }).select("id").single()).data?.id;
 // Persist the inbound message
 await sb.from("messages").insert({ business_id: biz.id, client_id: clientId, direction: "in", channel: actualChannel, text });
 // Notify the owner so they can reply manually
 await sb.from("notifications").insert({
 business_id: biz.id, type: "info",
 title: "New WhatsApp message — AI paused",
 message: `${from}: ${text}`,
 urgent: false,
 });
 continue;
 }

 // AI is on — full pipeline
 await fetch(`${SUPABASE_URL}/functions/v1/classify-message`, {
 method: "POST",
 headers: { Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
 body: JSON.stringify({ phone: from, text, business_id: biz.id, channel: actualChannel }),
 });
 }
 }
 }
 return new Response("ok", { status: 200 });
 } catch (err) {
 console.error(err);
 return new Response("ok", { status: 200 }); // always 200 to Meta to avoid retries
 }
});
