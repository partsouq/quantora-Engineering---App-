// ===========================================================================
// Civil take-off: the method of measurement by project country (24 Oct 2026).
// Used only by the civil / structural / architectural take-off prompts.
// ===========================================================================

const clean = (v: unknown) => String(v ?? "").trim().toLowerCase().replace(/\s+/g, " ");
const EU = ["austria", "belgium", "bulgaria", "croatia", "cyprus", "czech republic", "czechia", "denmark", "estonia",
  "finland", "greece", "hungary", "italy", "latvia", "lithuania", "luxembourg", "malta", "netherlands", "poland",
  "portugal", "romania", "slovakia", "slovenia", "spain", "sweden", "norway", "switzerland"];


// Civil / structural / architectural take-off: the method of measurement the
// project's country normally prices against. The measured quantities do not
// change; the units, what is deducted and how items are described follow it.
// ----------------------------------------------------------------------------
const CIVIL_METHOD: [string[], string][] = [
  [["uae", "united arab emirates", "ae", "emirates", "ksa", "saudi arabia", "saudi", "sa", "qatar", "qa", "kuwait", "kw", "bahrain", "bh", "oman", "om"],
    "POMI (Principles of Measurement International) or NRM2, as the GCC tender usually states; QCS for Qatar where specified"],
  [["india", "in", "bharat"], "IS 1200 (Method of measurement of building and civil engineering works), with CPWD specification item descriptions"],
  [["pakistan", "pk"], "SMM7 / NRM2 as used in Pakistani tenders, or the employer's schedule (e.g. MRS item descriptions)"],
  [["bangladesh", "bd"], "the PWD Schedule of Rates method of measurement (SMM7 / NRM2 for international tenders)"],
  [["sri lanka", "srilanka", "lk"], "SLS 573 / ICTAD (CIDA) method of measurement"],
  [["uk", "united kingdom", "great britain", "gb", "england", "scotland", "wales", "northern ireland", "ireland", "ie"], "NRM2 (RICS New Rules of Measurement); CESMM4 for civil engineering works"],
  [["us", "usa", "united states", "united states of america", "america", "canada", "ca"], "CSI MasterFormat divisions, quantities in the units the drawings use (convert to metric only if the project is metric)"],
  [["australia", "au", "new zealand", "nz"], "ASMM (Australian / New Zealand Standard Method of Measurement)"],
  [["singapore", "sg"], "SMM for Building Works (Singapore)"],
  [["malaysia", "my"], "SMM2 (Malaysian Standard Method of Measurement)"],
  [["hong kong", "hk", "hksar"], "HKSMM4 (Hong Kong Standard Method of Measurement)"],
  [["south africa", "za", "rsa"], "ASAQS Standard System of Measuring Building Work; SANS 1200 for civil works"],
  [["philippines", "ph"], "the DPWH / PICE method of measurement or POMI as the tender states"],
];

/** The method of measurement line for civil take-off prompts. */
export function civilMethodLine(country: unknown): string {
  const c = clean(country);
  const hit = CIVIL_METHOD.find(([names]) => names.includes(c));
  const method = hit ? hit[1] : (EU.includes(c)
    ? "the national standard method of measurement (or NRM2 / POMI where the tender states it)"
    : "POMI (Principles of Measurement International) unless the tender names another standard");
  return `\nMethod of measurement for this project (${country || "country not stated"}): measure and describe items to ${method}. ` +
    `The measurement rules below still apply; where the named method differs (deduction thresholds, units, item descriptions), follow the named method and say so in quantity_basis_notes.\n`;
}
