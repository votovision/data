/**
 * Téléchargeur des résultats officiels et des limites d'Elections Alberta,
 * pour usage local seulement : les fichiers vont dans raw/elections_alberta/
 * (non versionné) et ne sont pas republiés. Les conditions d'utilisation
 * d'Elections Alberta (https://www.elections.ab.ca/terms-conditions/)
 * autorisent la reproduction non modifiée avec mention de la source et
 * exigent une permission écrite pour toute autre utilisation ; le dépôt
 * contient ce téléchargeur, pas leurs données.
 *
 * Avec --formater, les résultats de 2023 (relevé du scrutin, une feuille par
 * circonscription, ligne « Total (All Voting Options) ») sont écrits dans
 * raw/elections_alberta/resultats_2023.csv, au format de csv/resultats.csv
 * (juridiction ab-provincial, carte de 2019, 87 circonscriptions) : votes
 * valides par parti, partis UCP, NDP, ABP (Alberta Party), LIB, GRN, WIP et
 * AUTRES. Les noms des circonscriptions viennent du fichier des sections de
 * vote de 2026, qui suit la même carte. Ce fichier reste local.
 *
 * Run: deno run --allow-read --allow-write --allow-net=www.elections.ab.ca sources/elections_alberta.ts [--formater]
 */

import { unzipSync } from "fflate";
import * as XLSX from "xlsx";
import { ecrireCsv, RACINE, USER_AGENT } from "../lib/commun.ts";

const RAW = new URL("raw/elections_alberta/", RACINE);
export const FICHIERS = [
  // Résultats officiels des élections générales (2023 : relevé du scrutin).
  "https://www.elections.ab.ca/uploads/2023-Provincial-General-Election-Statement-of-Vote.xlsx",
  "https://www.elections.ab.ca/uploads/2019PGEOfficialResultsAllEDs.xlsx",
  "https://www.elections.ab.ca/uploads/Volume-2-2019-Provincial-General-Election-Report.pdf",
  "https://www.elections.ab.ca/uploads/2015PGE-Official-Results.xlsx",
  "https://www.elections.ab.ca/uploads/2012PGEOfficialResults.xlsx",
  // Limites : circonscriptions de 2019 (utilisées en 2023), sections de vote.
  "https://www.elections.ab.ca/uploads/2019Boundaries_ED-Shapefiles.zip",
  "https://www.elections.ab.ca/uploads/EA_Voting_Area_Boundaries_2026.zip",
];

const PARTIS: Record<string, string> = { UCP: "UCP", NDP: "NDP", AP: "ABP", LIB: "LIB", GPA: "GRN", WIP: "WIP" };

/** Numéro -> nom des circonscriptions, d'après la table attributaire (DBF) des sections de vote. */
function nomsCirconscriptions(zip: Uint8Array): Map<string, string> {
  const [, dbf] = Object.entries(unzipSync(zip)).find(([n]) => /\.dbf$/i.test(n))!;
  const v = new DataView(dbf.buffer, dbf.byteOffset, dbf.byteLength);
  const n = v.getUint32(4, true), entete = v.getUint16(8, true), taille = v.getUint16(10, true);
  const champs: { nom: string; long: number }[] = [];
  for (let o = 32; dbf[o] !== 0x0d; o += 32) {
    champs.push({ nom: new TextDecoder().decode(dbf.slice(o, o + 11)).replace(/\0.*$/, ""), long: dbf[o + 16] });
  }
  const noms = new Map<string, string>(), dec = new TextDecoder("latin1");
  for (let i = 0; i < n; i++) {
    let o = entete + i * taille + 1;
    const r: Record<string, string> = {};
    for (const c of champs) { r[c.nom] = dec.decode(dbf.slice(o, o + c.long)).trim(); o += c.long; }
    noms.set(String(Number(r.ED_NUM)), r.ED_NAME);
  }
  return noms;
}

function formater2023() {
  const noms = nomsCirconscriptions(Deno.readFileSync(new URL("EA_Voting_Area_Boundaries_2026.zip", RAW)));
  const classeur = XLSX.read(Deno.readFileSync(new URL("2023-Provincial-General-Election-Statement-of-Vote.xlsx", RAW)), { type: "array" });
  const lignes: Record<string, unknown>[] = [];
  for (const feuille of classeur.SheetNames) {
    const g: unknown[][] = XLSX.utils.sheet_to_json(classeur.Sheets[feuille], { header: 1, raw: true, defval: "" });
    const entete = g[0].map((c) => String(c));
    const total = g.find((l) => String(l[1]).startsWith("Total (All Voting Options)"));
    const fin = entete.indexOf("Names on List");
    const code = String(Number(feuille)), nom = noms.get(code);
    if (!total || fin < 0 || !nom) throw new Error(`feuille ${feuille} : total, en-tête ou nom introuvable`);
    const votes: Record<string, number> = {};
    for (let j = 4; j < fin; j++) {
      const sigle = entete[j].split(/\r?\n/).at(-1)!.trim(), parti = PARTIS[sigle] ?? "AUTRES";
      votes[parti] = (votes[parti] ?? 0) + Number(total[j]);
    }
    const somme = Object.values(votes).reduce((a, b) => a + b, 0);
    if (somme !== Number(total[fin + 1])) throw new Error(`${nom} : ${somme} votes, ${total[fin + 1]} bulletins valides`);
    for (const [parti, v] of Object.entries(votes)) {
      lignes.push({ juridiction: "ab-provincial", election: "2023-05-29", carte: "2019", circonscription: code, nom, parti, votes: v, provenance: "Elections Alberta, relevé du scrutin de 2023" });
    }
  }
  ecrireCsv(new URL("resultats_2023.csv", RAW), ["juridiction", "election", "carte", "circonscription", "nom", "parti", "votes", "provenance"], lignes);
  console.log(`raw/elections_alberta/resultats_2023.csv : ${lignes.length} lignes, ${classeur.SheetNames.length} circonscriptions`);
}

if (import.meta.main && Deno.args.includes("--formater")) {
  formater2023();
} else if (import.meta.main) {
  Deno.mkdirSync(RAW, { recursive: true });
  for (const url of FICHIERS) {
    const r = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    if (!r.ok) { console.log(`${url} : HTTP ${r.status}`); continue; }
    const nom = url.split("/").at(-1)!;
    Deno.writeFileSync(new URL(nom, RAW), new Uint8Array(await r.arrayBuffer()));
    console.log(`raw/elections_alberta/${nom}`);
  }
}
