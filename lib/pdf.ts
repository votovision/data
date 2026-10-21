/**
 * Lecture des pages de PDF en rangées de cellules positionnées, pour les
 * tableaux des rapports de sondage.
 *
 * - rangees(page) : couche texte du PDF, lue par MuPDF (WebAssembly).
 * - rangeesOcr(page) : page rendue par MuPDF en image (300 dpi), lue par
 *   tesseract (sortie TSV : chaque mot avec sa boîte), pour les PDF sans
 *   couche texte (glyphes vectorisés, images). Demande la permission
 *   --allow-run=tesseract.
 * - rangeesAuto(page) : la couche texte si elle existe, sinon l'OCR.
 * - imagePng(page) : la page rendue en PNG, pour un modèle de vision.
 * - enTexte(rangees) : une ligne par rangée, cellules « texte@xNNN » de gauche
 *   à droite, x en points de la page.
 */

import * as mupdf from "mupdf";

export type Cellule = { x: number; s: string };

/** Regroupe des cellules (x, y, texte) en rangées de haut en bas, triées de gauche à droite. */
function enRangees(cellules: { x: number; y: number; s: string }[], tolerance: number): Cellule[][] {
  const parY = new Map<number, Cellule[]>();
  for (const c of cellules) {
    const cle = [...parY.keys()].find((v) => Math.abs(v - c.y) <= tolerance) ?? c.y;
    if (!parY.has(cle)) parY.set(cle, []);
    parY.get(cle)!.push({ x: c.x, s: c.s });
  }
  return [...parY].sort((a, b) => a[0] - b[0]).map(([, r]) => r.sort((a, b) => a.x - b.x));
}

export function rangees(page: mupdf.Page): Cellule[][] {
  const st = JSON.parse(page.toStructuredText("preserve-whitespace").asJSON());
  const cellules = [];
  for (const b of st.blocks) for (const l of b.lines ?? []) if (l.text.trim()) cellules.push({ x: l.bbox.x, y: l.bbox.y, s: l.text.trim() });
  return enRangees(cellules, 3);
}

export async function rangeesOcr(page: mupdf.Page, dpi = 300): Promise<Cellule[][]> {
  const echelle = dpi / 72;
  const pix = page.toPixmap(mupdf.Matrix.scale(echelle, echelle), mupdf.ColorSpace.DeviceGray, false, true);
  const image = await Deno.makeTempFile({ suffix: ".png" });
  try {
    await Deno.writeFile(image, pix.asPNG());
    const r = await new Deno.Command("tesseract", { args: [image, "stdout", "--psm", "6", "-l", "eng", "tsv"], stdout: "piped", stderr: "piped" }).output();
    if (!r.success) throw new Error(`tesseract : ${new TextDecoder().decode(r.stderr).slice(0, 200)}`);
    // Mots (niveau 5) : left top width height conf text.
    const mots = new TextDecoder().decode(r.stdout).split("\n").slice(1).map((l) => l.split("\t"))
      .filter((c) => c[0] === "5" && c[11]?.trim())
      .map((c) => ({ x: Number(c[6]), y: Number(c[7]), w: Number(c[8]), h: Number(c[9]), s: c[11].trim() }));
    if (!mots.length) return [];
    const hauteur = mots.map((m) => m.h).sort((a, b) => a - b)[Math.floor(mots.length / 2)];
    // Mots d'une même rangée séparés par moins d'une hauteur de ligne : une seule cellule.
    const out: Cellule[][] = [];
    for (const r of enRangees(mots.map((m) => ({ x: m.x, y: m.y + m.h / 2, s: JSON.stringify(m) })), hauteur * 0.6)) {
      const ms = r.map((c) => JSON.parse(c.s) as typeof mots[number]);
      const cellules: { x: number; fin: number; s: string }[] = [];
      for (const m of ms) {
        const derniere = cellules.at(-1);
        if (derniere && m.x - derniere.fin < hauteur * 0.9) { derniere.s += " " + m.s; derniere.fin = m.x + m.w; }
        else cellules.push({ x: m.x, fin: m.x + m.w, s: m.s });
      }
      out.push(cellules.map((c) => ({ x: c.x / echelle, s: c.s })));
    }
    return out;
  } finally {
    await Deno.remove(image).catch(() => {});
  }
}

export async function rangeesAuto(page: mupdf.Page): Promise<{ rangees: Cellule[][]; ocr: boolean }> {
  const r = rangees(page);
  return r.length ? { rangees: r, ocr: false } : { rangees: await rangeesOcr(page), ocr: true };
}

export const enTexte = (r: Cellule[][]): string => r.map((l) => l.map((c) => `${c.s}@x${Math.round(c.x)}`).join(" | ")).join("\n");

export function imagePng(page: mupdf.Page, dpi = 200): Uint8Array {
  const e = dpi / 72;
  return page.toPixmap(mupdf.Matrix.scale(e, e), mupdf.ColorSpace.DeviceRGB, false, true).asPNG();
}
