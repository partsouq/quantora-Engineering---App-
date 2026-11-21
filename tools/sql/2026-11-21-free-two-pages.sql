-- 2026-11-21 (owner): every free user gets 2 AI take-off pages in total.
-- The welcome pack itself now holds the 2 pages; the promo adds no AI pages (it still adds the
-- 100 Manual Take-off drawings and 10 Draftsman pages). The engine also caps free users at 2,
-- whatever bonus pages a company carries.
update plans set max_drawing_pages = 2 where id = 'trial';
update promo_campaigns set ai_pages = 0 where id = 'first50';
