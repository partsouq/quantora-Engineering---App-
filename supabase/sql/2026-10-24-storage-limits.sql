-- Quantora: storage limits by plan, with monthly add-ons (24 Oct 2026)
--
-- Every plan includes some storage; a company can buy more as a monthly add-on.
-- All files count: drawings, tender documents, quotations and support uploads.
-- At 100% new uploads are refused. Nothing is ever deleted.
-- To change the amounts later, edit plans.storage_gb. No code change needed.

alter table public.plans add column if not exists storage_gb numeric not null default 1;
update public.plans set storage_gb = case id
  when 'free' then 1 when 'trial' then 1 when 'starter' then 10
  when 'professional' then 50 when 'business' then 200 when 'enterprise' then 1000
  else storage_gb end;

alter table public.companies add column if not exists storage_addon_gb numeric not null default 0;

-- Bytes stored by one company, across every bucket.
create or replace function public.company_storage_used(p_company uuid)
returns bigint language sql stable security definer set search_path = public, storage, pg_temp as $$
  select coalesce(sum((o.metadata->>'size')::bigint), 0)::bigint
    from storage.objects o
   where (o.bucket_id = 'drawings' and split_part(o.name, '/', 1) in (
            select p.id::text from projects p left join profiles pr on pr.id = p.owner_id
             where coalesce(p.company_id, pr.company_id) = p_company))
      or (o.bucket_id = 'tenders' and split_part(o.name, '/', 1) in (
            select t.id::text from tenders t where t.company_id = p_company))
      or (o.bucket_id = 'support' and split_part(o.name, '/', 1) in (
            select pr.id::text from profiles pr where pr.company_id = p_company));
$$;
revoke execute on function public.company_storage_used(uuid) from public, anon, authenticated;

create or replace function public.company_storage_quota(p_company uuid)
returns bigint language sql stable security definer set search_path = public, pg_temp as $$
  select ((coalesce(pl.storage_gb, 1) + coalesce(co.storage_addon_gb, 0)) * 1073741824)::bigint
    from companies co left join plans pl on pl.id = coalesce(co.plan, 'free')
   where co.id = p_company;
$$;
revoke execute on function public.company_storage_quota(uuid) from public, anon, authenticated;

-- For the dashboard meter and the billing page.
create or replace function public.my_storage_usage()
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  with c as (select company_id from profiles where id = (select auth.uid()))
  select jsonb_build_object(
    'used_bytes',  public.company_storage_used(c.company_id),
    'quota_bytes', public.company_storage_quota(c.company_id),
    'plan_bytes',  (select (coalesce(pl.storage_gb, 1) * 1073741824)::bigint
                      from companies co left join plans pl on pl.id = coalesce(co.plan, 'free')
                     where co.id = c.company_id),
    'addon_gb',    (select storage_addon_gb from companies where id = c.company_id))
  from c where c.company_id is not null;
$$;
revoke execute on function public.my_storage_usage() from public, anon;
grant execute on function public.my_storage_usage() to authenticated;

-- The company a new file belongs to, from its bucket and folder.
create or replace function public.storage_object_company(p_bucket text, p_name text)
returns uuid language sql stable security definer set search_path = public, pg_temp as $$
  select case p_bucket
    when 'drawings' then (select coalesce(p.company_id, pr.company_id) from projects p
                            left join profiles pr on pr.id = p.owner_id
                           where p.id::text = split_part(p_name, '/', 1))
    when 'tenders'  then (select t.company_id from tenders t where t.id::text = split_part(p_name, '/', 1))
    when 'support'  then (select pr.company_id from profiles pr where pr.id::text = split_part(p_name, '/', 1))
  end;
$$;
create or replace function public.storage_has_room(p_bucket text, p_name text)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select case when c is null then true
              else public.company_storage_used(c) < public.company_storage_quota(c) end
    from (select public.storage_object_company(p_bucket, p_name) as c) x;
$$;
revoke execute on function public.storage_object_company(text, text) from public, anon;
revoke execute on function public.storage_has_room(text, text) from public, anon;
grant execute on function public.storage_has_room(text, text) to authenticated;

-- Uploads are refused once the company is at or over its storage.
-- Restrictive: adds to the existing owner rules. Reading and deleting are unchanged,
-- so a full account can always free space.
drop policy if exists storage_quota_insert on storage.objects;
create policy storage_quota_insert on storage.objects as restrictive for insert to authenticated
  with check (bucket_id not in ('drawings', 'tenders', 'support') or public.storage_has_room(bucket_id, name));
