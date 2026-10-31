# UniFind Campus

**Tagline:** Lost it. Find it. Get it back.

A neon Gen-Z campus Lost & Found website for IIIT Guwahati built with HTML, CSS, vanilla JavaScript, Supabase, and a static host such as Netlify or Vercel.

## Project structure

```text
UniFind_Campus_Project/
├── index.html
├── style.css
├── script.js
├── supabase-setup.sql
├── README.md
├── SUPABASE_SETUP.md
└── supabase/
    ├── config.toml
    ├── schedule-cleanup.sql
    └── functions/
        ├── submit-report/index.ts
        ├── resolve-report/index.ts
        └── cleanup-resolved-reports/index.ts
```

## Included

- Lost and found report forms, photo preview, detail modals, search, type/category filters, stats, responsive neon styling.
- Supabase shared reports via a public-safe `reports_public` view.
- Image upload through a server-side Edge Function, capped at 10 MiB, with JPEG/PNG/WebP support.
- Contact details hidden by default; public only when the reporter opts in.
- Approved moderator sign-in for resolving reports.
- Server-side cleanup Edge Function and a Cron setup script to remove resolved reports and their photos approximately one hour after resolution.
- Public submissions are rate-limited per hashed IP (thirty attempts/hour per hashed IP in this starter configuration).

## 1. Create a fresh Supabase project

Create a new project at https://supabase.com/dashboard. Open **SQL Editor → New query** and run the complete `supabase-setup.sql` file. This creates the `reports` table, a public-safe view, a moderator allow-list, a rate-limit table, indexes, and the `item-photos` bucket. It does not create any real reports or delete report rows.

Check Storage settings too: the bucket and the project's global Storage limit must both allow at least **10 MiB (10 × 1024 × 1024 bytes)**. The SQL configures `item-photos` to 10 MiB and image MIME types JPEG, PNG, WebP.

## 2. Configure the frontend

Open `script.js`. Replace these placeholders with the values from your own Supabase project:

```js
const SUPABASE_URL = 'PASTE_SUPABASE_PROJECT_URL_HERE';
const SUPABASE_PUBLISHABLE_KEY = 'PASTE_SUPABASE_PUBLISHABLE_KEY_HERE';
```

Get them from your project's Connect dialog or Project Settings → API Keys. Use the Project URL and publishable key (or legacy `anon` public key). **Never paste a service-role/secret key in `script.js`.**

The frontend will not pretend to save reports locally if Supabase is not configured.

## 3. Deploy the Edge Functions

Install the Supabase CLI and log in, then from this project directory run:

```bash
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase functions deploy submit-report
supabase functions deploy resolve-report
supabase functions deploy cleanup-resolved-reports
```

The `supabase/config.toml` disables gateway JWT verification for these three functions because `submit-report` is a public form endpoint and the other two validate their own moderator JWT or cleanup secret. That does **not** mean the actions are unprotected: submit requests are validated and rate-limited; resolve requires an authenticated user in `public.moderators`; cleanup requires the private `CLEANUP_SECRET` header.

Supabase normally supplies `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` to Edge Functions. Verify these are available in Edge Function secrets. If your project dashboard requires explicit configuration, set them there. The service-role key is used only by server-side functions and must never appear in the HTML/JS bundle or Git repository.

Optional: after deployment, set the `ALLOWED_ORIGIN` Edge Function secret to the exact public origin, e.g. `https://your-project.vercel.app` (no trailing slash), or your Netlify origin. The submit function allows any origin if `ALLOWED_ORIGIN` is absent; set it after the hosting URL is known.

## 4. Create a moderator account

1. In Supabase Dashboard → Authentication → Users, create an account for the trusted moderator. Keep sign-up unavailable to the public.
2. Copy the user's UUID.
3. In SQL Editor, run the following with the actual UUID:

```sql
insert into public.moderators (user_id)
values ('PASTE_AUTH_USER_UUID_HERE');
```

The `Moderator Sign In` link in the site uses Supabase Auth. The `resolve-report` Edge Function checks both the signed-in user's identity and the `public.moderators` allow-list before setting `resolved_at`.

## 5. Enable automatic one-hour cleanup

The resolved record is hidden from the public view once its `resolved_at` is older than one hour. A scheduled Edge Function permanently removes both its Storage object and database row. Cleanup can occur up to roughly one scheduled interval (about one minute) after the one-hour threshold.

1. In Supabase Dashboard, enable the `pg_cron`, `pg_net`, and Vault extensions where available.
2. Generate a long random cleanup secret.
3. Set the Edge Function secret `CLEANUP_SECRET` to that value. Example CLI command:

```bash
supabase secrets set CLEANUP_SECRET="YOUR_LONG_RANDOM_SECRET"
```

4. Open `supabase/schedule-cleanup.sql`. Replace `YOUR_PROJECT_REF`, `PASTE_SUPABASE_PUBLISHABLE_KEY_HERE`, and the cleanup-secret placeholder with your real values, then run it once in the SQL Editor. The publishable key can be public; keep the cleanup secret private. Do not commit the edited file after inserting the cleanup secret.
5. Verify in Supabase Dashboard → Integrations/ Cron / job run history (location may vary) that the `unifind-cleanup-resolved-reports` job runs successfully. Check Edge Function logs for failures.

The schedule block can be updated later, but the Vault secret-creation block only creates missing names; it does not rotate existing secret values. If you rotate the cleanup secret, update the matching Vault secret and Edge Function secret. The cron job is unscheduled and rescheduled by name when the schedule script is run.

## 6. Deploy the public website

The website is static. You can publish it as a **new site** on either provider:

### Netlify

- Open https://app.netlify.com/drop or create a new site in the dashboard.
- Upload the extracted project folder containing `index.html`, `style.css`, and `script.js`.

### Vercel

- Put the project files at the root of a new GitHub repository.
- Open https://vercel.com/new and import that repository as a **new project**.
- For plain HTML/CSS/JavaScript, choose **Other** as the framework preset. Leave the build command empty; keep `index.html`, `style.css`, and `script.js` at the project root.
- Deploy and use the new URL generated by Vercel.

This project contains no prior website URL and does not deploy over an existing website. Your hosting provider generates a new public URL. If you set `ALLOWED_ORIGIN`, set it to that exact URL origin and redeploy Edge Function secrets if necessary.

## 7. Test before sharing

1. Open the public site. The cloud status should show that sync is active, not setup required.
2. Submit a small test image and report. Only after server confirmation should the site show “Report Posted”.
3. Confirm the new row appears in **Table Editor → reports** and the photo object appears in **Storage → item-photos**.
4. Open the new site on a second device/browser; the report should appear there too.
5. Try an image larger than 10 MiB; it should be rejected with a clear message. Test a supported image under that size.
6. Sign in with an approved moderator, resolve a test report, and confirm it leaves the active list.
7. Temporarily test the cleanup function with a dedicated test record whose `resolved_at` is older than one hour; check that the row and photo disappear. Do not change real reports just to test cleanup.
8. Verify the scheduled job and Edge Function logs.

## Security and limitations

- `reports_public` exposes public report fields only. Contact details are returned only when the reporter explicitly opts to show them.
- Images are in a public bucket, which makes photos viewable by anyone with the URL. Do not upload IDs, financial documents, or other sensitive images.
- The report submission limit is a starter anti-spam control, not a complete bot defense. Consider CAPTCHA/Turnstile and stronger abuse monitoring before a large public launch.
- The browser key is publishable; the service-role key is privileged and must stay server-side.
- Do not disable RLS or add public update/delete policies to fix errors. Resolve policy errors by checking the view grants and Edge Function configuration.
- The one-hour cleanup relies on Supabase Cron/pg_net/Vault being enabled and the deployment secrets being set correctly. Code alone does not activate your account's scheduled task.

## Local preview

You can open `index.html` for layout work, but cloud reads/uploads require a working Supabase project, configured frontend URL/key, and deployed Edge Functions. Prefer a local static server or your host preview for testing API calls. Do not claim cloud features work until the database and Storage tests above pass.
