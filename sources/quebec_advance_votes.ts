/**
 * Vote par anticipation des élections générales québécoises, réparti par
 * section de vote (Élections Québec, données ouvertes, résultats par bureau
 * de vote : archive resultats-bureau-vote.zip déjà téléchargée dans
 * raw/elections_quebec/ par sources/elections_quebec_sections.ts).
 *
 * Les fichiers donnent le vote par anticipation par bureau (BVA), avec la
 * liste des sections qu'il dessert (« BVA1: SV no 1 à 4 », « BVA2: SV no 106,
 * 111, 118 »). Les votes d'un bureau sont répartis entre ses sections
 * territoriales (numéro < 500) au prorata des électeurs inscrits : exacts
 * pour le groupe de sections, répartis à l'intérieur. Une ligne par section
 * desservie par un bureau de vote par anticipation, dans
 * csv/advance_votes_sections_qc.csv ; les lignes des élections traitées sont
 * remplacées.
 *
 * Run: deno task advance-votes-qc --election AAAA-MM-JJ [--election AAAA-MM-JJ ...]
 */

import { unzipSync } from "fflate";
import { ecrireCsv, lireCsv, RACINE } from "../lib/commun.ts";
import { SIGLES } from "./elections_quebec_sections.ts";

const PARTIES = ["PQ", "LIB", "CAQ", "QS", "PCQ", "AUTRES"];
const COLUMNS = ["jurisdiction", "election", "riding_code", "riding_name", "section", "advance_poll", "electors", ...PARTIES, "source"];
const SOURCE = "Élections Québec, données ouvertes, résultats par bureau de vote (vote par anticipation réparti au prorata des électeurs)";
const OUTPUT = new URL("csv/advance_votes_sections_qc.csv", RACINE);

/** Section numbers listed in an advance-poll label: "1 à 4", "1 à 5, 500", "106, 111, 118". */
function listedSections(list: string): number[] {
  const sections: number[] = [];
  for (const part of list.split(",").map((s) => s.trim())) {
    const range = part.match(/^(\d+)\s*à\s*(\d+)$/), single = part.match(/^(\d+)[A-Z]?$/);
    if (range) for (let n = Number(range[1]); n <= Number(range[2]); n++) sections.push(n);
    else if (single) sections.push(Number(single[1]));
    else throw new Error(`liste de sections illisible : ${list}`);
  }
  return sections;
}

function readRiding(text: string, election: string, codes: Record<string, string>): Record<string, unknown>[] {
  const rows = text.split(/\r?\n/).filter((l) => l.trim()).map((l) => l.split(";"));
  const header = rows[0].map((h) => h.trim());
  const column = (...names: string[]) => {
    const i = header.findIndex((h) => names.includes(h));
    if (i < 0) throw new Error(`colonne ${names.join(" ou ")} absente`);
    return i;
  };
  const iName = column("Circonscription"), iPlace = header.findIndex((h) => /^Nom des municipalités$/i.test(h));
  const iSection = column("S.V.", "Section de vote"), iElectors = column("É.I.", "Électeurs inscrits"), iValid = column("B.V.", "Bulletins valides");
  if (iPlace < 0) throw new Error("colonne des municipalités absente");
  // Candidate columns sit between registered electors and valid ballots; the party code is the last word of the header.
  const candidates = header.slice(iElectors + 1, iValid).map((h, k) => ({ i: iElectors + 1 + k, party: codes[h.split(/\s+/).at(-1)!] ?? "AUTRES" }));
  const electors = new Map<number, number>();
  const polls = new Map<string, { sections: number[]; votes: Record<string, number> }>();
  let code = "", name = "";
  for (const r of rows.slice(1)) {
    const section = (r[iSection] ?? "").trim(), place = (r[iPlace] ?? "").trim();
    if (section) {
      code = r[0].trim(); name = r[iName].trim();
      const n = Number(section.match(/^\d+/)![0]);
      electors.set(n, (electors.get(n) ?? 0) + Number(r[iElectors] || 0));
      continue;
    }
    const label = place.match(/^(BVA\s*\d+)\s*:\s*SV\s*no\s*(.*)$/);
    if (!label) continue;
    const id = label[1].replace(/\s+/g, "");
    const poll = polls.get(id) ?? polls.set(id, { sections: listedSections(label[2]), votes: Object.fromEntries(PARTIES.map((p) => [p, 0])) }).get(id)!;
    for (const c of candidates) poll.votes[c.party] += Number(r[c.i] || 0);
  }
  const out: Record<string, unknown>[] = [];
  for (const [id, poll] of polls) {
    const territorial = poll.sections.filter((n) => n < 500 && electors.has(n));
    const total = territorial.reduce((s, n) => s + electors.get(n)!, 0);
    for (const n of territorial) {
      const share = total > 0 ? electors.get(n)! / total : 1 / territorial.length;
      out.push({ jurisdiction: "qc-provincial", election, riding_code: code, riding_name: name, section: n, advance_poll: id, electors: electors.get(n),
        ...Object.fromEntries(PARTIES.map((p) => [p, Math.round(poll.votes[p] * share * 100) / 100])), source: SOURCE });
    }
  }
  return out;
}

if (import.meta.main) {
  const elections = Deno.args.flatMap((a, i) => (a === "--election" ? [Deno.args[i + 1]] : []));
  if (!elections.length) throw new Error("--election requis");
  const decoder = new TextDecoder("iso-8859-1");
  let rows: Record<string, unknown>[] = lireCsv(OUTPUT).filter((r) => !elections.includes(String(r.election)));
  for (const election of elections) {
    const codes = SIGLES[election];
    if (!codes) throw new Error(`sigles des partis inconnus pour ${election}`);
    const zip = unzipSync(Deno.readFileSync(new URL(`raw/elections_quebec/resultats-bureau-vote_${election}.zip`, RACINE)));
    const added = Object.entries(zip).filter(([n]) => /\.csv$/i.test(n)).flatMap(([, content]) => readRiding(decoder.decode(content), election, codes));
    rows = [...rows, ...added];
    const votes = added.reduce((s, r) => s + PARTIES.reduce((t, p) => t + Number(r[p]), 0), 0);
    console.log(`${election} : ${added.length} sections desservies, ${new Set(added.map((r) => `${r.riding_code}-${r.advance_poll}`)).size} bureaux de vote par anticipation, ${Math.round(votes)} votes répartis`);
  }
  rows.sort((a, b) => String(a.election).localeCompare(String(b.election)) || Number(a.riding_code) - Number(b.riding_code) || Number(a.section) - Number(b.section));
  ecrireCsv(OUTPUT, COLUMNS, rows);
}
