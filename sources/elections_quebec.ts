/**
 * Résultats officiels d'Élections Québec (données ouvertes, licence
 * d'utilisation du Directeur général des élections ; mention obligatoire dans
 * ATTRIBUTIONS.md) : flux des résultats de l'élection en cours
 * (resultats.json), copié dans raw/elections_quebec/, puis les lignes de
 * cette élection et de cette carte dans csv/resultats.csv sont remplacées.
 * Partis principaux codés (PQ, LIB, PCQ, CAQ, QS) ; autres candidats :
 * AUTRES:<prénom nom sigle>. Le flux signale par circonscription si les
 * résultats sont définitifs (isResultatsFinaux) ; un flux incomplet est
 * refusé sauf --provisoire.
 *
 * Dépouillements judiciaires (sources/elections_quebec_depouillements.json) :
 * le flux n'est pas toujours mis à jour après un dépouillement judiciaire ;
 * les votes publiés par Élections Québec à son issue remplacent ceux du flux.
 * Chaque entrée donne, par candidat, [votes au recensement, votes au
 * dépouillement] ; le flux doit porter l'un ou l'autre, sinon le script
 * s'arrête.
 *
 * Run: deno run --allow-read --allow-write --allow-net=donnees.electionsquebec.qc.ca sources/elections_quebec.ts --date AAAA-MM-JJ --carte AAAA [--provisoire]
 */

import { ecrireCsv, lireCsv, RACINE, USER_AGENT } from "../lib/commun.ts";

const FLUX = "https://donnees.electionsquebec.qc.ca/production/provincial/resultats/resultats.json";
const PARTIS: Record<string, string> = { PQ: "PQ", "PLQ/QLP": "LIB", PCOQ: "PCQ", "ÉCF-CAQ": "CAQ", QS: "QS" };
const PROVENANCE = "Élections Québec, données ouvertes";

if (import.meta.main) {
  const arg = (n: string) => { const i = Deno.args.indexOf(n); return i >= 0 ? Deno.args[i + 1] : undefined; };
  const date = arg("--date"), carte = arg("--carte");
  if (!date || !carte) throw new Error("--date et --carte requis");
  const r = await fetch(FLUX, { headers: { "User-Agent": USER_AGENT } });
  if (!r.ok) throw new Error(`${FLUX} : HTTP ${r.status}`);
  const texte = await r.text();
  const RAW = new URL("raw/elections_quebec/", RACINE);
  Deno.mkdirSync(RAW, { recursive: true });
  Deno.writeTextFileSync(new URL(`resultats_${date}.json`, RAW), texte);
  const flux = JSON.parse(texte);
  const provisoires = flux.circonscriptions.filter((c: { isResultatsFinaux?: boolean }) => c.isResultatsFinaux === false).length;
  if (provisoires && !Deno.args.includes("--provisoire")) throw new Error(`${provisoires} circonscription(s) aux résultats non définitifs (--provisoire pour passer outre)`);
  const lignes: Record<string, unknown>[] = [];
  for (const c of flux.circonscriptions) {
    for (const k of c.candidats) {
      const sigle = k.abreviationPartiPolitique ?? "Ind";
      lignes.push({ juridiction: "qc-provincial", election: date, carte, circonscription: String(c.numeroCirconscription), nom: c.nomCirconscription,
        parti: PARTIS[sigle] ?? `AUTRES:${k.prenom} ${k.nom} ${sigle}`, votes: k.nbVoteTotal, provenance: PROVENANCE });
    }
  }
  const depouillements = JSON.parse(Deno.readTextFileSync(new URL("sources/elections_quebec_depouillements.json", RACINE)))
    .filter((d: { election: string }) => d.election === date);
  for (const d of depouillements as { circonscription: string; nom: string; date: string; votes: Record<string, [number, number]> }[]) {
    const ici = lignes.filter((l) => l.circonscription === d.circonscription);
    if (ici.length !== Object.keys(d.votes).length) throw new Error(`${d.nom} : ${ici.length} candidats dans le flux, ${Object.keys(d.votes).length} au dépouillement judiciaire`);
    for (const l of ici) {
      const v = d.votes[l.parti as string];
      if (!v || !v.includes(l.votes as number)) throw new Error(`${d.nom} ${l.parti} : ${l.votes} dans le flux, ni recensement ni dépouillement (${v})`);
      l.votes = v[1];
      l.provenance = `Élections Québec, dépouillement judiciaire du ${d.date}`;
    }
    console.log(`${d.nom} : votes du dépouillement judiciaire du ${d.date}`);
  }
  const F = new URL("csv/resultats.csv", RACINE);
  const autres = lireCsv(F).filter((l) => !(l.juridiction === "qc-provincial" && l.election === date && l.carte === carte));
  const tout = [...autres, ...lignes].sort((a, b) => String(a.juridiction).localeCompare(String(b.juridiction)) || String(a.election).localeCompare(String(b.election))
    || String(a.carte).localeCompare(String(b.carte)) || String(a.circonscription).localeCompare(String(b.circonscription)) || String(a.parti).localeCompare(String(b.parti)));
  ecrireCsv(F, ["juridiction", "election", "carte", "circonscription", "nom", "parti", "votes", "provenance"], tout);
  console.log(`${lignes.length} lignes (${flux.circonscriptions.length} circonscriptions) ; ${provisoires} non définitive(s)`);
}
