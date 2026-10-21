#!/usr/bin/env bash
# Vigile quotidienne de Votovision, pour une machine toujours allumée.
#
#  1. Met à jour les dépôts voisins (data, canada, bc, quebec) depuis GitHub.
#  2. Lance la vigile des sondages, la lecture automatique des tableaux de
#     Liaison (sources/liaison_tableaux.ts), puis de nouveau la vigile pour
#     intégrer les ventilations lues ; committe et pousse data.
#  3. Si data a changé : recalcule les prévisions (canada, bc, quebec après son
#     test golden), committe et pousse chaque dépôt modifié.
#  4. Liste les sondages fédéraux récents sans ventilation régionale, à
#     transcrire à la main.
#
# Les dépôts sont clonés côte à côte ; leur dossier parent est VOTOVISION_RACINE
# (par défaut, deux niveaux au-dessus de ce script). Journal :
# ~/.local/state/votovision/quotidien.log. Options : --force (recalcule les
# prévisions même sans nouveau sondage), --sans-push (ne pousse rien).
#
# Installation de la minuterie systemd : vigile/installer-systemd.sh.

set -uo pipefail
RACINE="${VOTOVISION_RACINE:-$(cd "$(dirname "$0")/../.." && pwd)}"
ETAT="${XDG_STATE_HOME:-$HOME/.local/state}/votovision"
mkdir -p "$ETAT"
JOURNAL="$ETAT/quotidien.log"
FORCE=0; PUSH=1
for a in "$@"; do case "$a" in --force) FORCE=1 ;; --sans-push) PUSH=0 ;; esac; done

# Deno et Node installés pour l'utilisateur (deno.land, nvm, fnm…).
export PATH="$HOME/.deno/bin:$HOME/.local/bin:$PATH"
export NO_COLOR=1   # journal lisible : pas de codes couleur de Deno
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
command -v fnm >/dev/null 2>&1 && eval "$(fnm env)"

exec >>"$JOURNAL" 2>&1
log() { printf '[%s] %s\n' "$(date '+%F %T')" "$*"; }
notifier() { command -v notify-send >/dev/null 2>&1 && notify-send -a Votovision "Votovision" "$1" || true; }

# Une seule exécution à la fois.
exec 9>"$ETAT/quotidien.lock"
if command -v flock >/dev/null 2>&1 && ! flock -n 9; then log "déjà en cours, abandon"; exit 0; fi

JOUR=$(date +%F)
log "début (racine $RACINE)"
for d in deno node npm git; do command -v "$d" >/dev/null 2>&1 || { log "ERREUR : $d introuvable"; notifier "Vigile : $d introuvable"; exit 1; }; done

pousser() { # $1 = dépôt
  [ "$PUSH" = 1 ] || { log "  $1 : push désactivé"; return 0; }
  git -C "$RACINE/$1" push -q origin HEAD || { log "  ERREUR : push $1"; notifier "Vigile : échec du push de $1"; return 1; }
}

for r in data canada bc quebec; do
  git -C "$RACINE/$r" pull -q --ff-only || { log "ERREUR : pull $r (modifications locales ?)"; notifier "Vigile : échec du pull de $r"; exit 1; }
done

# --- Données -----------------------------------------------------------------
cd "$RACINE/data" || exit 1
SORTIE=$( { deno task vigile; deno task liaison; deno task vigile; } 2>&1 | grep -v 'Download\|Initialize\|Task \|warning:\|format error' )
printf '%s\n' "$SORTIE" | sed 's/^/  /'
AJOUTS=$(printf '%s\n' "$SORTIE" | grep -E '^\s+\+ ' | sed -E 's/^\s+\+ //' | sort -u)
CHANGE=0
if [ -n "$(git status --porcelain csv sources/rapports etat)" ]; then
  CHANGE=1
  N=$(printf '%s\n' "$AJOUTS" | grep -c . || true)
  git add csv sources/rapports etat
  git commit -q -m "Vigile du $JOUR : $N ligne(s) ajoutée(s)

$AJOUTS" && log "data : commit ($N lignes)" && pousser data
else
  log "data : aucun nouveau sondage"
fi

# --- Prévisions ----------------------------------------------------------------
if [ "$CHANGE" = 1 ] || [ "$FORCE" = 1 ]; then
  modele() { # $1 = dépôt, puis les scripts npm à lancer dans l'ordre
    local r=$1; shift
    cd "$RACINE/$r" || return 1
    for s in "$@"; do
      if ! npm run -s "$s" >"$ETAT/$r-$s.log" 2>&1; then
        log "  ERREUR : $r npm run $s (voir $ETAT/$r-$s.log)"; notifier "Vigile : échec de $r ($s)"; git checkout -q -- data 2>/dev/null; return 1
      fi
    done
    if [ -n "$(git status --porcelain data)" ]; then
      git add data && git commit -q -m "Projection du $JOUR" && log "$r : prévision recalculée et committée" && pousser "$r"
    else
      log "$r : prévision inchangée"
    fi
  }
  modele canada donnees projection
  modele bc donnees projection
  modele quebec test donnees compute
fi

# --- Ventilations à transcrire --------------------------------------------------
cd "$RACINE/data" || exit 1
MANQUE=$(python3 -I - <<'EOF'
import csv, glob, json, datetime
depuis = (datetime.date.today() - datetime.timedelta(days=30)).isoformat()
faits = {(json.load(open(f))["firme"], json.load(open(f))["date_fin"]) for f in glob.glob("sources/rapports/ca/*.json")}
for r in csv.DictReader(open("csv/sondages.csv")):
    if r["juridiction"] == "ca-federal" and r["region"] == "National" and r["date_fin"] >= depuis and (r["firme"], r["date_fin"]) not in faits:
        print(f"{r['date_fin']} {r['firme']}" + (" (ventilations réservées aux abonnés)" if r["firme"] == "Nanos Research" else ""))
EOF
)
if [ -n "$MANQUE" ]; then log "sondages fédéraux sans ventilation (30 derniers jours) :"; printf '%s\n' "$MANQUE" | sed 's/^/    /'; fi

RESUME="$(printf '%s\n' "$AJOUTS" | grep -c . || true) ligne(s) ajoutée(s)"
A_TRANSCRIRE=$(printf '%s\n' "$MANQUE" | grep -v 'abonnés' | grep -c . || true)
[ "$A_TRANSCRIRE" -gt 0 ] && RESUME="$RESUME ; $A_TRANSCRIRE ventilation(s) à transcrire"
[ "$CHANGE" = 1 ] && notifier "Vigile du $JOUR : $RESUME"
log "fin : $RESUME"
