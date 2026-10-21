/**
 * Ventilations régionales des sondages fédéraux de Liaison Strategies, lues
 * dans leurs tableaux détaillés (« National Tables », PDF à couche texte) et
 * écrites dans sources/rapports/ca/, au format des transcriptions manuelles ;
 * la vigile les intègre ensuite aux tables.
 *
 * Pour chaque sondage fédéral national de Liaison (csv/sondages.csv) sans
 * transcription : le PDF est cherché à press.liaisonstrategies.ca sous les
 * noms connus, publié de 1 à 5 jours après la fin du terrain ; la page « If a
 * federal election were held today… Decided and Leaning only » est lue par
 * MuPDF (WebAssembly, sans dépendance système), chaque valeur rattachée à la colonne dont l'en-tête est le plus
 * proche. Un tableau n'est écrit que s'il passe tous les contrôles :
 *  - fin de terrain imprimée (« Field Dates ») = date du sondage ;
 *  - chaque colonne somme de 97 à 103 ;
 *  - moyenne des six régions, pondérée par leurs effectifs pondérés, à moins
 *    de 2 points du total pour LPC, CPC et NDP ;
 *  - total à moins de 1,5 point du sondage national de la table (Wikipédia).
 * Sinon, le sondage est signalé et laissé à la transcription manuelle.
 *
 * Run: deno task liaison
 */

import * as mupdf from "mupdf";
import { lireCsv, RACINE, USER_AGENT } from "../lib/commun.ts";

const BASE = "https://press.liaisonstrategies.ca/content/files";
const NOMS = ["National-Tables.pdf", "National-Tables-1.pdf", "National-Tracker-Tables.pdf", "National-Tracker-Tables-1.pdf"];
const COLONNES: Record<string, string> = { Total: "National", Atlantic: "ATL", Quebec: "QC", Ontario: "ON", Prairies: "MBSK", Alberta: "AB", BC: "BC" };
const PARTIS: Record<string, string> = { Liberal: "LPC", Conservative: "CPC", NDP: "NDP", BQ: "BQ", Green: "GPC", PPC: "PPC", Other: "AUTRES" };
const MOIS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DOSSIER = new URL("sources/rapports/ca/", RACINE);

type Cellule = { x: number; s: string };
type Groupe = { n: number; pondere: number; parts: Record<string, number> };

const iso = (d: Date) => d.toISOString().slice(0, 10);
const plusJours = (d: string, k: number) => iso(new Date(Date.parse(d) + k * 864e5));
const dateTexte = (t: string) => {
  const m = t.match(/([A-Z][a-z]+) (\d{1,2}),? (\d{4})/);
  return m && MOIS.includes(m[1]) ? `${m[3]}-${String(MOIS.indexOf(m[1]) + 1).padStart(2, "0")}-${m[2].padStart(2, "0")}` : null;
};

/** Le PDF des tableaux d'un sondage terminé le `fin` : [url, octets] ou null. */
async function chercherPdf(fin: string): Promise<[string, Uint8Array] | null> {
  for (let k = 1; k <= 5; k++) {
    const pub = plusJours(fin, k), [a, m] = pub.split("-");
    for (const nom of NOMS) {
      const url = `${BASE}/${a}/${m}/${pub.replaceAll("-", ".")}-${nom}`;
      let r: Response;
      try { r = await fetch(url, { headers: { "User-Agent": USER_AGENT } }); } catch { continue; }
      if (r.ok && (r.headers.get("content-type") ?? "").includes("pdf")) return [url, new Uint8Array(await r.arrayBuffer())];
      await r.body?.cancel();
    }
  }
  return null;
}

/** Lignes de texte d'une page, de haut en bas, cellules triées de gauche à droite. */
function lignes(page: mupdf.Page): Cellule[][] {
  const st = JSON.parse(page.toStructuredText("preserve-whitespace").asJSON());
  const parY = new Map<number, Cellule[]>();
  for (const b of st.blocks) {
    for (const l of b.lines ?? []) {
      if (!l.text.trim()) continue;
      const y = l.bbox.y, cle = [...parY.keys()].find((v) => Math.abs(v - y) <= 3) ?? y;
      if (!parY.has(cle)) parY.set(cle, []);
      parY.get(cle)!.push({ x: l.bbox.x, s: l.text.trim() });
    }
  }
  return [...parY].sort((a, b) => a[0] - b[0]).map(([, l]) => l.sort((a, b) => a.x - b.x));
}

/** Le tableau des intentions de vote (décidés et enclins) : fin de terrain et groupes, ou une erreur. */
function lireTableau(octets: Uint8Array): { fin: string; groupes: Record<string, Groupe> } | string {
  const doc = mupdf.Document.openDocument(octets, "application/pdf");
  for (let p = 0; p < doc.countPages(); p++) {
    const L = lignes(doc.loadPage(p)), texte = L.map((l) => l.map((c) => c.s).join(" ")).join("\n");
    if (!/which party would you vote for/i.test(texte) || !/Decided and Leaning/i.test(texte)) continue;
    const champ = texte.match(/Field Dates:[^\n]*?to ([A-Z][a-z]+ \d{1,2},? \d{4})/);
    const fin = champ ? dateTexte(champ[1]) : null;
    if (!fin) return "fin de terrain illisible";
    const entete = L.find((l) => l.some((c) => c.s === "Total") && l.some((c) => c.s === "Atlantic"));
    if (!entete) return "en-tête des colonnes introuvable";
    const cols = entete.filter((c) => COLONNES[c.s]).map((c) => ({ code: COLONNES[c.s], x: c.x }));
    if (cols.length !== 7) return `${cols.length} colonnes sur 7`;
    const ligne = (re: RegExp) => L.find((l) => re.test(l[0]?.s ?? ""));
    const valeurs = (l: Cellule[] | undefined) => {
      const out: Record<string, number> = {};
      for (const c of (l ?? []).slice(1)) {
        const v = Number(c.s.replace(/[%,]/g, ""));
        if (!Number.isFinite(v)) continue;
        const col = cols.reduce((b, k) => (Math.abs(k.x - c.x) < Math.abs(b.x - c.x) ? k : b));
        if (Math.abs(col.x - c.x) < 40) out[col.code] = v;
      }
      return out;
    };
    const n = valeurs(ligne(/^Unweighted Sample Size/)), w = valeurs(ligne(/^Weighted Sample Size/));
    const groupes: Record<string, Groupe> = Object.fromEntries(cols.map((c) => [c.code, { n: n[c.code], pondere: w[c.code], parts: {} }]));
    for (const [libelle, parti] of Object.entries(PARTIS)) {
      const v = valeurs(ligne(new RegExp(`^${libelle}$`)));
      for (const c of cols) {
        if (v[c.code] === undefined) return `${libelle} : valeur manquante en ${c.code}`;
        if (parti === "BQ" && c.code !== "QC" && c.code !== "National") continue;
        groupes[c.code].parts[parti] = v[c.code];
      }
    }
    return { fin, groupes };
  }
  return doc.countPages() && !lignes(doc.loadPage(0)).length ? "PDF sans couche texte (glyphes vectorisés)" : "page des intentions de vote introuvable";
}

/** Contrôles ; renvoie la liste des problèmes. */
function controler(g: Record<string, Groupe>, wiki: Record<string, number>): string[] {
  const pb: string[] = [];
  for (const [code, x] of Object.entries(g)) {
    const s = Object.values(x.parts).reduce((a, b) => a + b, 0);
    if (s < 97 || s > 103) pb.push(`${code} somme ${s}`);
    if (!x.n) pb.push(`${code} sans effectif`);
  }
  const reg = ["ATL", "QC", "ON", "MBSK", "AB", "BC"], W = reg.reduce((a, k) => a + (g[k].pondere || 0), 0);
  for (const p of ["LPC", "CPC", "NDP"]) {
    const m = reg.reduce((a, k) => a + (g[k].pondere || 0) * (g[k].parts[p] ?? 0), 0) / W;
    if (Math.abs(m - g.National.parts[p]) > 2) pb.push(`${p} : moyenne régionale ${m.toFixed(1)} ≠ total ${g.National.parts[p]}`);
    if (wiki[p] !== undefined && Math.abs(wiki[p] - g.National.parts[p]) > 1.5) pb.push(`${p} : total ${g.National.parts[p]} ≠ Wikipédia ${wiki[p]}`);
  }
  return pb;
}

if (import.meta.main) {
  const parts = new Map<string, Record<string, number>>();
  for (const p of lireCsv(new URL("csv/parts.csv", RACINE))) {
    if (!parts.has(p.id)) parts.set(p.id, {});
    parts.get(p.id)![p.parti] = Number(p.pct);
  }
  const faits = new Set<string>();
  for (const f of Deno.readDirSync(DOSSIER)) {
    if (f.name.startsWith("liaison_")) faits.add(JSON.parse(Deno.readTextFileSync(new URL(f.name, DOSSIER))).date_fin);
  }
  const depuis = Deno.args[0] ?? plusJours(iso(new Date()), -60);
  const aFaire = lireCsv(new URL("csv/sondages.csv", RACINE)).filter((s) =>
    s.juridiction === "ca-federal" && s.region === "National" && s.firme === "Liaison Strategies" && s.date_fin >= depuis && !faits.has(s.date_fin));
  if (!aFaire.length) console.log("Liaison : aucune ventilation à lire");
  for (const s of aFaire) {
    const pdf = await chercherPdf(s.date_fin);
    if (!pdf) { console.log(`Liaison ${s.date_fin} : tableaux introuvables (à transcrire à la main)`); continue; }
    const t = lireTableau(pdf[1]);
    if (typeof t === "string") { console.log(`Liaison ${s.date_fin} : ${t} (${pdf[0]})`); continue; }
    if (t.fin !== s.date_fin) { console.log(`Liaison ${s.date_fin} : fin de terrain imprimée ${t.fin} (${pdf[0]})`); continue; }
    const pb = controler(t.groupes, parts.get(s.id) ?? {});
    if (pb.length) { console.log(`Liaison ${s.date_fin} : contrôles échoués, à vérifier : ${pb.join(" ; ")} (${pdf[0]})`); continue; }
    const g = t.groupes, pond = Object.entries(g).map(([k, v]) => `${k} ${v.pondere}`).join(", ");
    const r = {
      juridiction: "ca-federal", firme: "Liaison Strategies", date_debut: s.date_debut || "", date_fin: s.date_fin,
      document: `Federal Tracker, National Survey – Detailed Tables (Liaison Strategies, ${pdf[0].match(/(\d{4})\.(\d{2})\.(\d{2})/)!.slice(1).join("-")})`,
      reference: pdf[0],
      note: "Lecture automatique (sources/liaison_tableaux.ts) du tableau « If a federal election were held today, which party would you vote for? Decided and Leaning only ». Base : électeurs décidés et enclins. n = « Unweighted Sample Size » (pondérés : " + pond + "). La colonne « Prairies », distincte de « Alberta », correspond au Manitoba et à la Saskatchewan (MBSK). BQ hors Québec omis. Contrôles passés : sommes, moyenne régionale pondérée contre le total, total contre Wikipédia.",
      groupes: Object.fromEntries(Object.entries(g).map(([k, v]) => [k, { n: v.n, libelle: Object.keys(COLONNES).find((c) => COLONNES[c] === k), parts: v.parts }])),
    };
    const f = new URL(`liaison_${s.date_fin}_regional.json`, DOSSIER);
    Deno.writeTextFileSync(f, JSON.stringify(r, null, 2) + "\n");
    console.log(`Liaison ${s.date_fin} : ventilation écrite (${pdf[0]})`);
  }
}
