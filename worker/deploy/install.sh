#!/bin/sh
set -eu
if [ "$(id -u)" -ne 0 ]; then
  echo "Lancez avec sudo bash worker/deploy/install.sh."
  exit 1
fi
task_repo=/home/admin/PlaniFiKateur
test -f "$task_repo/worker/deploy/update.py"
test -f /home/admin/planifikateur-worker.env
getent passwd admin >/dev/null
getent group docker >/dev/null
if ! command -v python3 >/dev/null 2>&1; then
  apt-get update
  apt-get install -y python3
fi
runuser -u admin -- test -r /home/admin/planifikateur-worker.env
chmod 600 /home/admin/planifikateur-worker.env
runuser -u admin -- mkdir -p /home/admin/.local/state/planifikateur-worker-update
chmod 700 /home/admin/.local/state/planifikateur-worker-update
install -m 644 "$task_repo/worker/deploy/planifikateur-worker-update.service" /etc/systemd/system/
install -m 644 "$task_repo/worker/deploy/planifikateur-worker-update.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now planifikateur-worker-update.timer
echo "Mises à jour automatiques activées : vérification toutes les cinq minutes."
echo "Logs : sudo journalctl -u planifikateur-worker-update.service -n 50 --no-pager"
# Copie quotidienne des données du site, activée quand son fichier privé existe (docs/backups.md).
backup_env=/home/admin/planifikateur-backup.env
if [ -f "$backup_env" ]; then
  chown admin:admin "$backup_env"
  chmod 600 "$backup_env"
  runuser -u admin -- mkdir -p /home/admin/planifikateur-backups
  chmod 700 /home/admin/planifikateur-backups
  install -m 644 "$task_repo/worker/deploy/planifikateur-backup.service" /etc/systemd/system/
  install -m 644 "$task_repo/worker/deploy/planifikateur-backup.timer" /etc/systemd/system/
  systemctl daemon-reload
  systemctl enable --now planifikateur-backup.timer
  echo "Copie quotidienne des données activée dans /home/admin/planifikateur-backups."
  echo "Logs : sudo journalctl -u planifikateur-backup.service -n 20 --no-pager"
else
  echo "Copie quotidienne des données non activée : créez $backup_env (voir docs/backups.md) puis relancez ce script."
fi
