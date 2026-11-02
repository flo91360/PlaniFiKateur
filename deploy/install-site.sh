#!/bin/sh
# Installation du site sur le VPS (docs/vps.md) : données restaurées depuis la dernière copie
# quotidienne, site et mandataire HTTPS démarrés, mises à jour automatiques activées.
set -eu
if [ "$(id -u)" -ne 0 ]; then
  echo "Lancez avec sudo bash deploy/install-site.sh."
  exit 1
fi
repo=/home/admin/PlaniFiKateur
site_env=/home/admin/planifikateur-site.env
test -f "$repo/deploy/site.py"
if [ ! -f "$site_env" ]; then
  echo "Créez d’abord $site_env (voir docs/vps.md)."
  exit 1
fi
test -f /home/admin/planifikateur-worker.env
getent group docker >/dev/null
chown admin:admin "$site_env"
chmod 600 "$site_env"
runuser -u admin -- mkdir -p /home/admin/.local/state/planifikateur-worker-update
restore=""
if [ "${1:-}" = "--sans-donnees" ]; then
  echo "Installation sans restauration : la base démarre vide."
else
  restore="--restore ${1:-latest}"
fi
# shellcheck disable=SC2086 # $restore : option et chemin, sans espace.
runuser -u admin -g admin -G docker -- python3 "$repo/deploy/site.py" --install $restore
install -m 644 "$repo/deploy/planifikateur-site-update.service" /etc/systemd/system/
install -m 644 "$repo/deploy/planifikateur-site-update.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now planifikateur-site-update.timer
echo "Mises à jour automatiques du site activées : vérification toutes les deux minutes."
echo "Logs : sudo journalctl -u planifikateur-site-update.service -n 50 --no-pager"
