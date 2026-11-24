/**
 * Intentions de vote des rapports PDF de Léger (Québec, Colombie-Britannique,
 * fédéral), écrites dans sources/rapports/<qc|bc|ca>/ au format des
 * transcriptions manuelles ; la vigile les intègre ensuite aux tables.
 *
 * Pour chaque sondage national de Léger lu sur Wikipédia (csv/sondages.csv)
 * depuis 45 jours, dont la référence est un PDF et qui n'a pas de transcription
 * (même juridiction, date de fin à 3 jours près) : le PDF est téléchargé et la
 * page « intentions de vote » est lue par MuPDF. Chaque valeur est rattachée à
 * la colonne dont l'en-tête (Total, région) est le plus proche. Un fichier n'est
 * écrit que s'il passe les contrôles :
 *  - la colonne nationale somme de 97 à 103 ;
 *  - chaque parti du national à moins de 2 points de la ligne de Wikipédia.
 * Sinon, le sondage est signalé et laissé à la transcription manuelle.
 *
 * Options : --essai (n'écrit rien), --tout (relit aussi les sondages déjà
 * transcrits et compare avec la transcription existante).
 *
 * Run: deno task leger
 */

import * as mupdf from "mupdf";
import { lireCsv, RACINE } from "../lib/commun.ts";

const AGENT = "votovision-data";
const JOURS = 45, TOLERANCE_JOURS = 3, ECART_MAX = 2;
/** Écart horizontal maximal (points de page) entre un en-tête de colonne et ses valeurs ; les colonnes sont espacées de 33 points ou plus. */
const TOLERANCE_X = 20;

interface Config {
  dossier: string;
  /** Rangée d'en-tête : régions reconnues par leur texte exact, dans la colonne de leur x. */
  regions: [RegExp, string][];
  partis: [RegExp, string][];
  /** Rang de la colonne nationale parmi les colonnes numériques (0 = la première). */
  colonneNationale: number;
}

const CONFIGS: Record<string, Config> = {
  "qc-provincial": {
    dossier: "qc",
    regions: [[/^MTL$/, "RMR-MTL"], [/^QC$/, "RMR-QC"], [/^Reste$/, "RESTE-QC"]],
    partis: [[/Parti Québécois/i, "PQ"], [/Parti libéral/i, "LIB"], [/Parti conservateur/i, "PCQ"], [/Québec solidaire/i, "QS"],
      [/Coalition Avenir/i, "CAQ"], [/autre parti/i, "AUTRES"]],
    colonneNationale: 1,
  },
  "bc-provincial": {
    dossier: "bc",
    regions: [[/^Metro Van$/, "METRO-VANCOUVER"], [/^Van Island$/, "VANCOUVER-ISLAND"], [/^Rest of BC$/, "INTERIOR-NORTH"]],
    partis: [[/^Conservative/i, "CON"], [/New Democratic|NDP/i, "NDP"], [/Green/i, "GRN"], [/OneBC/i, "ONEBC"], [/CentreBC/i, "CENTRE"],
      [/BC United/i, "BCU"], [/another party|other/i, "AUTRES"]],
    colonneNationale: 0,
  },
  "ca-federal": {
    dossier: "ca",
    regions: [[/^ATL$/, "ATL"], [/^QC$/, "QC"], [/^ON$/, "ON"], [/^MB\/SK$/, "MBSK"], [/^AB$/, "AB"], [/^BC$/, "BC"]],
    partis: [[/Liberal/i, "LPC"], [/Conservative/i, "CPC"], [/Bloc/i, "BQ"], [/New Democratic|NDP/i, "NDP"], [/Green/i, "GPC"],
      [/People.s Party/i, "PPC"], [/another party|other/i, "AUTRES"]],
    colonneNationale: 1,
  },
};

type Cellule = { x: number; y: number; s: string };

function cellules(page: mupdf.Page): Cellule[] {
  const st = JSON.parse(page.toStructuredText("preserve-whitespace").asJSON());
  const out: Cellule[] = [];
  for (const b of st.blocks) for (const l of b.lines ?? []) if (l.text.trim()) out.push({ x: l.bbox.x, y: l.bbox.y, s: l.text.trim() });
  return out;
}

function rangees(cs: Cellule[]): Cellule[][] {
  const par = new Map<number, Cellule[]>();
  for (const c of cs) {
    const k = [...par.keys()].find((v) => Math.abs(v - c.y) <= 3) ?? c.y;
    par.set(k, [...(par.get(k) ?? []), c]);
  }
  return [...par].sort((a, b) => a[0] - b[0]).map(([, r]) => r.sort((a, b) => a.x - b.x));
}

const POURCENT = /^(<\s?1|\d{1,3}(?:[.,]\d)?)\s?%/;
/** « 44% », « 6%↓ » : valeur ; « <1% » : 0,5 (borne d'arrondi) ; « - » : absent. */
function valeur(s: string): number | null {
  const m = s.match(POURCENT);
  if (!m) return null;
  return m[1].startsWith("<") ? 0.5 : Number(m[1].replace(",", "."));
}
const entier = (s: string): number | null => (/^[\d\s\u00a0,]+$/.test(s.trim()) && s.trim() ? Number(s.replace(/\D/g, "")) : null);

interface Lecture { groupes: Record<string, { n: number | null; parts: Record<string, number> }>; page: number; titre: string }

function lire(pdf: Uint8Array, cfg: Config): Lecture | string {
  const doc = mupdf.Document.openDocument(pdf, "application/pdf");
  for (let i = 0; i < doc.countPages(); i++) {
    const cs = cellules(doc.loadPage(i));
    const titre = [...cs].sort((a, b) => a.y - b.y)[0]?.s ?? "";
    const rows = rangees(cs);
    // Colonnes des régions : cellules d'en-tête au texte exact.
    const colonnes: [string, number][] = [];
    for (const [re, code] of cfg.regions) {
      const c = cs.find((x) => re.test(x.s));
      if (c) colonnes.push([code, c.x]);
    }
    if (colonnes.length < cfg.regions.length) continue;
    const proche = (row: Cellule[], x: number) => row.filter((c) => Math.abs(c.x - x) <= TOLERANCE_X).sort((a, b) => Math.abs(a.x - x) - Math.abs(b.x - x))[0];
    const groupes: Lecture["groupes"] = { National: { n: null, parts: {} } };
    for (const [code] of colonnes) groupes[code] = { n: null, parts: {} };

    // Effectifs non pondérés : « Unweighted n= », « n absolu= » ; sinon « Unweighted: n=937 » de la base.
    const ligneN = rows.find((r) => /unweighted n|n absolu/i.test(r[0]?.s ?? ""));
    let xNational: number | null = null;
    for (const r of rows) {
      const premier = r[0]?.s ?? "";
      const partis = cfg.partis.find(([re]) => re.test(premier));
      if (!partis) continue;
      const nums = r.filter((c) => c.x > 240 && (valeur(c.s) !== null || /^-$/.test(c.s)));
      const national = nums[cfg.colonneNationale];
      if (!national) continue;
      xNational ??= national.x;
      const v = valeur(national.s);
      if (v !== null) groupes.National.parts[partis[1]] = v;
      for (const [code, x] of colonnes) {
        const c = proche(r, x);
        const val = c ? valeur(c.s) : null;
        if (val !== null) groupes[code].parts[partis[1]] = val;
      }
    }
    if (Object.keys(groupes.National.parts).length < 3) continue;
    if (ligneN && xNational !== null) {
      const nat = ligneN.map((c) => ({ x: c.x, n: entier(c.s.replace(/^[^\d]*/, "")) })).filter((c) => c.n !== null);
      const n0 = nat.find((c) => Math.abs(c.x - xNational!) <= TOLERANCE_X);
      if (n0) groupes.National.n = n0.n;
      for (const [code, x] of colonnes) { const c = nat.find((q) => Math.abs(q.x - x) <= TOLERANCE_X); if (c) groupes[code].n = c.n; }
    } else {
      const base = cs.map((c) => c.s).join(" ").match(/Unweighted\s*:\s*n\s*=\s*([\d,]+)/i);
      if (base) groupes.National.n = Number(base[1].replace(/\D/g, ""));
    }
    return { groupes, page: i + 1, titre };
  }
  return "page des intentions de vote introuvable";
}

const jours = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 864e5;

async function main() {
  const essai = Deno.args.includes("--essai"), tout = Deno.args.includes("--tout");
  const sondages = lireCsv(new URL("csv/sondages.csv", RACINE)) as unknown as Record<string, string>[];
  const parts = lireCsv(new URL("csv/parts.csv", RACINE)) as unknown as Record<string, string>[];
  const partsParId = new Map<string, Map<string, number>>();
  for (const p of parts) { if (!partsParId.has(p.id)) partsParId.set(p.id, new Map()); partsParId.get(p.id)!.set(p.parti, Number(p.pct)); }
  const limite = new Date(Date.now() - JOURS * 864e5).toISOString().slice(0, 10);

  for (const [jur, cfg] of Object.entries(CONFIGS)) {
    const dossier = new URL(`sources/rapports/${cfg.dossier}/`, RACINE);
    const existants = [...Deno.readDirSync(dossier)].filter((f) => /^leger_.*\.json$/.test(f.name)).map((f) => ({
      nom: f.name, json: JSON.parse(Deno.readTextFileSync(new URL(f.name, dossier))),
    }));
    const candidats = sondages.filter((s) => s.juridiction === jur && s.region === "National" && s.firme === "Léger" && s.date_fin >= (tout ? "2026-01-01" : limite) &&
      /^https?:\/\/.*\.pdf/i.test(s.reference));
    console.log(`${jur} : ${candidats.length} sondage(s) de Léger avec un PDF`);
    for (const s of candidats) {
      const deja = existants.find((e) => jours(e.json.date_fin, s.date_fin) <= TOLERANCE_JOURS);
      if (deja && !tout) continue;
      const nom = `${s.date_fin} ${jur}`;
      let pdf: Uint8Array;
      try {
        const r = await fetch(s.reference, { headers: { "User-Agent": AGENT } });
        if (!r.ok) { console.log(`  ! ${nom} : téléchargement ${r.status}`); continue; }
        pdf = new Uint8Array(await r.arrayBuffer());
      } catch (e) { console.log(`  ! ${nom} : ${(e as Error).message}`); continue; }
      const lecture = lire(pdf, cfg);
      if (typeof lecture === "string") { console.log(`  ! ${nom} : ${lecture}`); continue; }
      const nat = lecture.groupes.National.parts, somme = Object.values(nat).reduce((a, b) => a + b, 0);
      const wiki = partsParId.get(s.id);
      const ecarts = wiki ? Object.entries(nat).filter(([p, v]) => wiki.has(p) && Math.abs(wiki.get(p)! - v) > ECART_MAX).map(([p, v]) => `${p} ${v} (PDF) / ${wiki.get(p)} (Wikipédia)`) : [];
      if (somme < 97 || somme > 103 || ecarts.length) {
        console.log(`  ! ${nom} : contrôles échoués (somme ${somme.toFixed(1)}${ecarts.length ? " ; " + ecarts.join(", ") : ""}), laissé à la transcription manuelle`);
        continue;
      }
      if (deja) {
        // Comparaison avec la transcription existante.
        const diffs: string[] = [];
        for (const [g, v] of Object.entries(lecture.groupes)) {
          const e = deja.json.groupes[g];
          if (!e) { diffs.push(`${g} absent de la transcription`); continue; }
          for (const [p, x] of Object.entries(v.parts)) if (e.parts[p] !== undefined && Math.abs(e.parts[p] - x) > 0.5) diffs.push(`${g} ${p} ${x} (PDF) / ${e.parts[p]} (transcrit)`);
          if (v.n !== null && e.n !== null && v.n !== e.n) diffs.push(`${g} n ${v.n} (PDF) / ${e.n} (transcrit)`);
        }
        console.log(`  ${nom} : ${deja.nom} ${diffs.length ? "DIFFÈRE : " + diffs.join(" ; ") : "identique"}`);
        continue;
      }
      const fichier = `leger_${s.date_fin}_regional.json`;
      const rapport = {
        juridiction: jur, firme: "Léger", date_debut: "", date_fin: s.date_fin,
        document: `${decodeURIComponent(s.reference.split("/").pop() ?? "")} (Léger, p. ${lecture.page}, « ${lecture.titre} »)`,
        reference: s.reference,
        note: "Lu automatiquement par sources/leger.ts. Base : électeurs décidés. n = effectifs non pondérés lorsque le tableau les donne. « <1 % » saisi à 0,5.",
        groupes: Object.fromEntries(Object.entries(lecture.groupes).filter(([, v]) => Object.keys(v.parts).length)),
      };
      console.log(`  + ${nom} : ${Object.keys(rapport.groupes).length} groupe(s), page ${lecture.page}${essai ? " (essai)" : ""}`);
      if (!essai) Deno.writeTextFileSync(new URL(fichier, dossier), JSON.stringify(rapport, null, 2) + "\n");
    }
  }
}

await main();
