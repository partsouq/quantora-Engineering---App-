-- Quantora (2026-11-02): Welcome Pack rules agreed with the owner.
--   * AI take-off: 1 drawing sheet (was 2)
--   * Tender / specification documents: 0 (Tender Intelligence and Specification are paid-plan features)
--   * Storage: 300 MB per Welcome Pack account (was 1 GB); more space = upgrade
--   * Rework 1, Draftsman 1 drawing, Estima chat 10, 1 project, 1 user: unchanged
--   * Login never expires (trial_duration_days already 36500)
--   * The 7-day Welcome Pack data clean-up is switched off, so their projects are kept
-- Manual Take-off, the Designed BOQ and downloads stay unlimited (they use no AI).
-- Locks for quotation compliance and pricing are enforced in ai-engine; the rest in the app.

update public.plans
   set max_drawing_pages = 1,
       max_documents     = 0,
       storage_gb        = 0.29296875     -- 300 MB
 where id = 'trial';

select cron.alter_job(jobid, active := false) from cron.job where jobname = 'welcome-cleanup-daily';

select id, max_drawing_pages, max_documents, storage_gb, max_rework_per_project, max_draftsman_pages, max_chat_requests from public.plans where id = 'trial';
