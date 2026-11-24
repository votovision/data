/**
 * Sondages fédéraux nationaux des pages « Opinion polling for the ...
 * Canadian federal election » de Wikipédia en anglais (sections nationales :
 * « Campaign period », « Pre-campaign period », « Table of polls »).
 * Cellules fusionnées développées ; lignes d'événements et résultats
 * d'élection écartés ; parti non mesuré (cellule vide ou tiret) : ligne
 * absente, pas zéro.
 */

import { parseHTML } from "linkedom";
import { effectif } from "../lib/effectif.ts";
import { grille, idSondage, texte, type PageWiki, type Part, type Sondage } from "../lib/commun.ts";

export const PAGES_FEDERALES: Record<string, string> = {
  "2019": "Opinion polling for the 2019 Canadian federal election",
  "2021": "Opinion polling for the 2021 Canadian federal election",
  "2025": "Opinion polling for the 2025 Canadian federal election",
  "46": "Opinion polling for the 46th Canadian federal election",
};
const JURIDICTION = "ca-federal";
const SECTIONS = /^(Campaign period|Pre-campaign period|Table of polls)$/;
const PARTIS: Record<string, string> = { LPC: "LPC", CPC: "CPC", NDP: "NDP", BQ: "BQ", GPC: "GPC", PPC: "PPC", Others: "AUTRES", Other: "AUTRES" };
const MOIS: Record<string, number> = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
const AGREGATEURS = /qc125|338canada/i;

const date = (t: string): string | null => {
  const m = t.match(/([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})/);
  return m && MOIS[m[1].toLowerCase()] ? `${m[3]}-${String(MOIS[m[1].toLowerCase()]).padStart(2, "0")}-${m[2].padStart(2, "0")}` : null;
};

export function lirePageFederale(p: PageWiki): { sondages: Sondage[]; parts: Part[] } {
  const { document } = parseHTML(`<html><body>${p.html}</body></html>`);
  const sondages: Sondage[] = [], parts: Part[] = [], vus = new Set<string>();
  let section = "";
  for (const el of document.querySelectorAll("h2, h3, h4, table")) {
    if (/^H/i.test(el.tagName)) { section = texte(el); continue; }
    if (!SECTIONS.test(section)) continue;
    const g = grille(el);
    const cols = (g[0] ?? []).map((c) => texte(c));
    const iFirme = cols.findIndex((c) => /firm/i.test(c)), iDate = cols.findIndex((c) => /last date/i.test(c));
    const iN = cols.findIndex((c) => /sample/i.test(c)), iLien = cols.findIndex((c) => /^link/i.test(c));
    if (iFirme < 0 || iDate < 0) continue;
    const partis = cols.map((c, j) => [PARTIS[c], j] as const).filter(([c]) => c);
    for (const l of g.slice(1)) {
      if (l.length < cols.length || l.some((x) => !x) || /^TH$/i.test(l[iFirme].tagName) || new Set(l).size < cols.length - 2) continue;
      const firme = texte(l[iFirme]), d = date(texte(l[iDate]));
      if (!firme || !d || /election|result/i.test(firme)) continue;
      const v = partis.map(([c, j]) => [c, texte(l[j]).replace(/[^\d.]/g, "")] as const).filter(([, x]) => x !== "").map(([c, x]) => [c, Number(x)] as const);
      const total = v.reduce((s, [, x]) => s + x, 0);
      if (v.length < 4 || total < 80 || total > 110) continue;
      const n = iN >= 0 ? effectif(texte(l[iN])) : null;
      // Même clé que la série historique : firme|date|effectif.
      const id = idSondage(JURIDICTION, "National", firme, d, n !== null ? String(n) : "null");
      if (vus.has(id)) continue;
      vus.add(id);
      // Lien du sondeur : direct, ou via l'appel de note (#cite_note-...) vers
      // la liste des références de la page.
      let ref = "";
      const externe = (scope: Element | null): string => {
        for (const a of scope?.querySelectorAll("a") ?? []) {
          const href = a.getAttribute("href") ?? "";
          if (href.startsWith("http") && !/wiki(pedia|media)\.org/.test(href)) return AGREGATEURS.test(href) ? "" : href;
        }
        return "";
      };
      if (iLien >= 0) {
        ref = externe(l[iLien]);
        const note = l[iLien].querySelector('a[href^="#cite_note"]')?.getAttribute("href");
        if (!ref && note) ref = externe(document.getElementById(decodeURIComponent(note.slice(1))));
      }
      sondages.push({ id, juridiction: JURIDICTION, region: "National", firme, date_debut: "", date_fin: d, n: n !== null ? String(n) : "", n_decides: "", provenance: `wikipedia:en:${p.titre}`, reference: ref });
      for (const [parti, pct] of v) parts.push({ id, parti, pct: String(pct) });
    }
  }
  return { sondages, parts };
}
