-- Live activity panel (2026-11-01): a customer's queued Draftsman job shows its place in the
-- platform-wide queue ("position 3"). Row security only lets a customer see their own jobs,
-- so the count of jobs ahead of theirs comes from this function. It returns positions only
-- for the caller's own company's queued jobs and never any detail of other companies' jobs.
-- Applied with "Approved SQL".
create or replace function public.draftsman_queue_positions(p_ids uuid[])
returns table(job_id uuid, "position" int)
language sql stable security definer set search_path = public as $$
  select j.id,
         (select count(*) from public.draftsman_jobs q
           where q.status = 'queued' and q.created_at <= j.created_at)::int
    from public.draftsman_jobs j
   where j.id = any(p_ids) and j.status = 'queued'
     and j.project_id in (select p.id from public.projects p
                            join public.profiles pr on pr.company_id = p.company_id
                           where pr.id = auth.uid())
$$;
revoke all on function public.draftsman_queue_positions(uuid[]) from public, anon;
grant execute on function public.draftsman_queue_positions(uuid[]) to authenticated;
