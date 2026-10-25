/**
 * Résultats officiels des élections générales de la Colombie-Britannique
 * (Elections BC, données ouvertes publiées sur DataBC ; Elections BC Open
 * Data Licence, mention obligatoire dans ATTRIBUTIONS.md).
 *
 *  - 2017 et 2020 : résultats par section de vote (carte de 2015,
 *    87 circonscriptions) ;
 *  - 2024 : résultats par lieu de vote (carte de 2023, 93 circonscriptions) ;
 *  - 2020 transposé sur la carte de 2023 : les votes du jour du scrutin de
 *    chaque section sont répartis entre les circonscriptions de 2023 selon
 *    les poids de sources/poids_bc.py (électeurs inscrits de 2024 dans le
 *    recoupement) ; les autres votes de la circonscription (anticipation,
 *    poste, vote spécial), connus seulement par circonscription, suivent
 *    pour chaque parti la répartition de ses votes du jour du scrutin.
 *
 * Votes valides seulement. Partis : NDP, CON, GRN, BCU (BC Liberal Party,
 * devenu BC United en 2023), ONEBC, CENTRE (CentreBC), AUTRES. Les lignes
 * bc-provincial de ces élections dans csv/resultats.csv sont remplacées ; celles
 * des autres élections (résultats du soir de 2026, sources/elections_bc_soir.ts)
 * sont gardées.
 *
 * Candidatures : csv/candidats_bc.csv, une ligne par candidature
 * (circonscription, nom « Prénom Nom », parti, votes valides, élu) pour les
 * élections de 2017, 2020 et 2024, et liste officielle de 2026
 * (circonscription, nom sur le bulletin et parti seulement ; les coordonnées
 * des agents, renseignements personnels, ne sont pas reprises).
 *
 * District régional de chaque circonscription des cartes de 2015 et de 2023
 * (sources/poids_bc.py) : csv/circonscriptions_bc.csv.
 *
 * Run:
 *   deno run --allow-read --allow-write --allow-net=catalogue.data.gov.bc.ca,openmaps.gov.bc.ca sources/elections_bc.ts --telecharger
 *   python sources/poids_bc.py
 *   deno run --allow-read --allow-write sources/elections_bc.ts
 */

import { ecrireCsv, lireCsv, RACINE, USER_AGENT, type Ligne } from "../lib/commun.ts";

const RAW = new URL("raw/elections_bc/", RACINE);
const CATALOGUE = "https://catalogue.data.gov.bc.ca/dataset";
const WFS = "https://openmaps.gov.bc.ca/geo/pub/wfs?service=WFS&version=2.0.0&request=GetFeature&outputFormat=application/json&srsName=EPSG:3005&typeName=pub:WHSE_ADMIN_BOUNDARIES";
const FICHIERS: Record<string, string> = {
  "results_va.csv": `${CATALOGUE}/44914a35-de9a-4830-ac48-870001ef8935/resource/fb40239e-b718-4a79-b18f-7a62139d9792/download/provincial_voting_results_by_va.csv`,
  "results_vp.csv": `${CATALOGUE}/44914a35-de9a-4830-ac48-870001ef8935/resource/4e7be8e3-0805-4f39-87f3-47c4c29e262d/download/provincial_voting_results_by_voting_place.csv`,
  "registered.csv": `${CATALOGUE}/60bf8c02-1436-49fc-b350-f985618d6881/resource/c332d1dc-67aa-4a6a-883f-18a50751844d/download/provincial_registered_voter_counts.csv`,
  "edva_2017_2024.xlsx": `${CATALOGUE}/fb26db04-780c-4229-a147-da4fd5311d36/resource/7dec2191-33e8-46b6-83cc-ad773b57742d/download/edva_conversiontable2017to2024.xlsx`,
  "va2017.zip": `${CATALOGUE}/f309df17-0462-40c0-bb11-b76c1cb83024/resource/712d1b73-24b8-4fb3-b491-50227e1cd720/download/edvas02232017.zip`,
  "va2024.geojson": `${WFS}.EBC_VOTING_AREAS_BS11_POLY_SVW`,
  "ced2023.geojson": `${WFS}.EBC_ELECTORAL_DISTS_BS11_SVW`,
  "candidats_2026.csv": "https://elections.bc.ca/2026election/2026-provincial-general-election-candidates.csv",
  "rd.geojson": `https://openmaps.gov.bc.ca/geo/pub/wfs?service=WFS&version=2.0.0&request=GetFeature&outputFormat=application/json&srsName=EPSG:3005&typeName=pub:WHSE_LEGAL_ADMIN_BOUNDARIES.ABMS_REGIONAL_DISTRICTS_SP`,
};
const ELECTIONS = [
  { evenement: "2017 General Election", fichier: "results_va.csv", election: "2017-05-09", carte: "2015" },
  { evenement: "2020 General Election", fichier: "results_va.csv", election: "2020-10-24", carte: "2015" },
  { evenement: "2024 Provincial General Election", fichier: "results_vp.csv", election: "2024-10-19", carte: "2023" },
];
export const PARTIS: Record<string, string> = {
  "BC NDP": "NDP", "BC Liberal Party": "BCU", "BC United": "BCU", "BC Green Party": "GRN",
  "Conservative": "CON", "Conservative Party": "CON", OneBC: "ONEBC", CentreBC: "CENTRE",
};
const PROVENANCE = "Elections BC, données ouvertes";
const PROVENANCE_TRANSPOSEE = "Elections BC, données ouvertes ; transposition Votovision sur la carte de 2023";

/** CSV d'Elections BC : en-tête précédé d'un BOM, octets hors UTF-8 (lus en windows-1252). */
function lireEbc(nom: string): Ligne[] {
  const fichier = new URL(nom, RAW);
  const temp = new URL(`${nom}.utf8`, RAW);
  Deno.writeTextFileSync(temp, new TextDecoder("windows-1252").decode(Deno.readFileSync(fichier)).replace(/^(﻿|ï»¿)/, ""));
  const lignes = lireCsv(temp);
  Deno.removeSync(temp);
  return lignes;
}

const somme = <K>(m: Map<K, number>, k: K, v: number) => m.set(k, (m.get(k) ?? 0) + v);

async function telecharger() {
  Deno.mkdirSync(RAW, { recursive: true });
  for (const [nom, url] of Object.entries(FICHIERS)) {
    const r = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    if (!r.ok) throw new Error(`${url} : HTTP ${r.status}`);
    Deno.writeFileSync(new URL(nom, RAW), new Uint8Array(await r.arrayBuffer()));
    console.log(nom);
  }
  console.log("Décompresser va2017.zip dans raw/elections_bc/va2017/, puis : python sources/poids_bc.py");
}

if (import.meta.main) {
  if (Deno.args.includes("--telecharger")) {
    await telecharger();
    Deno.exit(0);
  }
  const lignes: Record<string, unknown>[] = [];
  const parti = (affiliation: string) => PARTIS[affiliation] ?? "AUTRES";
  const sources = new Map<string, Ligne[]>();
  const noms23 = new Map<string, string>();

  const candidatures: Record<string, unknown>[] = [];
  const prenomNom = (n: string) => n.includes(",") ? `${n.split(",").slice(1).join(",").trim()} ${n.split(",")[0].trim()}` : n.trim();
  for (const e of ELECTIONS) {
    if (!sources.has(e.fichier)) sources.set(e.fichier, lireEbc(e.fichier));
    const rangs = sources.get(e.fichier)!.filter((r) => r.EVENT_NAME === e.evenement && r.VOTE_CATEGORY === "Valid");
    const parCandidat = new Map<string, { circonscription: string; nom: string; parti: string; votes: number; elu: boolean }>();
    for (const r of rangs) {
      if (!r.CANDIDATE) continue;
      const cle = `${r.ED_ABBREVIATION}|${r.CANDIDATE}`;
      if (!parCandidat.has(cle)) parCandidat.set(cle, { circonscription: r.ED_ABBREVIATION, nom: prenomNom(r.CANDIDATE), parti: parti(r.AFFILIATION), votes: 0, elu: false });
      const c = parCandidat.get(cle)!;
      c.votes += Number(r.VOTES_CONSIDERED) || 0;
      if (r.ELECTED === "Y") c.elu = true;
    }
    for (const c of parCandidat.values()) candidatures.push({ election: e.election, carte: e.carte, ...c, elu: c.elu ? 1 : 0 });
    const votes = new Map<string, number>(), noms = new Map<string, string>();
    for (const r of rangs) {
      somme(votes, `${r.ED_ABBREVIATION}|${parti(r.AFFILIATION)}`, Number(r.VOTES_CONSIDERED) || 0);
      noms.set(r.ED_ABBREVIATION, r.ED_NAME);
    }
    if (e.carte === "2023") for (const [k, v] of noms) noms23.set(k, v);
    for (const [k, v] of votes) {
      const [ced, p] = k.split("|");
      lignes.push({ juridiction: "bc-provincial", election: e.election, carte: e.carte, circonscription: ced, nom: noms.get(ced), parti: p, votes: v, provenance: PROVENANCE });
    }
    console.log(`${e.election} (carte ${e.carte}) : ${noms.size} circonscriptions`);
  }

  // Transposition de 2020 sur la carte de 2023.
  const poids = new Map<string, [string, number][]>();
  for (const r of lireCsv(new URL("poids_va2017_ced2023.csv", RAW))) {
    if (!poids.has(r.EDVA_CODE)) poids.set(r.EDVA_CODE, []);
    poids.get(r.EDVA_CODE)!.push([r.ED_2023, Number(r.poids)]);
  }
  const inscrits = new Map<string, number>();
  for (const r of lireEbc("registered.csv")) if (r.EVENT_NAME === "2020 General Election") inscrits.set(r.EDVA_CODE, Number(r.REGISTERED_VOTERS) || 0);
  const r2020 = sources.get("results_va.csv")!.filter((r) => r.EVENT_NAME === "2020 General Election" && r.VOTE_CATEGORY === "Valid");

  // Sections regroupées : les votes sont inscrits sous la section qui les déclare, dont le poids
  // est la moyenne des poids des sections regroupées, pondérée par leurs électeurs de 2020.
  const membres = new Map<string, Set<string>>();
  for (const r of r2020) {
    if (!r.EDVA_CODE || r.VOTING_OPPORTUNITY !== "General voting") continue;
    const chef = r.RESULTS_REPORTED_UNDER || r.EDVA_CODE;
    if (!membres.has(chef)) membres.set(chef, new Set());
    membres.get(chef)!.add(r.EDVA_CODE);
  }
  const poidsDeclarant = (chef: string): Map<string, number> | null => {
    const m = new Map<string, number>();
    let total = 0;
    for (const va of membres.get(chef) ?? [chef]) {
      const w = poids.get(va);
      if (!w) continue;
      const e = inscrits.get(va) || 1;
      for (const [ced, p] of w) somme(m, ced, p * e);
      total += e;
    }
    if (!total) return null;
    for (const [k, v] of m) m.set(k, v / total);
    return m;
  };

  // Votes du jour du scrutin répartis par section ; ancienne circonscription → nouvelle, par parti.
  const jour = new Map<string, Map<string, number>>(); // "ancienne|parti" → nouvelle → votes
  const autres = new Map<string, number>();            // "ancienne|parti" → votes hors section
  const sansPoids: Ligne[] = [];
  for (const r of r2020) {
    const v = Number(r.VOTES_CONSIDERED) || 0;
    const cle = `${r.ED_ABBREVIATION}|${parti(r.AFFILIATION)}`;
    if (!r.EDVA_CODE || r.VOTING_OPPORTUNITY !== "General voting") { somme(autres, cle, v); continue; }
    if (!v) continue;
    const w = poidsDeclarant(r.RESULTS_REPORTED_UNDER || r.EDVA_CODE);
    if (!w) { sansPoids.push(r); somme(autres, cle, v); continue; }
    if (!jour.has(cle)) jour.set(cle, new Map());
    for (const [ced, p] of w) somme(jour.get(cle)!, ced, v * p);
  }
  // Répartition de référence d'une ancienne circonscription : tous partis confondus.
  const ensemble = new Map<string, Map<string, number>>();
  for (const [cle, m] of jour) {
    const ancienne = cle.split("|")[0];
    if (!ensemble.has(ancienne)) ensemble.set(ancienne, new Map());
    for (const [ced, v] of m) somme(ensemble.get(ancienne)!, ced, v);
  }
  const transposes = new Map<string, number>();
  for (const [cle, m] of jour) for (const [ced, v] of m) somme(transposes, `${ced}|${cle.split("|")[1]}`, v);
  for (const [cle, v] of autres) {
    const [ancienne, p] = cle.split("|");
    const repartition = jour.get(cle) ?? ensemble.get(ancienne)!;
    const total = [...repartition.values()].reduce((a, b) => a + b, 0);
    for (const [ced, x] of repartition) somme(transposes, `${ced}|${p}`, v * x / total);
  }
  for (const [k, v] of transposes) {
    const [ced, p] = k.split("|");
    lignes.push({ juridiction: "bc-provincial", election: "2020-10-24", carte: "2023", circonscription: ced, nom: noms23.get(ced), parti: p, votes: Math.round(v), provenance: PROVENANCE_TRANSPOSEE });
  }
  const totalAvant = r2020.reduce((a, r) => a + (Number(r.VOTES_CONSIDERED) || 0), 0);
  const totalApres = [...transposes.values()].reduce((a, b) => a + b, 0);
  console.log(`2020 transposé : ${new Set([...transposes.keys()].map((k) => k.split("|")[0])).size} circonscriptions ; ` +
    `${sansPoids.length} lignes de section sans poids (réparties comme les votes hors section) ; total ${totalAvant} → ${Math.round(totalApres)}`);

  const districts = lireCsv(new URL("districts_regionaux.csv", RAW)).map((l) => ({ carte: l.carte, circonscription: l.ED, district_regional: l.district_regional }));
  ecrireCsv(new URL("csv/circonscriptions_bc.csv", RACINE), ["carte", "circonscription", "district_regional"], districts);

  // Candidatures de 2026.
  for (const c of lireCsv(new URL("candidats_2026.csv", RAW))) {
    candidatures.push({ election: "2026-10-24", carte: "2023", circonscription: c["ED Code"], nom: c["Candidate Ballot Name"], parti: parti(c.Affiliation), votes: "", elu: "" });
  }
  candidatures.sort((a, b) => String(a.election).localeCompare(String(b.election)) || String(a.circonscription).localeCompare(String(b.circonscription))
    || String(a.parti).localeCompare(String(b.parti)) || String(a.nom).localeCompare(String(b.nom)));
  ecrireCsv(new URL("csv/candidats_bc.csv", RACINE), ["election", "carte", "circonscription", "nom", "parti", "votes", "elu"], candidatures);
  console.log(`${candidatures.length} candidatures (2017, 2020, 2024, 2026)`);

  const F = new URL("csv/resultats.csv", RACINE);
  const ecrites = new Set(ELECTIONS.map((e) => e.election));
  const reste = lireCsv(F).filter((l) => l.juridiction !== "bc-provincial" || !ecrites.has(String(l.election)));
  const tout = [...reste, ...lignes].sort((a, b) => String(a.juridiction).localeCompare(String(b.juridiction)) || String(a.election).localeCompare(String(b.election))
    || String(a.carte).localeCompare(String(b.carte)) || String(a.circonscription).localeCompare(String(b.circonscription)) || String(a.parti).localeCompare(String(b.parti)));
  ecrireCsv(F, ["juridiction", "election", "carte", "circonscription", "nom", "parti", "votes", "provenance"], tout);
  console.log(`${lignes.length} lignes bc-provincial`);
}
