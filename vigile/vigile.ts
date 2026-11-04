/**
 * Vigile des sondages : détecte les sondages nouveaux, modifiés ou retirés
 * dans les sources publiques et met à jour csv/sondages.csv et csv/parts.csv.
 *
 * Chaque source se découpe en unités (une page Wikipédia, un fichier de
 * rapport). Pour une unité :
 *  1. changement ? identifiant de révision (Wikipédia) ou empreinte SHA-1
 *     du fichier (rapports), comparé à etat/sources.json ;
 *  2. si oui, lecture complète de l'unité, qui remplace les lignes de même
 *     provenance, sous garde-fous (retraits massifs, sommes de parts
 *     invraisemblables) : une violation annule l'écriture.
 * Doublons entre sources (même juridiction, groupe, firme et date) : la
 * ligne Wikipédia l'emporte pour la population entière (lien du sondeur),
 * la transcription du rapport pour les sous-groupes (effectif publié).
 *
 * Usage :
 *   deno task vigile                 # vérifier, intégrer s'il y a du nouveau
 *   deno task vigile --force         # tout relire
 *   deno task vigile --essai         # rapporter seulement
 *   deno task vigile --outrepasser   # passer outre aux garde-fous (après inspection)
 */

import { createHash } from "node:crypto";
import {
  COLONNES_PARTS, COLONNES_SONDAGES, ecrireCsv, idSondage, lireCsv, page, RACINE, revision,
  type Part, type Sondage,
} from "../lib/commun.ts";
import { lirePageQc, PAGES_QC } from "../sources/wikipedia_qc.ts";
import { lirePageFederale, PAGES_FEDERALES } from "../sources/wikipedia_federal.ts";
import { lirePageBc, PAGES_BC } from "../sources/wikipedia_bc.ts";
import { lirePageAb, PAGES_AB } from "../sources/wikipedia_ab.ts";

const F_SONDAGES = new URL("csv/sondages.csv", RACINE), F_PARTS = new URL("csv/parts.csv", RACINE);
const F_ETAT = new URL("etat/sources.json", RACINE);
const RAPPORTS = new URL("sources/rapports/", RACINE);
const MAX_RETRAITS = 5, SOMME: [number, number] = [85, 110];

export interface Options { force: boolean; essai: boolean; outrepasser: boolean }
interface Lot { unite: string; provenance: string; etat: string; sondages: Sondage[]; parts: Part[] }

export interface Source {
  nom: string;
  /** Unités modifiées depuis la dernière vigile, avec leur nouvel état. */
  changements(etat: Record<string, string>, force: boolean): Promise<[string, string][]>;
  /** Lecture complète d'une unité. */
  lire(unite: string, etat: string): Promise<Lot>;
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

class SourceWikipedia implements Source {
  constructor(public nom: string, private langue: string, private pages: Record<string, string>,
    private lecteur: (p: { titre: string; revid: number; html: string }) => { sondages: Sondage[]; parts: Part[] }) {}

  async changements(etat: Record<string, string>, force: boolean): Promise<[string, string][]> {
    const out: [string, string][] = [];
    for (const titre of Object.values(this.pages)) {
      const cle = `wikipedia:${this.langue}:${titre}`;
      try {
        const rev = String(await revision(this.langue, titre));
        if (force || etat[cle] !== rev) out.push([cle, rev]);
      } catch (e) { console.log(`  ! ${titre} : ${(e as Error).message}`); }
    }
    return out;
  }

  async lire(cle: string): Promise<Lot> {
    const titre = cle.split(":").slice(2).join(":");
    const p = await page(this.langue, titre);
    const { sondages, parts } = this.lecteur(p);
    return { unite: cle, provenance: cle, etat: String(p.revid), sondages, parts };
  }
}

const FIRMES_RAPPORTS: Record<string, string> = { "Segma / Radio-Canada": "Segma Recherche", "Angus Reid Institute": "Angus Reid" };
const empreinte = (u: URL): string => createHash("sha1").update(Deno.readFileSync(u)).digest("hex");

class SourceRapports implements Source {
  nom = "Rapports des maisons de sondage";
  private fichiers(): string[] {
    const out: string[] = [];
    for (const dossier of Deno.readDirSync(RAPPORTS)) {
      if (!dossier.isDirectory) continue;
      for (const f of Deno.readDirSync(new URL(`${dossier.name}/`, RAPPORTS))) if (f.name.endsWith(".json")) out.push(`${dossier.name}/${f.name}`);
    }
    return out.sort();
  }

  async changements(etat: Record<string, string>, force: boolean): Promise<[string, string][]> {
    return this.fichiers().map((f) => [`rapport:${f}`, empreinte(new URL(f, RAPPORTS))] as [string, string])
      .filter(([cle, h]) => force || etat[cle] !== h);
  }

  async lire(cle: string, etat: string): Promise<Lot> {
    const f = cle.slice("rapport:".length);
    const r = JSON.parse(Deno.readTextFileSync(new URL(f, RAPPORTS)));
    const firme = FIRMES_RAPPORTS[r.firme] ?? r.firme;
    const sondages: Sondage[] = [], parts: Part[] = [];
    for (const [groupe, { n, parts: p }] of Object.entries(r.groupes as Record<string, { n: number | null; parts: Record<string, number> }>)) {
      // Clé distincte de celle de Wikipédia (même firme, date et effectif) :
      // les deux versions d'un sondage gardent leurs parts jusqu'au dédoublonnage.
      const id = idSondage(r.juridiction, groupe, firme, r.date_fin, `${n ?? ""}|rapport`);
      sondages.push({ id, juridiction: r.juridiction, region: groupe, firme, date_debut: r.date_debut ?? "", date_fin: r.date_fin,
        n: n === null || n === undefined ? "" : String(n), n_decides: "", provenance: cle, reference: r.reference || r.document });
      for (const [parti, pct] of Object.entries(p)) parts.push({ id, parti, pct: String(pct) });
    }
    return { unite: cle, provenance: cle, etat, sondages, parts };
  }
}

// ---------------------------------------------------------------------------
// Vigile
// ---------------------------------------------------------------------------

export class VigileSondages {
  constructor(private sources: Source[]) {}

  async executer(o: Options): Promise<number> {
    console.log(`[${new Date().toISOString().slice(0, 16).replace("T", " ")}] vigile des sondages`);
    let etat: Record<string, string> = {};
    try { etat = JSON.parse(Deno.readTextFileSync(F_ETAT)); } catch { /* première vigile */ }
    let sondages = lireCsv(F_SONDAGES) as unknown as Sondage[];
    let parts = lireCsv(F_PARTS) as unknown as Part[];
    let total = 0;
    for (const source of this.sources) {
      const changes = await source.changements(etat, o.force);
      if (!changes.length) { console.log(`  ${source.nom} : rien de nouveau`); continue; }
      for (const [unite, val] of changes) {
        const lot = await source.lire(unite, val);
        const avant = sondages.filter((s) => s.provenance === lot.provenance);
        const ids = new Set(lot.sondages.map((s) => s.id)), anciens = new Set(avant.map((s) => s.id));
        const ajouts = lot.sondages.filter((s) => !anciens.has(s.id)), retraits = avant.filter((s) => !ids.has(s.id));
        const violations: string[] = [];
        if (retraits.length > MAX_RETRAITS) violations.push(`${retraits.length} retraits (max ${MAX_RETRAITS}) : page tronquée ou lecteur cassé ?`);
        const sommes = new Map<string, number>();
        for (const p of lot.parts) sommes.set(p.id, (sommes.get(p.id) ?? 0) + Number(p.pct));
        for (const s of ajouts) { const x = sommes.get(s.id) ?? 0; if (x < SOMME[0] || x > SOMME[1]) violations.push(`${s.firme} ${s.date_fin} ${s.region} : somme ${x.toFixed(1)}`); }
        if (violations.length && !o.outrepasser) {
          console.log(`  ${unite} : garde-fous, unité non intégrée (--outrepasser après inspection)`);
          for (const v of violations.slice(0, 10)) console.log(`    ! ${v}`);
          continue;
        }
        if (!ajouts.length && !retraits.length) {
          console.log(`  ${unite} : modifiée, aucun sondage changé`);
          etat[unite] = lot.etat;
          continue;
        }
        console.log(`  ${unite} : ${ajouts.length} ajout(s), ${retraits.length} retrait(s)`);
        for (const s of ajouts.slice(0, 8)) console.log(`    + ${s.date_fin} ${s.firme} ${s.region} n=${s.n || "?"}`);
        for (const s of retraits.slice(0, 8)) console.log(`    - ${s.date_fin} ${s.firme} ${s.region}`);
        total += ajouts.length + retraits.length;
        const garde = new Set(sondages.filter((s) => s.provenance !== lot.provenance).map((s) => s.id));
        sondages = [...sondages.filter((s) => s.provenance !== lot.provenance), ...lot.sondages];
        parts = [...parts.filter((p) => garde.has(p.id) && !ids.has(p.id)), ...lot.parts];
        etat[unite] = lot.etat;
      }
    }
    if (o.essai) { console.log("  --essai : rien n'a été écrit"); return total; }
    // Doublons ENTRE sources de nature différente (Wikipédia, rapport) pour un
    // même sondage (juridiction, groupe, firme, date) : une seule nature est
    // gardée. Deux sondages d'une même source le même jour restent distincts.
    const cle = (s: Sondage) => `${s.juridiction}|${s.region}|${s.firme}|${s.date_fin}`;
    const nature = (s: Sondage) => (s.provenance.startsWith("wikipedia") ? "wikipedia" : "rapport");
    const prefere = (s: Sondage) => (s.region === "National" ? "wikipedia" : "rapport");
    const natures = new Map<string, Set<string>>();
    for (const s of sondages) { const k = cle(s); if (!natures.has(k)) natures.set(k, new Set()); natures.get(k)!.add(nature(s)); }
    sondages = sondages.filter((s) => natures.get(cle(s))!.size === 1 || nature(s) === prefere(s));
    const idsGardes = new Set(sondages.map((s) => s.id));
    const vuPart = new Set<string>();
    parts = parts.filter((p) => idsGardes.has(p.id) && !vuPart.has(p.id + "|" + p.parti) && vuPart.add(p.id + "|" + p.parti));
    // Précisions tirées des rapports pour des sondages nationaux lus sur
    // Wikipédia (effectif des répondants décidés, début du terrain) :
    // sources/precisions/<juridiction>.json, appliquées par firme et date.
    for (const [jur, f] of [["qc-provincial", "qc.json"]]) {
      let prec: { firme: string; date_fin: string; n_decides: number; date_debut: string }[] = [];
      try { prec = JSON.parse(Deno.readTextFileSync(new URL(`sources/precisions/${f}`, RACINE))); } catch { continue; }
      for (const p of prec) {
        const s = sondages.find((x) => x.juridiction === jur && x.region === "National" && x.firme === p.firme && x.date_fin === p.date_fin);
        if (!s) { console.log(`  ! précision sans sondage : ${p.firme} ${p.date_fin}`); continue; }
        s.n_decides = String(p.n_decides ?? ""); if (p.date_debut) s.date_debut = p.date_debut;
      }
    }
    sondages.sort((a, b) => a.juridiction.localeCompare(b.juridiction) || a.date_fin.localeCompare(b.date_fin) || a.firme.localeCompare(b.firme) || a.region.localeCompare(b.region));
    const ordre = new Map(sondages.map((s, i) => [s.id, i]));
    parts.sort((a, b) => (ordre.get(a.id)! - ordre.get(b.id)!) || a.parti.localeCompare(b.parti));
    ecrireCsv(F_SONDAGES, COLONNES_SONDAGES, sondages as unknown as Record<string, unknown>[]);
    ecrireCsv(F_PARTS, COLONNES_PARTS, parts as unknown as Record<string, unknown>[]);
    Deno.mkdirSync(new URL("etat/", RACINE), { recursive: true });
    Deno.writeTextFileSync(F_ETAT, JSON.stringify(etat, null, 1) + "\n");
    console.log(`  tables écrites : ${sondages.length} sondages, ${parts.length} parts`);
    return total;
  }
}

if (import.meta.main) {
  const a = new Set(Deno.args);
  await new VigileSondages([
    new SourceWikipedia("Wikipédia (Québec)", "fr", PAGES_QC, lirePageQc),
    new SourceWikipedia("Wikipédia (fédéral)", "en", PAGES_FEDERALES, lirePageFederale),
    new SourceWikipedia("Wikipédia (Colombie-Britannique)", "en", PAGES_BC, lirePageBc),
    new SourceWikipedia("Wikipédia (Alberta)", "en", PAGES_AB, lirePageAb),
    new SourceRapports(),
  ]).executer({ force: a.has("--force"), essai: a.has("--essai"), outrepasser: a.has("--outrepasser") });
}
