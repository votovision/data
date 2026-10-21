#!/usr/bin/env bash
# Installe la vigile quotidienne comme minuterie systemd de l'utilisateur
# (Ubuntu ou toute distribution avec systemd) : tous les jours à l'heure
# donnée (7 h 15 par défaut), rattrapée au démarrage si la machine était
# éteinte. Les dépôts sont ceux qui entourent ce script.
#
#   bash vigile/installer-systemd.sh [HH:MM]
#
# Désinstaller : systemctl --user disable --now votovision-quotidien.timer
# Lancer à la main : systemctl --user start votovision-quotidien.service
# Journal : ~/.local/state/votovision/quotidien.log

set -euo pipefail
HEURE="${1:-07:15}"
SCRIPT="$(cd "$(dirname "$0")" && pwd)/quotidien.sh"
UNITES="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$UNITES"
chmod +x "$SCRIPT"

cat >"$UNITES/votovision-quotidien.service" <<EOF
[Unit]
Description=Vigile quotidienne de Votovision (sondages, ventilations, prévisions)
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/bin/env bash $SCRIPT
TimeoutStartSec=2h
EOF

cat >"$UNITES/votovision-quotidien.timer" <<EOF
[Unit]
Description=Vigile quotidienne de Votovision

[Timer]
OnCalendar=*-*-* $HEURE:00
Persistent=true
RandomizedDelaySec=10min

[Install]
WantedBy=timers.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now votovision-quotidien.timer
systemctl --user list-timers votovision-quotidien.timer --no-pager
echo
echo "Installé. Pour que la minuterie tourne même sans session ouverte : sudo loginctl enable-linger $USER"
echo "Le push passe par git : vérifie que 'git push' fonctionne sans mot de passe dans les quatre dépôts (clé SSH sans phrase de passe, ou agent accessible aux services utilisateur)."
