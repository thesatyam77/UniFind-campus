-- UniFind Campus: initial Supabase setup for a NEW project.
-- Safe to re-run for this schema. No report rows are dropped or truncated.
-- This setup keeps privileged writes server-side through Supabase Edge Functions.

create extension if not exists pgcrypto;

create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('lost', 'found')),
  item_name varchar(100) not null check (length(trim(item_name)) between 1 and 100),
  category varchar(60) not null default 'Other',
  description varchar(500) not null check (length(trim(description)) between 1 and 500),
  location varchar(150) not null check (length(trim(location)) between 1 and 150),
  report_date date not null,
  contact_method varchar(30),
  contact_details varchar(100),
  contact_is_public boolean not null default false,
  photo_url text not null,
  photo_path text not null,
  resolved boolean not null default false,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  constraint resolved_timestamp_consistency check (
    (resolved = false and resolved_at is null) or (resolved = true and resolved_at is not null)
  )
);

create index if not exists reports_active_created_idx
  on public.reports (resolved, created_at desc);
create index if not exists reports_cleanup_idx
  on public.reports (resolved_at)
  where resolved = true;

-- Only safe fields are exposed by this view. Contact information is NULL unless opted in.
-- Expired resolved reports are hidden immediately even if the scheduled cleanup is delayed.
create or replace view public.reports_public as
select
  id, type, item_name, category, description, location, report_date,
  case when contact_is_public then contact_method else null end as contact_method,
  case when contact_is_public then contact_details else null end as contact_details,
  photo_url, resolved, resolved_at, created_at
from public.reports
where resolved = false
   or (resolved = true and resolved_at >= now() - interval '1 hour');

grant select on public.reports_public to anon, authenticated, service_role;
revoke all on public.reports from anon, authenticated;
grant all privileges on public.reports to service_role;
alter table public.reports enable row level security;

-- Moderator allow-list: create users under Supabase Authentication, then insert their user UUID here.
create table if not exists public.moderators (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.moderators enable row level security;
revoke all on public.moderators from anon, authenticated;
grant all privileges on public.moderators to service_role;

-- Private rate-limit table; managed only by service-role Edge Functions.
create table if not exists public.report_submission_limits (
  id bigint generated always as identity primary key,
  ip_hash text not null,
  created_at timestamptz not null default now()
);
create index if not exists report_submission_limits_ip_time_idx
  on public.report_submission_limits (ip_hash, created_at desc);
alter table public.report_submission_limits enable row level security;
revoke all on public.report_submission_limits from anon, authenticated;
grant all privileges on public.report_submission_limits to service_role;
grant usage, select on all sequences in schema public to service_role;

-- Public photo reads are allowed, but only trusted Edge Functions can upload/remove.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('item-photos', 'item-photos', true, 10485760, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
set public = true,
    file_size_limit = 10485760,
    allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'];

-- A public bucket enables anonymous reads; do NOT add public INSERT, UPDATE, or DELETE policies.
-- Storage writes/removals use the service role exclusively from Edge Functions.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'UniFind Campus public can view item photos'
  ) then
    create policy "UniFind Campus public can view item photos"
      on storage.objects for select
      to anon, authenticated
      using (bucket_id = 'item-photos');
  end if;
end $$;
