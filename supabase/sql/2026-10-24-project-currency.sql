-- Quantora: each project has its own currency (24 Oct 2026).
-- Chosen on the project form, defaulting to the country's currency. Estimates,
-- RFQs, approvals and contracts on the project start from it. Existing rows in
-- those tables keep the currency they were saved with.
alter table public.projects add column if not exists currency text;
update public.projects set currency = case lower(trim(country))
    when 'uae' then 'AED' when 'united arab emirates' then 'AED' when 'ksa' then 'SAR' when 'saudi arabia' then 'SAR'
    when 'qatar' then 'QAR' when 'kuwait' then 'KWD' when 'bahrain' then 'BHD' when 'oman' then 'OMR'
    when 'india' then 'INR' when 'pakistan' then 'PKR' when 'bangladesh' then 'BDT' when 'sri lanka' then 'LKR'
    when 'malaysia' then 'MYR' when 'singapore' then 'SGD' when 'indonesia' then 'IDR' when 'thailand' then 'THB'
    when 'vietnam' then 'VND' when 'philippines' then 'PHP' when 'hong kong' then 'HKD' when 'australia' then 'AUD'
    when 'azerbaijan' then 'AZN' when 'ethiopia' then 'ETB' when 'uk' then 'GBP' when 'united kingdom' then 'GBP'
    when 'us' then 'USD' when 'usa' then 'USD' else null end
 where currency is null;
