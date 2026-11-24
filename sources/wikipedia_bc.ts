/**
 * Sondages provinciaux de la Colombie-Britannique, sections « Opinion
 * polling » / « Opinion polls » / « Voter intention polling » des pages
 * « <année> British Columbia general election » de Wikipédia en anglais.
 * Ligne d'en-tête repérée par « Polling firm » ; lignes d'événements et
 * résultats d'élection écartés ; parti non mesuré (cellule vide, tiret, N/A) :
 * ligne absente, pas zéro. Le tableau hypothétique avec le Parti libéral
 * (2026) est hors des sections lues.
 */

import { parseHTML } from "linkedom";
import { effectif } from "../lib/effectif.ts";
import { grille, idSondage, texte, type PageWiki, type Part, type Sondage } from "../lib/commun.ts";

export const PAGES_BC: Record<string, string> = {
  "2020": "2020 British Columbia general election",
  "2024": "2024 British Columbia general election",
  "2026": "2026 British Columbia general election",
};
const JURIDICTION = "bc-provincial";
const SECTIONS = /^(Opinion polling|Opinion polls|Voter intention polling)$/;
const PARTIS: Record<string, string> = {
  NDP: "NDP", "Con.": "CON", Con: "CON", Green: "GRN", "Grn.": "GRN", OneBC: "ONEBC", Centre: "CENTRE",
  BCU: "BCU", "Lib.": "BCU", Others: "AUTRES", "Oth.": "AUTRES",
};
const FIRMES: Record<string, string> = {
  Leger: "Léger", Mainstreet: "Mainstreet Research", "Insight West": "Insights West",
  "Innovative Research Group": "Innovative Research", "EKOS Research Associates": "EKOS",
};
const MOIS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const AGREGATEURS = /qc125|338canada/i;

/** Dates de terrain : « Oct 10–11, 2026 », « Sep 28 – Oct 2, 2026 », « Oct 5, 2026 ». */
function dates(t: string): [string, string] | null {
  const s = t.replace(/[–—-]/g, "-");
  const an = s.match(/(\d{4})\s*$/)?.[1];
  if (!an) return null;
  const jalons = [...s.matchAll(/([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})|(?:^|-)\s*(\d{1,2})(?=\s*,)/g)];
  const iso = (m: number, j: string) => `${an}-${String(m).padStart(2, "0")}-${j.padStart(2, "0")}`;
  let mois = 0;
  const out: string[] = [];
  for (const m of jalons) {
    if (m[1]) mois = MOIS[m[1].toLowerCase()] ?? 0;
    if (!mois) return null;
    out.push(iso(mois, m[2] ?? m[3]));
  }
  if (!out.length) return null;
  return [out[0], out[out.length - 1]];
}

export function lirePageBc(p: PageWiki): { sondages: Sondage[]; parts: Part[] } {
  const { document } = parseHTML(`<html><body>${p.html}</body></html>`);
  const sondages: Sondage[] = [], parts: Part[] = [], vus = new Set<string>();
  const externe = (scope: Element | null): string => {
    for (const a of scope?.querySelectorAll("a") ?? []) {
      const href = a.getAttribute("href") ?? "";
      if (href.startsWith("http") && !/wiki(pedia|media)\.org/.test(href)) return AGREGATEURS.test(href) ? "" : href;
    }
    return "";
  };
  let section = "";
  for (const el of document.querySelectorAll("h2, h3, h4, table")) {
    if (/^H/i.test(el.tagName)) { section = texte(el); continue; }
    if (!SECTIONS.test(section)) continue;
    const g = grille(el);
    const iEntete = g.findIndex((l) => l.some((c) => /^Polling firm$/i.test(texte(c))));
    if (iEntete < 0) continue;
    const cols = g[iEntete].map((c) => texte(c));
    const iFirme = cols.findIndex((c) => /^Polling firm$/i.test(c)), iDate = cols.findIndex((c) => /^Dates? (conducted|of polling)$/i.test(c));
    const iN = cols.findIndex((c) => /sample/i.test(c)), iLien = cols.findIndex((c) => /^Source$/i.test(c));
    if (iDate < 0) continue;
    const partis = cols.map((c, j) => [PARTIS[c], j] as const).filter(([c]) => c);
    for (const l of g.slice(iEntete + 1)) {
      if (l.length < cols.length || l.some((x) => !x) || /^TH$/i.test(l[iFirme].tagName) || new Set(l).size < cols.length - 3) continue;
      const brut = texte(l[iFirme]).split("/")[0].trim(), firme = FIRMES[brut] ?? brut, d = dates(texte(l[iDate]));
      if (!firme || !d || /election|result/i.test(firme)) continue;
      const v = partis.map(([c, j]) => [c, texte(l[j]).replace(/[^\d.]/g, "")] as const).filter(([, x]) => x !== "").map(([c, x]) => [c, Number(x)] as const);
      const total = v.reduce((s, [, x]) => s + x, 0);
      if (v.length < 3 || total < 80 || total > 110) continue;
      const n = iN >= 0 ? effectif(texte(l[iN])) : null;
      const id = idSondage(JURIDICTION, "National", firme, d[1], n !== null ? String(n) : "null");
      if (vus.has(id)) continue;
      vus.add(id);
      let ref = "";
      if (iLien >= 0) {
        ref = externe(l[iLien]);
        const note = l[iLien].querySelector('a[href^="#cite_note"]')?.getAttribute("href");
        if (!ref && note) ref = externe(document.getElementById(decodeURIComponent(note.slice(1))));
      }
      sondages.push({ id, juridiction: JURIDICTION, region: "National", firme, date_debut: d[0], date_fin: d[1], n: n !== null ? String(n) : "", n_decides: "", provenance: `wikipedia:en:${p.titre}`, reference: ref });
      for (const [parti, pct] of v) parts.push({ id, parti, pct: String(pct) });
    }
  }
  return { sondages, parts };
}
