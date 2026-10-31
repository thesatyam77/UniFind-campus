# UniFind Campus — Supabase setup

This is a fresh-project setup. Run `supabase-setup.sql` once in **Supabase Dashboard → SQL Editor → New query**. It creates the report schema, a public-safe view, moderator allow-list, rate-limit table, and the `item-photos` bucket with a 10 MiB bucket limit.

## Credentials

In `script.js`, fill in:

```js
const SUPABASE_URL = 'PASTE_SUPABASE_PROJECT_URL_HERE';
const SUPABASE_PUBLISHABLE_KEY = 'PASTE_SUPABASE_PUBLISHABLE_KEY_HERE';
```

Use a Project URL and publishable/anon key only. Never put the service-role key in browser code.

## Edge Functions

Deploy `submit-report`, `resolve-report`, and `cleanup-resolved-reports` using the Supabase CLI. The public submission function stores the image and report row server-side; it attempts to remove an uploaded image if the row insert fails. Only allow-listed moderator users can resolve reports. The cleanup function requires `CLEANUP_SECRET`.

## One-hour cleanup

Set `CLEANUP_SECRET` in Edge Function secrets and store the matching URL/secret using Supabase Vault. Replace the placeholders and run `supabase/schedule-cleanup.sql` to schedule cleanup every minute. Check the job run history and Edge Function logs after setup.

## Public image privacy

The `item-photos` bucket is public for image display. Do not upload sensitive documents. Public Storage read is not the same as permission to upload or delete; upload/removal are handled server-side by Edge Functions.
