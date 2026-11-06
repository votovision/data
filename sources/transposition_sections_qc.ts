/**
 * Transposition des résultats par section de vote d'une élection générale
 * québécoise (élection A) sur les sections de vote d'une élection suivante
 * (élection B), dont le découpage diffère. Produit, pour chaque section de B,
 * les votes de B et les votes de A transposés, par parti, avec le parti
 * arrivé premier dans chacune.
 *
 * Interpolation pondérée par les électeurs, comme sources/poids_bc.py : les
 * électeurs inscrits d'une section de B sont répartis uniformément sur sa
 * surface ; le poids d'une section de A vers une section de B est le nombre
 * d'électeurs de B dans le recoupement, divisé par le total sur tous les
 * recoupements de la section de A. Une section de A sans électeurs dans ses
 * recoupements est répartie selon la surface.
 *
 * Seules les sections territoriales (numéro < 500) sont traitées. Les votes
 * d'un bureau regroupé (regroupement BVO-n) sont ceux du bureau n, répartis
 * entre les sections du groupe au prorata des électeurs ; les sections
 * regroupées au bureau du directeur du scrutin (BVDS) n'ont pas de votes par
 * section et restent sans résultat. Les sous-sections lettrées (4A, 4B)
 * partagent un polygone et sont sommées. La colonne stabilite (0 à 1) dit si
 * la section de B correspond à une seule section de A (1 : découpage inchangé) ;
 * la colonne bureau donne, pour l'élection B, la section du bureau où les votes
 * de la section ont été dépouillés (elle-même, ou le bureau de regroupement) :
 * les sections d'un même bureau portent des votes répartis, pas mesurés.
 *
 * Entrées : csv/resultats_sections_qc.csv (sources/elections_quebec_sections.ts)
 * et les polygones des sections d'Élections Québec
 * (sections_vote_<année>_shapefile.zip, EPSG:3798), téléchargés dans
 * raw/elections_quebec/. Sortie :
 * raw/elections_quebec/transposition_sections_<A>_sur_<B>.csv (non versionné ;
 * copié dans le dossier data/ du billet qui l'utilise) et les poids de A vers
 * B, raw/elections_quebec/section_weights_<A>_to_<B>.csv.
 *
 * Run: deno task transposition-sections-qc --de 2018-10-01 --vers 2022-10-03
 */

import { DuckDBInstance } from "@duckdb/node-api";
import { unzipSync } from "fflate";
import { ecrireCsv, RACINE, USER_AGENT } from "../lib/commun.ts";

const GEO = "https://donnees.electionsquebec.qc.ca/autres/provincial";
const PARTIS = ["PQ", "LIB", "CAQ", "QS", "PCQ", "AUTRES"];
const RAW = new URL("raw/elections_quebec/", RACINE);

/** Chemin du .shp des sections d'une année, téléchargé et décompressé au besoin (l'archive de 2018 a un sous-dossier). */
async function shapefile(annee: string): Promise<string> {
  const dossier = new URL(`sections_vote_${annee}/`, RAW);
  Deno.mkdirSync(dossier, { recursive: true });
  let shp = [...Deno.readDirSync(dossier)].find((e) => /\.shp$/i.test(e.name))?.name;
  if (!shp) {
    const url = `${GEO}/sections_vote_${annee}_shapefile.zip`;
    const r = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    if (!r.ok) throw new Error(`${url} : HTTP ${r.status}`);
    const zip = unzipSync(new Uint8Array(await r.arrayBuffer()));
    for (const [nom, contenu] of Object.entries(zip)) {
      if (nom.endsWith("/")) continue;
      Deno.writeFileSync(new URL(nom.split("/").at(-1)!, dossier), contenu);
    }
    shp = [...Deno.readDirSync(dossier)].find((e) => /\.shp$/i.test(e.name))?.name;
    if (!shp) throw new Error(`${url} : pas de .shp`);
  }
  return new URL(shp, dossier).pathname;
}

if (import.meta.main) {
  const arg = (n: string) => { const i = Deno.args.indexOf(n); return i >= 0 ? Deno.args[i + 1] : undefined; };
  const de = arg("--de"), vers = arg("--vers");
  if (!de || !vers) throw new Error("--de et --vers requis (dates d'élection)");
  const shpA = await shapefile(de.slice(0, 4)), shpB = await shapefile(vers.slice(0, 4));

  const db = await DuckDBInstance.create(":memory:");
  const c = await db.connect();
  await c.run("INSTALL spatial; LOAD spatial;");

  // Polygones : noms de colonnes variables selon l'année (CO_CEP ou CO_CEP_VG, NO_SV ou NO_SV_VG).
  async function polygones(table: string, shp: string) {
    const cols = (await c.runAndReadAll(`SELECT column_name FROM (DESCRIBE SELECT * FROM ST_Read('${shp}'))`)).getRows().flat().map(String);
    const cep = cols.find((x) => /^CO_CEP/.test(x)), sv = cols.find((x) => /^NO_SV/.test(x));
    if (!cep || !sv) throw new Error(`${shp} : colonnes de circonscription ou de section introuvables (${cols.join(", ")})`);
    await c.run(`CREATE TABLE ${table} AS
      SELECT CAST(${cep} AS INTEGER) cep, CAST(${sv} AS INTEGER) sv, ST_Union_Agg(ST_MakeValid(geom)) geom
      FROM ST_Read('${shp}') WHERE CAST(${sv} AS INTEGER) < 500 GROUP BY 1, 2`);
  }
  await polygones("sa", shpA);
  await polygones("sb", shpB);

  // Votes par section territoriale (sous-sections lettrées sommées, bureaux regroupés répartis au prorata des électeurs).
  const somme = PARTIS.map((p) => `sum(${p}) ${p}`).join(", ");
  async function votes(table: string, election: string) {
    await c.run(`CREATE TABLE ${table} AS
      WITH l AS (
        SELECT CAST(circonscription AS INTEGER) cep, nom, CAST(regexp_extract(sv, '^\\d+') AS INTEGER) svn, electeurs, ${PARTIS.join(", ")}, valides,
               -- read_csv lit une cellule vide comme NULL : COALESCE, sinon NOT bvds éliminerait les sections ordinaires.
               CASE WHEN COALESCE(regroupement, '') LIKE 'BVO-%' THEN CAST(regexp_extract(regroupement, '\\d+') AS INTEGER) ELSE CAST(regexp_extract(sv, '^\\d+') AS INTEGER) END grp,
               COALESCE(regroupement, '') LIKE 'BVDS%' bvds
        FROM read_csv('${new URL("csv/resultats_sections_qc.csv", RACINE).pathname}', all_varchar = false)
        WHERE juridiction = 'qc-provincial' AND election = '${election}' AND CAST(regexp_extract(sv, '^\\d+') AS INTEGER) < 500
      ), g AS (
        SELECT cep, grp, sum(electeurs) e, count(*) n, ${somme}, sum(valides) valides FROM l WHERE NOT bvds GROUP BY cep, grp
      )
      SELECT l.cep, any_value(l.nom) nom, l.svn, any_value(l.grp) bureau, sum(l.electeurs) electeurs,
             ${PARTIS.map((p) => `sum(g.${p} * CASE WHEN g.e > 0 THEN l.electeurs / g.e ELSE 1.0 / g.n END) ${p}`).join(", ")},
             sum(g.valides * CASE WHEN g.e > 0 THEN l.electeurs / g.e ELSE 1.0 / g.n END) valides
      FROM l JOIN g USING (cep, grp) WHERE NOT l.bvds GROUP BY l.cep, l.svn`);
  }
  await votes("va", de);
  await votes("vb", vers);

  // Recoupements et poids de A vers B.
  await c.run(`CREATE TABLE inter AS
    SELECT a.cep cep_a, a.sv sv_a, b.cep cep_b, b.sv sv_b, ST_Area(ST_Intersection(a.geom, b.geom)) aire
    FROM sa a JOIN sb b ON ST_Intersects(a.geom, b.geom)`);
  await c.run(`CREATE TABLE poids AS
    WITH p AS (
      SELECT i.*, COALESCE(vb.electeurs, 0) * i.aire / ST_Area(sb.geom) pe
      FROM inter i JOIN sb ON sb.cep = i.cep_b AND sb.sv = i.sv_b
      LEFT JOIN vb ON vb.cep = i.cep_b AND vb.svn = i.sv_b
      WHERE i.aire > 0
    ), s AS (SELECT cep_a, sv_a, sum(pe) spe, sum(aire) spa FROM p GROUP BY 1, 2)
    SELECT p.cep_a, p.sv_a, p.cep_b, p.sv_b, CASE WHEN s.spe > 0 THEN p.pe / s.spe ELSE p.aire / s.spa END w
    FROM p JOIN s USING (cep_a, sv_a)`);
  // Poids de transposition, pour transposer d'autres comptes par section (vote par anticipation réparti).
  const weights = new URL(`section_weights_${de}_to_${vers}.csv`, RAW);
  await c.run(`COPY (SELECT cep_a from_riding, sv_a from_section, cep_b to_riding, sv_b to_section, round(w, 6) weight FROM poids WHERE w > 1e-6
    ORDER BY 1, 2, 3, 4) TO '${weights.pathname}' (HEADER)`);
  await c.run(`CREATE TABLE ta AS
    SELECT w.cep_b cep, w.sv_b svn, ${PARTIS.map((p) => `sum(w.w * va.${p}) ${p}`).join(", ")}, sum(w.w * va.valides) valides, sum(w.w * va.electeurs) electeurs
    FROM poids w JOIN va ON va.cep = w.cep_a AND va.svn = w.sv_a GROUP BY 1, 2`);

  // Stabilité du découpage d'une section de B : plus grande valeur, parmi les sections de A qui la recoupent, du minimum entre
  // la part de la section de A qui lui revient et la part de ses électeurs transposés qui en viennent (1 : même section).
  await c.run(`CREATE TABLE stab AS
    WITH k AS (SELECT w.cep_b, w.sv_b, w.w, w.w * COALESCE(va.electeurs, 0) e FROM poids w LEFT JOIN va ON va.cep = w.cep_a AND va.svn = w.sv_a),
         t AS (SELECT cep_b, sv_b, sum(e) te FROM k GROUP BY 1, 2)
    SELECT k.cep_b cep, k.sv_b svn, max(least(k.w, CASE WHEN t.te > 0 THEN k.e / t.te ELSE 0 END)) stabilite
    FROM k JOIN t USING (cep_b, sv_b) GROUP BY 1, 2`);

  // Une ligne par section de B.
  const r = await c.runAndReadAll(`
    SELECT sb.cep, sb.sv, vb.nom, vb.electeurs, vb.bureau,
           ${PARTIS.map((p) => `vb.${p} b_${p}`).join(", ")}, vb.valides b_valides,
           ${PARTIS.map((p) => `ta.${p} a_${p}`).join(", ")}, ta.valides a_valides, ta.electeurs a_electeurs, stab.stabilite
    FROM sb LEFT JOIN vb ON vb.cep = sb.cep AND vb.svn = sb.sv LEFT JOIN ta ON ta.cep = sb.cep AND ta.svn = sb.sv
    LEFT JOIN stab ON stab.cep = sb.cep AND stab.svn = sb.sv
    ORDER BY sb.cep, sb.sv`);
  const num = (v: unknown) => v === null || v === undefined ? null : Number(v);
  const gagnant = (l: Record<string, unknown>, pre: string) => {
    const v = PARTIS.map((p) => [p, num(l[`${pre}${p}`]) ?? 0] as const).filter(([p]) => p !== "AUTRES");
    const total = PARTIS.reduce((s, p) => s + (num(l[`${pre}${p}`]) ?? 0), 0);
    if (!total) return { parti: "", marge: null };
    v.sort((x, y) => y[1] - x[1]);
    return { parti: v[0][1] >= (num(l[`${pre}AUTRES`]) ?? 0) ? v[0][0] : "AUTRES", marge: (v[0][1] - v[1][1]) / total };
  };
  const arrondi = (v: number | null, d = 1) => v === null ? "" : Number(v.toFixed(d));
  const lignes: Record<string, unknown>[] = r.getRowObjects().map((l) => {
    const gb = gagnant(l, "b_"), ga = gagnant(l, "a_");
    return {
      circonscription: num(l.cep), nom: l.nom ?? "", sv: num(l.sv), electeurs: num(l.electeurs) ?? "",
      ...Object.fromEntries(PARTIS.map((p) => [`${vers.slice(0, 4)}_${p}`, arrondi(num(l[`b_${p}`]), 0)])),
      [`${vers.slice(0, 4)}_valides`]: arrondi(num(l.b_valides), 0), [`${vers.slice(0, 4)}_gagnant`]: gb.parti, [`${vers.slice(0, 4)}_marge`]: arrondi(gb.marge, 3),
      ...Object.fromEntries(PARTIS.map((p) => [`${de.slice(0, 4)}_${p}`, arrondi(num(l[`a_${p}`]))])),
      [`${de.slice(0, 4)}_valides`]: arrondi(num(l.a_valides)), [`${de.slice(0, 4)}_electeurs`]: arrondi(num(l.a_electeurs)),
      [`${de.slice(0, 4)}_gagnant`]: ga.parti, [`${de.slice(0, 4)}_marge`]: arrondi(ga.marge, 3),
      stabilite: arrondi(num(l.stabilite), 3), bureau: num(l.bureau) ?? "",
    };
  });
  const sortie = new URL(`transposition_sections_${de}_sur_${vers}.csv`, RAW);
  ecrireCsv(sortie, Object.keys(lignes[0]), lignes);

  // Bilan : matrice des premiers, couverture.
  const A = `${de.slice(0, 4)}_gagnant`, B = `${vers.slice(0, 4)}_gagnant`;
  const complets = lignes.filter((l) => l[A] && l[B]);
  console.log(`${lignes.length} sections de ${vers} ; ${complets.length} avec un premier aux deux élections ; ` +
    `${lignes.filter((l) => !l[B]).length} sans votes en ${vers.slice(0, 4)} ; ${lignes.filter((l) => !l[A]).length} sans transposition de ${de.slice(0, 4)}`);
  const noms = [...PARTIS];
  const m = Object.fromEntries(noms.map((a) => [a, Object.fromEntries(noms.map((b) => [b, 0]))]));
  for (const l of complets) m[String(l[A])][String(l[B])]++;
  console.log(`${de.slice(0, 4)} \\ ${vers.slice(0, 4)}`.padEnd(14) + noms.map((p) => p.padStart(7)).join(""));
  for (const a of noms) console.log(a.padEnd(14) + noms.map((b) => String(m[a][b]).padStart(7)).join(""));
  console.log(`écrit : ${sortie.pathname}`);
}
