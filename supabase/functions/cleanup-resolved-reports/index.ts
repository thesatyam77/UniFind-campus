import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type, x-cleanup-secret", "Access-Control-Allow-Methods": "POST, OPTIONS" };
function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } }); }
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);
  const expectedSecret = Deno.env.get("CLEANUP_SECRET");
  if (!expectedSecret || req.headers.get("x-cleanup-secret") !== expectedSecret) return json({ error: "Unauthorized cleanup request." }, 401);
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) return json({ error: "Server configuration is incomplete." }, 500);
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const expiresAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { data: due, error: queryError } = await admin.from("reports")
    .select("id, photo_path, resolved_at")
    .eq("resolved", true)
    .lte("resolved_at", expiresAt)
    .order("resolved_at", { ascending: true })
    .limit(100);
  if (queryError) {
    console.error("Cleanup query failed:", queryError.message);
    return json({ error: "Could not query expired resolved reports." }, 500);
  }
  let deleted = 0;
  let failed = 0;
  for (const report of due || []) {
    try {
      const path = typeof report.photo_path === "string" ? report.photo_path : "";
      if (path) {
        const { error: removeError } = await admin.storage.from("item-photos").remove([path]);
        if (removeError) {
          // If the object is already gone, allow row cleanup to continue; otherwise leave the row for retry.
          const { data: existing, error: listError } = await admin.storage.from("item-photos").list("", { search: path, limit: 10 });
          const exists = !listError && (existing || []).some((item) => item.name === path);
          if (exists || listError) {
            console.error(`Photo removal failed for report ${report.id}:`, removeError.message, listError?.message || "");
            failed++;
            continue;
          }
        }
      }
      // Delete only if it is still resolved and past the same deadline, to avoid races with changes.
      const { data: removedRows, error: deleteError } = await admin.from("reports")
        .delete().eq("id", report.id).eq("resolved", true).lte("resolved_at", expiresAt).select("id");
      if (deleteError) {
        console.error(`Database deletion failed for report ${report.id}:`, deleteError.message);
        failed++;
      } else if ((removedRows || []).length) {
        deleted++;
      }
    } catch (error) {
      console.error(`Cleanup failed for report ${report.id}:`, error);
      failed++;
    }
  }
  const staleLimit = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { error: limitsError } = await admin.from("report_submission_limits").delete().lt("created_at", staleLimit);
  if (limitsError) console.warn("Rate-limit cleanup failed:", limitsError.message);
  return json({ ok: true, examined: (due || []).length, deleted, failed, cutoff: expiresAt });
});
