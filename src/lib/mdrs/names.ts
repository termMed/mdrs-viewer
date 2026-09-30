import type { Tier } from "./types";

// Preferred terms for module concepts seen in the sample packages.
// Looked up on each edition's Snowstorm branch (Sept 2026); users can still
// load packages with modules not listed here — the id is shown instead.
export const KNOWN_MODULES: Record<string, string> = {
  "900000000000012004": "SNOMED CT model component",
  "900000000000207008": "SNOMED CT core",
  "449080006": "SNOMED CT to ICD-10 rule-based mapping module",
  "449079008": "SNOMED CT to ICD-9CM equivalency mapping module",
  "1204363008": "SNOMED CT to ICD-11 rule-based mapping module",
  "449081005": "SNOMED CT Spanish edition module",
  "450829007": "Latin American Spanish extension module",
  "11000241103": "SNOMED CT Common French translation module",
  "1303956008": "Nutrition Care Process Terminology module",
  "1157359004": "International Classification for Nursing Practice module",
  "890195008": "IHTSDO Global Patient Set module",
  "827022005": "International Patient Summary module",
  "816211006": "MedDRA simple map module",
  "784009001": "SNOMED CT to Orphanet simple map module",
  "733984003": "IHTSDO Nursing Activities module",
  "733983009": "IHTSDO Nursing Health Issues module",
  "721230008": "IHTSDO odontogram module",
  "718292005": "IHTSDO general dentistry diagnostic module",
  "715152001": "IHTSDO general and family practitioner module",
  "715151008": "ICNP–SNOMED CT equivalency mapping module",
  // National
  "11000172109": "Belgian module",
  "11000234105": "Austrian module",
  "11000220105": "Irish module",
  "1601000220105": "Irish drugs module",
  "51000202101": "Norwegian module",
  "57091000202101": "Norwegian module for medicines",
  "57101000202106": "Norwegian module for code systems",
  "20621000087109": "Canada Health Infoway English module",
  "20611000087101": "Canada Health Infoway French module",
  "22091000087100": "Canada Health Infoway Reference Set module",
  "11000221109": "Argentinian extension module",
  "900000001000122104": "Spanish national extension components module",
  "90000011000140108": "Deprecated Spanish national module (ns 1000140)",
  "32506021000036107": "SNOMED CT Australian extension",
  "351000168100": "Australian third party reference set module",
  "900062011000036108": "Australian Medicines Terminology module",
  "999000041000000102": "UK Edition module",
  "999000031000000106": "UK Edition reference set module",
  "999000011000000103": "UK clinical extension module",
  "999000021000000109": "UK clinical extension reference set module",
  "999000011000001104": "UK drug extension module",
  "999000021000001108": "UK drug extension reference set module",
  "83821000000107": "UK composition module",
  "11000146104": "Netherlands NRC maintained module",
  "15561000146104": "Netherlands module 15561000146104",
  "21000210109": "New Zealand integrated care module",
  "11000210104": "New Zealand module 11000210104",
  "731000124108": "US NLM maintained module",
  "5991000124107": "US module 5991000124107",
  "1119411007": "DICOM module",
  "1119414004": "IHE module",
  "1119418001": "ERA-EDTA module",
  "1237620007": "EDQM module",
  // Synthetic demo modules (namespace 1000999) used by public/samples
  "21000999105": "Demo shared language edition module",
  "31000999103": "Demo country A module",
  "41000999107": "Demo country B module",
  "51000999100": "Demo country B drugs module",
  "61000999104": "Demo country C module",
  "71000999109": "Demo country C reference set module",
};

const INT_RELEASE_MODULES = new Set([
  "900000000000012004",
  "900000000000207008",
  "449080006",
  "449079008",
  "1204363008",
]);

const EDITION_MODULES = new Set(["450829007", "449081005", "11000241103", "21000999105"]);

/** SCTID namespace: partition id is digits [-3,-2]; '0x' = short (INT), '1x' = long with 7-digit namespace */
export function namespaceOf(sctid: string): string {
  if (sctid.length < 4) return "?";
  const partition = sctid.slice(-3, -1);
  if (partition[0] === "1") return sctid.slice(-10, -3);
  return "INT";
}

export function tierOf(id: string): Tier {
  if (INT_RELEASE_MODULES.has(id)) return "int-core";
  if (EDITION_MODULES.has(id)) return "edition";
  if (namespaceOf(id) === "INT") return "int-derivative";
  return "national";
}

export function moduleName(id: string, extra?: Record<string, string>): string {
  return extra?.[id] ?? KNOWN_MODULES[id] ?? id;
}

export function shortName(id: string, extra?: Record<string, string>): string {
  const n = moduleName(id, extra);
  if (n === id) return id;
  return n
    .replace(/^SNOMED CT /, "")
    .replace(/^International Health Terminology Standards Development Organisation/, "IHTSDO")
    .replace(/ module$/i, "");
}

export const TIER_LABEL: Record<Tier, string> = {
  "int-core": "International release",
  "int-derivative": "International derivative",
  edition: "Shared edition / common translation",
  national: "National extension",
};

export function fmtDate(et: string): string {
  if (!et || et.length !== 8) return et || "—";
  return `${et.slice(0, 4)}-${et.slice(4, 6)}-${et.slice(6, 8)}`;
}
