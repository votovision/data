/**
 * Résultats par section de vote d'Élections Québec (données ouvertes, licence
 * d'utilisation du Directeur général des élections ; mention obligatoire dans
 * ATTRIBUTIONS.md) : archive resultats-bureau-vote.zip d'une élection
 * générale (un CSV ISO-8859-1 par circonscription), copiée dans
 * raw/elections_quebec/, puis les lignes de cette élection dans
 * csv/resultats_sections_qc.csv sont remplacées.
 *
 * Une ligne par section de vote (S.V.) : électeurs inscrits et votes du jour
 * du scrutin par parti (PQ, LIB, CAQ, QS, PCQ, AUTRES). Le vote par
 * anticipation, le vote au bureau du directeur du scrutin, en établissement
 * d'enseignement et hors circonscription ne sont pas ventilés par section et
 * ne figurent pas ici : en 2022, ils représentaient environ 40 % des votes.
 * Les bureaux de moins de 10 votes (ou dont tous les votes vont à une même
 * personne) sont regroupés par Élections Québec avec un autre bureau : la
 * colonne regroupement donne ce bureau (BVO-n, section n de la même
 * circonscription) ou BVDS-n (bureau du directeur du scrutin) ; la section
 * conserve ses électeurs et porte 0 vote. Les sections numérotées 500 et plus
 * sont des sections d'établissement (hébergement, détention), non
 * territoriales.
 *
 * En 2026, les en-têtes sont écrits en toutes lettres (« Section de vote »,
 * « Électeurs inscrits », « Bulletins valides », « Bulletins rejetés ») et
 * trois colonnes descriptives s'ajoutent (date, étendue, municipalités) ; les
 * fichiers intègrent le dépouillement judiciaire de Vachon.
 *
 * Les sigles des partis changent d'une élection à l'autre et se ressemblent
 * (P.C.Q./C.P.Q. : conservateurs en 2018, Parti culinaire en 2022) : la table
 * SIGLES est déclarée par élection et toute élection absente est refusée.
 *
 * Run: deno task sections-qc --election AAAA-MM-JJ --carte AAAA [--url <zip>]
 */

import { unzipSync } from "fflate";
import * as XLSX from "xlsx";
import { ecrireCsv, lireCsv, RACINE, USER_AGENT } from "../lib/commun.ts";

const ARCHIVES = "https://donnees.electionsquebec.qc.ca/production/provincial/resultats/archives";
const PROVENANCE = "Élections Québec, données ouvertes, résultats par bureau de vote";
const PARTIS = ["PQ", "LIB", "CAQ", "QS", "PCQ", "AUTRES"];
export const COLONNES = ["juridiction", "election", "carte", "circonscription", "nom", "sv", "electeurs", ...PARTIS, "valides", "rejetes", "regroupement", "provenance"];

/** Sigle (dernier mot de l'en-tête de colonne) -> parti codé, par élection. Les autres sigles vont dans AUTRES. */
const SIGLES: Record<string, Record<string, string>> = {
  "2018-10-01": { "P.Q.": "PQ", "P.L.Q./Q.L.P.": "LIB", "C.A.Q.-É.F.L.": "CAQ", "Q.S.": "QS", "P.C.Q./C.P.Q.": "PCQ" },
  "2022-10-03": { "P.Q.": "PQ", "P.L.Q./Q.L.P.": "LIB", "C.A.Q.-E.F.L.": "CAQ", "Q.S.": "QS", "P.C.Q-E.E.D.": "PCQ" },
  "2026-10-05": { "PQ": "PQ", "PLQ/QLP": "LIB", "CAQ": "CAQ", "ÉCF-CAQ": "CAQ", "QS": "QS", "PCOQ": "PCQ" },
};

/** Première feuille d'un classeur Excel (quatre circonscriptions de 2018 ne sont fournies qu'ainsi), au format des CSV : champs séparés par « ; ». */
function texteXlsx(octets: Uint8Array): string {
  const classeur = XLSX.read(octets, { type: "array" });
  const lignes: unknown[][] = XLSX.utils.sheet_to_json(classeur.Sheets[classeur.SheetNames[0]], { header: 1, raw: true, defval: "" });
  return lignes.map((l) => l.map((v) => String(v ?? "").replace(/;/g, ",")).join(";")).join("\n");
}

/** Lignes de csv/resultats_sections_qc.csv d'un fichier de circonscription (texte décodé). */
export function lireCirconscription(texte: string, election: string, carte: string, sigles: Record<string, string>, inconnus: Map<string, number>) {
  const lignes = texte.split(/\r?\n/).filter((l) => l.trim()).map((l) => l.split(";"));
  const entete = lignes[0];
  // Abréviations jusqu'en 2022, en toutes lettres en 2026.
  const col = (...noms: string[]) => {
    const i = entete.findIndex((h) => noms.includes(h.trim()));
    if (i < 0) throw new Error(`colonne ${noms.join(" ou ")} absente : ${entete.join(";")}`);
    return i;
  };
  // Le code de circonscription est la première colonne ; son en-tête est « Code », sauf dans un fichier de 2022 (« S »).
  const iCode = 0, iNom = col("Circonscription"), iRegr = col("Regroupement"), iSv = col("S.V.", "Section de vote"),
    iEi = col("É.I.", "Électeurs inscrits"), iBv = col("B.V.", "Bulletins valides"), iBr = col("B.R.", "Bulletins rejetés");
  // Colonnes de candidatures : entre É.I. et B.V. ; le sigle est le dernier mot de l'en-tête.
  const candidats = entete.slice(iEi + 1, iBv).map((h, k) => {
    const sigle = h.trim().split(/\s+/).at(-1)!;
    return { i: iEi + 1 + k, sigle, parti: sigles[sigle] ?? "AUTRES" };
  });
  const sortie: Record<string, unknown>[] = [];
  for (const l of lignes.slice(1)) {
    const sv = (l[iSv] ?? "").trim();
    if (!sv) continue;
    const votes = Object.fromEntries(PARTIS.map((p) => [p, 0]));
    for (const c of candidats) {
      const v = Number(l[c.i] || 0);
      votes[c.parti] += v;
      if (c.parti === "AUTRES") inconnus.set(c.sigle, (inconnus.get(c.sigle) ?? 0) + v);
    }
    sortie.push({
      juridiction: "qc-provincial", election, carte, circonscription: l[iCode].trim(), nom: l[iNom].trim(), sv,
      electeurs: Number(l[iEi] || 0), ...votes, valides: Number(l[iBv] || 0), rejetes: Number(l[iBr] || 0),
      regroupement: (l[iRegr] ?? "").replace(/^Regr\.\s*/, "").trim(), provenance: PROVENANCE,
    });
  }
  return sortie;
}

if (import.meta.main) {
  const arg = (n: string) => { const i = Deno.args.indexOf(n); return i >= 0 ? Deno.args[i + 1] : undefined; };
  const election = arg("--election"), carte = arg("--carte");
  if (!election || !carte) throw new Error("--election et --carte requis");
  const sigles = SIGLES[election];
  if (!sigles) throw new Error(`sigles des partis inconnus pour ${election} : compléter SIGLES`);
  const url = arg("--url") ?? `${ARCHIVES}/gen${election}/resultats-bureau-vote.zip`;

  const RAW = new URL("raw/elections_quebec/", RACINE);
  Deno.mkdirSync(RAW, { recursive: true });
  const zip = new URL(`resultats-bureau-vote_${election}.zip`, RAW);
  let octets: Uint8Array;
  try { octets = Deno.readFileSync(zip); } catch {
    const r = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    if (!r.ok) throw new Error(`${url} : HTTP ${r.status}`);
    octets = new Uint8Array(await r.arrayBuffer());
    Deno.writeFileSync(zip, octets);
  }

  const decodeur = new TextDecoder("iso-8859-1");
  const inconnus = new Map<string, number>();
  const lignes: Record<string, unknown>[] = [];
  let fichiers = 0;
  for (const [nom, contenu] of Object.entries(unzipSync(octets))) {
    let texte: string;
    if (/\.csv$/i.test(nom)) texte = decodeur.decode(contenu);
    else if (/\.xlsx$/i.test(nom)) texte = texteXlsx(contenu);
    else continue;
    fichiers++;
    lignes.push(...lireCirconscription(texte, election, carte, sigles, inconnus));
  }
  const num = (sv: string) => Number(sv.match(/^\d+/)?.[0] ?? 0);
  lignes.sort((a, b) => Number(a.circonscription) - Number(b.circonscription) || num(String(a.sv)) - num(String(b.sv)) || String(a.sv).localeCompare(String(b.sv)));

  const F = new URL("csv/resultats_sections_qc.csv", RACINE);
  const autres = lireCsv(F).filter((l) => !(l.juridiction === "qc-provincial" && l.election === election));
  const tout = [...autres, ...lignes].sort((a, b) => String(a.election).localeCompare(String(b.election)) || Number(a.circonscription) - Number(b.circonscription)
    || num(String(a.sv)) - num(String(b.sv)) || String(a.sv).localeCompare(String(b.sv)));
  ecrireCsv(F, COLONNES, tout);

  const circs = new Set(lignes.map((l) => l.circonscription)).size;
  const regroupees = lignes.filter((l) => l.regroupement).length;
  console.log(`${election} : ${fichiers} fichiers, ${circs} circonscriptions, ${lignes.length} sections (${regroupees} regroupées)`);
  const autresTries = [...inconnus].sort((a, b) => b[1] - a[1]);
  console.log(`sigles comptés dans AUTRES (votes) : ${autresTries.map(([s, v]) => `${s} ${v}`).join(", ")}`);
}
