/**
 * Recensement de 2021 par section de vote québécoise de 2026 (Statistique
 * Canada, Profil du recensement par aire de diffusion, 98-401-X2021006, et
 * limites des aires de diffusion, lda_000b21a_e ; Licence ouverte de
 * Statistique Canada). Les fichiers, trop gros et protégés contre le
 * téléchargement automatisé, sont déposés à la main dans raw/statcan/ :
 * 98-401-X2021006_fra_CSV.zip et lda_000b21a_e.zip.
 *
 * 1. Lecture en flux du fichier du Québec (unzip -p) : une ligne par aire de
 *    diffusion et par caractéristique retenue (VARIABLES), chiffre total.
 *    Écrit raw/statcan/ad_qc_2021.csv.
 * 2. Poids des aires de diffusion vers les sections de 2026 (numéro < 500),
 *    comme sources/transposition_sections_qc.ts : les électeurs inscrits de
 *    2026 d'une section sont répartis uniformément sur sa surface ; le poids
 *    d'une aire vers une section est le nombre d'électeurs de la section dans
 *    leur recoupement, divisé par le total de l'aire ; une aire sans électeurs
 *    dans ses recoupements est répartie selon la surface.
 * 3. Par section : comptes interpolés (somme pondérée), et pour les valeurs
 *    non additives (revenu médian, fréquence du faible revenu, taille moyenne
 *    des ménages) moyenne pondérée par la population interpolée, sur les aires
 *    où la valeur est publiée ; point représentatif de la section (x, y en
 *    mètres, EPSG:3798), pour les analyses spatiales. Écrit la table dans le
 *    dossier de données du billet (--sortie), sans aucune variable de vote.
 *
 * Run: deno run --allow-read --allow-write --allow-run=unzip --allow-ffi --allow-env --allow-sys --allow-net=extensions.duckdb.org \
 *        sources/recensement_sections_qc.ts --sortie <dossier>
 */

import { DuckDBInstance } from "@duckdb/node-api";
import { ecrireCsv, lireCsv, RACINE } from "../lib/commun.ts";

const RAW = new URL("raw/statcan/", RACINE);
const PROFIL = new URL("98-401-X2021006_fra_CSV.zip", RAW).pathname;
const LIMITES = new URL("lda_000b21a_e.zip", RAW).pathname;

/** ID de caractéristique -> nom de colonne. Comptes, sauf NON_ADDITIVES. */
export const VARIABLES: Record<number, string> = {
  1: "population", 7: "superficie_km2",
  9: "age_0_14", 14: "age_15_19", 15: "age_20_24", 16: "age_25_29", 17: "age_30_34", 18: "age_35_39", 19: "age_40_44",
  20: "age_45_49", 21: "age_50_54", 22: "age_55_59", 23: "age_60_64", 25: "age_65_69", 26: "age_70_74", 27: "age_75_79", 29: "age_85_plus", 28: "age_80_84",
  41: "logements_total", 42: "maison_individuelle", 43: "maison_jumelee", 44: "maison_rangee", 45: "duplex", 46: "appartement_moins_5_etages",
  47: "appartement_5_etages_plus", 48: "autre_maison_attenante", 49: "logement_mobile",
  50: "menages_total", 51: "menages_1_personne", 52: "menages_2_personnes", 53: "menages_3_personnes", 54: "menages_4_personnes", 55: "menages_5_personnes_plus",
  57: "taille_moyenne_menages",
  244: "revenu_median_menages_apres_impot", 345: "faible_revenu_mfr_api_pct",
  393: "langue_maternelle_total", 396: "langue_maternelle_anglais", 397: "langue_maternelle_francais", 398: "langue_maternelle_non_officielle",
  1402: "autochtone_total", 1403: "autochtone",
  1414: "occupation_total", 1415: "proprietaires", 1416: "locataires",
  1527: "immigration_total", 1529: "immigrants",
  1683: "minorites_visibles_total", 1684: "minorites_visibles",
  1949: "religion_total", 1956: "catholique", 1973: "aucune_religion",
  1983: "mobilite_5_ans_total", 1985: "demenage_5_ans",
  2014: "scolarite_25_64_total", 2015: "scol_aucun", 2016: "scol_secondaire", 2019: "scol_metiers", 2022: "scol_college_cegep",
  2023: "scol_universitaire_inferieur_bac", 2024: "scol_bac_plus",
  2223: "activite_total", 2224: "population_active", 2226: "chomeurs",
  2248: "professions_total", 2249: "prof_0_cadres_superieurs", 2250: "prof_1_affaires_finance_admin", 2251: "prof_2_sciences",
  2252: "prof_3_sante", 2253: "prof_4_enseignement_droit_social", 2254: "prof_5_arts_culture", 2255: "prof_6_vente_services",
  2256: "prof_7_metiers_transport", 2257: "prof_8_ressources_naturelles", 2258: "prof_9_fabrication",
  2603: "navette_total", 2604: "navette_auto", 2607: "navette_transport_commun", 2608: "navette_marche", 2609: "navette_velo", 2610: "navette_autre",
};
const NON_ADDITIVES = new Set(["taille_moyenne_menages", "revenu_median_menages_apres_impot", "faible_revenu_mfr_api_pct"]);
const COLONNES = Object.values(VARIABLES);

/** Champs d'une ligne CSV (guillemets doubles). */
const champs = (l: string): string[] => {
  const out: string[] = []; let f = "", q = false;
  for (const c of l) { if (q) { if (c === '"') q = false; else f += c; } else if (c === '"') q = true; else if (c === ",") { out.push(f); f = ""; } else f += c; }
  out.push(f); return out;
};

async function airesDeDiffusion(): Promise<URL> {
  const sortie = new URL("ad_qc_2021.csv", RAW);
  try { Deno.statSync(sortie); return sortie; } catch { /* à produire */ }
  const p = new Deno.Command("unzip", { args: ["-p", PROFIL, "98-401-X2021006_Francais_CSV_data_Quebec.csv"], stdout: "piped" }).spawn();
  const lignes = p.stdout.pipeThrough(new TextDecoderStream("latin1"));
  const par = new Map<string, Record<string, unknown>>();
  let reste = "", entete: string[] | null = null, iNiv = 0, iCode = 0, iId = 0, iVal = 0;
  for await (const bloc of lignes) {
    const morceaux = (reste + bloc).split(/\r?\n/);
    reste = morceaux.pop()!;
    for (const l of morceaux) {
      if (!entete) {
        entete = champs(l); iNiv = entete.indexOf("NIVEAU_GÉO"); iCode = entete.indexOf("CODE_GÉO_ALT");
        iId = entete.indexOf("ID_CARACTÉRISTIQUE"); iVal = entete.indexOf("C1_CHIFFRE_TOTAL");
        continue;
      }
      if (!l.includes("Aire de diffusion")) continue;
      const f = champs(l);
      if (f[iNiv] !== "Aire de diffusion") continue;
      const nom = VARIABLES[Number(f[iId])];
      if (!nom) continue;
      const d = par.get(f[iCode]) ?? par.set(f[iCode], { dauid: f[iCode] }).get(f[iCode])!;
      d[nom] = f[iVal] === "" ? "" : Number(f[iVal]);
    }
  }
  if ((await p.status).code !== 0) throw new Error("unzip a échoué");
  ecrireCsv(sortie, ["dauid", ...COLONNES], [...par.values()]);
  console.log(`raw/statcan/ad_qc_2021.csv : ${par.size} aires de diffusion`);
  return sortie;
}

if (import.meta.main) {
  const i = Deno.args.indexOf("--sortie");
  if (i < 0) throw new Error("--sortie <dossier> requis");
  const dossier = Deno.args[i + 1].replace(/\/?$/, "/");
  const ad = await airesDeDiffusion();

  const shp = [...Deno.readDirSync(new URL("raw/elections_quebec/sections_vote_2026/", RACINE))].find((e) => /\.shp$/i.test(e.name))!.name;
  const db = await DuckDBInstance.create(":memory:");
  const c = await db.connect();
  await c.run("INSTALL spatial; LOAD spatial;");
  // Sections de 2026 (EPSG:3798) et leurs électeurs (sous-sections lettrées sommées).
  await c.run(`CREATE TABLE sec AS SELECT CAST(CO_CEP AS INTEGER) cep, CAST(NO_SV AS INTEGER) sv, ST_Union_Agg(ST_MakeValid(geom)) geom
    FROM ST_Read('${new URL(`raw/elections_quebec/sections_vote_2026/${shp}`, RACINE).pathname}') WHERE CAST(NO_SV AS INTEGER) < 500 GROUP BY 1, 2`);
  await c.run(`CREATE TABLE el AS SELECT CAST(circonscription AS INTEGER) cep, any_value(nom) nom, CAST(regexp_extract(sv, '^\\d+') AS INTEGER) sv, sum(electeurs) electeurs
    FROM read_csv('${new URL("csv/resultats_sections_qc.csv", RACINE).pathname}', all_varchar = false)
    WHERE juridiction = 'qc-provincial' AND election = '2026-10-05' AND CAST(regexp_extract(sv, '^\\d+') AS INTEGER) < 500 GROUP BY 1, 3`);
  // Aires de diffusion du Québec (PRUID 24), ramenées en EPSG:3798.
  await c.run(`CREATE TABLE da AS SELECT DAUID dauid, ST_Transform(ST_MakeValid(geom), 'EPSG:3347', 'EPSG:3798') geom
    FROM ST_Read('/vsizip/${LIMITES}/lda_000b21a_e.shp') WHERE PRUID = '24'`);
  await c.run(`CREATE TABLE inter AS SELECT d.dauid, s.cep, s.sv, ST_Area(ST_Intersection(d.geom, s.geom)) aire, ST_Area(s.geom) aire_s
    FROM da d JOIN sec s ON ST_Intersects(d.geom, s.geom)`);
  await c.run(`CREATE TABLE poids AS
    WITH p AS (SELECT i.*, COALESCE(el.electeurs, 0) * i.aire / i.aire_s pe FROM inter i LEFT JOIN el USING (cep, sv) WHERE i.aire > 0),
         t AS (SELECT dauid, sum(pe) spe, sum(aire) spa FROM p GROUP BY 1)
    SELECT p.dauid, p.cep, p.sv, CASE WHEN t.spe > 0 THEN p.pe / t.spe ELSE p.aire / t.spa END w FROM p JOIN t USING (dauid)`);
  await c.run(`CREATE TABLE adv AS SELECT * FROM read_csv('${ad.pathname}', all_varchar = false, types = {'dauid': 'VARCHAR'})`);

  const additives = COLONNES.filter((v) => !NON_ADDITIVES.has(v));
  const moyennes = [...NON_ADDITIVES].map((v) => `sum(w.w * adv.population * adv.${v}) FILTER (WHERE adv.${v} IS NOT NULL) / NULLIF(sum(w.w * adv.population) FILTER (WHERE adv.${v} IS NOT NULL), 0) ${v}`);
  const r = await c.runAndReadAll(`
    SELECT s.cep, s.sv, el.nom, el.electeurs, round(ST_X(ST_PointOnSurface(any_value(s.geom)))) x, round(ST_Y(ST_PointOnSurface(any_value(s.geom)))) y,
           count(DISTINCT w.dauid) n_aires,
           ${additives.map((v) => `sum(w.w * adv.${v}) ${v}`).join(", ")}, ${moyennes.join(", ")}
    FROM sec s LEFT JOIN el USING (cep, sv) LEFT JOIN poids w USING (cep, sv) LEFT JOIN adv USING (dauid)
    GROUP BY s.cep, s.sv, el.nom, el.electeurs ORDER BY s.cep, s.sv`);
  const cols = r.columnNames();
  const lignes = r.getRows().map((l) => Object.fromEntries(cols.map((k, j) => {
    const v = l[j];
    return [k, v === null || v === undefined ? "" : typeof v === "number" && !Number.isInteger(v) ? Math.round(v * 1000) / 1000 : typeof v === "bigint" ? Number(v) : v];
  })));
  Deno.mkdirSync(dossier, { recursive: true });
  ecrireCsv(new URL(`${dossier}recensement_sections_2026.csv`, `file://${Deno.cwd()}/`), cols, lignes);
  const pop = lignes.reduce((a, l) => a + (Number(l.population) || 0), 0);
  console.log(`${lignes.length} sections ; population interpolée ${Math.round(pop)} ; sections sans aire : ${lignes.filter((l) => !l.n_aires).length}`);
}
