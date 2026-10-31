v-- UniFind Campus scheduled cleanup setup.
-- BEFORE running this file:
-- 1) Enable Supabase extensions pg_cron, pg_net, and Vault (Dashboard -> Integrations/Extensions).
-- 2) Deploy supabase/functions/cleanup-resolved-reports with verify_jwt=false.
-- 3) Add a CLEANUP_SECRET Edge Function secret and set it to a long random string.
-- 4) Replace the URL, publishable-key, and cleanup-secret placeholders below.
-- 5) The publishable key is public, but the cleanup secret must remain private and match CLEANUP_SECRET.
-- 6) Never commit a real cleanup secret to GitHub or put it in frontend code.

do $$
begin
  if not exists (select 1 from vault.decrypted_secrets where name = 'unifind_cleanup_function_url') then
    perform vault.create_secret(
      'https://YOUR_PROJECT_REF.supabase.co/functions/v1/cleanup-resolved-reports',
      'unifind_cleanup_function_url'
    );
  end if;
  if not exists (select 1 from vault.decrypted_secrets where name = 'unifind_cleanup_apikey') then
    perform vault.create_secret(
      'PASTE_SUPABASE_PUBLISHABLE_KEY_HERE',
      'unifind_cleanup_apikey'
    );
  end if;
  if not exists (select 1 from vault.decrypted_secrets where name = 'unifind_cleanup_function_secret') then
    perform vault.create_secret(
      'REPLACE_WITH_THE_SAME_LONG_RANDOM_CLEANUP_SECRET',
      'unifind_cleanup_function_secret'
    );
  end if;
end $$;

-- Safe to rerun: unschedule a prior job with this name before scheduling again.
do $$
declare existing_job record;
begin
  for existing_job in select jobid from cron.job where jobname = 'unifind-cleanup-resolved-reports' loop
    perform cron.unschedule(existing_job.jobid);
  end loop;
end $$;

select cron.schedule(
  'unifind-cleanup-resolved-reports',
  '* * * * *',
  $$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'unifind_cleanup_function_url'),
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'unifind_cleanup_apikey'),
        'x-cleanup-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'unifind_cleanup_function_secret')
      ),
      body := '{}'::jsonb
    );
  $$
);
