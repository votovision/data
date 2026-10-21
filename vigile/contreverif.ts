/**
 * Contre-vérification par un LLM des ventilations lues automatiquement.
 *
 * Pour chaque fichier de sources/rapports/ca/ donné en argument : le document
 * source (champ reference, PDF) est téléchargé, la page du tableau des
 * électeurs décidés est repérée et son texte extrait par MuPDF, ou par OCR
 * (tesseract) pour un PDF sans couche texte (lib/pdf.ts : une ligne par rangée,
 * chaque cellule avec sa position horizontale) ; un modèle servi par
 * Ollama relit le tableau, à température 0, et chaque valeur du fichier (parts
 * et effectifs) est comparée à sa lecture. Au moindre écart, le fichier est
 * déplacé dans raw/a_verifier/ avec la réponse du modèle, et n'est donc pas
 * intégré par la vigile. Si le modèle ne répond pas, le fichier est gardé et
 * signalé comme non contre-vérifié.
 *
 * Modèle : VOTOVISION_LLM (glm-5.3:cloud par défaut) ; serveur : OLLAMA_HOST
 * (http://localhost:11434 par défaut).
 *
 * Run: deno task contreverif sources/rapports/ca/<fichier>.json [...]
 */

import * as mupdf from "mupdf";
import { enTexte, rangeesAuto } from "../lib/pdf.ts";
import { encodeBase64 } from "jsr:@std/encoding@1/base64";
import { RACINE, USER_AGENT } from "../lib/commun.ts";

export const MODELE = Deno.env.get("VOTOVISION_LLM") ?? "glm-5.3:cloud";
export const MODELE_VISION = Deno.env.get("VOTOVISION_LLM_VISION") ?? "glm-5.3-flash:cloud";
const HOTE = Deno.env.get("OLLAMA_HOST") ?? "http://localhost:11434";
const A_VERIFIER = new URL("raw/a_verifier/", RACINE);

const CONSIGNE = `Tu extrais un tableau d'intentions de vote fédérales canadiennes d'un rapport de sondage. Le texte ci-dessous est la page, une ligne par rangée du document ; chaque cellule est suivie de sa position horizontale (@xNNN) : une valeur appartient à la colonne dont l'en-tête a la position la plus proche.
Prends UNIQUEMENT le tableau des électeurs décidés (« Decided », « Decided and Leaning », « Decided Voters », « DECIDED VOTE »), pas celui qui inclut les indécis.
Réponds par un objet JSON : {"groupes": {"<groupe>": {"n": <effectif non pondéré ou null>, "parts": {"<parti>": <nombre>}}}}.
Groupes : National (colonne Total/Canada), ATL, QC, ON, MBSK (Manitoba et Saskatchewan ensemble : « Prairies » quand Alberta est une colonne séparée, « MB/SK », « SK / MB »), AB, BC. Partis : LPC, CPC, NDP, BQ, GPC, PPC, AUTRES (Other / Another party / Someone else). Omet BQ hors National et QC. Ne mets pas « Maverick » ni « Undecided ». Recopie les nombres tels qu'imprimés, sans %, sans calcul.`;

type Groupes = Record<string, { n: number | null; parts: Record<string, number> }>;

/** La page du tableau des décidés avec les colonnes régionales, ou null. */
async function pageDuTableau(url: string): Promise<string | null> {
  const r = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!r.ok) return null;
  const doc = mupdf.Document.openDocument(new Uint8Array(await r.arrayBuffer()), "application/pdf");
  for (let p = 0; p < doc.countPages(); p++) {
    const t = enTexte((await rangeesAuto(doc.loadPage(p))).rangees);
    // « decided » comme mot entier : « Undecided » marque le tableau de tous les répondants.
    if (/\bdecided\b/i.test(t) && /atlantic|atl/i.test(t) && /quebec|qc/i.test(t)) return t;
  }
  return null;
}

/** Lecture d'images de pages par le modèle de vision, ou null s'il ne répond pas. */
export async function relireImages(images: Uint8Array[]): Promise<{ groupes: Groupes; brut: string } | null> {
  const consigne = CONSIGNE.replace("Le texte ci-dessous est la page, une ligne par rangée du document ; chaque cellule est suivie de sa position horizontale (@xNNN) : une valeur appartient à la colonne dont l'en-tête a la position la plus proche.",
    "Les images ci-jointes sont les pages du rapport ; s'il y en a plusieurs, le total national peut être sur une page et les régions sur une autre.");
  return await demander(MODELE_VISION, [{ role: "system", content: consigne },
    { role: "user", content: "Voici les pages.", images: images.map((i) => encodeBase64(i)) }]);
}

/** Lecture du modèle, ou null s'il ne répond pas. Le JSON peut suivre un raisonnement. */
export async function relire(page: string): Promise<{ groupes: Groupes; brut: string } | null> {
  return await demander(MODELE, [{ role: "system", content: CONSIGNE }, { role: "user", content: page }]);
}

async function demander(modele: string, messages: unknown[]): Promise<{ groupes: Groupes; brut: string } | null> {
  let j;
  try {
    const r = await fetch(`${HOTE}/api/chat`, {
      method: "POST",
      body: JSON.stringify({ model: modele, stream: false, format: "json", think: false, options: { temperature: 0 }, messages }),
    });
    j = await r.json();
  } catch { return null; }
  const s = String(j?.message?.content ?? "");
  const debuts = [...s.matchAll(/\{\s*"groupes"/g)].map((m) => m.index!), fin = s.lastIndexOf("}");
  try { return { groupes: JSON.parse(s.slice(debuts.length ? debuts.at(-1)! : s.indexOf("{"), fin + 1)).groupes, brut: s }; } catch { return null; }
}

if (import.meta.main) {
  let ecarte = 0;
  for (const chemin of Deno.args) {
    const nom = chemin.split("/").at(-1)!;
    const f = JSON.parse(Deno.readTextFileSync(chemin));
    let page: string | null = null;
    try { page = /\.pdf($|\?)/i.test(f.reference) ? await pageDuTableau(f.reference) : null; }
    catch (e) { console.log(`contre-vérification ${nom} : lecture impossible (${(e as Error).message.slice(0, 80)}), non contre-vérifié`); continue; }
    if (!page) { console.log(`contre-vérification ${nom} : page source introuvable, non contre-vérifié`); continue; }
    const lu = await relire(page);
    if (!lu) { console.log(`contre-vérification ${nom} : ${MODELE} sans réponse lisible, non contre-vérifié`); continue; }
    const ecarts: string[] = [];
    for (const [g, v] of Object.entries(f.groupes as Groupes)) {
      for (const [p, x] of Object.entries(v.parts)) if (lu.groupes?.[g]?.parts?.[p] !== x) ecarts.push(`${g}.${p} ${x}≠${lu.groupes?.[g]?.parts?.[p]}`);
      if (v.n !== null && lu.groupes?.[g]?.n !== v.n) ecarts.push(`${g}.n ${v.n}≠${lu.groupes?.[g]?.n}`);
    }
    if (ecarts.length) {
      Deno.mkdirSync(A_VERIFIER, { recursive: true });
      Deno.renameSync(chemin, new URL(nom, A_VERIFIER));
      Deno.writeTextFileSync(new URL(nom.replace(/\.json$/, ".llm.txt"), A_VERIFIER), lu.brut);
      console.log(`contre-vérification ${nom} : ÉCART avec ${MODELE} (${ecarts.join(", ")}) ; fichier mis de côté dans raw/a_verifier/`);
      ecarte++;
    } else {
      f.note += ` Contre-vérifié par ${MODELE} le ${new Date().toISOString().slice(0, 10)} : toutes les valeurs concordent.`;
      Deno.writeTextFileSync(chemin, JSON.stringify(f, null, 2) + "\n");
      console.log(`contre-vérification ${nom} : concorde avec ${MODELE}`);
    }
  }
  if (ecarte) Deno.exit(2);
}
