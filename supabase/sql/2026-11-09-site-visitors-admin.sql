-- 2026-11-09  Website visitors: real people only, and an Admin page (approved by the owner).
-- 1. Google's own checks (URL Inspection / "Google-InspectionTool", GoogleOther, AdsBot, AI crawlers)
--    are no longer counted as visitors.
-- 2. Visits from people already signed in to Quantora (the owner, the team, existing customers,
--    the robot) are not counted, so the number shows new people only. visit.js sends m=1 for them.
-- 3. q_site_visits_admin(): numbers for the Admin "Website Visitors" page (owner + allowed team).

create or replace function public.q_site_visit(p jsonb)
 returns void language plpgsql security definer set search_path to 'public' as $function$
declare h jsonb := coalesce(nullif(current_setting('request.headers', true), '')::jsonb, '{}'::jsonb);
        ua text := coalesce(h->>'user-agent', ''); ip text := split_part(coalesce(h->>'x-forwarded-for', ''), ',', 1);
        v text;
begin
  if coalesce(p->>'m', '') = '1' then return; end if;
  if ua = '' or ua ~* '(bot|crawl|spider|slurp|headless|playwright|puppeteer|lighthouse|preview|curl|python|wget|monitor|google|inspectiontool|adsbot|mediapartners|facebookexternalhit|yandex|baidu|semrush|ahrefs|gptbot|chatgpt-user|oai-searchbot|claude|anthropic|perplexity|bytespider|petalbot|applebot|duckduck|bingpreview|vercel|uptime|pingdom|scan)' then return; end if;
  v := md5(ip || '|' || ua || '|' || current_date::text || '|qe-visits');
  if (select count(*) from site_visits where vhash = v and at > now() - interval '1 day') >= 50 then return; end if;
  insert into site_visits (path, ref_host, source, country, vhash)
  values (left(coalesce(p->>'path', '/'), 120), nullif(left(lower(coalesce(p->>'ref', '')), 80), ''),
          nullif(left(lower(coalesce(p->>'src', '')), 60), ''), nullif(left(coalesce(h->>'cf-ipcountry', ''), 4), ''), v);
end $function$;

create or replace function public.q_site_visits_admin(p_days int default 30)
 returns jsonb language plpgsql stable security definer set search_path to 'public' as $function$
declare d int := greatest(1, least(coalesce(p_days, 30), 180));
        day0 timestamptz := date_trunc('day', now() at time zone 'Asia/Dubai') at time zone 'Asia/Dubai';
begin
  if public.q_staff_level('visitors') < 1 then raise exception 'No access to Website Visitors.'; end if;
  return (
    with v as (select * from site_visits where at >= day0 - make_interval(days => d - 1))
    select jsonb_build_object(
      'today',  (select count(distinct vhash) from v where at >= day0),
      'week',   (select count(distinct vhash) from v where at >= day0 - interval '6 days'),
      'period', (select count(distinct vhash) from v),
      'views',  (select count(*) from v),
      'days', d,
      'daily', coalesce((select jsonb_agg(x order by x->>'day') from (
          select jsonb_build_object('day', to_char(g::date, 'YYYY-MM-DD'),
                 'n', (select count(distinct vhash) from v where (at at time zone 'Asia/Dubai')::date = g::date)) x
          from generate_series((day0 at time zone 'Asia/Dubai')::date - (d - 1), (day0 at time zone 'Asia/Dubai')::date, interval '1 day') g) q), '[]'::jsonb),
      'sources', coalesce((select jsonb_agg(x) from (select coalesce(source, ref_host, 'direct') s, count(distinct vhash) n from v group by 1 order by 2 desc limit 10) x), '[]'::jsonb),
      'countries', coalesce((select jsonb_agg(x) from (select coalesce(country, '?') c, count(distinct vhash) n from v group by 1 order by 2 desc limit 10) x), '[]'::jsonb),
      'pages', coalesce((select jsonb_agg(x) from (select path, count(*) n, count(distinct vhash) people from v group by 1 order by 2 desc limit 15) x), '[]'::jsonb),
      'recent', coalesce((select jsonb_agg(x) from (select at, path, coalesce(source, ref_host, 'direct') s, country c from v order by at desc limit 40) x), '[]'::jsonb)));
end $function$;
revoke all on function public.q_site_visits_admin(int) from public, anon;
grant execute on function public.q_site_visits_admin(int) to authenticated;
