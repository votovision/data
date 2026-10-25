/**
 * Résultats du soir de l'élection générale de la Colombie-Britannique du
 * 24 octobre 2026 (Elections BC, Event Night Reporting,
 * https://results.elections.bc.ca) : page des résultats par candidat,
 * agrégés par circonscription et par parti (NDP, CON, GRN, BCU, ONEBC,
 * CENTRE, AUTRES, comme sources/elections_bc.ts), carte de 2023. Les lignes
 * bc-provincial de cette élection dans csv/resultats.csv sont remplacées ;
 * la provenance donne l'heure de la page et la part des urnes dépouillées.
 *
 * Résultats préliminaires : les votes par la poste, par téléphone et des
 * électeurs absents ne sont comptés qu'au décompte final (6 novembre 2026).
 * La page HTML est copiée dans raw/elections_bc/.
 *
 * Run: deno run --allow-read --allow-write --allow-net=results.elections.bc.ca sources/elections_bc_soir.ts
 */

import { ecrireCsv, lireCsv, RACINE, USER_AGENT } from "../lib/commun.ts";
import { PARTIS } from "./elections_bc.ts";

const ELECTION = "2026-10-24", CARTE = "2023";
const PAGE = "https://results.elections.bc.ca/Results_11684_GE-2026-10-24_Candidate.html";

if (import.meta.main) {
  const r = await fetch(PAGE, { headers: { "User-Agent": USER_AGENT } });
  if (!r.ok) throw new Error(`${PAGE} : HTTP ${r.status}`);
  const html = await r.text();
  const RAW = new URL("raw/elections_bc/", RACINE);
  Deno.mkdirSync(RAW, { recursive: true });
  Deno.writeTextFileSync(new URL(`resultats_soir_${ELECTION}.html`, RAW), html);

  const heure = html.match(/As of ([^<]+?)\s*</)?.[1].trim();
  const urnes = html.match(/main-line">([\d.]+)%<\/div>\s*<\/div>\s*<div class="small-line">Of ballot boxes/)?.[1];
  if (!heure) throw new Error("heure de mise à jour introuvable : format de page changé ?");

  // Codes des circonscriptions de la carte de 2023, d'après les résultats de 2024.
  const F = new URL("csv/resultats.csv", RACINE);
  const lignes = lireCsv(F);
  const codes = new Map(lignes.filter((l) => l.juridiction === "bc-provincial" && l.carte === CARTE).map((l) => [String(l.nom), String(l.circonscription)]));

  // Une rangée par candidature (cellule data-canname), puis trois rangées de
  // totaux par circonscription ; les votes valides servent de contrôle.
  const votes = new Map<string, Map<string, number>>(), valides = new Map<string, number>();
  for (const m of html.matchAll(/<tr data-ed="([^"]+)"[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cellules = [...m[2].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1].replace(/<[^>]+>/g, "").trim());
    const [, candidature, affiliation, total] = cellules;
    const nom = m[1].replace(/&amp;/g, "&").replace(/&#39;/g, "'");
    if (!codes.has(nom)) throw new Error(`circonscription inconnue de la carte de ${CARTE} : ${nom}`);
    if (!m[2].includes("data-canname")) {
      if (candidature === "Total Valid Votes") valides.set(nom, Number(total.replace(/,/g, "")));
      continue;
    }
    const parti = PARTIS[affiliation] ?? "AUTRES";
    const v = votes.get(nom) ?? new Map<string, number>();
    v.set(parti, (v.get(parti) ?? 0) + Number(total.replace(/,/g, "")));
    votes.set(nom, v);
  }
  if (votes.size !== codes.size) throw new Error(`${votes.size} circonscriptions lues, ${codes.size} attendues`);
  for (const [nom, v] of votes) {
    const somme = [...v.values()].reduce((a, b) => a + b, 0);
    if (somme !== valides.get(nom)) throw new Error(`${nom} : ${somme} votes lus, ${valides.get(nom)} votes valides annoncés`);
  }

  const provenance = `Elections BC, résultats préliminaires du soir (${heure}${urnes ? `, ${urnes} % des urnes` : ""})`;
  const nouvelles = [...votes].flatMap(([nom, v]) => [...v].map(([parti, n]) => ({
    juridiction: "bc-provincial", election: ELECTION, carte: CARTE, circonscription: codes.get(nom)!, nom, parti, votes: n, provenance,
  })));
  const tout = [...lignes.filter((l) => !(l.juridiction === "bc-provincial" && l.election === ELECTION)), ...nouvelles]
    .sort((a, b) => String(a.juridiction).localeCompare(String(b.juridiction)) || String(a.election).localeCompare(String(b.election))
      || String(a.carte).localeCompare(String(b.carte)) || String(a.circonscription).localeCompare(String(b.circonscription)) || String(a.parti).localeCompare(String(b.parti)));
  ecrireCsv(F, ["juridiction", "election", "carte", "circonscription", "nom", "parti", "votes", "provenance"], tout);

  const sieges: Record<string, number> = {}, total: Record<string, number> = {};
  for (const v of votes.values()) {
    const [premier] = [...v].sort((a, b) => b[1] - a[1]);
    sieges[premier[0]] = (sieges[premier[0]] ?? 0) + 1;
    for (const [p, n] of v) total[p] = (total[p] ?? 0) + n;
  }
  console.log(`${nouvelles.length} lignes (${votes.size} circonscriptions) ; ${provenance}`);
  console.log(`en tête : ${JSON.stringify(sieges)} ; votes : ${JSON.stringify(total)}`);
}
