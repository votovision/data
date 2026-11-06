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
 *    Écrit raw/statcan/da_qc_2021.csv.
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
 *    mètres, EPSG:3798), pour les analyses spatiales. Écrit
 *    census_polling_divisions_2026.csv dans le dossier donné (--output), sans
 *    aucune variable de vote.
 *
 * Run: deno task census-polling-divisions-qc --output <dossier>
 */

import { DuckDBInstance } from "@duckdb/node-api";
import { ecrireCsv, RACINE } from "../lib/commun.ts";

const RAW = new URL("raw/statcan/", RACINE);
const PROFILE = new URL("98-401-X2021006_fra_CSV.zip", RAW).pathname;
const BOUNDARIES = new URL("lda_000b21a_e.zip", RAW).pathname;

/** Characteristic ID of the census profile -> column name. Counts, except NON_ADDITIVE. */
export const VARIABLES: Record<number, string> = {
  1: "population", 7: "land_area_km2", 9: "age_0_14", 14: "age_15_19", 15: "age_20_24", 16: "age_25_29", 17: "age_30_34", 18: "age_35_39",
  19: "age_40_44", 20: "age_45_49", 21: "age_50_54", 22: "age_55_59", 23: "age_60_64", 25: "age_65_69", 26: "age_70_74", 27: "age_75_79",
  28: "age_80_84", 29: "age_85_plus", 30: "age_85_89", 31: "age_90_94", 32: "age_95_99", 33: "age_100_plus", 41: "dwellings_total",
  42: "dwelling_single_detached", 43: "dwelling_semi_detached", 44: "dwelling_row_house", 45: "dwelling_duplex",
  46: "dwelling_apartment_under_5_storeys", 47: "dwelling_apartment_5_storeys_plus", 48: "dwelling_other_attached", 49: "dwelling_movable",
  50: "households_total", 51: "households_1_person", 52: "households_2_persons", 53: "households_3_persons", 54: "households_4_persons",
  55: "households_5_persons_plus", 56: "persons_in_private_households", 57: "mean_household_size", 244: "median_after_tax_household_income",
  345: "low_income_lim_at_pct", 393: "mother_tongue_total", 396: "mother_tongue_english", 397: "mother_tongue_french",
  398: "mother_tongue_non_official", 1402: "indigenous_total", 1403: "indigenous_identity", 1414: "tenure_total", 1415: "owners", 1416: "renters",
  1527: "immigration_total", 1529: "immigrants", 1683: "visible_minority_total", 1684: "visible_minority", 1949: "religion_total", 1956: "catholic",
  1973: "no_religion", 1983: "mobility_5_years_total", 1985: "movers_5_years", 2014: "education_25_64_total", 2015: "edu_none",
  2016: "edu_high_school", 2019: "edu_trades", 2020: "edu_trades_school", 2021: "edu_apprenticeship", 2022: "edu_college_cegep",
  2023: "edu_university_below_bachelor", 2024: "edu_bachelor_or_higher", 2025: "edu_bachelor", 2026: "edu_university_above_bachelor",
  2027: "edu_medicine", 2028: "edu_master", 2029: "edu_doctorate", 2223: "labour_total", 2224: "labour_force", 2226: "unemployed",
  2248: "occupations_total", 2249: "occ_0_senior_management", 2250: "occ_1_business_finance_admin", 2251: "occ_2_sciences", 2252: "occ_3_health",
  2253: "occ_4_education_law_social", 2254: "occ_5_arts_culture", 2255: "occ_6_sales_service", 2256: "occ_7_trades_transport",
  2257: "occ_8_natural_resources", 2258: "occ_9_manufacturing", 2603: "commute_total", 2604: "commute_car", 2607: "commute_transit",
  2608: "commute_walk", 2609: "commute_bicycle", 2610: "commute_other",
};
const NON_ADDITIVE = new Set(["mean_household_size", "median_after_tax_household_income", "low_income_lim_at_pct"]);
const COLUMNS = Object.values(VARIABLES);

/** Fields of a CSV line (double quotes). */
const fields = (line: string): string[] => {
  const out: string[] = []; let f = "", quoted = false;
  for (const c of line) { if (quoted) { if (c === '"') quoted = false; else f += c; } else if (c === '"') quoted = true; else if (c === ",") { out.push(f); f = ""; } else f += c; }
  out.push(f); return out;
};

async function disseminationAreas(): Promise<URL> {
  const output = new URL("da_qc_2021.csv", RAW);
  // Extraction déjà faite avec les mêmes colonnes : réutilisée.
  try {
    const header = Deno.readTextFileSync(output).slice(0, 20000).split("\n")[0].split(",");
    if (COLUMNS.every((c) => header.includes(c))) return output;
  } catch { /* à produire */ }
  const unzip = new Deno.Command("unzip", { args: ["-p", PROFILE, "98-401-X2021006_Francais_CSV_data_Quebec.csv"], stdout: "piped" }).spawn();
  const byArea = new Map<string, Record<string, unknown>>();
  let rest = "", header: string[] | null = null, iLevel = 0, iCode = 0, iId = 0, iValue = 0;
  for await (const chunk of unzip.stdout.pipeThrough(new TextDecoderStream("latin1"))) {
    const lines = (rest + chunk).split(/\r?\n/);
    rest = lines.pop()!;
    for (const line of lines) {
      if (!header) {
        header = fields(line); iLevel = header.indexOf("NIVEAU_GÉO"); iCode = header.indexOf("CODE_GÉO_ALT");
        iId = header.indexOf("ID_CARACTÉRISTIQUE"); iValue = header.indexOf("C1_CHIFFRE_TOTAL");
        continue;
      }
      if (!line.includes("Aire de diffusion")) continue;
      const f = fields(line);
      if (f[iLevel] !== "Aire de diffusion") continue;
      const name = VARIABLES[Number(f[iId])];
      if (!name) continue;
      const area = byArea.get(f[iCode]) ?? byArea.set(f[iCode], { dauid: f[iCode] }).get(f[iCode])!;
      area[name] = f[iValue] === "" ? "" : Number(f[iValue]);
    }
  }
  if ((await unzip.status).code !== 0) throw new Error("unzip a échoué");
  ecrireCsv(output, ["dauid", ...COLUMNS], [...byArea.values()]);
  console.log(`raw/statcan/da_qc_2021.csv : ${byArea.size} aires de diffusion`);
  return output;
}

if (import.meta.main) {
  const i = Deno.args.indexOf("--output");
  if (i < 0) throw new Error("--output <dossier> requis");
  const folder = Deno.args[i + 1].replace(/\/?$/, "/");
  const areas = await disseminationAreas();

  const shapefile = [...Deno.readDirSync(new URL("raw/elections_quebec/sections_vote_2026/", RACINE))].find((e) => /\.shp$/i.test(e.name))!.name;
  const db = await DuckDBInstance.create(":memory:");
  const c = await db.connect();
  await c.run("INSTALL spatial; LOAD spatial;");
  // Sections de 2026 (EPSG:3798) et leurs électeurs (sous-sections lettrées sommées).
  await c.run(`CREATE TABLE sections AS SELECT CAST(CO_CEP AS INTEGER) riding_code, CAST(NO_SV AS INTEGER) section, ST_Union_Agg(ST_MakeValid(geom)) geom
    FROM ST_Read('${new URL(`raw/elections_quebec/sections_vote_2026/${shapefile}`, RACINE).pathname}') WHERE CAST(NO_SV AS INTEGER) < 500 GROUP BY 1, 2`);
  await c.run(`CREATE TABLE electors AS SELECT CAST(circonscription AS INTEGER) riding_code, any_value(nom) riding_name, CAST(regexp_extract(sv, '^\\d+') AS INTEGER) section, sum(electeurs) electors
    FROM read_csv('${new URL("csv/resultats_sections_qc.csv", RACINE).pathname}', all_varchar = false)
    WHERE juridiction = 'qc-provincial' AND election = '2026-10-05' AND CAST(regexp_extract(sv, '^\\d+') AS INTEGER) < 500 GROUP BY 1, 3`);
  // Aires de diffusion du Québec (PRUID 24), ramenées en EPSG:3798.
  await c.run(`CREATE TABLE da AS SELECT DAUID dauid, ST_Transform(ST_MakeValid(geom), 'EPSG:3347', 'EPSG:3798') geom
    FROM ST_Read('/vsizip/${BOUNDARIES}/lda_000b21a_e.shp') WHERE PRUID = '24'`);
  await c.run(`CREATE TABLE overlap AS SELECT d.dauid, s.riding_code, s.section, ST_Area(ST_Intersection(d.geom, s.geom)) area, ST_Area(s.geom) section_area
    FROM da d JOIN sections s ON ST_Intersects(d.geom, s.geom)`);
  await c.run(`CREATE TABLE weights AS
    WITH p AS (SELECT o.*, COALESCE(e.electors, 0) * o.area / o.section_area shared FROM overlap o LEFT JOIN electors e USING (riding_code, section) WHERE o.area > 0),
         t AS (SELECT dauid, sum(shared) total_shared, sum(area) total_area FROM p GROUP BY 1)
    SELECT p.dauid, p.riding_code, p.section, CASE WHEN t.total_shared > 0 THEN p.shared / t.total_shared ELSE p.area / t.total_area END w FROM p JOIN t USING (dauid)`);
  await c.run(`CREATE TABLE profile AS SELECT * FROM read_csv('${areas.pathname}', all_varchar = false, types = {'dauid': 'VARCHAR'})`);

  const additive = COLUMNS.filter((v) => !NON_ADDITIVE.has(v));
  const means = [...NON_ADDITIVE].map((v) => `sum(w.w * profile.population * profile.${v}) FILTER (WHERE profile.${v} IS NOT NULL) / NULLIF(sum(w.w * profile.population) FILTER (WHERE profile.${v} IS NOT NULL), 0) ${v}`);
  const result = await c.runAndReadAll(`
    SELECT s.riding_code, s.section, e.riding_name, e.electors, round(ST_X(ST_PointOnSurface(any_value(s.geom)))) x, round(ST_Y(ST_PointOnSurface(any_value(s.geom)))) y,
           count(DISTINCT w.dauid) n_dissemination_areas,
           ${additive.map((v) => `sum(w.w * profile.${v}) ${v}`).join(", ")}, ${means.join(", ")}
    FROM sections s LEFT JOIN electors e USING (riding_code, section) LEFT JOIN weights w USING (riding_code, section) LEFT JOIN profile USING (dauid)
    GROUP BY s.riding_code, s.section, e.riding_name, e.electors ORDER BY s.riding_code, s.section`);
  const names = result.columnNames();
  const rows = result.getRows().map((r) => Object.fromEntries(names.map((k, j) => {
    const v = r[j];
    return [k, v === null || v === undefined ? "" : typeof v === "number" && !Number.isInteger(v) ? Math.round(v * 1000) / 1000 : typeof v === "bigint" ? Number(v) : v];
  })));
  Deno.mkdirSync(folder, { recursive: true });
  ecrireCsv(new URL(`${folder}census_polling_divisions_2026.csv`, `file://${Deno.cwd()}/`), names, rows);
  const population = rows.reduce((a, r) => a + (Number(r.population) || 0), 0);
  console.log(`${rows.length} sections ; population interpolée ${Math.round(population)} ; sections sans aire : ${rows.filter((r) => !r.n_dissemination_areas).length}`);
}
