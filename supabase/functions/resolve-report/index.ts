import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return json({ error: "Moderator sign-in is required." }, 401);
  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !anonKey || !serviceKey) return json({ error: "Server configuration is incomplete." }, 500);
  const authClient = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: userData, error: userError } = await authClient.auth.getUser(token);
  if (userError || !userData.user) return json({ error: "Your session is invalid or expired. Please sign in again." }, 401);
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: moderator, error: moderatorError } = await admin.from("moderators").select("user_id").eq("user_id", userData.user.id).maybeSingle();
  if (moderatorError) {
    console.error("Moderator lookup failed:", moderatorError.message);
    return json({ error: "Could not verify moderator permissions." }, 500);
  }
  if (!moderator) return json({ error: "This account is not an approved UniFind Campus moderator." }, 403);
  let body: { id?: string };
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON request." }, 400); }
  const id = typeof body.id === "string" ? body.id : "";
  if (!/^[0-9a-f-]{36}$/i.test(id)) return json({ error: "Invalid report id." }, 400);
  const { data, error } = await admin.from("reports")
    .update({ resolved: true, resolved_at: new Date().toISOString() })
    .eq("id", id).eq("resolved", false).select("id").maybeSingle();
  if (error) {
    console.error("Resolve update failed:", error.message);
    return json({ error: "Could not update the report." }, 500);
  }
  if (!data) return json({ error: "Report was not found or is already resolved." }, 404);
  return json({ ok: true, id: data.id, message: "Resolved timestamp recorded by the server." });
});
