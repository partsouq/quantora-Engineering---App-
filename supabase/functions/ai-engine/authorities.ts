// ===========================================================================
// Local authorities and codes by project country (24 Oct 2026).
//
// Every take-off, design and revision prompt used to end with "Use local
// UAE/regional norms (DEWA, Dubai Civil Defence ...)", so an India or UK
// project was steered towards Dubai rules. The prompt now names the
// authorities for the project's own country. A country not listed here is
// told to use the authority having jurisdiction in that country, with the
// international codes as a baseline and a note that local approval must be
// confirmed -- never UAE rules by default.
// ===========================================================================

type Norms = { names: string[]; text: string };

const N = (names: string[], text: string): Norms => ({ names, text });

// City-level entries are checked first (the UAE emirates differ).
const CITY_NORMS: Record<string, Norms> = {
  dubai: N(["dubai"], "Dubai: Dubai Civil Defence (UAE Fire and Life Safety Code of Practice), DEWA (electricity and water regulations), SIRA (security systems / CCTV), TDRA (telecom), Dubai Municipality and Al Sa'fat green building regulations."),
  abudhabi: N(["abu dhabi", "al ain", "musaffah", "ruwais"], "Abu Dhabi: Abu Dhabi Civil Defence (UAE Fire and Life Safety Code of Practice), ADDC / AADC (Abu Dhabi electricity wiring regulations), Monitoring and Control Centre (ADMCC) security systems guideline, TDRA (telecom), Estidama Pearl rating, Abu Dhabi building code."),
  sharjah: N(["sharjah"], "Sharjah: Sharjah Civil Defence (UAE Fire and Life Safety Code of Practice), SEWA (electricity and water), Sharjah Police security requirements, TDRA (telecom), Sharjah Municipality."),
  northern: N(["ajman", "ras al khaimah", "rak", "fujairah", "umm al quwain", "uaq"], "Northern Emirates: UAE Civil Defence (UAE Fire and Life Safety Code of Practice), Etihad Water and Electricity (EtihadWE) regulations, local police security requirements, TDRA (telecom), the emirate's municipality."),
};

const COUNTRY_NORMS: Norms[] = [
  N(["uae", "united arab emirates", "ae", "emirates"], "UAE: UAE Civil Defence (UAE Fire and Life Safety Code of Practice), the emirate's electricity authority (DEWA, ADDC/AADC, SEWA or EtihadWE), the emirate's security systems regulator (e.g. SIRA in Dubai), TDRA (telecom), the emirate's municipality."),
  N(["ksa", "saudi arabia", "saudi", "kingdom of saudi arabia", "sa"], "Saudi Arabia: Saudi Building Code (SBC 801 fire protection, SBC 401 electrical, SBC 501 mechanical, SBC 601/602 energy), Saudi Civil Defence, Saudi Electricity Company (SEC) connection requirements, HCIS / Ministry of Interior security requirements where applicable, CST (telecom), Balady / municipality."),
  N(["qatar", "qa"], "Qatar: Qatar Civil Defence Department (QCDD) fire safety standards, KAHRAMAA wiring and water regulations, Ministry of Interior security systems requirements, CRA (telecom), Qatar Construction Specifications (QCS 2014), Ashghal (drainage), GSAS."),
  N(["kuwait", "kw"], "Kuwait: Kuwait Fire Force fire prevention requirements, Ministry of Electricity, Water and Renewable Energy (MEW) regulations and Code of Practice R-6, Ministry of Interior CCTV regulation, CITRA (telecom), Kuwait Municipality."),
  N(["bahrain", "bh", "kingdom of bahrain"], "Bahrain: General Directorate of Civil Defence fire safety requirements, Electricity and Water Authority (EWA) regulations, Ministry of Interior security requirements, TRA Bahrain (telecom), Ministry of Works / municipality building regulations."),
  N(["oman", "om", "sultanate of oman"], "Oman: Civil Defence and Ambulance Authority (CDAA) fire code, APSR / Nama electricity distribution standards, Royal Oman Police security requirements, TRA Oman (telecom), Muscat Municipality / local municipality, Oman Building Code."),
  N(["india", "in", "bharat"], "India: National Building Code of India 2016 (Part 4 fire and life safety, Part 8 building services), the State Fire Services (Fire NOC), IS 2189 (fire detection and alarm), IS 15105 (sprinklers), Central Electricity Authority (Safety and Electric Supply) Regulations and the state Electrical Inspectorate / DISCOM, IS 732 (wiring), TEC / DoT (telecom), the local municipal corporation or development authority, ECBC (energy)."),
  N(["pakistan", "pk"], "Pakistan: Building Code of Pakistan (Fire Safety Provisions 2016), the local Civil Defence / Rescue 1122 fire department, NEPRA and the local distribution company (e.g. K-Electric, LESCO, IESCO), PTA (telecom), the local development or building control authority (CDA, LDA, SBCA, KDA)."),
  N(["bangladesh", "bd"], "Bangladesh: Bangladesh National Building Code (BNBC 2020), Fire Service and Civil Defence (FSCD), the local distribution company (DPDC, DESCO, BREB), BTRC (telecom), RAJUK or the local development authority."),
  N(["sri lanka", "lk", "srilanka"], "Sri Lanka: the Municipal Council fire brigade fire safety approval, Ceylon Electricity Board (CEB) / LECO, Sri Lanka Electricity Act and wiring regulations, TRCSL (telecom), Urban Development Authority (UDA) regulations."),
  N(["nepal", "np"], "Nepal: Nepal National Building Code (NBC), the municipality's building permit and fire requirements, Nepal Electricity Authority (NEA), Nepal Telecommunications Authority (NTA)."),
  N(["uk", "united kingdom", "great britain", "gb", "england", "scotland", "wales", "northern ireland"], "United Kingdom: Building Regulations (Approved Document B fire, Part L energy, Part P electrical), the local Fire and Rescue Service, Building Control / Building Safety Regulator for higher-risk buildings, BS 5839 (fire detection), BS EN 12845 / BS 9251 (sprinklers), BS 7671 (IET wiring), BS 5266 (emergency lighting), the Distribution Network Operator, BS EN 50173 (cabling)."),
  N(["ireland", "ie", "republic of ireland"], "Ireland: Building Regulations (Technical Guidance Document B fire), Fire Safety Certificate from the local Building Control Authority, I.S. 3218 (fire detection), I.S. 10101 / ET 101 (wiring rules), ESB Networks, ComReg (telecom)."),
  N(["us", "usa", "united states", "united states of america", "america"], "United States: the local authority having jurisdiction (building department and fire marshal), IBC / IFC as adopted locally, NFPA 72 (fire alarm), NFPA 13 (sprinklers), NFPA 70 (NEC), NFPA 101 (life safety), the local electric utility, TIA-568 (cabling), ASHRAE 90.1 / IECC (energy)."),
  N(["canada", "ca"], "Canada: National Building Code of Canada and National Fire Code as adopted by the province, CAN/ULC-S524 (fire alarm installation), NFPA 13 (sprinklers), CSA C22.1 Canadian Electrical Code and the provincial electrical safety authority, the local utility, CRTC (telecom)."),
  N(["australia", "au"], "Australia: National Construction Code (NCC / BCA), the state fire and rescue service, AS 1670.1 (fire detection), AS 2118 (sprinklers), AS 2293 (emergency lighting), AS/NZS 3000 (wiring rules), the local network service provider, ACMA and AS/CA S009 (cabling)."),
  N(["new zealand", "nz"], "New Zealand: New Zealand Building Code, Fire and Emergency New Zealand, NZS 4512 (fire alarm), NZS 4541 (sprinklers), AS/NZS 3000 (wiring rules), WorkSafe electrical regulations, the local lines company."),
  N(["singapore", "sg"], "Singapore: SCDF Fire Code, SS 645 (fire detection and alarm), SS CP 52 (sprinklers), SS 638 (electrical installations), Energy Market Authority (EMA) / SP Group, IMDA COPIF (telecom facilities), BCA (building control and Green Mark), PUB (water and drainage)."),
  N(["malaysia", "my"], "Malaysia: Uniform Building By-Laws 1984 and Bomba (Fire and Rescue Department) approval, MS 1745 (fire detection), MS 1910 (sprinklers), Suruhanjaya Tenaga (Energy Commission) and TNB / the local utility, MCMC (telecom), the local council."),
  N(["indonesia", "id"], "Indonesia: SNI standards (fire protection, SNI 03-3985 fire detection), the local fire department (Dinas Pemadam Kebakaran), PUIL 2011 (wiring), PLN (electricity), Komdigi (telecom), the local building approval (PBG)."),
  N(["philippines", "ph"], "Philippines: Fire Code of the Philippines (RA 9514) and Bureau of Fire Protection (BFP), National Building Code (PD 1096) and the local building official, Philippine Electrical Code (PEC), Meralco or the local distribution utility, NTC (telecom)."),
  N(["thailand", "th"], "Thailand: Building Control Act and Ministerial Regulations, EIT standards (fire alarm, wiring), MEA / PEA (electricity), NBTC (telecom), the local municipality building permit."),
  N(["vietnam", "viet nam", "vn"], "Vietnam: QCVN 06 (fire safety of buildings) and the Fire Police (PCCC) approval, TCVN standards, EVN (electricity), Ministry of Construction building permits, Ministry of Information and Communications (telecom)."),
  N(["hong kong", "hk", "hksar"], "Hong Kong: Fire Services Department Codes of Practice for Minimum Fire Service Installations, Buildings Department, EMSD Code of Practice for the Electricity (Wiring) Regulations, CLP Power / HK Electric, OFCA (telecom)."),
  N(["south africa", "za", "rsa"], "South Africa: SANS 10400-T (fire protection), SANS 10139 (fire detection), SANS 10287 (sprinklers), SANS 10142-1 (wiring), the municipal fire department and building control, Eskom or the municipal utility, ICASA (telecom)."),
  N(["egypt", "eg"], "Egypt: Egyptian Code for Fire Protection and the Civil Protection Authority, Egyptian Electrical Code and the local electricity distribution company, NTRA (telecom), the local building permit authority."),
  N(["jordan", "jo"], "Jordan: Jordan National Building Codes (fire, electrical), Jordan Civil Defence, the electricity distribution company (e.g. JEPCO), TRC (telecom), the local municipality / Greater Amman Municipality."),
  N(["turkey", "turkiye", "türkiye", "tr"], "Turkey: Regulation on Fire Protection of Buildings and the municipal fire brigade, the Electrical Installations Regulation and the distribution company, BTK (telecom), the municipality building permit."),
  N(["azerbaijan", "az"], "Azerbaijan: Ministry of Emergency Situations (State Fire Protection Service) approval, Azerbaijan building norms and rules, Azerishiq (electricity distribution), the Ministry of Digital Development and Transport (telecom). Confirm the applicable editions with the local authority."),
  N(["ethiopia", "et"], "Ethiopia: Ethiopian Building Code Standards (EBCS), the city fire and emergency prevention and rescue authority, Ethiopian Electric Utility (EEU), Ethiopian Communications Authority (telecom), the city building permit authority. Confirm the applicable editions with the local authority."),
  N(["kenya", "ke"], "Kenya: Kenya Building Code, the county fire department, Kenya Power and EPRA (electrical), Communications Authority of Kenya, the county building approval and NCA."),
  N(["nigeria", "ng"], "Nigeria: National Building Code, the Federal / State Fire Service, the local electricity distribution company and NEMSA, NCC (telecom), the state development control authority."),
  N(["germany", "de", "deutschland"], "Germany: the state building code (Landesbauordnung), DIN 14675 / DIN VDE 0833 (fire alarm), VdS / DIN EN 12845 (sprinklers), DIN VDE 0100 (wiring), the local fire brigade and building authority, the local network operator."),
  N(["france", "fr"], "France: ERP / Code de la construction fire regulations, NF S 61-970 (fire detection), APSAD R1 / NF EN 12845 (sprinklers), NF C 15-100 (wiring), the SDIS fire service and commission de sécurité, Enedis."),
];

const EU = ["austria", "belgium", "bulgaria", "croatia", "cyprus", "czech republic", "czechia", "denmark", "estonia",
  "finland", "greece", "hungary", "italy", "latvia", "lithuania", "luxembourg", "malta", "netherlands", "poland",
  "portugal", "romania", "slovakia", "slovenia", "spain", "sweden", "norway", "switzerland"];

const clean = (v: unknown) => String(v ?? "").trim().toLowerCase().replace(/\s+/g, " ");

export function localNorms(country: unknown, city: unknown): string {
  const c = clean(country), t = clean(city);
  const uae = !c || COUNTRY_NORMS[0].names.includes(c);
  if (uae) {
    for (const n of Object.values(CITY_NORMS)) {
      if (n.names.some((x) => t === x || t.startsWith(x + " ") || t.includes(x))) return n.text;
    }
  }
  const hit = COUNTRY_NORMS.find((n) => n.names.includes(c));
  if (hit) return hit.text;
  if (EU.includes(c)) {
    return `${country}: the national building and fire regulations, EN 54 (fire detection), EN 12845 (sprinklers), ` +
      `HD 60364 / the national wiring rules, EN 1838 (emergency lighting), EN 50173 (cabling), the local fire service and building authority.`;
  }
  return `${country || "the project country"}: the authority having jurisdiction for fire, electrical, water and telecom approvals in ` +
    `${country || "the project country"}. Where its local code is not known, use the international baseline (NFPA 72 / EN 54 fire alarm, ` +
    `NFPA 13 / EN 12845 sprinklers, IEC 60364 wiring, TIA-568 / EN 50173 cabling, ASHRAE 90.1 energy) and say in the notes that local approval must be confirmed.`;
}

/** The line every take-off, design and revision prompt ends its project context with. */
export function localNormsLine(country: unknown, city: unknown): string {
  return `Apply the codes and approval authorities of the project's own country and city: ${localNorms(country, city)} ` +
    `Do not apply another country's authorities. Where a question, basis note or default below names a UAE authority or code ` +
    `(e.g. DEWA, Dubai Civil Defence, SIRA, Al Sa'fat, Estidama) and the project is not in that emirate, use the equivalent ` +
    `requirement of the project's own country instead.`;
}

// ----------------------------------------------------------------------------
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
