-- 2026-11-09  Website visitor counter (approved by the owner).
-- No cookies and no personal data: only page, referring site, campaign source, country and a
-- one-way daily code (hash of network address + browser + date) so a visitor counts once a day.
create table if not exists public.site_visits (
  id bigserial primary key,
  at timestamptz not null default now(),
  path text,
  ref_host text,
  source text,
  country text,
  vhash text
);
create index if not exists site_visits_at on public.site_visits (at);
alter table public.site_visits enable row level security;   -- no policies: only the server reads it

create or replace function public.q_site_visit(p jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare h jsonb := coalesce(nullif(current_setting('request.headers', true), '')::jsonb, '{}'::jsonb);
        ua text := coalesce(h->>'user-agent', ''); ip text := split_part(coalesce(h->>'x-forwarded-for', ''), ',', 1);
        v text;
begin
  if ua = '' or ua ~* '(bot|crawl|spider|slurp|headless|playwright|puppeteer|lighthouse|preview|curl|python|wget|monitor)' then return; end if;
  v := md5(ip || '|' || ua || '|' || current_date::text || '|qe-visits');
  if (select count(*) from site_visits where vhash = v and at > now() - interval '1 day') >= 50 then return; end if;
  insert into site_visits (path, ref_host, source, country, vhash)
  values (left(coalesce(p->>'path', '/'), 120), nullif(left(lower(coalesce(p->>'ref', '')), 80), ''),
          nullif(left(lower(coalesce(p->>'src', '')), 60), ''), nullif(left(coalesce(h->>'cf-ipcountry', ''), 4), ''), v);
end $$;
revoke all on function public.q_site_visit(jsonb) from public;
grant execute on function public.q_site_visit(jsonb) to anon, authenticated;

-- for the hourly report (service role only)
create or replace function public.q_site_visit_stats(p_from timestamptz, p_to timestamptz) returns jsonb
language sql stable security definer set search_path = public as $$
  with v as (select * from site_visits where at >= p_from and at < p_to)
  select jsonb_build_object(
    'visitors', (select count(distinct vhash) from v),
    'views', (select count(*) from v),
    'sources', coalesce((select jsonb_agg(x) from (select coalesce(source, ref_host, 'direct') s, count(distinct vhash) n from v group by 1 order by 2 desc limit 5) x), '[]'::jsonb),
    'countries', coalesce((select jsonb_agg(x) from (select coalesce(country, '?') c, count(distinct vhash) n from v group by 1 order by 2 desc limit 5) x), '[]'::jsonb),
    'pages', coalesce((select jsonb_agg(x) from (select path, count(*) n from v group by 1 order by 2 desc limit 5) x), '[]'::jsonb));
$$;
revoke all on function public.q_site_visit_stats(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.q_site_visit_stats(timestamptz, timestamptz) to service_role;
