#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Cloud Agent start script for SkyNet-EnginX (ISP NetOps).
#
# Runs on every boot. Brings up MariaDB (which does not run under systemd in the
# agent VM) and waits until it is ready. The database schema and seed data were
# created by install.sh and persist in the snapshot's data directory, so this
# script only reconciles the running service — it does not reinstall or reseed.
# The application dev server itself is launched by the `dev-server` terminal.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

echo "==> Ensuring MariaDB is running"
sudo mkdir -p /var/run/mysqld
sudo chown mysql:mysql /var/run/mysqld

if ! sudo mysqladmin ping >/dev/null 2>&1; then
  sudo sh -c 'nohup mariadbd-safe >/var/log/mariadb-boot.log 2>&1 &'
fi

for i in $(seq 1 60); do
  if sudo mysqladmin ping >/dev/null 2>&1; then
    echo "==> MariaDB is up"
    exit 0
  fi
  sleep 1
done

echo "!! MariaDB did not become ready in time" >&2
sudo tail -n 40 /var/log/mariadb-boot.log 2>/dev/null || true
exit 1
