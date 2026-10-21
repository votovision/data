# data

Données électorales et de sondages du projet Votovision / election and poll data for the Votovision project.

## Contenu

| Dossier | Contenu |
|---|---|
| `csv/` | Tables publiées : sondages (`sondages.csv`), parts par parti (`parts.csv`), résultats officiels par circonscription (`resultats.csv`) et, pour le Québec, par section de vote (`resultats_sections_qc.csv`), candidatures, circonscriptions et recensement par circonscription. Chaque ligne indique sa source primaire. |
| `geo/` | Limites des circonscriptions en GeoJSON simplifié (fédérales de 2023, Colombie-Britannique de 2023), lues par les tableaux de bord. |
| `sources/` | Téléchargeurs et lecteurs, un par source publique (Wikipédia, Élections Canada, Élections Québec, Elections BC, Statistique Canada, rapports des maisons de sondage, agences provinciales), et transpositions d'une carte électorale à une autre. `sources/rapports/<juridiction>/` : ventilations des sondages (régions, langue, âge) transcrites des rapports des sondeurs, un fichier JSON par sondage avec le document source ; la vigile les intègre aux tables. |
| `vigile/` | Vigile des sondages : détecte les sondages nouveaux ou modifiés dans les sources, les intègre et met à jour les tables. |
| `etat/` | État de la vigile : dernière révision lue de chaque source. |
| `raw/` | Téléchargements bruts, locaux, non versionnés. |
| `prive/` | Données dont la republication n'est pas autorisée, locales, non versionnées. |

Les données des agences dont les conditions n'autorisent pas la republication (par exemple Elections Alberta) sont téléchargées par les outils de `sources/` dans `raw/` et ne sont pas versionnées : le dépôt contient le téléchargeur, pas leurs données.

Les chiffres de sondage proviennent des rapports publiés par les maisons de sondage. Chaque ligne cite le sondeur, la date de terrain et le document d'origine ; les rapports eux-mêmes ne sont pas reproduits.

## Utilisation

Deno 2 ; les paquets npm sont installés par Deno (`nodeModulesDir: "auto"`).

```
deno task vigile                                                  # sondages : Wikipédia -> csv/sondages.csv, csv/parts.csv
deno task limites-federales                                       # limites fédérales -> geo/
deno run -A sources/elections_quebec.ts --date AAAA-MM-JJ --carte AAAA   # résultats par circonscription (flux d'Élections Québec)
deno task sections-qc --election AAAA-MM-JJ --carte AAAA          # résultats par section de vote -> csv/resultats_sections_qc.csv
deno task transposition-sections-qc --de AAAA-MM-JJ --vers AAAA-MM-JJ    # résultats d'une élection sur les sections de la suivante -> raw/
```

Chaque script de `sources/` documente en tête sa source, sa licence et sa commande.

### Vigile quotidienne

`vigile/quotidien.sh` enchaîne, pour une machine toujours allumée : mise à jour des quatre dépôts voisins (`data`, `canada`, `bc`, `quebec`), vigile des sondages, lecture automatique des tableaux détaillés de Liaison (`deno task liaison`, `sources/liaison_tableaux.ts` : un tableau n'est écrit que s'il passe les contrôles de sommes, de moyenne régionale et d'accord avec Wikipédia), intégration, puis recalcul et push des prévisions si un sondage est arrivé. Il liste dans son journal (`~/.local/state/votovision/quotidien.log`) les sondages fédéraux récents dont la ventilation reste à transcrire à la main.

```
bash vigile/installer-systemd.sh 07:15     # minuterie systemd de l'utilisateur, chaque jour
bash vigile/quotidien.sh --sans-push       # essai à la main, sans rien pousser
```

## Licences

- **Code** (`sources/`, `vigile/`, outils) : GNU GPL v3 (`LICENSE`).
- **Données** (`csv/`) : Creative Commons Attribution - Partage dans les mêmes conditions 4.0 International (CC BY-SA 4.0, `LICENCE-CC-BY-SA-4.0.txt`). Les tables dérivées de Wikipédia et de l'Atlas des élections au Québec sont elles-mêmes sous CC BY-SA 4.0.
- **Limites** (`geo/`) : dérivées des données d'Élections Canada (Licence du gouvernement ouvert – Canada) et d'Elections BC (Open Data Licence), sous ces licences.
- **Attributions** obligatoires des sources : `ATTRIBUTIONS.md`.

Citer : Votovision, *data* (https://github.com/votovision/data), avec les attributions des sources utilisées.
