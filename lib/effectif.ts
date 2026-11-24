/**
 * Effectif d'un sondage tel qu'écrit dans les tableaux anglais de Wikipédia :
 * « 1,027 », « 1,027 (1/4) » (échantillon glissant), « 1,000[3] ». Seul le premier
 * nombre compte ; les fractions et appels de note ne sont pas des chiffres de l'effectif.
 */
export function effectif(t: string): number | null {
  const m = t.replace(/\[.*?\]/g, "").match(/\d[\d,\s  ]*/);
  const n = m ? Number(m[0].replace(/\D/g, "")) : 0;
  return n > 0 ? n : null;
}
