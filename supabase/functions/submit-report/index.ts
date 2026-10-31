import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
const ALLOWED_CATEGORIES = new Set([
  "Electronics", "Bags & Accessories", "Books & Stationery", "Clothing",
  "ID & Documents", "Keys", "Sports & Recreation", "Jewelry & Accessories",
  "Food & Containers", "Other",
]);
const ALLOWED_CONTACT_METHODS = new Set(["Email", "Phone", "Instagram", "WhatsApp"]);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
function clean(value: FormDataEntryValue | null, max: number): string {
  return (typeof value === "string" ? value : "").trim().slice(0, max);
}
async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value || "unknown-client");
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);

  const origin = req.headers.get("origin");
  const allowedOrigin = Deno.env.get("ALLOWED_ORIGIN");
  if (allowedOrigin && origin !== allowedOrigin) return json({ error: "This website origin is not allowed." }, 403);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) return json({ error: "Server configuration is incomplete." }, 500);
  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });

  let form: FormData;
  try { form = await req.formData(); } catch { return json({ error: "Send a valid multipart form with the report fields and image." }, 400); }

  const type = clean(form.get("type"), 10);
  const itemName = clean(form.get("item_name"), 100);
  const category = clean(form.get("category"), 60);
  const description = clean(form.get("description"), 500);
  const location = clean(form.get("location"), 150);
  const reportDate = clean(form.get("report_date"), 10);
  const contactMethodRaw = clean(form.get("contact_method"), 30);
  const contactDetails = clean(form.get("contact_details"), 100);
  const contactIsPublic = clean(form.get("contact_is_public"), 5) === "true";
  const honeypot = clean(form.get("website"), 120);
  const photo = form.get("photo");

  if (honeypot) return json({ error: "Submission rejected." }, 400);
  if (!["lost", "found"].includes(type)) return json({ error: "Choose Lost or Found." }, 400);
  if (!itemName || !description || !location || !reportDate) return json({ error: "Complete the required item name, description, location, and date fields." }, 400);
  if (!ALLOWED_CATEGORIES.has(category)) return json({ error: "Choose a valid category." }, 400);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDate) || Number.isNaN(Date.parse(`${reportDate}T12:00:00Z`))) return json({ error: "Enter a valid report date." }, 400);
  const contactMethod = ALLOWED_CONTACT_METHODS.has(contactMethodRaw) ? contactMethodRaw : null;
  if (contactIsPublic && (!contactMethod || !contactDetails)) return json({ error: "To display contact information publicly, provide both a contact method and details." }, 400);
  if (!(photo instanceof File)) return json({ error: "A photo is required." }, 400);
  if (!ALLOWED_MIME.has(photo.type)) return json({ error: "Only JPEG, PNG, and WebP images are accepted." }, 400);
  if (photo.size > MAX_IMAGE_BYTES) return json({ error: "The source image exceeds the 10 MiB limit." }, 413);
  if (photo.size <= 0) return json({ error: "The uploaded photo is empty." }, 400);

  // Simple server-side per-IP throttle: at most thirty submission attempts per hour.
  const forwardedFor = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || req.headers.get("cf-connecting-ip") || "unknown-client";
  const ipHash = await sha256(forwardedFor);
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { data: recent, error: rateReadError } = await admin.from("report_submission_limits")
    .select("id").eq("ip_hash", ipHash).gte("created_at", since).limit(30);
  if (rateReadError) {
    console.error("Rate-limit lookup failed:", rateReadError.message);
    return json({ error: "Could not verify submission limits. Please retry later." }, 503);
  }
  if ((recent || []).length >= 30) return json({ error: "Too many reports from this connection. Please try again later." }, 429);
  const { error: rateInsertError } = await admin.from("report_submission_limits").insert({ ip_hash: ipHash });
  if (rateInsertError) console.warn("Rate-limit event could not be recorded:", rateInsertError.message);

  const reportId = crypto.randomUUID();
  const ext = photo.type === "image/png" ? "png" : photo.type === "image/webp" ? "webp" : "jpg";
  const photoPath = `${reportId}.${ext}`;
  const arrayBuffer = await photo.arrayBuffer();
  const { error: uploadError } = await admin.storage.from("item-photos").upload(photoPath, arrayBuffer, {
    contentType: photo.type, upsert: false, cacheControl: "60",
  });
  if (uploadError) {
    console.error("Photo upload failed:", uploadError.message);
    return json({ error: "Photo upload failed. Check the item-photos bucket and Storage configuration." }, 502);
  }
  const { data: publicUrl } = admin.storage.from("item-photos").getPublicUrl(photoPath);
  const { error: insertError } = await admin.from("reports").insert({
    id: reportId,
    type,
    item_name: itemName,
    category,
    description,
    location,
    report_date: reportDate,
    contact_method: contactMethod,
    contact_details: contactDetails || null,
    contact_is_public: contactIsPublic,
    photo_url: publicUrl.publicUrl,
    photo_path: photoPath,
    resolved: false,
    resolved_at: null,
  });
  if (insertError) {
    const { error: rollbackError } = await admin.storage.from("item-photos").remove([photoPath]);
    if (rollbackError) console.error("Could not remove orphaned photo after report insert failure:", rollbackError.message);
    console.error("Report insert failed:", insertError.message);
    return json({ error: "The image uploaded, but the report could not be saved. The server attempted to remove the uploaded image. Please check the database setup and retry." }, 502);
  }

  const { data: publicReport, error: readError } = await admin.from("reports_public").select("*").eq("id", reportId).single();
  if (readError || !publicReport) {
    // The row was saved, so do not claim failure and invite a duplicate submission. The caller receives the report id.
    console.error("Inserted report could not be read from the public view:", readError?.message);
    return json({ ok: true, report: { id: reportId }, warning: "Report saved; refresh the listings if it is not visible immediately." }, 201);
  }
  return json({ ok: true, report: publicReport }, 201);
});
