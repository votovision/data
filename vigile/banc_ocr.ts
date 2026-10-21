/**
 * Banc d'essai de la lecture par OCR (lib/pdf.ts : MuPDF + tesseract) suivie
 * de la relecture par le LLM (vigile/contreverif.ts), sur des ventilations
 * déjà vérifiées à la main : chaque valeur lue est comparée au fichier de
 * référence de sources/rapports/ca/. L'OCR est forcé même quand le PDF a une
 * couche texte, pour mesurer l'OCR seul.
 *
 * Cas : deux PDF Liaison sans couche texte (tableaux détaillés du 27 juin
 * 2026 ; rapport graphique du 16 février 2026, national p. 9 et régions
 * p. 10), et trois pages à couche texte lues comme images (Liaison 17
 * octobre 2026, Pollara 19 avril 2025, Research Co. 30 août 2021).
 *
 * Le texte OCR et la réponse du modèle de chaque cas sont écrits dans
 * raw/banc_ocr/ pour inspection.
 *
 * Run: deno task banc-ocr
 */

import * as mupdf from "mupdf";
import { enTexte, rangeesOcr } from "../lib/pdf.ts";
import { RACINE, USER_AGENT } from "../lib/commun.ts";
import { MODELE, relire } from "./contreverif.ts";

const CAS = [
  { ref: "liaison_2026-06-27", pages: [2], n: true },
  { ref: "liaison_2026-02-14", pages: [9, 10], n: false },
  { ref: "liaison_2026-10-17", pages: [2], n: true },
  { ref: "pollara_2025-04-19", pages: [1], n: true },
  { ref: "researchco_2021-08-30", pages: [3], n: false },
];
const SORTIE = new URL("raw/banc_ocr/", RACINE);
Deno.mkdirSync(SORTIE, { recursive: true });

let total = 0, faux = 0;
console.log(`Modèle : ${MODELE}`);
for (const c of CAS) {
  const f = JSON.parse(Deno.readTextFileSync(new URL(`sources/rapports/ca/${c.ref}_regional.json`, RACINE)));
  const r = await fetch(f.reference, { headers: { "User-Agent": USER_AGENT } });
  if (!r.ok) { console.log(`${c.ref.padEnd(24)} PDF introuvable (${r.status})`); continue; }
  const doc = mupdf.Document.openDocument(new Uint8Array(await r.arrayBuffer()), "application/pdf");
  const t0 = Date.now();
  const textes = [];
  for (const p of c.pages) textes.push(enTexte(await rangeesOcr(doc.loadPage(p - 1))));
  const texte = textes.join("\n=== page suivante ===\n");
  Deno.writeTextFileSync(new URL(`${c.ref}.ocr.txt`, SORTIE), texte);
  const lu = await relire(texte);
  Deno.writeTextFileSync(new URL(`${c.ref}.llm.txt`, SORTIE), lu?.brut ?? "(pas de réponse)");
  const ecarts: string[] = [];
  let n = 0;
  for (const [g, v] of Object.entries(f.groupes) as [string, { n: number | null; parts: Record<string, number> }][]) {
    for (const [p, x] of Object.entries(v.parts)) { n++; if (lu?.groupes?.[g]?.parts?.[p] !== x) ecarts.push(`${g}.${p} ${x}→${lu?.groupes?.[g]?.parts?.[p]}`); }
    if (c.n && v.n !== null) { n++; if (lu?.groupes?.[g]?.n !== v.n) ecarts.push(`${g}.n ${v.n}→${lu?.groupes?.[g]?.n}`); }
  }
  total += n; faux += ecarts.length;
  console.log(`${c.ref.padEnd(24)} ${n - ecarts.length}/${n} identiques (${((Date.now() - t0) / 1000).toFixed(0)} s)${ecarts.length ? " — écarts : " + ecarts.join(", ") : ""}`);
}
console.log(`\nTotal : ${total - faux}/${total} valeurs identiques (${total ? (100 * (total - faux) / total).toFixed(1) : 0} %)`);
console.log(`Textes OCR et réponses du modèle : ${SORTIE.pathname}`);
